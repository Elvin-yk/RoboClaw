"""Dataset source resolution for the trajectory viewer.

Thin wrapper around `roboclaw.data.explorer.dual_source` so the trajectory-viz
routes share the same local/path/session semantics as the explorer.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import HTTPException

from roboclaw.data.explorer.dual_source import (
    normalize_explorer_source,
    resolve_local_dataset_path,
    resolve_path_dataset,
)


TrajectorySource = Literal["local", "path"]


def resolve_episode_dataset(
    *, source: str | None, dataset: str | None, path: str | None
) -> tuple[TrajectorySource, str, Path]:
    """Resolve a (source, dataset_label, dataset_path) for episode loading.

    `source="remote"` is intentionally rejected: remote datasets must first be
    materialized as a local session via the explorer flow.
    """
    normalized = normalize_explorer_source(source)
    if normalized == "remote":
        raise HTTPException(
            status_code=400,
            detail="Trajectory viewer requires source 'local' or 'path'; prepare a session first.",
        )
    if normalized == "local":
        if not dataset:
            raise HTTPException(status_code=422, detail="Missing 'dataset' for source=local")
        return "local", dataset, resolve_local_dataset_path(dataset)
    if not path:
        raise HTTPException(status_code=422, detail="Missing 'path' for source=path")
    return "path", path, resolve_path_dataset(path)
