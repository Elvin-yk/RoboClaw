from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .ee_validator import validate_ee_trajectory
from .episode_loader import (
    _download_remote_file,
    _extract_timestamps,
    _remote_cache_root,
    _resolve_remote_dataset_id,
    load_episode_data,
    resolve_video_relative_paths,
)
from .metadata_validator import validate_metadata
from .state import load_dataset_info
from .timing_validator import validate_timing
from .validation_core import (
    QUALITY_THRESHOLD_DEFAULTS,
    VALIDATOR_CATEGORY_WEIGHTS,
    finalize_validator,
    make_issue,
    merge_threshold_overrides as _merge_threshold_overrides,
    safe_float,
    weighted_issue_score,
    weighted_validator_score,
)
from .visual_validators import validate_depth_assets, validate_visual_assets


def validate_action(
    data: dict[str, Any],
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    from .action_validator import validate_action as _validate_action

    return _validate_action(data, threshold_overrides)


def validate_trajectory_dtw(
    data: dict[str, Any],
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    operator_name = "trajectory_dtw"
    issue = make_issue(
        operator_name=operator_name,
        check_name="requires_batch_context",
        passed=False,
        message="trajectory_dtw runs after batch quality validation",
        level="major",
        value={"skipped": True, "reason": "requires_batch_context"},
    )
    return finalize_validator(
        operator_name,
        [issue],
        details={"skipped": True, "reason": "requires_batch_context"},
    )


VALIDATOR_REGISTRY: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "metadata": validate_metadata,
    "timing": validate_timing,
    "action": validate_action,
    "visual": validate_visual_assets,
    "depth": validate_depth_assets,
    "ee_trajectory": validate_ee_trajectory,
    "trajectory_dtw": validate_trajectory_dtw,
}


def run_quality_validators(
    dataset_path: Path,
    episode_index: int,
    *,
    selected_validators: list[str] | None = None,
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Run selected validators. If None, runs all."""
    names = selected_validators or list(VALIDATOR_REGISTRY.keys())
    unknown = [n for n in names if n not in VALIDATOR_REGISTRY]
    if unknown:
        raise ValueError(f"Unknown validators: {unknown}")
    data = load_episode_data(dataset_path, episode_index)
    results: list[dict[str, Any]] = []
    for name in names:
        results.append(VALIDATOR_REGISTRY[name](data, threshold_overrides))

    all_issues = [issue for result in results for issue in result["issues"]]
    total_score = weighted_validator_score(results) if results else 0.0
    passed = all(r["passed"] for r in results)
    validators_dict = {
        r["name"]: {"passed": r["passed"], "score": r["score"]}
        for r in results
    }
    return {
        "passed": passed,
        "score": round(total_score, 1),
        "validators": validators_dict,
        "issues": all_issues,
    }
