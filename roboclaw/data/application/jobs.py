from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Awaitable, Callable, AsyncIterator
from typing import Any
from uuid import uuid4

from roboclaw.data.domain.models import DataJob, DataJobEvent
from roboclaw.data.infrastructure.state_store import utc_now_iso

from .serialization import json_ready

JobRunner = Callable[["DataJobHandle"], Awaitable[dict[str, Any] | None]]
TERMINAL_PHASES = {"completed", "failed", "cancelled"}


class DataJobHandle:
    def __init__(self, coordinator: "DataJobCoordinator", job_id: str) -> None:
        self._coordinator = coordinator
        self.job_id = job_id

    @property
    def cancelled(self) -> bool:
        job = self._coordinator.require(self.job_id)
        return job.phase in {"cancelling", "cancelled"}

    async def set_total(self, total: int) -> None:
        self._coordinator.update(self.job_id, total=max(0, int(total)))

    async def update(self, *, processed: int | None = None, message: str = "") -> None:
        self._coordinator.update(self.job_id, processed=processed, message=message)

    async def item(self, item: dict[str, Any]) -> None:
        self._coordinator.add_item(self.job_id, item)


class DataJobCoordinator:
    def __init__(self) -> None:
        self._jobs: dict[str, DataJob] = {}
        self._threads: dict[str, threading.Thread] = {}
        self._active_targets: dict[tuple[str, str], str] = {}
        self._listeners: dict[str, list[tuple[asyncio.Queue[DataJobEvent], asyncio.AbstractEventLoop]]] = {}
        self._lock = threading.Lock()

    def start(
        self,
        *,
        kind: str,
        target_type: str,
        target_id: str,
        total: int,
        message: str,
        runner: JobRunner,
    ) -> DataJob:
        target_key = (target_type, target_id)
        with self._lock:
            active_job_id = self._active_targets.get(target_key)
            if active_job_id:
                active = self._jobs.get(active_job_id)
                if active and active.phase not in TERMINAL_PHASES:
                    raise ValueError(
                        f"{target_type} '{target_id}' already has running data job '{active_job_id}'"
                    )
            now = utc_now_iso()
            job = DataJob(
                job_id=uuid4().hex[:12],
                kind=kind,
                target_type=target_type,  # type: ignore[arg-type]
                target_id=target_id,
                phase="queued",
                total=max(0, int(total)),
                processed=0,
                message=message,
                started_at=now,
                updated_at=now,
            )
            self._jobs[job.job_id] = job
            self._active_targets[target_key] = job.job_id

        thread = threading.Thread(
            target=lambda: asyncio.run(self._run(job.job_id, runner)),
            name=f"data-job-{job.job_id}",
            daemon=True,
        )
        with self._lock:
            self._threads[job.job_id] = thread
        thread.start()
        self._emit(job.job_id, "snapshot", self.snapshot(job.job_id))
        return self.snapshot(job.job_id)

    def require(self, job_id: str) -> DataJob:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise KeyError(job_id)
            return job

    def snapshot(self, job_id: str) -> DataJob:
        job = self.require(job_id)
        return DataJob(**job.to_dict())

    def update(
        self,
        job_id: str,
        *,
        phase: str | None = None,
        processed: int | None = None,
        total: int | None = None,
        message: str | None = None,
        error: str | None = None,
        result: dict[str, Any] | None = None,
    ) -> DataJob:
        with self._lock:
            job = self._jobs[job_id]
            if phase is not None:
                job.phase = phase  # type: ignore[assignment]
            if processed is not None:
                job.processed = max(0, int(processed))
            if total is not None:
                job.total = max(0, int(total))
            if message is not None:
                job.message = message
            if error is not None:
                job.error = error
            if result is not None:
                job.result = json_ready(result)
            job.updated_at = utc_now_iso()
            snapshot = DataJob(**job.to_dict())
        self._emit(job_id, "snapshot", snapshot.to_dict())
        return snapshot

    def add_item(self, job_id: str, item: dict[str, Any]) -> None:
        payload = json_ready(item)
        with self._lock:
            job = self._jobs[job_id]
            job.items.append(payload)
            job.updated_at = utc_now_iso()
        self._emit(job_id, "item", payload)

    def cancel(self, job_id: str) -> DataJob:
        return self.update(job_id, phase="cancelling", message="Cancelling")

    async def events(self, job_id: str) -> AsyncIterator[DataJobEvent]:
        queue: asyncio.Queue[DataJobEvent] = asyncio.Queue()
        loop = asyncio.get_running_loop()
        with self._lock:
            if job_id not in self._jobs:
                raise KeyError(job_id)
            self._listeners.setdefault(job_id, []).append((queue, loop))
        snapshot = self.snapshot(job_id)
        yield DataJobEvent("snapshot", snapshot.to_dict())
        if snapshot.phase in TERMINAL_PHASES:
            event_type = "complete" if snapshot.phase == "completed" else "cancel" if snapshot.phase == "cancelled" else "error"
            yield DataJobEvent(event_type, snapshot.to_dict())
            with self._lock:
                listeners = self._listeners.get(job_id, [])
                self._listeners[job_id] = [item for item in listeners if item[0] is not queue]
            return
        try:
            while True:
                event = await queue.get()
                yield event
                if event.type in {"complete", "error", "cancel"}:
                    break
        finally:
            with self._lock:
                listeners = self._listeners.get(job_id, [])
                self._listeners[job_id] = [item for item in listeners if item[0] is not queue]

    async def _run(self, job_id: str, runner: JobRunner) -> None:
        handle = DataJobHandle(self, job_id)
        self.update(job_id, phase="running", message=self.require(job_id).message)
        try:
            result = await runner(handle)
        except asyncio.CancelledError:
            self.update(job_id, phase="cancelled", message="Cancelled")
            self._finish(job_id, "cancel")
            return
        except Exception as exc:
            self.update(job_id, phase="failed", error=str(exc), message=str(exc))
            self._finish(job_id, "error")
            return

        phase = self.require(job_id).phase
        if phase == "cancelling":
            self.update(job_id, phase="cancelled", message="Cancelled")
            self._finish(job_id, "cancel")
            return
        self.update(job_id, phase="completed", processed=self.require(job_id).total, message="Completed", result=result or {})
        self._finish(job_id, "complete")

    def _finish(self, job_id: str, event_type: str) -> None:
        job = self.snapshot(job_id)
        with self._lock:
            self._active_targets.pop((job.target_type, job.target_id), None)
            self._threads.pop(job_id, None)
        self._emit(job_id, event_type, job.to_dict())

    def _emit(self, job_id: str, event_type: str, data: dict[str, Any]) -> None:
        event = DataJobEvent(type=event_type, data=json_ready(data))
        with self._lock:
            listeners = list(self._listeners.get(job_id, []))
        for queue, loop in listeners:
            if loop.is_closed():
                continue
            loop.call_soon_threadsafe(queue.put_nowait, event)


def format_sse(event: DataJobEvent) -> str:
    return f"event: {event.type}\ndata: {json.dumps(event.data, ensure_ascii=False)}\n\n"
