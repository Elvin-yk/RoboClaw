"""Materialize critical-phase intervals into a new LeRobot dataset.

Generic, task-agnostic. Callers provide a fully-built list of
``CriticalInterval`` objects; the extractor just feeds them to the GPU
encoder backend. ``load_dataset_fps`` and ``resolve_single_data_parquet``
are also generic source-dataset metadata helpers.
"""
from __future__ import annotations

from pathlib import Path

from roboclaw.data.curation.state import load_dataset_info

from .interval import CriticalInterval


def load_dataset_fps(dataset_root: Path) -> float:
    info = load_dataset_info(dataset_root)
    if not info:
        raise FileNotFoundError(
            f"meta/info.json not found or empty under {dataset_root}"
        )
    fps = info.get("fps")
    if not isinstance(fps, (int, float)) or isinstance(fps, bool):
        raise ValueError(f"meta/info.json missing numeric 'fps' (got {fps!r})")
    fps_value = float(fps)
    if fps_value <= 0:
        raise ValueError(f"invalid fps {fps_value!r} in {dataset_root}")
    return fps_value


def resolve_single_data_parquet(dataset_root: Path) -> Path:
    """Stage-1 limitation: source dataset must be a single-chunk parquet."""
    candidate = dataset_root / "data" / "chunk-000" / "file-000.parquet"
    if not candidate.is_file():
        raise FileNotFoundError(
            f"expected single-file parquet at {candidate}; multi-chunk "
            f"datasets are not supported in stage 1"
        )
    return candidate


def extract_event_windows_dataset(
    source_root: Path,
    output_root: Path,
    intervals: list[CriticalInterval],
    source_repo_id: str,
    output_repo_id: str,
    task: str,
    vcodec: str,
) -> Path:
    from .encoder import extract_critical_phase_dataset_direct

    result = extract_critical_phase_dataset_direct(
        source_repo_id=source_repo_id,
        source_root=source_root,
        output_repo_id=output_repo_id,
        output_root=output_root,
        intervals=[iv.as_lerobot_tuple() for iv in intervals],
        task=task,
        vcodec=vcodec,
    )
    if result is None:
        raise RuntimeError(
            "extract_critical_phase_dataset_direct returned None; "
            "output dataset was not created"
        )
    return Path(result)
