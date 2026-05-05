from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from roboclaw.data.local_discovery import iter_data_files

from .serializers import coerce_int


def _is_remote_session_dataset(dataset_path: Path) -> bool:
    from roboclaw.data import dataset_sessions

    parsed = dataset_sessions.parse_session_handle(dataset_path.name)
    if parsed is not None:
        return parsed[0] == "remote"

    resolved = dataset_path.resolve()
    remote_root = (dataset_sessions._session_root() / "remote").resolve()
    try:
        relative = resolved.relative_to(remote_root)
    except ValueError:
        return False
    return len(relative.parts) == 2 and relative.parts[1] == "dataset"


def _safe_rmtree(path: Path, root: Path) -> None:
    if not path.exists():
        return
    resolved = path.resolve()
    resolved_root = root.resolve()
    if resolved == resolved_root or not str(resolved).startswith(str(resolved_root) + "/"):
        return
    shutil.rmtree(resolved)


def _safe_unlink(path: Path, root: Path) -> bool:
    if not path.exists() or not path.is_file():
        return False
    resolved = path.resolve()
    resolved_root = root.resolve()
    if not str(resolved).startswith(str(resolved_root) + "/"):
        return False
    resolved.unlink()
    return True


def _prune_empty_parents(path: Path, stop_at: Path) -> None:
    current = path.parent
    resolved_stop = stop_at.resolve()
    while current.exists() and current.resolve() != resolved_stop:
        try:
            current.rmdir()
        except OSError:
            return
        current = current.parent


def _remote_cache_download_root(dataset_path: Path) -> Path:
    return dataset_path / ".cache" / "huggingface" / "download"


def cleanup_remote_quality_cache(dataset_path: Path) -> dict[str, Any]:
    if not _is_remote_session_dataset(dataset_path):
        return {"removed_paths": [], "removed_count": 0}

    removed_paths: list[str] = []
    for path in (dataset_path / "videos", dataset_path / ".remote-cache", _remote_cache_download_root(dataset_path)):
        if not path.exists():
            continue
        _safe_rmtree(path, dataset_path)
        removed_paths.append(str(path))
    return {"removed_paths": removed_paths, "removed_count": len(removed_paths)}


def _video_file_references(
    dataset_path: Path,
    info: dict[str, Any],
    episode_meta: dict[str, Any],
    episode_index: int,
) -> list[Path]:
    template = info.get("video_path")
    features = info.get("features", {})
    if not isinstance(template, str) or not isinstance(features, dict):
        return []

    video_paths: list[Path] = []
    chunk_size = int(info.get("chunks_size", 1000) or 1000)
    for video_key, config in features.items():
        if not isinstance(config, dict) or config.get("dtype") != "video":
            continue
        prefix = f"videos/{video_key}/"
        chunk_index = coerce_int(episode_meta.get(f"{prefix}chunk_index"))
        if chunk_index is None:
            chunk_index = coerce_int(episode_meta.get("video_chunk_index"))
        if chunk_index is None:
            chunk_index = episode_index // max(chunk_size, 1)

        file_index = coerce_int(episode_meta.get(f"{prefix}file_index"))
        if file_index is None:
            file_index = coerce_int(episode_meta.get("video_file_index"))
        rendered = template.format(
            video_key=video_key,
            chunk_index=chunk_index,
            file_index=file_index if file_index is not None else 0,
            episode_index=episode_index,
            episode_chunk=chunk_index,
        )
        video_paths.append(dataset_path / rendered)
    return video_paths


def _load_episode_meta_map(dataset_path: Path) -> dict[int, dict[str, Any]]:
    episodes_path = dataset_path / "meta" / "episodes.jsonl"
    if episodes_path.is_file():
        rows: dict[int, dict[str, Any]] = {}
        for line in episodes_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            payload = json.loads(line)
            index = coerce_int(payload.get("episode_index"))
            if index is not None:
                rows[index] = payload
        return rows

    episodes_root = dataset_path / "meta" / "episodes"
    if not episodes_root.exists():
        return {}
    rows = {}
    from .bridge import read_parquet_rows

    for parquet_path in iter_data_files(episodes_root, "*.parquet"):
        for payload in read_parquet_rows(parquet_path):
            index = coerce_int(payload.get("episode_index"))
            if index is not None:
                rows[index] = payload
    return rows


def cleanup_completed_remote_episode_assets(
    dataset_path: Path,
    info: dict[str, Any],
    completed_episode_index: int,
    remaining_episode_indices: set[int],
) -> dict[str, Any]:
    if not _is_remote_session_dataset(dataset_path):
        return {"removed_paths": [], "removed_count": 0}

    episode_meta_map = _load_episode_meta_map(dataset_path)
    completed_meta = episode_meta_map.get(completed_episode_index, {})
    candidate_paths = set(
        _video_file_references(dataset_path, info, completed_meta, completed_episode_index)
    )
    if not candidate_paths:
        return {"removed_paths": [], "removed_count": 0}

    future_paths: set[Path] = set()
    for episode_index in remaining_episode_indices:
        future_paths.update(
            _video_file_references(
                dataset_path,
                info,
                episode_meta_map.get(episode_index, {}),
                episode_index,
            )
        )

    removed_paths: list[str] = []
    for path in sorted(candidate_paths - future_paths):
        if _safe_unlink(path, dataset_path):
            removed_paths.append(str(path))
            _prune_empty_parents(path, dataset_path / "videos")
    return {"removed_paths": removed_paths, "removed_count": len(removed_paths)}


def cleanup_existing_remote_quality_assets(
    dataset_path: Path,
    info: dict[str, Any],
    completed_episode_indices: set[int],
    remaining_episode_indices: set[int],
) -> dict[str, Any]:
    if not _is_remote_session_dataset(dataset_path):
        return {"removed_paths": [], "removed_count": 0}

    episode_meta_map = _load_episode_meta_map(dataset_path)
    future_paths: set[Path] = set()
    for episode_index in remaining_episode_indices:
        future_paths.update(
            _video_file_references(
                dataset_path,
                info,
                episode_meta_map.get(episode_index, {}),
                episode_index,
            )
        )

    candidate_paths: set[Path] = set()
    for episode_index in completed_episode_indices:
        candidate_paths.update(
            _video_file_references(
                dataset_path,
                info,
                episode_meta_map.get(episode_index, {}),
                episode_index,
            )
        )

    removed_paths: list[str] = []
    for path in sorted(candidate_paths - future_paths):
        if _safe_unlink(path, dataset_path):
            removed_paths.append(str(path))
            _prune_empty_parents(path, dataset_path / "videos")
    return {"removed_paths": removed_paths, "removed_count": len(removed_paths)}
