"""Turn detected gripper events into per-event critical windows.

Each event becomes a window of ``round(pre_event_seconds * fps)`` frames that
ends at and INCLUDES the event frame: ``[max(0, event+1-W), event+1)``.
Within a single source episode, an :class:`OverlapPolicy` controls what
happens when two windows touch; across episodes, windows never interact.
``min_events_per_episode`` is purely a warning threshold — the builder never
drops events for falling below it.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Mapping

from .gripper_events import GripperEvent


class OverlapPolicy(str, Enum):
    KEEP = "keep"
    SKIP = "skip-overlap"
    ERROR = "error"


@dataclass(frozen=True)
class WindowSpec:
    pre_event_seconds: float
    fps: float
    overlap_policy: OverlapPolicy = OverlapPolicy.KEEP
    min_events_per_episode: int = 5


@dataclass(frozen=True)
class CriticalInterval:
    source_episode_index: int
    start_frame: int
    end_frame_exclusive: int
    event_frame: int

    def as_lerobot_tuple(self) -> tuple[int, int, int]:
        return (self.source_episode_index, self.start_frame, self.end_frame_exclusive)


@dataclass(frozen=True)
class ExtractionReport:
    source_episode_count: int
    output_segment_count: int
    total_output_frames: int
    episodes_with_no_events: list[int]
    episodes_with_fewer_than_min_events: dict[int, int]
    clamped_windows: int
    skipped_overlaps: int


class CriticalWindowBuilder:
    def __init__(self, spec: WindowSpec) -> None:
        if spec.fps <= 0:
            raise ValueError(f"fps must be > 0 (got {spec.fps})")
        if spec.pre_event_seconds <= 0:
            raise ValueError(f"pre_event_seconds must be > 0 (got {spec.pre_event_seconds})")
        if int(round(spec.pre_event_seconds * spec.fps)) < 1:
            raise ValueError(
                "pre_event_seconds * fps rounds to 0 frames; "
                f"got pre={spec.pre_event_seconds} fps={spec.fps}"
            )
        self.spec = spec

    @property
    def window_frames(self) -> int:
        return int(round(self.spec.pre_event_seconds * self.spec.fps))

    def build(
        self,
        events_by_episode: Mapping[int, list[GripperEvent]],
        episode_lengths: Mapping[int, int],
    ) -> tuple[list[CriticalInterval], ExtractionReport]:
        missing = sorted(set(events_by_episode) - set(episode_lengths))
        if missing:
            raise KeyError(f"events reference episodes absent from episode_lengths: {missing}")

        intervals: list[CriticalInterval] = []
        no_events: list[int] = []
        few_events: dict[int, int] = {}
        clamped = 0
        skipped_overlaps = 0
        for ep_idx in sorted(episode_lengths):
            ep_events = events_by_episode.get(ep_idx, [])
            if not ep_events:
                no_events.append(ep_idx)
                continue
            if len(ep_events) < self.spec.min_events_per_episode:
                few_events[ep_idx] = len(ep_events)
            ep_intervals, ep_clamped = self._make_intervals(ep_events)
            kept, ep_skipped = self._apply_overlap_policy(ep_idx, ep_intervals)
            intervals.extend(kept)
            clamped += ep_clamped
            skipped_overlaps += ep_skipped

        return intervals, ExtractionReport(
            source_episode_count=len(episode_lengths),
            output_segment_count=len(intervals),
            total_output_frames=sum(iv.end_frame_exclusive - iv.start_frame for iv in intervals),
            episodes_with_no_events=no_events,
            episodes_with_fewer_than_min_events=few_events,
            clamped_windows=clamped,
            skipped_overlaps=skipped_overlaps,
        )

    def _make_intervals(
        self,
        events: list[GripperEvent],
    ) -> tuple[list[CriticalInterval], int]:
        w = self.window_frames
        out: list[CriticalInterval] = []
        clamped = 0
        for ev in sorted(events, key=lambda e: e.event_frame):
            end = ev.event_frame + 1
            start = end - w
            if start < 0:
                start = 0
                clamped += 1
            out.append(
                CriticalInterval(
                    source_episode_index=ev.episode_index,
                    start_frame=start,
                    end_frame_exclusive=end,
                    event_frame=ev.event_frame,
                )
            )
        return out, clamped

    def _apply_overlap_policy(
        self,
        ep_idx: int,
        intervals: list[CriticalInterval],
    ) -> tuple[list[CriticalInterval], int]:
        policy = self.spec.overlap_policy
        if policy is OverlapPolicy.KEEP or len(intervals) <= 1:
            return intervals, 0
        kept: list[CriticalInterval] = [intervals[0]]
        skipped = 0
        for curr in intervals[1:]:
            if curr.start_frame < kept[-1].end_frame_exclusive:
                if policy is OverlapPolicy.ERROR:
                    raise ValueError(
                        f"overlap detected in episode {ep_idx}: "
                        f"event_frame {kept[-1].event_frame} window "
                        f"[{kept[-1].start_frame},{kept[-1].end_frame_exclusive}) "
                        f"overlaps event_frame {curr.event_frame} window "
                        f"[{curr.start_frame},{curr.end_frame_exclusive})"
                    )
                skipped += 1
                continue
            kept.append(curr)
        return kept, skipped
