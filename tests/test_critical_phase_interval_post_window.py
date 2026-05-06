"""Tests for post-event window extension and tail clamping in CriticalWindowBuilder."""
from __future__ import annotations

import pytest

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    CriticalWindowBuilder,
    OverlapPolicy,
    WindowSpec,
)


def _ev(ep: int, frame: int, episode_length: int = 1000) -> CriticalEvent:
    return CriticalEvent(
        episode_index=ep, event_frame=frame, episode_length=episode_length
    )


def _builder(
    *,
    pre: float = 10.0,
    post: float = 0.0,
    fps: float = 30.0,
    policy: OverlapPolicy = OverlapPolicy.KEEP,
    min_events: int = 5,
) -> CriticalWindowBuilder:
    return CriticalWindowBuilder(
        WindowSpec(
            pre_event_seconds=pre,
            post_event_seconds=post,
            fps=fps,
            overlap_policy=policy,
            min_events_per_episode=min_events,
        )
    )


def test_post_w_zero_matches_pre_only() -> None:
    """With post=0, output should match the original pre-only window."""
    intervals_post0, report_post0 = _builder(pre=10.0, post=0.0).build(
        {0: [_ev(0, 450)]}, {0: 1000}
    )
    assert len(intervals_post0) == 1
    iv = intervals_post0[0]
    assert iv.start_frame == 151
    assert iv.end_frame_exclusive == 451
    assert iv.event_frame == 450
    assert report_post0.tail_clamped_windows == 0
    assert report_post0.clamped_windows == 0


def test_post_w_positive_extends_window() -> None:
    """pre=2.0s, post=0.5s, fps=30 → window = 60 + 15 = 75 frames per event."""
    events = [_ev(0, f) for f in (100, 200, 300, 400, 500)]
    intervals, report = _builder(pre=2.0, post=0.5, fps=30.0).build(
        {0: events}, {0: 1000}
    )
    assert len(intervals) == 5
    for iv in intervals:
        assert iv.end_frame_exclusive - iv.start_frame == 75
    # event 100: start = 100+1-60 = 41, end = 100+1+15 = 116
    assert intervals[0].start_frame == 41
    assert intervals[0].end_frame_exclusive == 116
    assert report.total_output_frames == 5 * 75
    assert report.tail_clamped_windows == 0
    assert report.clamped_windows == 0


def test_end_of_episode_clamp() -> None:
    """Event near end of episode → end clamped to episode_length, tail count incremented."""
    # episode_length=200, event_frame=195, pre=2.0s/30fps=60, post=0.5s/30fps=15
    # natural end = 195+1+15 = 211 -> clamp to 200; tail_clamped_windows == 1
    intervals, report = _builder(pre=2.0, post=0.5, fps=30.0).build(
        {0: [_ev(0, 195, episode_length=200)]}, {0: 200}
    )
    assert len(intervals) == 1
    iv = intervals[0]
    assert iv.start_frame == 195 + 1 - 60
    assert iv.end_frame_exclusive == 200
    assert report.tail_clamped_windows == 1
    assert report.clamped_windows == 0


def test_negative_post_rejected() -> None:
    with pytest.raises(ValueError, match="post_event_seconds must be >= 0"):
        CriticalWindowBuilder(
            WindowSpec(
                pre_event_seconds=2.0,
                post_event_seconds=-0.1,
                fps=30.0,
            )
        )


def test_post_w_zero_does_not_increment_tail_clamped() -> None:
    """With post=0, an event at the last frame should NOT count as tail-clamped
    (end == event_frame+1 == episode_length, not GREATER than episode_length)."""
    intervals, report = _builder(pre=2.0, post=0.0, fps=30.0).build(
        {0: [_ev(0, 199, episode_length=200)]}, {0: 200}
    )
    assert intervals[0].end_frame_exclusive == 200
    assert report.tail_clamped_windows == 0


def test_both_clamps_can_apply_to_same_event() -> None:
    """Tiny episode with event near both edges → both pre and post clamp."""
    # episode_length=20, event=10, pre=2.0s/30fps=60 -> start clamps to 0
    # post=2.0s/30fps=60 -> end=10+1+60=71 clamps to 20
    intervals, report = _builder(pre=2.0, post=2.0, fps=30.0).build(
        {0: [_ev(0, 10, episode_length=20)]}, {0: 20}
    )
    iv = intervals[0]
    assert iv.start_frame == 0
    assert iv.end_frame_exclusive == 20
    assert report.clamped_windows == 1
    assert report.tail_clamped_windows == 1
