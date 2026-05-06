"""Pure helpers for summarising and analysing the per-frame end-effector
distance series.

Mirrors the FE TS module ``distanceSeries.ts`` exactly: strict ``<`` for the
below-threshold predicate, identical empty-series fallbacks, and the same
even-spaced down-sampling rule (first + last frames always included).

No placo, no THREE: pure numpy. Safe to use anywhere in offline pipelines.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class DistanceStats:
    """Aggregate stats for a single distance series.

    ``below_count`` uses strict ``<`` against ``threshold_m`` to match the FE.
    """

    min: float
    max: float
    mean: float
    below_count: int


@dataclass(frozen=True)
class BelowThresholdRange:
    """Inclusive frame range whose distance is strictly below ``threshold_m``."""

    start_frame: int
    end_frame: int  # inclusive
    start_time_s: float
    end_time_s: float


def summarize_distance_series(series: np.ndarray, threshold_m: float) -> DistanceStats:
    """Return min/max/mean/below_count for ``series``.

    Empty input returns all zeros (FE parity). Non-finite values (NaN/inf)
    propagate per numpy semantics — pre-clean the series upstream if you need
    defined min/max/mean for dirty data. The FE silently skips ``NaN`` in its
    ``if (v < min)`` loop and counts ``NaN < threshold`` as false; this Python
    helper instead surfaces the contamination as ``NaN`` in the stats.
    """
    if series.size == 0:
        return DistanceStats(min=0.0, max=0.0, mean=0.0, below_count=0)
    arr = np.asarray(series)
    return DistanceStats(
        min=float(arr.min()),
        max=float(arr.max()),
        mean=float(arr.mean()),
        below_count=int(np.sum(arr < threshold_m)),
    )


def find_below_threshold_ranges(
    series: np.ndarray,
    threshold_m: float,
    time_s: np.ndarray | None,
) -> list[BelowThresholdRange]:
    """Return contiguous runs where ``series[i] < threshold_m``.

    ``end_frame`` is inclusive. If ``time_s`` is missing or shorter than the
    series at a given frame, the corresponding timestamp falls back to ``0.0``
    (FE parity).
    """
    if series.size == 0:
        return []
    arr = np.asarray(series)
    below = arr < threshold_m
    ranges: list[BelowThresholdRange] = []
    run_start = -1
    for i, is_below in enumerate(below.tolist()):
        if is_below and run_start == -1:
            run_start = i
        elif not is_below and run_start != -1:
            ranges.append(_make_range(run_start, i - 1, time_s))
            run_start = -1
    if run_start != -1:
        ranges.append(_make_range(run_start, int(arr.size) - 1, time_s))
    return ranges


def _make_range(
    start_frame: int, end_frame: int, time_s: np.ndarray | None
) -> BelowThresholdRange:
    start_t = _safe_time(time_s, start_frame)
    end_t = _safe_time(time_s, end_frame)
    if end_t == 0.0 and (time_s is None or end_frame >= len(time_s)):
        end_t = start_t
    return BelowThresholdRange(
        start_frame=int(start_frame),
        end_frame=int(end_frame),
        start_time_s=float(start_t),
        end_time_s=float(end_t),
    )


def _safe_time(time_s: np.ndarray | None, frame: int) -> float:
    if time_s is None:
        return 0.0
    if frame < 0 or frame >= len(time_s):
        return 0.0
    return float(time_s[frame])


def downsample_distance_series(
    series: np.ndarray, max_points: int
) -> tuple[np.ndarray, np.ndarray]:
    """Down-sample to at most ``max_points`` evenly-spaced samples.

    Returns ``(frame_indices, values)`` as int / float ndarrays. First and last
    frames are always retained (FE parity). Edge cases:

    - empty series or ``max_points <= 0`` → empty arrays
    - ``len(series) <= max_points`` → full pass-through
    - ``max_points == 1`` → ``([0], [series[0]])``
    """
    arr = np.asarray(series)
    length = int(arr.size)
    if length == 0 or max_points <= 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=arr.dtype)
    if length <= max_points:
        return np.arange(length, dtype=np.int64), arr.astype(arr.dtype, copy=True)
    if max_points == 1:
        return np.array([0], dtype=np.int64), np.array([arr[0]], dtype=arr.dtype)
    step = (length - 1) / (max_points - 1)
    raw = np.arange(max_points) * step
    # Match FE Math.round semantics (round-half-away-from-zero on positive
    # values). numpy's ``rint`` uses banker's rounding which would diverge.
    indices = np.floor(raw + 0.5).astype(np.int64)
    return indices, arr[indices]
