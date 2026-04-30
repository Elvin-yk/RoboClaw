from __future__ import annotations

import math
from typing import Any

QUALITY_THRESHOLD_DEFAULTS: dict[str, float] = {
    "metadata_require_info_json": 1.0,
    "metadata_require_episode_metadata": 1.0,
    "metadata_require_data_files": 1.0,
    "metadata_require_videos": 1.0,
    "metadata_require_task_description": 1.0,
    "metadata_min_duration_s": 1.0,
    "timing_min_monotonicity": 0.99,
    "timing_max_interval_cv": 0.05,
    "timing_min_frequency_hz": 20.0,
    "timing_max_gap_ratio": 0.01,
    "timing_min_frequency_consistency": 0.98,
    "action_static_threshold": 0.001,
    "action_max_all_static_s": 3.0,
    "action_max_key_static_s": 5.0,
    "action_max_velocity_rad_s": 3.14,
    "action_min_duration_s": 1.0,
    "action_max_nan_ratio": 0.01,
    "visual_min_resolution_width": 640.0,
    "visual_min_resolution_height": 480.0,
    "visual_min_frame_rate": 20.0,
    "visual_frame_rate_tolerance": 2.0,
    "visual_color_shift_max": 0.10,
    "visual_overexposure_ratio_max": 0.05,
    "visual_underexposure_ratio_max": 0.10,
    "visual_abnormal_black_ratio_max": 0.95,
    "visual_abnormal_white_ratio_max": 0.95,
    "visual_min_video_count": 1.0,
    "visual_min_accessible_ratio": 1.0,
    "depth_min_stream_count": 0.0,
    "depth_min_accessible_ratio": 1.0,
    "depth_invalid_pixel_max": 0.10,
    "depth_continuity_min": 0.90,
    "ee_min_event_count": 1.0,
    "ee_min_gripper_span": 0.05,
    "trajectory_dtw_position_floor": 0.05,
    "trajectory_dtw_velocity_floor": 0.01,
    "trajectory_dtw_distance_quantile": 0.999,
    "trajectory_dtw_velocity_quantile": 0.999,
    "trajectory_dtw_deviation_multiplier": 1.2,
    "trajectory_dtw_hesitation_multiplier": 2.0,
    "trajectory_dtw_stall_frame_threshold": 30.0,
    "trajectory_dtw_min_segment_s": 0.2,
    "trajectory_dtw_min_reference_count": 6.0,
}

ISSUE_LEVEL_WEIGHTS: dict[str, float] = {
    "critical": 1.0,
    "major": 0.7,
    "minor": 0.3,
    "info": 0.05,
}

VALIDATOR_CATEGORY_WEIGHTS: dict[str, float] = {
    "metadata": 0.20,
    "timing": 0.15,
    "action": 0.20,
    "visual": 0.15,
    "depth": 0.10,
    "ee_trajectory": 0.10,
    "trajectory_dtw": 0.10,
}

# ---------------------------------------------------------------------------
# Issue / score model
# ---------------------------------------------------------------------------


def make_issue(
    *,
    operator_name: str,
    check_name: str,
    passed: bool,
    message: str,
    level: str = "major",
    value: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "operator_name": operator_name,
        "check_name": check_name,
        "passed": passed,
        "message": message,
        "level": level,
        "value": value or {},
    }


def is_present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True


def finalize_validator(
    operator_name: str,
    issues: list[dict[str, Any]],
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    score = weighted_issue_score(issues)
    blocking_levels = {"critical", "major"}
    passed = all(issue["passed"] for issue in issues if issue["level"] in blocking_levels)
    return {
        "name": operator_name,
        "passed": passed,
        "score": score,
        "issues": issues,
        "details": details or {},
    }


def weighted_issue_score(issues: list[dict[str, Any]]) -> float:
    weights = [
        ISSUE_LEVEL_WEIGHTS.get(str(issue.get("level", "major")), ISSUE_LEVEL_WEIGHTS["major"])
        for issue in issues
    ]
    total_weight = sum(weights) or 1.0
    passed_weight = sum(
        weight
        for issue, weight in zip(issues, weights)
        if issue.get("passed")
    )
    return round((passed_weight / total_weight) * 100, 1)


def weighted_validator_score(results: list[dict[str, Any]]) -> float:
    weighted_scores = []
    for result in results:
        name = str(result.get("name", ""))
        weight = VALIDATOR_CATEGORY_WEIGHTS.get(name, 0.10)
        weighted_scores.append((float(result.get("score", 0.0) or 0.0), weight))
    total_weight = sum(weight for _score, weight in weighted_scores) or 1.0
    score = sum(score * weight for score, weight in weighted_scores) / total_weight
    return round(score, 1)


def safe_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def merge_threshold_overrides(threshold_overrides: dict[str, float] | None = None) -> dict[str, float]:
    merged = dict(QUALITY_THRESHOLD_DEFAULTS)
    if not threshold_overrides:
        return merged
    for key, value in threshold_overrides.items():
        if key not in merged:
            continue
        numeric = safe_float(value)
        if numeric is None:
            continue
        merged[key] = numeric
    return merged
