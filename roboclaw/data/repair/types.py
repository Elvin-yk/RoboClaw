from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

SKIP_FRAME_KEYS = {"timestamp", "frame_index", "episode_index", "index", "task_index"}


class DamageType(Enum):
    HEALTHY = "healthy"
    EMPTY_SHELL = "empty_shell"
    CRASH_NO_SAVE = "crash_no_save"
    TMP_VIDEOS_STUCK = "tmp_videos_stuck"
    PARTIAL_TMP_VIDEOS_STUCK = "partial_tmp_videos_stuck"
    PARQUET_NO_VIDEO = "parquet_no_video"
    META_STALE = "meta_stale"
    FRAME_MISMATCH = "frame_mismatch"
    MISSING_CP = "missing_cp"


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
    damage_type: DamageType
    repairable: bool
    details: dict[str, Any]


@dataclass(frozen=True)
class RepairResult:
    dataset_dir: Path
    damage_type: DamageType | None
    outcome: str
    error: str | None = None
