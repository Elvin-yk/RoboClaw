from __future__ import annotations

from pathlib import Path
from typing import Any

from roboclaw.data.paths import datasets_root

PACKAGE_DATA_PATH = "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
PACKAGE_VIDEO_PATH = "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"

__all__ = [
    "PACKAGE_DATA_PATH",
    "PACKAGE_VIDEO_PATH",
    "datasets_root",
    "video_path_from_indices",
]


def video_path_from_indices(
    dataset_dir: Path,
    info: dict[str, Any],
    video_key: str,
    chunk_index: int,
    file_index: int,
) -> Path:
    template = str(info.get("video_path") or PACKAGE_VIDEO_PATH)
    return dataset_dir / template.format(
        video_key=video_key,
        chunk_index=chunk_index,
        file_index=file_index,
    )
