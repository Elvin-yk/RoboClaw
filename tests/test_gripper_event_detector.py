"""Unit tests for GripperEventDetector — single-pass hysteresis + debounce."""
from __future__ import annotations

import numpy as np
import pytest

from roboclaw.data.dataset_pipeline.gripper_events import (
    GripperEventConfig,
    GripperEventDetector,
)


def _events(detector: GripperEventDetector, trace: list[float]) -> list[int]:
    arr = np.asarray(trace, dtype=np.float64)
    return [ev.event_frame for ev in detector.detect(0, arr, len(arr))]


def _make(open_t: float, reset_t: float | None = None, min_sep: int = 0) -> GripperEventDetector:
    if reset_t is None:
        reset_t = open_t
    return GripperEventDetector(
        GripperEventConfig(
            open_threshold=open_t,
            reset_threshold=reset_t,
            min_separation_frames=min_sep,
        )
    )


def test_detector_fires_on_first_crossing() -> None:
    assert _events(_make(10.0), [0, 2, 11, 12]) == [2]


def test_detector_does_not_retrigger_while_above_threshold() -> None:
    assert _events(_make(10.0), [0, 11, 12, 13, 9, 11]) == [1, 5]


def test_detector_uses_reset_threshold_hysteresis() -> None:
    assert _events(_make(10.0, 7.0), [0, 11, 9, 8, 11, 6, 11]) == [1, 6]


def test_detector_handles_starting_open() -> None:
    assert _events(_make(10.0), [11, 12]) == [0]


def test_detector_handles_exact_threshold() -> None:
    assert _events(_make(10.0), [10]) == [0]


def test_detector_returns_empty_without_crossing() -> None:
    assert _events(_make(10.0), [0, 1, 2]) == []


def test_detector_min_separation_frames() -> None:
    assert _events(_make(10.0, min_sep=3), [11, 0, 11, 0, 11]) == [0, 4]


def test_detector_five_well_separated_peaks() -> None:
    det = _make(10.0)
    trace = np.zeros(100, dtype=np.float64)
    peak_starts = [5, 25, 45, 65, 85]
    for s in peak_starts:
        trace[s : s + 3] = 12.0
    assert _events(det, trace.tolist()) == peak_starts


def test_detector_rejects_reset_above_open() -> None:
    with pytest.raises(ValueError):
        GripperEventDetector(
            GripperEventConfig(open_threshold=5.0, reset_threshold=10.0, min_separation_frames=0)
        )


def test_detector_rejects_negative_min_separation() -> None:
    with pytest.raises(ValueError):
        GripperEventDetector(
            GripperEventConfig(open_threshold=10.0, reset_threshold=10.0, min_separation_frames=-1)
        )


def test_detector_rearms_after_sticky_reset_then_debounce() -> None:
    # Regression: prior implementation required value < reset_threshold AND
    # gap_ok on the same frame. Trace below has a brief reset at frame 1, but
    # the debounce window only elapses by frame 3 — by which time the value
    # is already back above reset. The detector must remember the earlier dip.
    det = _make(10.0, min_sep=3)
    assert _events(det, [11, 0, 11, 11, 11]) == [0, 3]
