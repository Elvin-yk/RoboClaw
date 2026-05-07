"""Dataset explorer payload builders for local and remote LeRobot datasets."""

from __future__ import annotations

import json
from collections import Counter
from math import ceil
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq

# ---------------------------------------------------------------------------
# Feature shape / component extraction
# ---------------------------------------------------------------------------


def flatten_feature_component_names(raw_names: Any) -> list[str]:
    if isinstance(raw_names, list):
        result: list[str] = []
        for item in raw_names:
            result.extend(flatten_feature_component_names(item))
        return result
    if raw_names is None:
        return []
    text = str(raw_names).strip()
    return [text] if text else []


def extract_feature_shape(feature_config: Any) -> list[Any]:
    if not isinstance(feature_config, dict):
        return []
    shape = feature_config.get("shape")
    if isinstance(shape, list):
        return shape
    nested = feature_config.get("feature")
    if nested is not None:
        return extract_feature_shape(nested)
    return []


def extract_feature_component_names(feature_config: Any) -> list[str]:
    if not isinstance(feature_config, dict):
        return []
    names = flatten_feature_component_names(feature_config.get("names"))
    if names:
        return names
    nested = feature_config.get("feature")
    if nested is not None:
        return extract_feature_component_names(nested)
    return []


# ---------------------------------------------------------------------------
# Statistics helpers
# ---------------------------------------------------------------------------


def collect_stat_preview(value: Any, *, limit: int = 4) -> tuple[list[Any], bool]:
    preview: list[Any] = []
    truncated = False

    def visit(node: Any) -> None:
        nonlocal truncated
        if truncated:
            return
        if isinstance(node, list):
            for item in node:
                visit(item)
                if truncated:
                    break
            return
        if len(preview) >= limit:
            truncated = True
            return
        preview.append(node)

    visit(value)
    return preview, truncated


def extract_stat_count(value: Any) -> int | float | None:
    preview, _ = collect_stat_preview(value, limit=1)
    if not preview:
        return None
    scalar = preview[0]
    if isinstance(scalar, bool):
        return int(scalar)
    if isinstance(scalar, (int, float)):
        return scalar
    return None


# ---------------------------------------------------------------------------
# Feature statistics
# ---------------------------------------------------------------------------


def build_feature_summary(features: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]]]:
    feature_names = list(features.keys())
    counter: Counter[str] = Counter()
    for config in features.values():
        counter[str(config.get("dtype", "unknown"))] += 1
    distribution = [{"name": name, "value": count} for name, count in counter.items()]
    return feature_names, distribution


