from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

SKIP_FRAME_KEYS = {"timestamp", "frame_index", "episode_index", "index", "task_index"}


class IntegrityStatus(Enum):
    HEALTHY = "healthy"
    EMPTY_SHELL = "empty_shell"
    STRUCTURE_INCOMPLETE = "structure_incomplete"


class DamageKind(Enum):
    NONE = "none"
    EMPTY_SHELL = "empty_shell"
    MISSING_DATA_ROWS = "missing_data_rows"
    MISSING_METADATA = "missing_metadata"
    ORPHAN_DATA_EPISODES = "orphan_data_episodes"
    STALE_INFO_TOTALS = "stale_info_totals"
    MISSING_VIDEO_FILES = "missing_video_files"
    RECOVERABLE_TMP_VIDEOS = "recoverable_tmp_videos"
    TMP_VIDEO_RESIDUE = "tmp_video_residue"
    UNKNOWN_DAMAGE = "unknown_damage"


class RepairStrategy(Enum):
    NONE = "none"
    FORMALIZE_DATA_EPISODES = "formalize_data_episodes"


@dataclass(frozen=True)
class TmpVideo:
    """One stuck mp4 in a top-level ``tmp*/`` dir.

    Two naming patterns ship from lerobot:

    - Streaming encoder writes ``<video_key>_streaming.mp4`` per episode
      (``video_utils.py``); ``episode_index`` is unknown from the filename.
    - Batch encoder writes ``<video_key>_<NNN>.mp4`` (``dataset_writer.py``);
      ``episode_index`` parses directly from the trailing ``NNN``.
    """

    video_key: str
    path: Path
    episode_index: int | None


@dataclass(frozen=True)
class DiagnosisResult:
    dataset_dir: Path
    integrity_status: IntegrityStatus
    damage_kind: DamageKind
    repair_strategy: RepairStrategy
    repairable: bool
    details: dict[str, Any]


@dataclass(frozen=True)
class RepairResult:
    dataset_dir: Path
    damage_kind: DamageKind | None
    repair_strategy: RepairStrategy | None
    status: str
    error: str | None = None
