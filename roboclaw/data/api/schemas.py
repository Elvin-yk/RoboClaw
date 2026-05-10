from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ImportRequest(BaseModel):
    dataset_id: str
    include_videos: bool = True
    force: bool = False


class QcRunRequest(BaseModel):
    dataset_ids: list[str]
    chain_id: str = "default"
    task: str = ""
    vcodec: str = "libx264"
    force: bool = True


class ManualReviewSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    dataset_id: str
    chain_id: str = "default"


class ManualReviewDecisionRequest(BaseModel):
    decision: str
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)


class GateUpdateRequest(BaseModel):
    status: str
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)


class PackageCreateRequest(BaseModel):
    package_id: str
    dataset_ids: list[str]
    groups: dict[str, list[str]] = Field(default_factory=dict)
    force: bool = False


class PackageUploadRequest(BaseModel):
    repo_id: str
    token: str = ""
    private: bool = False


class EvaluationRunRequest(BaseModel):
    package_id: str
    selected_validators: list[str]
    episode_indices: list[int] | None = None
    threshold_overrides: dict[str, float] | None = None


class AnnotationSaveRequest(BaseModel):
    package_id: str
    episode_index: int
    task_context: dict[str, Any] = Field(default_factory=dict)
    annotations: list[dict[str, Any]] = Field(default_factory=list)


class PrototypeRunRequest(BaseModel):
    package_id: str
    cluster_count: int | None = None
    candidate_limit: int = Field(default=200, ge=1)
    episode_indices: list[int] | None = None
    quality_filter_mode: str = "passed"


class PropagationRunRequest(BaseModel):
    package_id: str
    source_episode_index: int
