"""Coordinator for dataset diagnose/repair jobs.

A single global job runs at a time.  The coordinator owns:

- the ``asyncio.Lock`` that enforces mutual exclusion,
- the ``cancel_event`` consulted at every dataset boundary,
- the SSE event fan-out (one ``asyncio.Queue`` per subscriber).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable
from pathlib import Path, PurePosixPath
from typing import Callable
from uuid import uuid4

from . import selection
from .diagnosis import diagnose_dataset
from .repairers import repair_dataset
from .schemas import (
    DamageSummary,
    DatasetJobItem,
    DatasetRepairDataset,
    DatasetRepairFilter,
    DiagnoseRequest,
    JobKind,
    JobPhase,
    RepairJobState,
)
from .status import mark_checked, record_diagnosis, utc_now_iso
from .types import DiagnosisResult, RepairResult

DiagnoseFn = Callable[[Path], DiagnosisResult]
RepairFn = Callable[..., RepairResult]
LogSink = Callable[[str], None]

DEFAULT_TASK = "default-task"
DEFAULT_VCODEC = "h264"

ITEM_BOUNDARY_EXCEPTIONS = (FileNotFoundError, PermissionError, OSError, ValueError)
TERMINAL_PHASES: set[JobPhase] = {"completed", "failed", "cancelled"}
ACTIVE_PHASES: set[JobPhase] = {"diagnosing", "repairing", "cancelling"}
JOB_ERROR_EVENT = "job-error"


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
        cleaned_root: Path | None = None,
        diagnose_fn: DiagnoseFn | None = None,
        repair_fn: RepairFn | None = None,
        log_sink: LogSink | None = None,
        task: str = DEFAULT_TASK,
        vcodec: str = DEFAULT_VCODEC,
    ) -> None:
        self._datasets_root = datasets_root
        self._resolved_datasets_root = datasets_root.expanduser().resolve()
        # Cleaned artifacts live as a sibling of the scan root so they don't
        # pollute the source listing or get confused with backups.
        self._cleaned_root = cleaned_root or (datasets_root.parent / "cleaned")
        self._diagnose_fn: DiagnoseFn = diagnose_fn or diagnose_dataset
        self._repair_fn: RepairFn = repair_fn or repair_dataset
        self._log_sink = log_sink
        self._task = task
        self._vcodec = vcodec
        self._lock = asyncio.Lock()
        self._active_job: RepairJobState | None = None
        self._jobs: dict[str, RepairJobState] = {}
        self._cancel_event: asyncio.Event | None = None
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._worker_task: asyncio.Task | None = None

    @property
    def datasets_root(self) -> Path:
        return self._datasets_root

    def _log(self, message: str) -> None:
        if self._log_sink is None:
            return
        self._log_sink(f"[dataset-repair] {message}")

    async def list_datasets(
        self,
        filters: DatasetRepairFilter,
    ) -> list[DatasetRepairDataset]:
        root = self._resolve_scan_root(filters.root)
        return await asyncio.to_thread(
            selection.list_datasets,
            root,
            filters,
            id_root=self._resolved_datasets_root,
        )

    def _resolve_scan_root(self, requested: str | None) -> Path:
        """Reject any caller-supplied root that escapes the configured scan
        area. Without this, ``filters.root`` would let the API scan arbitrary
        directories and trigger ``ensure_status`` writes wherever the process
        has write access.
        """
        if not requested:
            return self._resolved_datasets_root
        candidate = Path(requested).expanduser()
        anchor = self._resolved_datasets_root
        if not candidate.is_absolute():
            candidate = anchor / candidate
        candidate = candidate.resolve()
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
        return await self._start_job(request, kind="diagnose", phase="diagnosing")

    async def start_repair(self, request: DiagnoseRequest) -> RepairJobState:
        return await self._start_job(request, kind="repair", phase="repairing")

    async def _start_job(
        self,
        request: DiagnoseRequest,
        *,
        kind: JobKind,
        phase: JobPhase,
    ) -> RepairJobState:
        async with self._lock:
            if self._active_job is not None and self._active_job.phase in ACTIVE_PHASES:
                raise JobConflictError(self._active_job)

            dataset_records = await self._resolve_targets(request)
            job = self._build_initial_job(dataset_records, kind=kind, phase=phase)
            self._active_job = job
            self._jobs[job.job_id] = job
            self._cancel_event = asyncio.Event()
            self._subscribers[job.job_id] = set()
            self._log(f"job {job.job_id} starting: kind={kind}, total={job.total}")
            if kind == "diagnose":
                coro = self._run_diagnosis(job, dataset_records)
            else:
                coro = self._run_repair(job, dataset_records, request.force)
            self._worker_task = asyncio.create_task(coro)
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
                        "type": JOB_ERROR_EVENT,
                        "data": _job_error_payload(job),
                    }
                else:
                    yield {"type": "complete", "data": job.model_dump()}
                return
            while True:
                event = await queue.get()
                yield event
                if event["type"] in ("complete", JOB_ERROR_EVENT):
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
        return self._cleaned_root / _safe_dataset_id_path(dataset_id)

    async def _run_diagnosis(
        self,
        job: RepairJobState,
        datasets: list[DatasetRepairDataset],
    ) -> None:
        await self._run_worker(
            job,
            datasets,
            lambda index, dataset: self._diagnose_one(job, index, dataset),
        )

    async def _run_repair(
        self,
        job: RepairJobState,
        datasets: list[DatasetRepairDataset],
        force: bool,
    ) -> None:
        await self._run_worker(
            job,
            datasets,
            lambda index, dataset: self._repair_one(job, index, dataset, force),
        )

    async def _run_worker(
        self,
        job: RepairJobState,
        datasets: list[DatasetRepairDataset],
        process_one: Callable[[int, DatasetRepairDataset], Awaitable[None]],
    ) -> None:
        try:
            for index, dataset in enumerate(datasets):
                if self._cancel_event is not None and self._cancel_event.is_set():
                    await self._cancel_remaining(job, index)
                    break
                await process_one(index, dataset)
        except Exception as exc:
            job.phase = "failed"
            job.error = str(exc)
            job.updated_at = utc_now_iso()
            self._log(f"job {job.job_id} failed: {type(exc).__name__}: {exc}")
            await self._publish(
                job.job_id,
                JOB_ERROR_EVENT,
                _job_error_payload(job),
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
            repairable=result.repairable,
            job_id=job.job_id,
        )
        self._log(f"{dataset.id}: diagnosed damage={damage} repairable={result.repairable}")
        await self._publish(job.job_id, "item", item.model_dump())

    async def _repair_one(
        self,
        job: RepairJobState,
        index: int,
        dataset: DatasetRepairDataset,
        force: bool,
    ) -> None:
        item = job.items[index]
        cleaned_path = self._cleaned_output_path(dataset.id)
        # output_path was already populated by _build_initial_job; just flip status.
        item.status = "repairing"
        self._log(f"{dataset.id}: repairing → {cleaned_path}")
        await self._publish(job.job_id, "item", item.model_dump())

        dataset_path = Path(dataset.path)
        try:
            diagnosis = await asyncio.to_thread(self._diagnose_fn, dataset_path)
            result = await asyncio.to_thread(
                self._repair_fn,
                diagnosis,
                task=self._task,
                vcodec=self._vcodec,
                dry_run=False,
                force=force,
                output_dir=cleaned_path,
            )
        except ITEM_BOUNDARY_EXCEPTIONS as exc:
            item.status = "failed"
            item.error = str(exc)
            job.processed += 1
            job.updated_at = utc_now_iso()
            self._log(f"{dataset.id}: repair raised {type(exc).__name__}: {exc}")
            await self._publish(job.job_id, "item", item.model_dump())
            return

        damage = diagnosis.damage_type.value
        item.damage_type = damage  # type: ignore[assignment]
        item.repairable = diagnosis.repairable
        item.error = result.error
        # ``skipped`` covers EMPTY_SHELL/unrepairable/dry-run/output-exists; they
        # finish without writing a cleaned artifact but aren't job failures.
        if result.outcome in {"repaired", "healthy", "skipped"}:
            item.status = "done"
        else:
            item.status = "failed"

        job.processed += 1
        job.updated_at = utc_now_iso()
        _bump_summary(job.summary, damage, diagnosis.repairable)
        suffix = f" ({result.error})" if result.error else ""
        self._log(f"{dataset.id}: outcome={result.outcome} damage={damage}{suffix}")

        if result.outcome == "repaired":
            cleaned_id = f"cleaned/{_safe_dataset_id_path(dataset.id).as_posix()}"
            await asyncio.to_thread(
                record_diagnosis,
                dataset_path,
                damage_type=damage,
                repairable=diagnosis.repairable,
                job_id=job.job_id,
            )
            await asyncio.to_thread(
                mark_checked,
                dataset_path,
                damage_type=damage,
                job_id=job.job_id,
                cleaned_dataset_id=cleaned_id,
            )
        elif result.outcome == "healthy":
            await asyncio.to_thread(
                mark_checked,
                dataset_path,
                damage_type="healthy",
                repairable=diagnosis.repairable,
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
        self._log(f"job {job.job_id} {job.phase}: processed={job.processed}/{job.total}")
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


def _job_error_payload(job: RepairJobState) -> dict:
    return {"job": job.model_dump(), "error": job.error or "job failed"}


def _safe_dataset_id_path(dataset_id: str) -> PurePosixPath:
    path = PurePosixPath(dataset_id)
    if (
        not dataset_id
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ValueError(f"Invalid dataset id: {dataset_id!r}")
    return path


def _consume_task_exception(task: asyncio.Task) -> None:
    """Done callback that retrieves and discards any worker exception so
    asyncio doesn't log "Task exception was never retrieved".  The exception
    has already been published as an SSE ``job-error`` event by the worker.
    """
    if not task.cancelled():
        task.exception()
