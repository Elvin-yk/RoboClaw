from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

WorkshopStage = Literal["dirty", "clean", "complete", "excluded"]
GateStatus = Literal["pending", "running", "passed", "failed", "manual_required", "skipped"]
AssemblyStatus = Literal["draft", "upload_queued"]
UploadStatus = Literal["queued"]
GateKey = Literal[
    "repair_diagnosis",
    "auto_prune",
    "repair",
    "manual_boundary_review",
    "quality_validation",
    "organize",
    "assembly",
    "upload",
]

GATE_KEYS: tuple[GateKey, ...] = (
    "repair_diagnosis",
    "auto_prune",
    "repair",
    "manual_boundary_review",
    "quality_validation",
    "organize",
    "assembly",
    "upload",
)

DIRTY_REQUIRED_GATES: tuple[GateKey, ...] = (
    "repair_diagnosis",
    "manual_boundary_review",
    "quality_validation",
)


@dataclass
class ProcessingGate:
    key: GateKey
    status: GateStatus = "pending"
    required: bool = False
    label: str = ""
    message: str = ""
    updated_at: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "status": self.status,
            "required": self.required,
            "label": self.label or self.key,
            "message": self.message,
            "updated_at": self.updated_at,
            "details": self.details,
            "history": self.history,
        }

    @classmethod
    def from_dict(cls, key: GateKey, payload: dict[str, Any] | None) -> "ProcessingGate":
        payload = payload or {}
        return cls(
            key=key,
            status=_coerce_gate_status(payload.get("status")),
            required=bool(payload.get("required", key in DIRTY_REQUIRED_GATES)),
            label=str(payload.get("label") or _gate_label(key)),
            message=str(payload.get("message") or ""),
            updated_at=str(payload.get("updated_at") or ""),
            details=dict(payload.get("details") or {}),
            history=list(payload.get("history") or []),
        )


@dataclass
class WorkshopDataset:
    id: str
    name: str
    label: str
    path: str
    real_path: str
    is_symlink: bool
    stage: WorkshopStage
    stats: dict[str, Any]
    gates: dict[GateKey, ProcessingGate]
    diagnosis: dict[str, Any] | None = None
    structure: dict[str, Any] = field(default_factory=dict)
    groups: list[str] = field(default_factory=list)
    batch: str = ""
    notes: str = ""
    assembly_ids: list[str] = field(default_factory=list)
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "label": self.label,
            "path": self.path,
            "real_path": self.real_path,
            "is_symlink": self.is_symlink,
            "stage": self.stage,
            "stats": self.stats,
            "gates": {key: gate.to_dict() for key, gate in self.gates.items()},
            "diagnosis": self.diagnosis,
            "structure": self.structure,
            "groups": self.groups,
            "batch": self.batch,
            "notes": self.notes,
            "assembly_ids": self.assembly_ids,
            "updated_at": self.updated_at,
        }


@dataclass
class UploadTask:
    id: str
    status: UploadStatus
    target: str
    created_at: str
    updated_at: str
    message: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "target": self.target,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "message": self.message,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any] | None) -> "UploadTask | None":
        if not payload:
            return None
        return cls(
            id=str(payload.get("id") or ""),
            status=_coerce_upload_status(payload.get("status")),
            target=str(payload.get("target") or ""),
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
            message=str(payload.get("message") or ""),
        )


@dataclass
class DatasetAssembly:
    id: str
    name: str
    status: AssemblyStatus
    dataset_ids: list[str]
    groups: dict[str, list[str]]
    created_at: str
    updated_at: str
    quality_summary: dict[str, Any]
    upload_task: UploadTask | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "dataset_ids": self.dataset_ids,
            "groups": self.groups,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "quality_summary": self.quality_summary,
            "upload_task": self.upload_task.to_dict() if self.upload_task else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DatasetAssembly":
        return cls(
            id=str(payload["id"]),
            name=str(payload.get("name") or payload["id"]),
            status=_coerce_assembly_status(payload.get("status")),
            dataset_ids=[str(item) for item in payload.get("dataset_ids") or []],
            groups={
                str(key): [str(item) for item in value]
                for key, value in (payload.get("groups") or {}).items()
            },
            created_at=str(payload.get("created_at") or ""),
            updated_at=str(payload.get("updated_at") or ""),
            quality_summary=dict(payload.get("quality_summary") or {}),
            upload_task=UploadTask.from_dict(payload.get("upload_task")),
        )


def _gate_label(key: GateKey) -> str:
    return {
        "repair_diagnosis": "修复诊断",
        "auto_prune": "算法剔除",
        "repair": "算法修复",
        "manual_boundary_review": "人工检查",
        "quality_validation": "质量验证",
        "organize": "数据整理",
        "assembly": "完整数据包",
        "upload": "上传",
    }[key]


def _coerce_gate_status(value: Any) -> GateStatus:
    allowed = {"pending", "running", "passed", "failed", "manual_required", "skipped"}
    return value if value in allowed else "pending"


def _coerce_assembly_status(value: Any) -> AssemblyStatus:
    return value if value in {"draft", "upload_queued"} else "draft"


def _coerce_upload_status(value: Any) -> UploadStatus:
    return value if value == "queued" else "queued"
