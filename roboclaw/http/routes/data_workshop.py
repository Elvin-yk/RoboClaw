from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from roboclaw.data.paths import datasets_root
from roboclaw.data.workshop.service import DataWorkshopService
from roboclaw.data.workshop.types import GateKey, GateStatus, WorkshopStage

_service = DataWorkshopService(root_resolver=lambda: datasets_root())


class RepairRequest(BaseModel):
    task: str = "repaired episode"
    vcodec: str = "h264"
    force: bool = False
    dry_run: bool = False


class GateUpdateRequest(BaseModel):
    status: GateStatus
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)
    groups: list[str] = Field(default_factory=list)
    batch: str = ""
    notes: str = ""


class PromoteRequest(BaseModel):
    target_stage: WorkshopStage = "clean"


class AssemblyCreateRequest(BaseModel):
    name: str
    dataset_ids: list[str]
    groups: dict[str, list[str]] = Field(default_factory=dict)


class UploadCreateRequest(BaseModel):
    target: str = "aliyun-oss"


def register_data_workshop_routes(app: FastAPI) -> None:
    @app.get("/api/data-workshop/datasets")
    def data_workshop_datasets() -> list[dict[str, Any]]:
        return _service.list_datasets()

    @app.get("/api/data-workshop/datasets/{dataset_id:path}")
    def data_workshop_dataset(dataset_id: str) -> dict[str, Any]:
        return _service.get_dataset(dataset_id)

    @app.post("/api/data-workshop/datasets/{dataset_id:path}/diagnose")
    def data_workshop_diagnose(dataset_id: str) -> dict[str, Any]:
        return _service.diagnose(dataset_id)

    @app.post("/api/data-workshop/datasets/{dataset_id:path}/repair")
    def data_workshop_repair(dataset_id: str, body: RepairRequest) -> dict[str, Any]:
        return _service.repair(
            dataset_id,
            task=body.task,
            vcodec=body.vcodec,
            force=body.force,
            dry_run=body.dry_run,
        )

    @app.post("/api/data-workshop/datasets/{dataset_id:path}/gates/{gate_key}")
    def data_workshop_gate_update(
        dataset_id: str,
        gate_key: GateKey,
        body: GateUpdateRequest,
    ) -> dict[str, Any]:
        return _service.update_gate(
            dataset_id,
            gate_key,
            status=body.status,
            message=body.message,
            details=body.details,
            groups=body.groups,
            batch=body.batch,
            notes=body.notes,
        )

    @app.post("/api/data-workshop/datasets/{dataset_id:path}/promote")
    def data_workshop_promote(dataset_id: str, body: PromoteRequest) -> dict[str, Any]:
        return _service.promote(dataset_id, body.target_stage)

    @app.get("/api/data-workshop/assemblies")
    def data_workshop_assemblies() -> list[dict[str, Any]]:
        return _service.list_assemblies()

    @app.post("/api/data-workshop/assemblies")
    def data_workshop_create_assembly(body: AssemblyCreateRequest) -> dict[str, Any]:
        if not body.dataset_ids:
            raise HTTPException(status_code=400, detail="dataset_ids must not be empty")
        return _service.create_assembly(
            name=body.name,
            dataset_ids=body.dataset_ids,
            groups=body.groups,
        )

    @app.get("/api/data-workshop/assemblies/{assembly_id}")
    def data_workshop_assembly(assembly_id: str) -> dict[str, Any]:
        try:
            return _service.get_assembly(assembly_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data-workshop/assemblies/{assembly_id}/upload")
    def data_workshop_upload(assembly_id: str, body: UploadCreateRequest) -> dict[str, Any]:
        try:
            return _service.create_upload_placeholder(assembly_id, body.target)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
