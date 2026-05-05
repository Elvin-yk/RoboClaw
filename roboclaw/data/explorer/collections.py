"""Explorer payload builders for local dataset collection sessions."""

from __future__ import annotations

from math import ceil
from pathlib import Path
from typing import Any

from roboclaw.data.dataset_sessions import (
    get_dataset_summary,
    list_local_collection_dataset_items,
)

from .local import (
    build_explorer_summary_from_info,
    load_episodes_list_file,
    load_json_file,
    scan_dataset_siblings,
    summarize_files,
    summarize_modalities,
)


def build_collection_summary(handle: str) -> dict[str, Any]:
    summary = get_dataset_summary(handle)
    return build_explorer_summary_from_info(handle, _summary_info(summary))


def build_collection_details(handle: str) -> dict[str, Any]:
    summary = get_dataset_summary(handle)
    children = _collection_children(handle)
    file_counts = {
        "total_files": 0,
        "parquet_files": 0,
        "video_files": 0,
        "meta_files": 0,
        "other_files": 0,
    }
    feature_names: list[str] = []
    seen_features: set[str] = set()
    modalities: dict[str, dict[str, Any]] = {}

    for child in children:
        siblings = scan_dataset_siblings(child["path"])
        files = summarize_files(siblings)
        for key in file_counts:
            file_counts[key] += int(files.get(key, 0) or 0)

        info = load_json_file(child["path"] / "meta" / "info.json")
        for name in (info.get("features") or {}).keys():
            text = str(name)
            if text not in seen_features:
                seen_features.add(text)
                feature_names.append(text)

        for item in summarize_modalities(siblings, info.get("features") or {}):
            current = modalities.setdefault(
                str(item["id"]),
                {
                    "id": item["id"],
                    "label": item["label"],
                    "present": False,
                    "count": 0,
                },
            )
            if item.get("present"):
                current["present"] = True
                current["count"] = int(current["count"]) + 1

    return {
        **build_collection_summary(handle),
        "files": file_counts,
        "feature_names": feature_names,
        "feature_stats": [],
        "feature_type_distribution": [],
        "dataset_stats": {
            "row_count": int(summary.get("total_frames", 0) or 0) or None,
            "features_with_stats": 0,
            "vector_features": 0,
        },
        "modality_summary": [
            {
                "id": item["id"],
                "label": item["label"],
                "present": item["present"],
                "detail": f"{item['count']} datasets",
            }
            for item in modalities.values()
        ],
        "children": [
            {
                "id": child["id"],
                "label": child["label"],
                "path": str(child["path"]),
                "summary": child["summary"],
            }
            for child in children
        ],
    }


def build_collection_episode_page(
    handle: str,
    page: int,
    page_size: int,
) -> dict[str, Any]:
    children = _collection_children(handle)
    all_episodes: list[dict[str, Any]] = []
    for child_index, child in enumerate(children):
        episodes = load_episodes_list_file(child["path"])
        total = int(child["summary"].get("total_episodes", 0) or 0)
        lengths = list(child["summary"].get("episode_lengths") or [])
        for local_index in range(total):
            if local_index < len(episodes):
                raw = episodes[local_index]
                source_episode_index = int(raw.get("episode_index", local_index) or local_index)
                length = int(raw.get("length", 0) or 0)
            else:
                source_episode_index = local_index
                length = int(lengths[local_index]) if local_index < len(lengths) else 0
            all_episodes.append({
                "episode_index": len(all_episodes),
                "source_episode_index": source_episode_index,
                "source_dataset": child["id"],
                "source_label": child["label"],
                "source_path": str(child["path"]),
                "child_index": child_index,
                "length": length,
            })

    safe_page_size = max(1, int(page_size or 50))
    total_episodes = len(all_episodes)
    total_pages = max(1, ceil(total_episodes / safe_page_size)) if total_episodes > 0 else 1
    safe_page = min(max(int(page or 1), 1), total_pages)
    start = (safe_page - 1) * safe_page_size
    stop = min(start + safe_page_size, total_episodes)
    return {
        "dataset": handle,
        "page": safe_page,
        "page_size": safe_page_size,
        "total_episodes": total_episodes,
        "total_pages": total_pages,
        "episodes": all_episodes[start:stop],
    }


def resolve_collection_episode(handle: str, episode_index: int) -> tuple[str, Path, int]:
    page = build_collection_episode_page(handle, 1, max(episode_index + 1, 1))
    episodes = page["episodes"]
    if episode_index < 0 or episode_index >= len(episodes):
        raise IndexError(f"Episode {episode_index} is outside collection '{handle}'")
    episode = episodes[episode_index]
    return (
        str(episode["source_dataset"]),
        Path(str(episode["source_path"])),
        int(episode["source_episode_index"]),
    )


def _collection_children(handle: str) -> list[dict[str, Any]]:
    children: list[dict[str, Any]] = []
    for item in list_local_collection_dataset_items(handle):
        child_id = str(item["id"])
        child_path = Path(str(item["path"]))
        children.append({
            "id": child_id,
            "label": str(item.get("label") or child_id),
            "path": child_path,
            "summary": get_dataset_summary(child_id),
        })
    return children


def _summary_info(summary: dict[str, Any]) -> dict[str, Any]:
    return {
        "total_episodes": summary.get("total_episodes", 0),
        "total_frames": summary.get("total_frames", 0),
        "fps": summary.get("fps", 0),
        "robot_type": summary.get("robot_type", ""),
        "features": {name: {} for name in summary.get("features") or []},
        "episode_lengths": list(summary.get("episode_lengths") or []),
    }
