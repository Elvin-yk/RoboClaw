"""Unit tests for GripperOpenMaskDetector — single-pass hysteresis on a 1-D trace."""
from __future__ import annotations

import numpy as np
import pytest

from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.detectors import (
    GripperOpenMaskConfig,
    GripperOpenMaskDetector,
)


def _mask(
    trace: list[float],
    *,
    open_t: float,
    reset_t: float | None = None,
) -> list[bool]:
    if reset_t is None:
        reset_t = open_t
    detector = GripperOpenMaskDetector(
        GripperOpenMaskConfig(open_threshold=open_t, reset_threshold=reset_t)
    )
    arr = np.asarray(trace, dtype=np.float64)
    return detector.open_mask(arr).tolist()


def test_no_hysteresis_open_equals_reset() -> None:
    assert _mask([0, 11, 12, 9, 8, 11], open_t=10.0) == [
        False,
        True,
        True,
        False,
        False,
        True,
    ]


def test_hysteresis_band_keeps_open_until_below_reset() -> None:
    # open=10, reset=7. Once open at frame 1, stays open through 9 and 8
    # (>= reset=7), drops at frame 5 (6 < 7), reopens at frame 6.
    assert _mask([0, 11, 9, 8, 11, 6, 11], open_t=10.0, reset_t=7.0) == [
        False,
        True,
        True,
        True,
        True,
        False,
        True,
    ]


def test_starts_above_open_threshold() -> None:
    assert _mask([11], open_t=10.0) == [True]


def test_open_threshold_inclusive() -> None:
    # Equality on open_threshold counts as open.
    assert _mask([10], open_t=10.0) == [True]


def test_reset_threshold_strict_inequality() -> None:
    # open=10, reset=7. Trace drops to exactly 7 should NOT close
    # (< reset_threshold required).
    assert _mask([11, 8, 7], open_t=10.0, reset_t=7.0) == [True, True, True]


def test_reset_above_open_rejected() -> None:
    with pytest.raises(ValueError):
        GripperOpenMaskDetector(
            GripperOpenMaskConfig(open_threshold=5.0, reset_threshold=10.0)
        )


def test_non_1d_trace_rejected() -> None:
    detector = GripperOpenMaskDetector(
        GripperOpenMaskConfig(open_threshold=10.0, reset_threshold=10.0)
    )
    with pytest.raises(ValueError):
        detector.open_mask(np.zeros((3, 4), dtype=np.float64))


def test_mask_dtype_is_bool() -> None:
    detector = GripperOpenMaskDetector(
        GripperOpenMaskConfig(open_threshold=10.0, reset_threshold=10.0)
    )
    out = detector.open_mask(np.asarray([0, 11, 0], dtype=np.float64))
    assert out.dtype == np.bool_
    assert out.shape == (3,)
