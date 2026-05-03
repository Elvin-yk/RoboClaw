"""Value objects for the human-review domain.

All objects are frozen dataclasses; ``to_dict`` is the single canonical
JSON-serialisation entry point used by both the marks-store sidecar and
the FastAPI route layer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ReviewMark:
    episode_index: int
    abnormal: bool
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "episode_index": self.episode_index,
            "abnormal": self.abnormal,
            "updated_at": self.updated_at,
        }


@dataclass(frozen=True)
class ReviewSummary:
    total_episodes: int
    reviewed: int
    abnormal: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "total_episodes": self.total_episodes,
            "reviewed": self.reviewed,
            "abnormal": self.abnormal,
        }


@dataclass(frozen=True)
class ReviewState:
    dataset_id: str
    version: int
    updated_at: str
    marks: dict[int, ReviewMark] = field(default_factory=dict)
    commits: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset_id": self.dataset_id,
            "version": self.version,
            "updated_at": self.updated_at,
            "marks": {
                str(idx): mark.to_dict() for idx, mark in sorted(self.marks.items())
            },
            "commits": list(self.commits),
        }


@dataclass(frozen=True)
class ReviewDatasetSummary:
    id: str
    label: str
    path: str
    total_episodes: int
    fps: float
    reviewed: int
    abnormal: int
    is_critical_phase: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "path": self.path,
            "total_episodes": self.total_episodes,
            "fps": self.fps,
            "reviewed": self.reviewed,
            "abnormal": self.abnormal,
            "is_critical_phase": self.is_critical_phase,
        }


@dataclass(frozen=True)
class CommitDeletionRequest:
    dataset_id: str
    output_dataset_id: str
    task: str
    source_repo_id: str = "local/review_src"
    output_repo_id: str = "local/review_out"
    vcodec: str = "h264"
    dry_run: bool = False


@dataclass(frozen=True)
class CommitDeletionResult:
    source_dataset: str
    output_dataset: str
    output_path: str | None
    kept_episode_indices: list[int]
    deleted_episode_indices: list[int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_dataset": self.source_dataset,
            "output_dataset": self.output_dataset,
            "output_path": self.output_path,
            "kept_episode_indices": list(self.kept_episode_indices),
            "deleted_episode_indices": list(self.deleted_episode_indices),
        }
