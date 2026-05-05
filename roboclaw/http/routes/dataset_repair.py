"""Dataset-repair HTTP routes.

Thin translation layer over :class:`DatasetRepairCoordinator`.  All business
logic lives in ``roboclaw.data.repair``.
"""

from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import StreamingResponse

from roboclaw.data.repair.schemas import (
    DatasetRepairFilter,
    DiagnoseRequest,
    RepairJobState,
)
from roboclaw.data.repair.service import (
    DatasetRepairCoordinator,
    JobConflictError,
)


def register_dataset_repair_routes(
    app: FastAPI,
    service: DatasetRepairCoordinator,
) -> None:

    @app.get("/api/dataset-repair/datasets")
    async def list_datasets(
        root: str | None = None,
        date_from: str | None = None,
        date_to: str | None = None,
        task: str | None = None,
        tag: str = Query(default="all", pattern="^(dirty|checked|all)$"),
    ) -> dict:
        filters = DatasetRepairFilter(
            root=root,
            date_from=date_from,
            date_to=date_to,
            task=task,
            tag=tag,  # type: ignore[arg-type]
        )
        try:
            datasets = await service.list_datasets(filters)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        effective_root = filters.root or str(service.datasets_root)
        return {
            "root": effective_root,
            "datasets": [item.model_dump() for item in datasets],
        }

    @app.post("/api/dataset-repair/diagnose")
    async def diagnose(req: DiagnoseRequest) -> RepairJobState:
        try:
            return await service.start_diagnosis(req)
        except JobConflictError as exc:
            raise HTTPException(status_code=409, detail=exc.current.model_dump()) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/dataset-repair/repair")
    async def repair(req: DiagnoseRequest) -> RepairJobState:
        try:
            return await service.start_repair(req)
        except JobConflictError as exc:
            raise HTTPException(status_code=409, detail=exc.current.model_dump()) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/dataset-repair/jobs/current")
    async def current_job() -> dict:
        job = await service.get_current_job()
        return {"job": job.model_dump() if job is not None else None}

    @app.get("/api/dataset-repair/jobs/{job_id}")
    async def job_snapshot(job_id: str) -> RepairJobState:
        job = await service.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")
        return job

    @app.get("/api/dataset-repair/jobs/{job_id}/events")
    async def job_events(job_id: str) -> StreamingResponse:
        job = await service.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found")

        async def event_stream():
            async for event in service.stream_events(job_id):
                payload = json.dumps(event["data"])
                yield f"event: {event['type']}\ndata: {payload}\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    @app.post("/api/dataset-repair/jobs/{job_id}/cancel")
    async def cancel(job_id: str) -> RepairJobState:
        try:
            return await service.cancel(job_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
