"""Unit tests for the compound (gripper-open AND EE-close) detector."""
from __future__ import annotations

import numpy as np
import pytest

from roboclaw.data.dataset_pipeline.critical_phase import RisingEdgeConfig
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.detectors import (
    GripperEEEventConfig,
    GripperEEEventDetector,
    GripperOpenMaskConfig,
)


def _config(
    *,
    open_t: float = 10.0,
    reset_t: float = 10.0,
    ee_thresh: float = 0.1,
    min_sep: int = 0,
) -> GripperEEEventConfig:
    return GripperEEEventConfig(
        gripper=GripperOpenMaskConfig(open_threshold=open_t, reset_threshold=reset_t),
        ee_close_threshold_m=ee_thresh,
        edge=RisingEdgeConfig(min_separation_frames=min_sep),
    )


def _detect(
    gripper_trace: list[float],
    ee_trace: list[float],
    *,
    config: GripperEEEventConfig,
    episode_index: int = 0,
) -> list[int]:
    gripper_arr = np.asarray(gripper_trace, dtype=np.float64)
    ee_arr = np.asarray(ee_trace, dtype=np.float64)
    detector = GripperEEEventDetector(config)
    events = detector.detect(episode_index, gripper_arr, ee_arr, len(gripper_arr))
    return [ev.event_frame for ev in events]


def test_synchronous_and_rising_edges() -> None:
    # gripper opens at 1 and 4; ee close at the same frames.
    assert (
        _detect(
            [0, 11, 11, 0, 11],
            [1.0, 0.05, 0.05, 1.0, 0.05],
            config=_config(),
        )
        == [1, 4]
    )


def test_gripper_open_but_ee_far_emits_nothing() -> None:
    assert (
        _detect(
            [0, 11, 11, 11],
            [1.0, 1.0, 1.0, 1.0],
            config=_config(),
        )
        == []
    )


def test_ee_close_but_gripper_closed_emits_nothing() -> None:
    assert (
        _detect(
            [0, 0, 0, 0],
            [0.05, 0.05, 0.05, 0.05],
            config=_config(),
        )
        == []
    )


def test_two_separate_compound_events() -> None:
    assert (
        _detect(
            [0, 11, 11, 0, 0, 11, 11],
            [1.0, 0.05, 0.05, 1.0, 1.0, 0.05, 0.05],
            config=_config(),
        )
        == [1, 5]
    )


def test_min_separation_blocks_intermediate_event() -> None:
    # Three valid AND-rises at frames 0, 2, 4 with low between each, but
    # min_sep=3 only allows frames 0 and 4.
    assert (
        _detect(
            [11, 0, 11, 0, 11],
            [0.05, 1.0, 0.05, 1.0, 0.05],
            config=_config(min_sep=3),
        )
        == [0, 4]
    )


def test_ee_threshold_strict_below() -> None:
    # ee_thresh=0.1; ee==0.1 is NOT close (< threshold required).
    assert (
        _detect(
            [11, 11],
            [0.1, 0.05],
            config=_config(ee_thresh=0.1),
        )
        == [1]
    )


def test_ee_trace_shape_mismatch_raises() -> None:
    config = _config()
    detector = GripperEEEventDetector(config)
    gripper = np.asarray([0, 11, 11], dtype=np.float64)
    ee = np.zeros(4, dtype=np.float64)
    with pytest.raises(ValueError, match="ee_trace shape"):
        detector.detect(0, gripper, ee, 3)


def test_non_positive_ee_threshold_rejected() -> None:
    with pytest.raises(ValueError, match="ee_close_threshold_m"):
        GripperEEEventDetector(_config(ee_thresh=0.0))
