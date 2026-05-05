"""Coordinator for dataset diagnose/repair jobs.

A single global job runs at a time.  The coordinator owns:

- the ``asyncio.Lock`` that enforces mutual exclusion,
- the ``cancel_event`` consulted at every dataset boundary,
- the SSE event fan-out (one ``asyncio.Queue`` per subscriber).

Phase 1 implements diagnosis only; the repair worker is Phase 3.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Callable
from uuid import uuid4

from . import selection
from .diagnosis import diagnose_dataset
from .schemas import (
    DamageSummary,
    DatasetJobItem,
    DatasetRepairDataset,
    DatasetRepairFilter,
    DiagnoseRequest,
    JobPhase,
    RepairJobState,
)
from .status import record_diagnosis, utc_now_iso
from .types import DiagnosisResult

DiagnoseFn = Callable[[Path], DiagnosisResult]

ITEM_BOUNDARY_EXCEPTIONS = (FileNotFoundError, PermissionError, OSError, ValueError)
TERMINAL_PHASES: set[JobPhase] = {"completed", "failed", "cancelled"}
ACTIVE_PHASES: set[JobPhase] = {"diagnosing", "repairing", "cancelling"}


class JobConflictError(RuntimeError):
    """Raised when a second job is started while one is active."""

    def __init__(self, current: RepairJobState) -> None:
        super().__init__(f"Job {current.job_id} already running ({current.phase})")
        self.current = current


class DatasetRepairCoordinator:
    """Single-job coordinator for diagnose/repair runs."""

    def __init__(
        self,
        datasets_root: Path,
        *,
        diagnose_fn: DiagnoseFn | None = None,
    ) -> None:
        self._datasets_root = datasets_root
        self._diagnose_fn: DiagnoseFn = diagnose_fn or diagnose_dataset
        self._lock = asyncio.Lock()
        self._active_job: RepairJobState | None = None
        self._jobs: dict[str, RepairJobState] = {}
        self._cancel_event: asyncio.Event | None = None
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._worker_task: asyncio.Task | None = None

    @property
    def datasets_root(self) -> Path:
        return self._datasets_root

    async def list_datasets(
        self,
        filters: DatasetRepairFilter,
    ) -> list[DatasetRepairDataset]:
        root = self._resolve_scan_root(filters.root)
        return await asyncio.to_thread(selection.list_datasets, root, filters)

    def _resolve_scan_root(self, requested: str | None) -> Path:
        """Reject any caller-supplied root that escapes the configured scan
        area. Without this, ``filters.root`` would let the API scan arbitrary
        directories and trigger ``ensure_status`` writes wherever the process
        has write access.
        """
        if not requested:
            return self._datasets_root
        candidate = Path(requested).expanduser().resolve()
        anchor = self._datasets_root.resolve()
        if candidate != anchor and not candidate.is_relative_to(anchor):
            raise ValueError(
                f"root must be inside {anchor}; got {candidate}"
            )
        return candidate

    async def get_current_job(self) -> RepairJobState | None:
        return self._active_job

    async def get_job(self, job_id: str) -> RepairJobState | None:
        return self._jobs.get(job_id)

    async def start_diagnosis(self, request: DiagnoseRequest) -> RepairJobState:
        async with self._lock:
            if self._active_job is not None and self._active_job.phase in ACTIVE_PHASES:
                raise JobConflictError(self._active_job)

            dataset_records = await self._resolve_targets(request)
            job = self._build_initial_job(dataset_records, kind="diagnose", phase="diagnosing")
            self._active_job = job
            self._jobs[job.job_id] = job
            self._cancel_event = asyncio.Event()
            self._subscribers[job.job_id] = set()
            self._worker_task = asyncio.create_task(self._run_diagnosis(job, dataset_records))
            self._worker_task.add_done_callback(_consume_task_exception)
            return job

    async def cancel(self, job_id: str) -> RepairJobState:
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise ValueError(f"Job {job_id} not found")
            if job.phase in TERMINAL_PHASES:
                return job
            if self._cancel_event is not None:
                self._cancel_event.set()
            job.phase = "cancelling"
            job.updated_at = utc_now_iso()
            await self._publish(job_id, "snapshot", job.model_dump())
            return job

    async def stream_events(self, job_id: str) -> AsyncIterator[dict]:
        job = self._jobs.get(job_id)
        if job is None:
            raise ValueError(f"Job {job_id} not found")
        queue: asyncio.Queue = asyncio.Queue()
        self._subscribers.setdefault(job_id, set()).add(queue)
        try:
            await queue.put({"type": "snapshot", "data": job.model_dump()})
            if job.phase in TERMINAL_PHASES:
                yield await queue.get()
                if job.phase == "failed":
                    # Match the live-failure shape so late subscribers don't
                    # lose ``data.error`` (the frontend reducer reads it).
                    yield {
                        "type": "error",
                        "data": {
                            "job": job.model_dump(),
                            "error": job.error or "job failed",
                        },
                    }
                else:
                    yield {"type": "complete", "data": job.model_dump()}
                return
            while True:
                event = await queue.get()
                yield event
                if event["type"] in ("complete", "error"):
                    return
        finally:
            subs = self._subscribers.get(job_id)
            if subs is not None:
                subs.discard(queue)
                if not subs:
                    self._subscribers.pop(job_id, None)

    async def _resolve_targets(self, request: DiagnoseRequest) -> list[DatasetRepairDataset]:
        filters = request.filters or DatasetRepairFilter()
        all_datasets = await self.list_datasets(filters)
        if request.dataset_ids is None:
            return all_datasets
        wanted = set(request.dataset_ids)
        return [item for item in all_datasets if item.id in wanted]

    def _build_initial_job(
        self,
        datasets: list[DatasetRepairDataset],
        *,
        kind,
        phase: JobPhase,
    ) -> RepairJobState:
        now = utc_now_iso()
        items = [
            DatasetJobItem(
                dataset_id=item.id,
                dataset_path=item.path,
                status="queued",
                output_path=str(self._cleaned_output_path(item.id)),
            )
            for item in datasets
        ]
        return RepairJobState(
            job_id=uuid4().hex[:12],
            kind=kind,
            phase=phase,
            total=len(items),
            processed=0,
            summary=DamageSummary(total=len(items)),
            items=items,
            started_at=now,
            updated_at=now,
        )

    def _cleaned_output_path(self, dataset_id: str) -> Path:
        """Phase 3 will write repairs here; we expose it now so the UI can
        preview the target path on every job item.
        """
        slug = dataset_id.rsplit("/", 1)[-1]
        return self._datasets_root / "cleaned" / "local" / slug

    async def _run_diagnosis(
        self,
        job: RepairJobState,
        datasets: list[DatasetRepairDataset],
    ) -> None:
        try:
            for index, dataset in enumerate(datasets):
                if self._cancel_event is not None and self._cancel_event.is_set():
                    await self._cancel_remaining(job, index)
                    break
                await self._diagnose_one(job, index, dataset)
        except Exception as exc:
            job.phase = "failed"
            job.error = str(exc)
            job.updated_at = utc_now_iso()
            await self._publish(
                job.job_id,
                "error",
                {"job": job.model_dump(), "error": job.error},
            )
            if self._active_job is job:
                self._active_job = None
                self._cancel_event = None
            raise

        await self._finalize_job(job)

    async def _diagnose_one(
        self,
        job: RepairJobState,
        index: int,
        dataset: DatasetRepairDataset,
    ) -> None:
        item = job.items[index]
        item.status = "diagnosing"
        dataset_path = Path(dataset.path)
        try:
            result = await asyncio.to_thread(self._diagnose_fn, dataset_path)
        except ITEM_BOUNDARY_EXCEPTIONS as exc:
            item.status = "failed"
            item.error = str(exc)
            job.processed += 1
            job.updated_at = utc_now_iso()
            await self._publish(job.job_id, "item", item.model_dump())
            return

        damage = result.damage_type.value
        item.status = "done"
        item.damage_type = damage  # type: ignore[assignment]
        item.repairable = result.repairable
        job.processed += 1
        job.updated_at = utc_now_iso()
        _bump_summary(job.summary, damage, result.repairable)

        await asyncio.to_thread(
            record_diagnosis,
            dataset_path,
            damage_type=damage,
            job_id=job.job_id,
        )
        await self._publish(job.job_id, "item", item.model_dump())

    async def _cancel_remaining(self, job: RepairJobState, start_index: int) -> None:
        for remaining in job.items[start_index:]:
            if remaining.status == "queued":
                remaining.status = "cancelled"
        job.updated_at = utc_now_iso()

    async def _finalize_job(self, job: RepairJobState) -> None:
        if self._cancel_event is not None and self._cancel_event.is_set():
            job.phase = "cancelled"
        else:
            job.phase = "completed"
        job.updated_at = utc_now_iso()
        await self._publish(job.job_id, "complete", job.model_dump())
        if self._active_job is job:
            self._active_job = None
            self._cancel_event = None


    async def _publish(self, job_id: str, event_type: str, data: dict) -> None:
        subs = self._subscribers.get(job_id)
        if not subs:
            return
        payload = {"type": event_type, "data": data}
        for queue in list(subs):
            queue.put_nowait(payload)


def _bump_summary(summary: DamageSummary, damage: str, repairable: bool) -> None:
    if hasattr(summary, damage):
        setattr(summary, damage, getattr(summary, damage) + 1)
    if not repairable and damage != "healthy":
        summary.unrepairable += 1


def _consume_task_exception(task: asyncio.Task) -> None:
    """Done callback that retrieves and discards any worker exception so
    asyncio doesn't log "Task exception was never retrieved".  The exception
    has already been published as an SSE ``error`` event by the worker.
    """
    if not task.cancelled():
        task.exception()