def build_feature_stats(
    features: dict[str, Any],
    stats: dict[str, Any],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for name, feature_config in features.items():
        stat_entry = stats.get(name, {}) if isinstance(stats.get(name), dict) else {}
        stat_preview: dict[str, dict[str, Any]] = {}
        for key in ("min", "max", "mean", "std"):
            values, truncated = collect_stat_preview(stat_entry.get(key))
            if values:
                stat_preview[key] = {"values": values, "truncated": truncated}
        result.append({
            "name": name,
            "dtype": str(feature_config.get("dtype", "unknown")),
            "shape": extract_feature_shape(feature_config),
            "component_names": extract_feature_component_names(feature_config),
            "has_dataset_stats": bool(stat_entry),
            "count": extract_stat_count(stat_entry.get("count")),
            "stats_preview": stat_preview,
        })
    return result


def summarize_dataset_stats(feature_stats: list[dict[str, Any]]) -> dict[str, Any]:
    counts = [
        int(item["count"])
        for item in feature_stats
        if isinstance(item.get("count"), (int, float))
    ]
    features_with_stats = sum(1 for item in feature_stats if item.get("has_dataset_stats"))
    vector_features = sum(1 for item in feature_stats if len(item.get("shape", [])) > 0)
    return {
        "row_count": max(counts) if counts else None,
        "features_with_stats": features_with_stats,
        "vector_features": vector_features,
    }


# ---------------------------------------------------------------------------
# File inventory & modality detection
# ---------------------------------------------------------------------------


def summarize_files(siblings: list[dict[str, Any]]) -> dict[str, Any]:
    filenames = [item.get("rfilename", "") for item in siblings if item.get("rfilename")]
    meta_files = sum(1 for name in filenames if name.startswith("meta/"))
    non_meta = [name for name in filenames if not name.startswith("meta/")]
    parquet_files = sum(1 for name in non_meta if name.endswith(".parquet"))
    video_files = sum(1 for name in non_meta if name.endswith(".mp4"))
    other_files = len(non_meta) - parquet_files - video_files
    return {
        "total_files": len(filenames),
        "parquet_files": parquet_files,
        "video_files": video_files,
        "meta_files": meta_files,
        "other_files": other_files,
    }


def summarize_modalities(
    siblings: list[dict[str, Any]],
    features: dict[str, Any],
) -> list[dict[str, Any]]:
    filenames = [item.get("rfilename", "") for item in siblings if item.get("rfilename")]
    feature_names_lower = [name.lower() for name in features]

    def has_feature_token(*tokens: str) -> bool:
        return any(any(tok in name for tok in tokens) for name in feature_names_lower)

    return [
        {
            "id": "video",
            "label": "Video",
            "present": any(name.endswith(".mp4") for name in filenames),
            "detail": f"{sum(1 for name in filenames if name.endswith('.mp4'))} mp4 files",
        },
        {
            "id": "depth",
            "label": "Depth",
            "present": any("depth" in name.lower() for name in filenames) or has_feature_token("depth"),
            "detail": "Depth files or depth feature columns detected",
        },
        {
            "id": "action",
            "label": "Action",
            "present": has_feature_token("action"),
            "detail": "Action trajectories available",
        },
        {
            "id": "state",
            "label": "State",
            "present": has_feature_token("observation.state", "state"),
            "detail": "Robot state trajectories available",
        },
        {
            "id": "images",
            "label": "Images",
            "present": has_feature_token("observation.images", "images"),
            "detail": "Image streams available",
        },
    ]


def scan_dataset_siblings(dataset_path: Path) -> list[dict[str, str]]:
    """Walk dataset directory and produce HF-compatible siblings list."""
    siblings: list[dict[str, str]] = []
    for file_path in sorted(dataset_path.rglob("*")):
        if not file_path.is_file():
            continue
        relative_path = file_path.relative_to(dataset_path)
        parts = relative_path.parts
        if any(part.startswith(".workflow") for part in parts):
            continue
        if file_path.name.startswith("."):
            continue
        siblings.append({"rfilename": relative_path.as_posix()})
    return siblings


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def load_episodes_list_file(dataset_path: Path) -> list[dict[str, Any]]:
    episodes_path = dataset_path / "meta" / "episodes.jsonl"
    if not episodes_path.exists():
        return []
    result: list[dict[str, Any]] = []
    for line in episodes_path.read_text(encoding="utf-8").strip().splitlines():
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        result.append(entry)
    return result


def build_explorer_payload_from_artifacts(
    *,
    dataset_name: str,
    info: dict[str, Any],
    stats: dict[str, Any],
    siblings: list[dict[str, Any]],
    episodes_meta: list[dict[str, Any]],
    dataset_path: Path | None = None,
) -> dict[str, Any]:
    """Build the explorer payload from already-loaded artifacts."""
    overview = build_explorer_overview_from_artifacts(
        dataset_name=dataset_name,
        info=info,
        stats=stats,
        siblings=siblings,
        episodes_meta=episodes_meta,
        dataset_path=dataset_path,
    )
    overview["episodes"] = build_explorer_episode_page_from_artifacts(
        dataset_name=dataset_name,
        info=info,
        episodes_meta=episodes_meta,
        page=1,
        page_size=max(int(info.get("total_episodes", 0) or 0), 1),
        dataset_path=dataset_path,
    )["episodes"]
    return overview


def build_explorer_summary_from_info(
    dataset_name: str,
    info: dict[str, Any],
    episodes_meta: list[dict[str, Any]] | None = None,
    dataset_path: Path | None = None,
) -> dict[str, Any]:
    features = info.get("features", {})
    feature_names = list(features.keys()) if isinstance(features, dict) else []
    return {
        "dataset": dataset_name,
        "summary": {
            "total_episodes": int(info.get("total_episodes", 0) or 0),
            "total_frames": int(info.get("total_frames", 0) or 0),
            "fps": int(info.get("fps", 0) or 0),
            "robot_type": str(info.get("robot_type", "")),
            "codebase_version": str(info.get("codebase_version", "")),
            "chunks_size": int(info.get("chunks_size", 1000) or 1000),
            "features": feature_names,
            "episode_lengths": resolve_episode_lengths(info, episodes_meta or [], dataset_path),
            "camera_resolutions": extract_camera_resolutions(features),
        },
    }


def resolve_episode_lengths(
    info: dict[str, Any],
    episodes_meta: list[dict[str, Any]] | None = None,
    dataset_path: Path | None = None,
) -> list[int]:
    explicit = normalize_positive_ints(info.get("episode_lengths", []))
    if explicit:
        return explicit

    meta_lengths = normalize_positive_ints([
        entry.get("length", 0)
        for entry in episodes_meta or []
    ])
    if meta_lengths:
        return meta_lengths

    total_episodes = int(info.get("total_episodes", 0) or 0)
    total_frames = int(info.get("total_frames", 0) or 0)
    parquet_lengths = infer_episode_lengths_from_data(dataset_path, total_episodes)
    if parquet_lengths:
        return parquet_lengths

    if total_episodes == 1 and total_frames > 0:
        return [total_frames]
    return []


def infer_episode_lengths_from_data(dataset_path: Path | None, total_episodes: int) -> list[int]:
    if dataset_path is None:
        return []
    data_root = dataset_path / "data"
    if not data_root.exists():
        return []

    counts: Counter[int] = Counter()
    for parquet_path in sorted(data_root.rglob("*.parquet")):
        parquet_file = pq.ParquetFile(parquet_path)
        if "episode_index" not in parquet_file.schema_arrow.names:
            continue
        table = parquet_file.read(columns=["episode_index"])
        for value in table.column("episode_index").to_pylist():
            if isinstance(value, (int, float)):
                counts[int(value)] += 1

    if not counts:
        return []
    if total_episodes > 0:
        lengths = [counts.get(index, 0) for index in range(total_episodes)]
        return lengths if any(length > 0 for length in lengths) else []
    return [counts[index] for index in sorted(counts)]


def normalize_positive_ints(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    result: list[int] = []
    for item in value:
        if isinstance(item, (int, float)) and int(item) > 0:
            result.append(int(item))
    return result


def extract_camera_resolutions(features: Any) -> list[dict[str, Any]]:
    if not isinstance(features, dict):
        return []
    result: list[dict[str, Any]] = []
    for name, feature_config in features.items():
        if not str(name).startswith("observation.images"):
            continue
        shape = [value for value in extract_feature_shape(feature_config) if isinstance(value, (int, float))]
        if len(shape) < 2:
            continue
        if len(shape) >= 3 and shape[0] <= 4 and shape[1] > 4 and shape[2] > 4:
            height = int(shape[1])
            width = int(shape[2])
        else:
            height = int(shape[0])
            width = int(shape[1])
        result.append({"name": str(name), "width": width, "height": height})
    return result


def build_explorer_overview_from_artifacts(
    *,
    dataset_name: str,
    info: dict[str, Any],
    stats: dict[str, Any],
    siblings: list[dict[str, Any]],
    episodes_meta: list[dict[str, Any]] | None = None,
    dataset_path: Path | None = None,
) -> dict[str, Any]:
    """Build explorer metadata without embedding the full episode list."""
    features = info.get("features", {})
    feature_names, feature_type_distribution = build_feature_summary(features)
    feature_stats = build_feature_stats(features, stats)
    dataset_stats = summarize_dataset_stats(feature_stats)
    files = summarize_files(siblings)
    modality_summary = summarize_modalities(siblings, features)

    return {
        **build_explorer_summary_from_info(dataset_name, info, episodes_meta, dataset_path),
        "files": files,
        "feature_names": feature_names,
        "feature_stats": feature_stats,
        "feature_type_distribution": feature_type_distribution,
        "dataset_stats": dataset_stats,
        "modality_summary": modality_summary,
    }


def build_explorer_episode_page_from_artifacts(
    *,
    dataset_name: str,
    info: dict[str, Any],
    episodes_meta: list[dict[str, Any]],
    page: int,
    page_size: int,
    dataset_path: Path | None = None,
) -> dict[str, Any]:
    total_episodes = int(info.get("total_episodes", 0) or 0)
    safe_page_size = max(1, int(page_size or 50))
    total_pages = max(1, ceil(total_episodes / safe_page_size)) if total_episodes > 0 else 1
    safe_page = min(max(int(page or 1), 1), total_pages)
    start = (safe_page - 1) * safe_page_size
    stop = min(start + safe_page_size, total_episodes)
    episode_lengths = resolve_episode_lengths(info, episodes_meta, dataset_path)

    page_items: list[dict[str, Any]] = []
    for index in range(start, stop):
        if index < len(episodes_meta):
            entry = episodes_meta[index]
            length = int(entry.get("length", 0) or 0)
            page_items.append({
                "episode_index": int(entry.get("episode_index", index) or index),
                "length": length if length > 0 else (
                    int(episode_lengths[index]) if index < len(episode_lengths) else 0
                ),
            })
        else:
            page_items.append({
                "episode_index": index,
                "length": int(episode_lengths[index]) if index < len(episode_lengths) else 0,
            })

    return {
        "dataset": dataset_name,
        "page": safe_page,
        "page_size": safe_page_size,
        "total_episodes": total_episodes,
        "total_pages": total_pages,
        "episodes": page_items,
    }


def build_explorer_payload(dataset_path: Path, dataset_name: str) -> dict[str, Any]:
    """Build the complete explorer dashboard payload for a local dataset."""
    return build_explorer_payload_from_artifacts(
        dataset_name=dataset_name,
        info=load_json_file(dataset_path / "meta" / "info.json"),
        stats=load_json_file(dataset_path / "meta" / "stats.json"),
        siblings=scan_dataset_siblings(dataset_path),
        episodes_meta=load_episodes_list_file(dataset_path),
        dataset_path=dataset_path,
    )
