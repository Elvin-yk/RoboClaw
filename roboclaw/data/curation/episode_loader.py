from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

from huggingface_hub import hf_hub_download
from loguru import logger

from roboclaw.data.dataset_sessions import (
    is_session_handle,
    parse_session_handle,
    read_session_metadata,
)

from .bridge import read_parquet_rows
from .state import load_dataset_info
from .validation_core import safe_float

_load_info_json = load_dataset_info


def load_episode_data(
    dataset_path: Path,
    episode_index: int,
    *,
    include_videos: bool = True,
) -> dict[str, Any]:
    """Load episode parquet data, metadata, and optionally video paths from LeRobot directory."""
    info = _load_info_json(dataset_path)
    episodes_meta = _load_episode_meta(dataset_path, episode_index)
    chunk = _resolve_chunk(info, episode_index)
    parquet_relative_path = _resolve_data_relative_path(info, episodes_meta, episode_index)
    parquet_path = dataset_path / parquet_relative_path
    remote_cache_root = _remote_cache_root(dataset_path)
    if parquet_path.exists():
        rows = _read_episode_parquet_rows(parquet_path, episodes_meta, episode_index)
    else:
        remote_dataset_id = _resolve_remote_dataset_id(dataset_path, info)
        parquet_path = _download_remote_file(
            remote_dataset_id,
            parquet_relative_path,
            local_root=remote_cache_root,
        )
        rows = _read_episode_parquet_rows(parquet_path, episodes_meta, episode_index)

    video_dir = dataset_path / "videos" / f"chunk-{chunk}" / f"episode_{episode_index:06d}"
    video_files: list[Path] = []
    if include_videos:
        if video_dir.exists():
            video_files = _list_video_files(video_dir)
        else:
            remote_dataset_id = _resolve_remote_dataset_id(dataset_path, info)
            video_files = _download_remote_videos(
                remote_dataset_id,
                info,
                episodes_meta,
                episode_index,
                local_root=remote_cache_root,
            )

    return {
        "info": info,
        "episode_meta": episodes_meta,
        "rows": rows,
        "dataset_path": dataset_path,
        "parquet_path": parquet_path,
        "video_dir": video_dir,
        "video_files": video_files,
        "chunk": chunk,
    }


def _resolve_remote_dataset_id(dataset_path: Path, info: dict[str, Any]) -> str:
    session_name = dataset_path.name
    if is_session_handle(session_name):
        try:
            metadata = read_session_metadata(session_name)
            source_dataset = metadata.get("source_dataset")
            if isinstance(source_dataset, str) and source_dataset.strip():
                return source_dataset.strip()
        except Exception:
            logger.debug("Failed to resolve remote dataset id from session metadata", exc_info=True)

    source_dataset = info.get("source_dataset") or info.get("repo_id") or info.get("dataset_id")
    if isinstance(source_dataset, str) and source_dataset.strip():
        return source_dataset.strip()
    try:
        from roboclaw.data.curation.paths import datasets_root
        root = datasets_root().resolve()
        resolved = dataset_path.resolve()
        if str(resolved).startswith(str(root) + "/"):
            return resolved.relative_to(root).as_posix()
    except Exception:
        logger.debug("Failed to resolve remote dataset id", exc_info=True)
    return dataset_path.name


def _remote_cache_root(dataset_path: Path) -> Path | None:
    session_name = dataset_path.name
    parsed = parse_session_handle(session_name)
    if parsed is None:
        return dataset_path
    kind, _session_id = parsed
    if kind != "remote":
        return dataset_path
    return dataset_path / ".remote-cache"


def _load_episode_meta(dataset_path: Path, episode_index: int) -> dict[str, Any]:
    episodes_path = dataset_path / "meta" / "episodes.jsonl"
    if not episodes_path.exists():
        return _load_episode_meta_from_parquet(dataset_path, episode_index)
    for line in episodes_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get("episode_index") == episode_index:
            return entry
    return _load_episode_meta_from_parquet(dataset_path, episode_index)


def _load_episode_meta_from_parquet(dataset_path: Path, episode_index: int) -> dict[str, Any]:
    episodes_root = dataset_path / "meta" / "episodes"
    if not episodes_root.exists():
        return {}
    for parquet_path in sorted(episodes_root.rglob("*.parquet")):
        for entry in _read_parquet_rows(parquet_path, filters=[("episode_index", "=", episode_index)]):
            if _safe_int(entry.get("episode_index")) == episode_index:
                return entry
    return {}


def _filter_episode_rows(
    rows: list[dict[str, Any]],
    episode_meta: dict[str, Any],
    episode_index: int,
) -> list[dict[str, Any]]:
    if not rows:
        return rows

    start_index = _safe_int(episode_meta.get("dataset_from_index"))
    end_index = _safe_int(episode_meta.get("dataset_to_index"))
    if start_index is not None and end_index is not None and end_index >= start_index:
        sliced = [
            row
            for row in rows
            if (row_index := _safe_int(row.get("index"))) is not None
            and start_index <= row_index < end_index
        ]
        if sliced:
            return sliced

    filtered = [
        row
        for row in rows
        if _safe_int(row.get("episode_index")) == episode_index
    ]
    if filtered:
        return filtered
    return rows


def _resolve_chunk(info: dict[str, Any], episode_index: int) -> str:
    chunks_size = info.get("chunks_size", 1000)
    if chunks_size <= 0:
        chunks_size = 1000
    return f"{episode_index // chunks_size:03d}"


def _safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _extract_timestamps(rows: list[dict[str, Any]]) -> list[float]:
    raw = [
        safe_float(
            row["timestamp"] if "timestamp" in row else row.get("timestamp_utc"),
        )
        for row in rows
    ]
    return [value for value in raw if value is not None]


