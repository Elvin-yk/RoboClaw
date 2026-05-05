"""Unit tests for the task-agnostic RisingEdgeDetector."""
from __future__ import annotations

import numpy as np
import pytest

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    RisingEdgeConfig,
    RisingEdgeDetector,
)


def _detect(
    mask: list[bool],
    *,
    min_sep: int = 0,
    require_low: bool = True,
    episode_index: int = 0,
    episode_length: int | None = None,
) -> list[int]:
    arr = np.asarray(mask, dtype=np.bool_)
    length = episode_length if episode_length is not None else len(mask)
    detector = RisingEdgeDetector(
        RisingEdgeConfig(min_separation_frames=min_sep, require_low_between_events=require_low)
    )
    events = detector.detect(episode_index, arr, length)
    return [ev.event_frame for ev in events]


def test_single_rising_edge() -> None:
    assert _detect([False, False, True, True, False]) == [2]


def test_continuous_true_does_not_retrigger() -> None:
    assert _detect([True, True, True, True]) == [0]


def test_starts_true_fires_at_zero() -> None:
    assert _detect([True, True]) == [0]


def test_two_peaks_with_low_in_between() -> None:
    assert _detect([True, True, False, True]) == [0, 3]


def test_sticky_reset_then_late_rearm_with_min_sep() -> None:
    # Brief False at frame 1 sets reset_seen sticky; min_sep=3 holds rearm
    # until frame 3, by which time the trace is back to True.
    assert _detect([True, False, True, True, True], min_sep=3) == [0, 3]


def test_min_sep_blocks_intermediate_event() -> None:
    assert _detect([True, False, True, False, True], min_sep=3) == [0, 4]


def test_require_low_false_periodic_emit() -> None:
    assert (
        _detect([True, True, True, True, True], min_sep=2, require_low=False)
        == [0, 2, 4]
    )


def test_all_false_emits_nothing() -> None:
    assert _detect([False, False, False]) == []


def test_negative_min_separation_rejected() -> None:
    with pytest.raises(ValueError):
        RisingEdgeDetector(RisingEdgeConfig(min_separation_frames=-1))


def test_mask_length_mismatch_raises() -> None:
    detector = RisingEdgeDetector(RisingEdgeConfig(min_separation_frames=0))
    arr = np.asarray([True, False, True], dtype=np.bool_)
    with pytest.raises(ValueError):
        detector.detect(0, arr, episode_length=5)


def test_event_carries_episode_index_and_length() -> None:
    detector = RisingEdgeDetector(RisingEdgeConfig(min_separation_frames=0))
    mask = np.asarray([False, True, True, False, True], dtype=np.bool_)
    events = detector.detect(episode_index=42, mask=mask, episode_length=5)
    assert events == [
        CriticalEvent(episode_index=42, event_frame=1, episode_length=5),
        CriticalEvent(episode_index=42, event_frame=4, episode_length=5),
    ]


def test_non_bool_dtype_rejected() -> None:
    detector = RisingEdgeDetector(RisingEdgeConfig(min_separation_frames=0))
    with pytest.raises(ValueError):
        detector.detect(0, np.asarray([0, 1, 0], dtype=np.int64), episode_length=3)


def test_require_low_true_does_not_retrigger_without_drop() -> None:
    # require_low=True, plateau of True with min_sep=0 still emits only once
    # because reset_seen never flips.
    assert _detect([True, True, True, True], min_sep=0, require_low=True) == [0]
