"""Unit tests for CriticalWindowBuilder — windows, overlap policies, reports."""
from __future__ import annotations

import pytest

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    CriticalWindowBuilder,
    OverlapPolicy,
    WindowSpec,
)


def _ev(ep: int, frame: int) -> CriticalEvent:
    return CriticalEvent(episode_index=ep, event_frame=frame, episode_length=1000)


def _builder(
    pre: float = 10.0,
    fps: float = 30.0,
    policy: OverlapPolicy = OverlapPolicy.KEEP,
    min_events: int = 5,
) -> CriticalWindowBuilder:
    return CriticalWindowBuilder(
        WindowSpec(
            pre_event_seconds=pre,
            fps=fps,
            overlap_policy=policy,
            min_events_per_episode=min_events,
        )
    )


def test_window_frames_round_30fps() -> None:
    assert _builder(10.0, 30.0).window_frames == 300
    assert _builder(10.0, 25.0).window_frames == 250


def test_event_at_450_with_window_300_includes_event() -> None:
    intervals, _ = _builder().build({0: [_ev(0, 450)]}, {0: 1000})
    assert len(intervals) == 1
    iv = intervals[0]
    assert iv.start_frame == 151
    assert iv.end_frame_exclusive == 451
    assert iv.event_frame == 450


def test_event_at_50_with_window_300_clamps_start_to_zero_and_reports_clamp() -> None:
    intervals, report = _builder().build({0: [_ev(0, 50)]}, {0: 1000})
    iv = intervals[0]
    assert iv.start_frame == 0
    assert iv.end_frame_exclusive == 51
    assert report.clamped_windows == 1


def test_overlap_keep_default() -> None:
    intervals, report = _builder().build({0: [_ev(0, 300), _ev(0, 320)]}, {0: 1000})
    assert len(intervals) == 2
    assert report.skipped_overlaps == 0


def test_overlap_skip_drops_later() -> None:
    intervals, report = _builder(policy=OverlapPolicy.SKIP).build(
        {0: [_ev(0, 300), _ev(0, 320)]}, {0: 1000}
    )
    assert len(intervals) == 1
    assert intervals[0].event_frame == 300
    assert report.skipped_overlaps == 1


def test_overlap_error_raises() -> None:
    builder = _builder(policy=OverlapPolicy.ERROR)
    with pytest.raises(ValueError) as excinfo:
        builder.build({7: [_ev(7, 300), _ev(7, 320)]}, {7: 1000})
    assert "7" in str(excinfo.value)


def test_to_extract_intervals_tuple_shape() -> None:
    intervals, _ = _builder().build({3: [_ev(3, 450)]}, {3: 1000})
    assert intervals[0].as_lerobot_tuple() == (3, 151, 451)


def test_min_events_warn_only() -> None:
    events = [_ev(0, f) for f in (350, 700, 950)]
    intervals, report = _builder(min_events=5).build({0: events}, {0: 1000})
    assert len(intervals) == 3
    assert report.episodes_with_fewer_than_min_events == {0: 3}


def test_episodes_with_no_events_listed() -> None:
    intervals, report = _builder().build({}, {0: 1000, 1: 500})
    assert intervals == []
    assert report.episodes_with_no_events == [0, 1]


def test_missing_episode_length_raises() -> None:
    with pytest.raises(KeyError):
        _builder().build({2: [_ev(2, 100)]}, {0: 1000})


def test_window_frames_must_be_at_least_one() -> None:
    with pytest.raises(ValueError, match="rounds to 0"):
        CriticalWindowBuilder(
            WindowSpec(pre_event_seconds=0.001, fps=1.0)
        )
