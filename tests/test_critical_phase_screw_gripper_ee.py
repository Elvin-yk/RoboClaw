"""Unit tests for the compound (gripper-open AND EE-close) detector."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pyarrow as pa
import pytest

from roboclaw.data.dataset_pipeline.critical_phase import RisingEdgeConfig
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.detectors import (
    GripperEEEventConfig,
    GripperEEEventDetector,
    GripperOpenMaskConfig,
)
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.ee_distance import (
    NotImplementedEEDistanceProvider,
)


@dataclass
class _FixedEEProvider:
    trace: np.ndarray

    def distance_trace(
        self, parquet: pa.Table, episode_index: int, num_frames: int
    ) -> np.ndarray:
        return self.trace.copy()


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


def _empty_table() -> pa.Table:
    return pa.table({"placeholder": pa.array([], type=pa.int64())})


def _detect(
    gripper_trace: list[float],
    ee_trace: list[float],
    *,
    config: GripperEEEventConfig,
    episode_index: int = 0,
) -> list[int]:
    gripper_arr = np.asarray(gripper_trace, dtype=np.float64)
    ee_arr = np.asarray(ee_trace, dtype=np.float64)
    detector = GripperEEEventDetector(config, _FixedEEProvider(ee_arr))
    events = detector.detect(_empty_table(), episode_index, gripper_arr, len(gripper_arr))
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


def test_shape_mismatch_between_traces_raises() -> None:
    config = _config()
    detector = GripperEEEventDetector(
        config, _FixedEEProvider(np.zeros(4, dtype=np.float64))
    )
    gripper = np.asarray([0, 11, 11], dtype=np.float64)
    with pytest.raises(ValueError):
        detector.detect(_empty_table(), 0, gripper, 3)


def test_default_provider_raises_not_implemented() -> None:
    config = _config()
    detector = GripperEEEventDetector(config, NotImplementedEEDistanceProvider())
    gripper = np.asarray([0, 11, 11], dtype=np.float64)
    with pytest.raises(NotImplementedError):
        detector.detect(_empty_table(), 0, gripper, 3)


def test_non_positive_ee_threshold_rejected() -> None:
    with pytest.raises(ValueError):
        GripperEEEventDetector(
            _config(ee_thresh=0.0),
            _FixedEEProvider(np.zeros(1, dtype=np.float64)),
        )
