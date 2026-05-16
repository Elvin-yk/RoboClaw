from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

DatasetStage = Literal["raw", "inspecting", "cleaning", "needs_review", "clean", "excluded"]
DatasetPackageStage = Literal[
    "assembling",
    "assembled",
    "validating",
    "validated",
    "annotating",
    "annotated",
    "upload_queued",
    "uploaded",
    "failed",
]
GateStatus = Literal["pending", "running", "passed", "failed", "needs_review", "skipped"]
DatasetGateKey = Literal["inspect", "diagnose", "clean", "review"]
DatasetPackageGateKey = Literal["assemble", "validate", "annotate", "upload"]
DataJobPhase = Literal[
    "queued",
    "running",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
]


DATASET_GATE_KEYS: tuple[DatasetGateKey, ...] = ("inspect", "diagnose", "clean", "review")
PACKAGE_GATE_KEYS: tuple[DatasetPackageGateKey, ...] = ("assemble", "validate", "annotate", "upload")


@dataclass
class Gate:
    key: str
    status: GateStatus = "pending"
    required: bool = True
    message: str = ""
    updated_at: str = ""
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "status": self.status,
            "required": self.required,
            "message": self.message,
            "updated_at": self.updated_at,
            "details": self.details,
        }


@dataclass(frozen=True)
class DatasetStats:
    total_episodes: int = 0
    total_frames: int = 0
    fps: int = 0
    robot_type: str = ""
    features: tuple[str, ...] = ()
    episode_lengths: tuple[int, ...] = ()
    task_description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_episodes": self.total_episodes,
            "total_frames": self.total_frames,
            "fps": self.fps,
            "robot_type": self.robot_type,
            "features": list(self.features),
            "episode_lengths": list(self.episode_lengths),
            "task_description": self.task_description,
        }


@dataclass
class Dataset:
    id: str
    name: str
    label: str
    path: Path
    real_path: Path
    source: Literal["local", "remote", "path"] = "local"
    stage: DatasetStage = "raw"
    stats: DatasetStats = field(default_factory=DatasetStats)
    gates: dict[str, Gate] = field(default_factory=dict)
    qc: dict[str, Any] = field(default_factory=dict)
    active_output: dict[str, Any] = field(default_factory=dict)
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "label": self.label,
            "path": str(self.path),
            "real_path": str(self.real_path),
            "source": self.source,
            "lifecycle_stage": self.stage,
            "stats": self.stats.to_dict(),
            "gates": {key: gate.to_dict() for key, gate in self.gates.items()},
            "qc": self.qc,
            "active_output": self.active_output,
            "updated_at": self.updated_at,
        }


@dataclass
class DatasetPackage:
    id: str
    name: str
    label: str
    path: Path
    real_path: Path
    dataset_ids: list[str]
    groups: dict[str, list[str]]
    stage: DatasetPackageStage = "assembled"
    stats: DatasetStats = field(default_factory=DatasetStats)
    gates: dict[str, Gate] = field(default_factory=dict)
    evaluation_summary: dict[str, Any] = field(default_factory=dict)
    market_listing: dict[str, Any] = field(default_factory=dict)
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "label": self.label,
            "path": str(self.path),
            "real_path": str(self.real_path),
            "dataset_ids": self.dataset_ids,
            "groups": self.groups,
            "lifecycle_stage": self.stage,
            "stats": self.stats.to_dict(),
            "gates": {key: gate.to_dict() for key, gate in self.gates.items()},
            "evaluation_summary": self.evaluation_summary,
            "market_listing": self.market_listing,
            "updated_at": self.updated_at,
        }


@dataclass
class DataJobEvent:
    type: str
    data: dict[str, Any]


@dataclass
class DataJob:
    job_id: str
    kind: str
    target_type: Literal["dataset", "package", "global"]
    target_id: str
    phase: DataJobPhase
    total: int
    processed: int
    message: str
    started_at: str
    updated_at: str
    error: str | None = None
    result: dict[str, Any] | None = None
    items: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "kind": self.kind,
            "target_type": self.target_type,
            "target_id": self.target_id,
            "phase": self.phase,
            "total": self.total,
            "processed": self.processed,
            "message": self.message,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "error": self.error,
            "result": self.result,
            "items": self.items,
        }