def _render_repo_path(template: str | None, **values: Any) -> str | None:
    if not isinstance(template, str) or not template.strip():
        return None
    try:
        return template.format(**values)
    except (IndexError, KeyError, ValueError):
        return None


def _resolve_data_relative_path(
    info: dict[str, Any],
    episode_meta: dict[str, Any],
    episode_index: int,
) -> Path:
    chunk_index = _safe_int(episode_meta.get("data/chunk_index"))
    if chunk_index is None:
        chunk_index = _safe_int(episode_meta.get("data_chunk_index"))
    if chunk_index is None:
        chunk_index = episode_index // max(int(info.get("chunks_size", 1000) or 1000), 1)

    file_index = _safe_int(episode_meta.get("data/file_index"))
    if file_index is None:
        file_index = _safe_int(episode_meta.get("data_file_index"))

    rendered = _render_repo_path(
        info.get("data_path"),
        chunk_index=chunk_index,
        file_index=file_index if file_index is not None else 0,
        episode_index=episode_index,
        episode_chunk=chunk_index,
    )
    if rendered:
        return Path(rendered)

    return Path("data") / f"chunk-{chunk_index:03d}" / f"episode_{episode_index:06d}.parquet"


def resolve_video_relative_paths(
    info: dict[str, Any],
    episode_meta: dict[str, Any],
    episode_index: int,
) -> list[Path]:
    template = info.get("video_path")
    if not isinstance(template, str) or not template:
        return []

    paths: list[Path] = []
    for video_key in _extract_video_keys(info):
        relative_path = _resolve_video_relative_path(
            template,
            video_key,
            info,
            episode_meta,
            episode_index,
        )
        if relative_path is not None:
            paths.append(relative_path)
    return paths


def _resolve_video_relative_path(
    template: str,
    video_key: str,
    info: dict[str, Any],
    episode_meta: dict[str, Any],
    episode_index: int,
) -> Path | None:
    prefix = f"videos/{video_key}/"
    chunk_index = _safe_int(episode_meta.get(f"{prefix}chunk_index"))
    if chunk_index is None:
        chunk_index = _safe_int(episode_meta.get("video_chunk_index"))
    if chunk_index is None:
        chunk_index = episode_index // max(int(info.get("chunks_size", 1000) or 1000), 1)

    file_index = _safe_int(episode_meta.get(f"{prefix}file_index"))
    if file_index is None:
        file_index = _safe_int(episode_meta.get("video_file_index"))

    rendered = _render_repo_path(
        template,
        video_key=video_key,
        chunk_index=chunk_index,
        file_index=file_index if file_index is not None else 0,
        episode_index=episode_index,
        episode_chunk=chunk_index,
    )
    return Path(rendered) if rendered else None


def _read_parquet_rows(
    path: Path,
    *,
    filters: Any | None = None,
    columns: list[str] | None = None,
) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return read_parquet_rows(path, filters=filters, columns=columns)


def _read_episode_parquet_rows(
    path: Path,
    episode_meta: dict[str, Any],
    episode_index: int,
) -> list[dict[str, Any]]:
    if not path.exists():
        return []

    filter_candidates: list[list[tuple[str, str, int]]] = []
    start_index = _safe_int(episode_meta.get("dataset_from_index"))
    end_index = _safe_int(episode_meta.get("dataset_to_index"))
    if start_index is not None and end_index is not None and end_index >= start_index:
        filter_candidates.append([
            ("index", ">=", start_index),
            ("index", "<", end_index),
        ])
    filter_candidates.append([("episode_index", "=", episode_index)])

    for filters in filter_candidates:
        try:
            rows = read_parquet_rows(path, filters=filters)
        except Exception:
            logger.debug("Filtered parquet read failed for {}", path, exc_info=True)
            continue
        filtered = _filter_episode_rows(rows, episode_meta, episode_index)
        if filtered:
            return filtered

    return _filter_episode_rows(_read_parquet_rows(path), episode_meta, episode_index)


def _download_remote_file(
    dataset_id: str,
    relative_path: Path,
    *,
    local_root: Path | None = None,
) -> Path:
    kwargs: dict[str, Any] = {
        "repo_id": dataset_id,
        "filename": relative_path.as_posix(),
        "repo_type": "dataset",
    }
    if local_root is not None:
        kwargs["local_dir"] = str(local_root)
    cached_path = hf_hub_download(**kwargs)
    return Path(cached_path)


def _extract_video_keys(info: dict[str, Any]) -> list[str]:
    features = info.get("features", {})
    keys: list[str] = []
    for name, config in features.items():
        if not isinstance(config, dict):
            continue
        if config.get("dtype") == "video":
            keys.append(str(name))
    return keys


def _download_remote_videos(
    dataset_id: str,
    info: dict[str, Any],
    episode_meta: dict[str, Any],
    episode_index: int,
    *,
    local_root: Path | None = None,
) -> list[Path]:
    template = info.get("video_path")
    if not isinstance(template, str) or not template:
        return []

    video_keys = _extract_video_keys(info)
    results: list[Path] = []
    for video_key in video_keys:
        try:
            relative_path = _resolve_video_relative_path(
                template,
                video_key,
                info,
                episode_meta,
                episode_index,
            )
            if relative_path is None:
                continue
            results.append(
                _download_remote_file(
                    dataset_id,
                    relative_path,
                    local_root=local_root,
                ),
            )
        except Exception:
            logger.warning("Failed to download video %s", video_key, exc_info=True)
            continue
    return results


def _list_video_files(video_dir: Path) -> list[Path]:
    if not video_dir.exists():
        return []
    return sorted(video_dir.glob("*.mp4"))
