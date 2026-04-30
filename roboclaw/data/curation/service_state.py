from __future__ import annotations

from pathlib import Path
from typing import Any

from .serializers import coerce_int
from .state import (
    load_quality_results,
    load_workflow_state,
    save_workflow_state,
    load_dataset_info,
)

_load_info = load_dataset_info


def set_stage_status(
    dataset_path: Path,
    stage_key: str,
    status: str,
) -> dict[str, Any]:
    state = load_workflow_state(dataset_path)
    state["stages"][stage_key]["status"] = status
    save_workflow_state(dataset_path, state)
    return state


def set_prototype_stage_context(
    dataset_path: Path,
    *,
    quality_filter_mode: str,
    selected_episode_indices: list[int],
    summary: dict[str, Any] | None = None,
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["prototype_discovery"]
    stage["quality_filter_mode"] = quality_filter_mode
    stage["selected_episode_indices"] = list(selected_episode_indices)
    if summary is not None:
        stage["summary"] = summary
    save_workflow_state(dataset_path, state)


def update_prototype_running_summary(
    dataset_path: Path,
    summary_update: dict[str, Any],
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["prototype_discovery"]
    summary = stage.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    summary.update(summary_update)
    stage["summary"] = summary
    save_workflow_state(dataset_path, state)


def update_annotation_running_summary(
    dataset_path: Path,
    summary_update: dict[str, Any],
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["annotation"]
    summary = stage.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    summary.update(summary_update)
    stage["summary"] = summary
    save_workflow_state(dataset_path, state)


def update_quality_running_summary(
    dataset_path: Path,
    summary_update: dict[str, Any],
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["quality_validation"]
    summary = stage.get("summary")
    if not isinstance(summary, dict):
        summary = quality_summary_from_results(dataset_path, state)
    summary.update(summary_update)
    stage["summary"] = summary
    save_workflow_state(dataset_path, state)


def update_stage_summary(
    dataset_path: Path,
    stage_key: str,
    summary: dict[str, Any],
    *,
    status: str = "completed",
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"][stage_key]
    stage["status"] = status
    stage["summary"] = summary
    save_workflow_state(dataset_path, state)


def configure_quality_stage(
    dataset_path: Path,
    *,
    status: str,
    selected_validators: list[str],
    active_run_id: str | None = None,
) -> None:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["quality_validation"]
    stage["status"] = status
    stage["selected_validators"] = list(selected_validators)
    stage["active_run_id"] = active_run_id
    stage["pause_requested"] = False
    if status == "running":
        stage["summary"] = None
    save_workflow_state(dataset_path, state)


def quality_run_is_current(dataset_path: Path, run_id: str | None) -> bool:
    if run_id is None:
        return True
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["quality_validation"]
    return stage.get("active_run_id") == run_id


def quality_summary_from_results(
    dataset_path: Path,
    state: dict[str, Any],
) -> dict[str, Any]:
    results = load_quality_results(dataset_path) or {}
    episodes = results.get("episodes", [])
    if not isinstance(episodes, list):
        episodes = []

    total = coerce_int(results.get("total"))
    if total is None:
        existing_summary = state["stages"]["quality_validation"].get("summary")
        if isinstance(existing_summary, dict):
            total = coerce_int(existing_summary.get("total"))
    if total is None:
        total = coerce_int(_load_info(dataset_path).get("total_episodes")) or len(episodes)

    passed = coerce_int(results.get("passed"))
    if passed is None:
        passed = sum(1 for episode in episodes if episode.get("passed"))

    failed = coerce_int(results.get("failed"))
    if failed is None:
        failed = max(len(episodes) - passed, 0)

    overall_score = results.get("overall_score", 0.0)
    completed = len(episodes)
    return {
        "total": total,
        "completed": completed,
        "remaining": max(total - completed, 0),
        "passed": passed,
        "failed": failed,
        "overall_score": overall_score,
        "progress_percent": round((completed / max(total, 1)) * 100, 1),
        "quality_parquet_path": None,
    }


def mark_quality_stage_paused(
    dataset_path: Path,
    *,
    pause_requested: bool,
) -> dict[str, Any]:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["quality_validation"]
    stage["status"] = "paused"
    stage["summary"] = quality_summary_from_results(dataset_path, state)
    stage["pause_requested"] = pause_requested
    stage["active_run_id"] = None
    save_workflow_state(dataset_path, state)
    return state


def finish_quality_stage(
    dataset_path: Path,
    *,
    status: str,
    summary: dict[str, Any],
    run_id: str | None,
) -> bool:
    state = load_workflow_state(dataset_path)
    stage = state["stages"]["quality_validation"]
    if run_id is not None and stage.get("active_run_id") != run_id:
        return False
    stage["status"] = status
    stage["summary"] = summary
    stage["pause_requested"] = False
    stage["active_run_id"] = None
    save_workflow_state(dataset_path, state)
    return True
