"""Pydantic v2 models for the dataset-repair API surface."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .status import RepairTag

DamageTypeStr = Literal[
    "healthy",
    "empty_shell",
    "crash_no_save",
    "tmp_videos_stuck",
    "partial_tmp_videos_stuck",
    "parquet_no_video",
    "meta_stale",
    "frame_mismatch",
    "missing_cp",
]

JobPhase = Literal[
    "idle",
    "diagnosing",
    "repairing",
    "completed",
    "failed",
    "cancelling",
    "cancelled",
]

ItemStatus = Literal["queued", "diagnosing", "repairing", "done", "failed", "cancelled"]

JobKind = Literal["diagnose", "repair"]

TagFilter = Literal["dirty", "checked", "all"]


class DatasetRepairFilter(BaseModel):
    root: str | None = None
    date_from: str | None = None
    date_to: str | None = None
    task: str | None = None
    tag: TagFilter = "all"


class DamageSummary(BaseModel):
    healthy: int = 0
    empty_shell: int = 0
    crash_no_save: int = 0
    tmp_videos_stuck: int = 0
    partial_tmp_videos_stuck: int = 0
    parquet_no_video: int = 0
    meta_stale: int = 0
    frame_mismatch: int = 0
    missing_cp: int = 0
    unrepairable: int = 0
    total: int = 0


class DatasetRepairDataset(BaseModel):
    id: str
    name: str
    path: str
    created_date: str | None = None
    task: str | None = None
    tag: RepairTag
    last_damage_type: DamageTypeStr | None = None
    repairable: bool | None = None
    cleaned_dataset_id: str | None = None


class DatasetJobItem(BaseModel):
    dataset_id: str
    dataset_path: str
    status: ItemStatus
    damage_type: DamageTypeStr | None = None
    repairable: bool | None = None
    output_path: str | None = None
    error: str | None = None


class RepairJobState(BaseModel):
    job_id: str
    kind: JobKind
    phase: JobPhase
    total: int
    processed: int
    summary: DamageSummary = Field(default_factory=DamageSummary)
    items: list[DatasetJobItem] = Field(default_factory=list)
    started_at: str
    updated_at: str
    error: str | None = None


class DiagnoseRequest(BaseModel):
    dataset_ids: list[str] | None = None
    filters: DatasetRepairFilter | None = None
    force: bool = False
