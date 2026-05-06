"""Concatenate already-trimmed LeRobot v3 datasets into one.

Thin wrapper over :func:`lerobot.datasets.aggregate.aggregate_datasets`, which
already handles index renumbering, video timestamps, stats merging, and
ffmpeg stream-copy. We add a single-task invariant check tailored to the
screw critical-phase trim CLI's outputs.
"""
from __future__ import annotations

from pathlib import Path

from lerobot.datasets.aggregate import aggregate_datasets
from lerobot.datasets.dataset_metadata import LeRobotDatasetMetadata


def concat_lerobot_datasets(
    sources: list[Path],
    dst: Path,
    *,
    task: str,
) -> Path:
    """Concat ``sources`` into a single LeRobot v3 dataset at ``dst``.

    Each source must contain exactly one task and that task must equal
    ``task``. ``dst`` must not exist.
    """
    if not sources:
        raise ValueError("at least one source dataset is required")
    missing = [s for s in sources if not s.exists()]
    if missing:
        raise FileNotFoundError(f"source dataset not found: {missing[0]}")
    if dst.exists():
        raise FileExistsError(f"destination already exists: {dst}")

    for src in sources:
        _validate_single_task(src, expected=task)

    aggregate_datasets(
        repo_ids=[f"local/concat_src_{i}" for i in range(len(sources))],
        aggr_repo_id="local/concat_dst",
        roots=list(sources),
        aggr_root=dst,
    )
    return dst


def _validate_single_task(src: Path, *, expected: str) -> None:
    meta = LeRobotDatasetMetadata(repo_id=f"local/_concat_check_{src.name}", root=src)
    tasks = list(meta.tasks.index)
    if len(tasks) != 1:
        raise ValueError(
            f"source {src} has {len(tasks)} tasks {tasks}; concat requires single-task sources"
        )
    if tasks[0] != expected:
        raise ValueError(
            f"source {src} task {tasks[0]!r} != expected {expected!r}"
        )
