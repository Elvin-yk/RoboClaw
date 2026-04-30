from __future__ import annotations

import statistics
from typing import Any

from .episode_loader import _extract_timestamps
from .validation_core import finalize_validator, make_issue, merge_threshold_overrides


def validate_timing(
    data: dict[str, Any],
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    operator_name = "timing"
    thresholds = merge_threshold_overrides(threshold_overrides)
    rows = data["rows"]
    issues: list[dict[str, Any]] = []
    timestamps = _extract_timestamps(rows)

    if len(timestamps) < 2:
        issues.append(make_issue(
            operator_name=operator_name,
            check_name="timestamps",
            passed=False,
            message="Insufficient timestamps for timing validation",
            level="critical",
        ))
        return finalize_validator(operator_name, issues)

    diffs = [timestamps[i] - timestamps[i - 1] for i in range(1, len(timestamps))]
    positive_diffs = [d for d in diffs if d > 0]
    _check_monotonicity(issues, operator_name, diffs, thresholds)

    if positive_diffs:
        _check_timing_details(issues, operator_name, positive_diffs, thresholds)

    return finalize_validator(operator_name, issues, details={"frame_count": len(timestamps)})


def _extract_timestamps(rows: list[dict[str, Any]]) -> list[float]:
    raw = [
        safe_float(
            row["timestamp"] if "timestamp" in row else row.get("timestamp_utc"),
        )
        for row in rows
    ]
    return [v for v in raw if v is not None]


def _check_monotonicity(
    issues: list[dict[str, Any]],
    operator_name: str,
    diffs: list[float],
    thresholds: dict[str, float],
) -> None:
    non_monotonic = sum(1 for d in diffs if d <= 0)
    ratio = 1.0 - (non_monotonic / len(diffs))
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="monotonicity",
        passed=ratio >= thresholds["timing_min_monotonicity"],
        message=f"Timestamp monotonicity {ratio * 100:.2f}%",
        level="major",
        value={"monotonic_ratio": ratio},
    ))


def _check_timing_details(
    issues: list[dict[str, Any]],
    operator_name: str,
    positive_diffs: list[float],
    thresholds: dict[str, float],
) -> None:
    median_interval = statistics.median(positive_diffs)
    mean_interval = statistics.fmean(positive_diffs)
    std_interval = statistics.pstdev(positive_diffs) if len(positive_diffs) > 1 else 0.0
    interval_cv = (std_interval / mean_interval) if mean_interval > 0 else 0.0
    estimated_freq = (1.0 / median_interval) if median_interval > 0 else 0.0
    gap_ratio = sum(1 for d in positive_diffs if d > 1.0) / len(positive_diffs)
    consistency = _trimmed_consistency(positive_diffs)

    issues.extend([
        make_issue(
            operator_name=operator_name,
            check_name="interval_cv",
            passed=interval_cv < thresholds["timing_max_interval_cv"],
            message=f"Sampling interval CV {interval_cv * 100:.2f}%",
            level="major",
            value={"interval_cv": interval_cv},
        ),
        make_issue(
            operator_name=operator_name,
            check_name="estimated_frequency",
            passed=estimated_freq >= thresholds["timing_min_frequency_hz"],
            message=f"Estimated frequency {estimated_freq:.2f} Hz",
            level="major",
            value={"estimated_frequency_hz": estimated_freq},
        ),
        make_issue(
            operator_name=operator_name,
            check_name="gap_ratio",
            passed=gap_ratio < thresholds["timing_max_gap_ratio"],
            message=f"Gaps >1s ratio {gap_ratio * 100:.2f}%",
            level="major",
            value={"gap_ratio": gap_ratio},
        ),
        make_issue(
            operator_name=operator_name,
            check_name="frequency_consistency",
            passed=consistency >= thresholds["timing_min_frequency_consistency"],
            message=f"Frequency consistency {consistency * 100:.2f}%",
            level="major",
            value={"consistency": consistency},
        ),
    ])


def _trimmed_consistency(positive_diffs: list[float]) -> float:
    trimmed = positive_diffs[:]
    if len(trimmed) > 10:
        trim = max(int(len(trimmed) * 0.1), 1)
        trimmed = sorted(trimmed)[trim:-trim] or trimmed
    trimmed_mean = statistics.fmean(trimmed)
    trimmed_std = statistics.pstdev(trimmed) if len(trimmed) > 1 else 0.0
    return 1.0 - ((trimmed_std / trimmed_mean) if trimmed_mean > 0 else 0.0)
