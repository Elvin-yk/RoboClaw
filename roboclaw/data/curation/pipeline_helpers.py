from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from loguru import logger

from . import propagation_history
from .features import resolve_timestamp
from .propagation import propagate_annotation_spans
from .serializers import coerce_int
from .state import (
    load_annotations,
    load_propagation_results,
    load_prototype_results,
    load_quality_results,
    load_workflow_state,
    save_annotations,
    save_propagation_results,
    save_prototype_results,
    save_workflow_state,
)
from .trajectory_entries import (
    build_propagation_entry,
    build_prototype_entry,
    propagation_dtw_config,
)
from .validators import load_episode_data


def load_episode_duration(dataset_path: Path, episode_index: int) -> float:
    from . import service as curation_service

    data = curation_service.load_episode_data(dataset_path, episode_index, include_videos=False)
    rows = data["rows"]
    if len(rows) < 2:
        return 0.0
    timestamps = [resolve_timestamp(row) for row in rows]
    valid = [timestamp for timestamp in timestamps if timestamp is not None]
    if len(valid) < 2:
        return 0.0
    return max(valid[-1] - valid[0], 0.0)


def collect_passed_episodes(dataset_path: Path) -> list[int]:
    quality = load_quality_results(dataset_path)
    if quality is None:
        return []
    return [
        ep["episode_index"]
        for ep in quality.get("episodes", [])
        if ep.get("passed")
    ]


def build_canonical_entries(
    dataset_path: Path,
    episode_indices: list[int],
    progress_callback: Callable[[dict[str, Any]], None] | None,
) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    total = len(episode_indices)
    for position, ep_idx in enumerate(episode_indices):
        logger.info("Building canonical trajectory for episode {}/{}", position + 1, total)
        from . import service as curation_service

        data = curation_service.load_episode_data(dataset_path, ep_idx, include_videos=False)
        rows = data["rows"]
        if not rows:
            continue
        entry = build_prototype_entry(
            dataset_path,
            ep_idx,
            quality=_episode_quality_summary(dataset_path, ep_idx),
            data=data,
        )
        if not entry.get("sequence"):
            continue
        entries.append(entry)

        if progress_callback is not None:
            progress_callback({
                "phase": "building_canonical",
                "completed": position + 1,
                "total": total,
                "progress_percent": round(((position + 1) / max(total, 1)) * 100, 1),
            })

    return entries


def _episode_quality_summary(dataset_path: Path, episode_index: int) -> dict[str, Any]:
    quality = load_quality_results(dataset_path)
    if quality is None:
        return {}
    for ep in quality.get("episodes", []):
        if ep.get("episode_index") == episode_index:
            return {"score": ep.get("score", 0), "passed": ep.get("passed", False)}
    return {}


def finish_prototype_empty(dataset_path: Path) -> dict[str, Any]:
    results: dict[str, Any] = {
        "clustering": {},
        "refinement": {},
        "candidate_count": 0,
        "entry_count": 0,
        "cluster_count": 0,
    }
    save_prototype_results(dataset_path, results)
    from . import service as curation_service

    curation_service._update_stage_summary(
        dataset_path,
        "prototype_discovery",
        {"candidate_count": 0, "entry_count": 0, "cluster_count": 0},
    )
    logger.warning("Prototype discovery: no passed episodes found")
    return results


# ---------------------------------------------------------------------------
# Propagation helpers
# ---------------------------------------------------------------------------


def propagate_single_target(
    dataset_path: Path,
    target: dict[str, Any],
    spans: list[dict[str, Any]],
    source_duration: float,
    source_entry: dict[str, Any],
    source_annotations: dict[str, Any],
    source_episode_index: int,
) -> tuple[dict[str, Any], bool]:
    target_idx = target["episode_index"]
    target_duration = load_episode_duration(dataset_path, target_idx)
    target_entry = build_propagation_entry(dataset_path, target_idx)
    target_spans = propagate_annotation_spans(
        spans,
        source_duration=source_duration,
        target_duration=target_duration,
        target_record_key=str(target_idx),
        prototype_score=target.get("prototype_score", 0.0),
        source_sequence=source_entry.get("sequence"),
        target_sequence=target_entry.get("sequence"),
        source_time_axis=source_entry.get("time_axis"),
        target_time_axis=target_entry.get("time_axis"),
        dtw_config=propagation_dtw_config(source_entry, target_entry),
    )
    result = {
        "episode_index": target_idx,
        "spans": target_spans,
        "prototype_score": target.get("prototype_score", 0.0),
        "alignment_method": "dtw" if any(span.get("source") == "dtw_propagated" for span in target_spans) else "scale",
    }
    existing = load_annotations(dataset_path, target_idx) or {}
    existing_annotations = existing.get("annotations", []) or []
    has_manual = any(
        isinstance(span, dict) and span.get("source") == "user"
        for span in existing_annotations
    )
    if has_manual:
        return result, False
    save_annotations(
        dataset_path,
        target_idx,
        {
            "episode_index": target_idx,
            "task_context": {
                **(source_annotations.get("task_context", {}) or {}),
                "source_episode_index": source_episode_index,
                "source": "propagation",
            },
            "annotations": target_spans,
        },
    )
    return result, True


def finish_propagation_empty(
    dataset_path: Path,
    source_episode_index: int,
) -> dict[str, Any]:
    previous_results = load_propagation_results(dataset_path)
    state = load_workflow_state(dataset_path)
    annotation_stage = state["stages"]["annotation"]
    propagated_source_episodes = propagation_history.collect_propagated_source_episodes(
        annotation_stage,
        previous_results,
        source_episode_index,
    )
    results: dict[str, Any] = {
        "source_episode_index": source_episode_index,
        "source_episode_indices": propagated_source_episodes,
        "target_count": 0,
        "propagated": [],
    }
    save_propagation_results(dataset_path, results)
    annotation_stage["propagated_source_episodes"] = propagated_source_episodes
    save_workflow_state(dataset_path, state)
    from . import service as curation_service

    curation_service._update_stage_summary(
        dataset_path,
        "annotation",
        {
            "source_episode_index": source_episode_index,
            "propagated_source_episodes": propagated_source_episodes,
            "target_count": 0,
            "completed": 0,
            "total": 0,
            "phase": "semantic_propagation",
            "progress_percent": 100,
        },
    )
    logger.warning("Semantic propagation: no annotations found for episode {}", source_episode_index)
    return results
