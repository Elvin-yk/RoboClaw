"""Tests for ``roboclaw.data.trajectory_viz.distance_series``.

These mirror the FE TS helpers (``distanceSeries.ts``) and stay free of any
placo / engine dependency.
"""

from __future__ import annotations

import numpy as np

from roboclaw.data.trajectory_viz.distance_series import (
    BelowThresholdRange,
    DistanceStats,
    downsample_distance_series,
    find_below_threshold_ranges,
    summarize_distance_series,
)


# ---------- summarize_distance_series ----------


def test_summarize_empty_series_returns_zeros() -> None:
    stats = summarize_distance_series(np.array([], dtype=np.float32), threshold_m=0.1)
    assert stats == DistanceStats(min=0.0, max=0.0, mean=0.0, below_count=0)


def test_summarize_single_value() -> None:
    stats = summarize_distance_series(np.array([0.5], dtype=np.float32), threshold_m=1.0)
    assert stats.min == 0.5
    assert stats.max == 0.5
    assert stats.mean == 0.5
    assert stats.below_count == 1


def test_summarize_mixed_series() -> None:
    series = np.array([0.05, 0.2, 0.3, 0.04], dtype=np.float32)
    stats = summarize_distance_series(series, threshold_m=0.1)
    assert stats.min == float(np.float32(0.04))
    assert stats.max == float(np.float32(0.3))
    assert stats.mean == float(np.mean(series))
    assert stats.below_count == 2  # 0.05 and 0.04 are < 0.1


def test_summarize_strict_lt_boundary_excludes_equal_values() -> None:
    """Value == threshold must NOT count as below (strict ``<``)."""
    series = np.array([0.1, 0.1, 0.1], dtype=np.float32)
    stats = summarize_distance_series(series, threshold_m=0.1)
    assert stats.below_count == 0


# ---------- find_below_threshold_ranges ----------


def test_find_ranges_empty_series() -> None:
    assert find_below_threshold_ranges(np.array([]), 0.1, time_s=None) == []


def test_find_ranges_all_above_returns_empty() -> None:
    series = np.array([0.5, 0.6, 0.7], dtype=np.float32)
    assert find_below_threshold_ranges(series, 0.1, time_s=None) == []


def test_find_ranges_all_below_single_run() -> None:
    series = np.array([0.01, 0.02, 0.03], dtype=np.float32)
    ranges = find_below_threshold_ranges(series, 0.1, time_s=np.array([0.0, 0.1, 0.2]))
    assert ranges == [
        BelowThresholdRange(start_frame=0, end_frame=2, start_time_s=0.0, end_time_s=0.2)
    ]


def test_find_ranges_two_separated_runs() -> None:
    series = np.array([0.05, 0.5, 0.05, 0.05, 0.5, 0.04], dtype=np.float32)
    times = np.array([0.0, 0.1, 0.2, 0.3, 0.4, 0.5])
    ranges = find_below_threshold_ranges(series, 0.1, time_s=times)
    assert ranges == [
        BelowThresholdRange(start_frame=0, end_frame=0, start_time_s=0.0, end_time_s=0.0),
        BelowThresholdRange(start_frame=2, end_frame=3, start_time_s=0.2, end_time_s=0.3),
        BelowThresholdRange(start_frame=5, end_frame=5, start_time_s=0.5, end_time_s=0.5),
    ]


def test_find_ranges_strict_lt_boundary_does_not_open_run() -> None:
    """Values equal to the threshold must not start a below-range."""
    series = np.array([0.1, 0.1, 0.1], dtype=np.float32)
    assert find_below_threshold_ranges(series, 0.1, time_s=None) == []


def test_find_ranges_missing_time_s_falls_back_to_zero() -> None:
    series = np.array([0.05, 0.05], dtype=np.float32)
    ranges = find_below_threshold_ranges(series, 0.1, time_s=None)
    assert ranges == [
        BelowThresholdRange(start_frame=0, end_frame=1, start_time_s=0.0, end_time_s=0.0)
    ]


def test_find_ranges_short_time_s_falls_back_to_start_time() -> None:
    """Mirrors FE: ``endTime = timeS[endFrame] ?? (timeS[startFrame] ?? 0)``."""
    series = np.array([0.05, 0.05, 0.05], dtype=np.float32)
    ranges = find_below_threshold_ranges(series, 0.1, time_s=np.array([0.7]))
    assert ranges == [
        BelowThresholdRange(start_frame=0, end_frame=2, start_time_s=0.7, end_time_s=0.7)
    ]


# ---------- downsample_distance_series ----------


def test_downsample_empty_series_returns_empty() -> None:
    frames, values = downsample_distance_series(np.array([], dtype=np.float32), max_points=10)
    assert frames.size == 0
    assert values.size == 0


def test_downsample_len_le_max_passes_through() -> None:
    series = np.array([0.1, 0.2, 0.3], dtype=np.float32)
    frames, values = downsample_distance_series(series, max_points=10)
    assert frames.tolist() == [0, 1, 2]
    assert values.tolist() == [float(np.float32(0.1)), float(np.float32(0.2)), float(np.float32(0.3))]


def test_downsample_max_points_one_returns_first() -> None:
    series = np.array([0.5, 0.6, 0.7, 0.8], dtype=np.float32)
    frames, values = downsample_distance_series(series, max_points=1)
    assert frames.tolist() == [0]
    assert values.tolist() == [float(np.float32(0.5))]


def test_downsample_evenly_spaced_includes_first_and_last() -> None:
    series = np.arange(10, dtype=np.float32)
    frames, values = downsample_distance_series(series, max_points=5)
    # FE step formula: round(i * (length-1)/(max_points-1)) for i in 0..max_points-1
    expected_frames = [0, 2, 5, 7, 9]
    assert frames.tolist() == expected_frames
    assert values.tolist() == [float(series[i]) for i in expected_frames]


def test_downsample_zero_or_negative_max_points_returns_empty() -> None:
    series = np.array([0.1, 0.2], dtype=np.float32)
    frames, values = downsample_distance_series(series, max_points=0)
    assert frames.size == 0 and values.size == 0
