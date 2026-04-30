from __future__ import annotations

from typing import Any

from .episode_loader import _extract_timestamps
from .propagation import (
    _extract_gripper_series,
    _find_gripper_index,
    detect_grasp_place_events,
)
from .validation_core import finalize_validator, make_issue, merge_threshold_overrides


def validate_ee_trajectory(
    data: dict[str, Any],
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    operator_name = "ee_trajectory"
    thresholds = merge_threshold_overrides(threshold_overrides)
    rows = data["rows"]
    info = data["info"]
    timestamps = _extract_timestamps(rows)
    duration_s = max(timestamps[-1] - timestamps[0], 0.0) if len(timestamps) > 1 else 0.0
    action_names = info.get("features", {}).get("action", {}).get("names", []) if isinstance(info.get("features", {}).get("action"), dict) else []
    state_names = info.get("features", {}).get("observation.state", {}).get("names", []) if isinstance(info.get("features", {}).get("observation.state"), dict) else []
    issues: list[dict[str, Any]] = []

    spans = detect_grasp_place_events(
        rows=rows,
        action_names=[str(name) for name in action_names] if isinstance(action_names, list) else [],
        state_names=[str(name) for name in state_names] if isinstance(state_names, list) else [],
        duration_s=duration_s,
    )
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="grasp_event_count",
        passed=len(spans) >= int(thresholds["ee_min_event_count"]),
        message=f"Detected grasp/place events {len(spans)}",
        level="major",
        value={"event_count": len(spans)},
    ))

    gripper_series, _series_timestamps = _extract_gripper_series(rows, _find_gripper_index(
        [str(name) for name in action_names] if isinstance(action_names, list) else [],
        [str(name) for name in state_names] if isinstance(state_names, list) else [],
    ))
    if gripper_series:
        span = max(gripper_series) - min(gripper_series)
        issues.append(make_issue(
            operator_name=operator_name,
            check_name="gripper_motion_span",
            passed=span >= thresholds["ee_min_gripper_span"],
            message=f"Gripper span {span:.3f}",
            level="major",
            value={"gripper_span": span},
        ))
    elif thresholds["ee_min_gripper_span"] > 0:
        issues.append(make_issue(
            operator_name=operator_name,
            check_name="gripper_motion_span",
            passed=False,
            message=f"Gripper span unavailable (min {thresholds['ee_min_gripper_span']:.3f})",
            level="major",
            value={"gripper_span": None},
        ))

    return finalize_validator(operator_name, issues, details={"event_count": len(spans)})
