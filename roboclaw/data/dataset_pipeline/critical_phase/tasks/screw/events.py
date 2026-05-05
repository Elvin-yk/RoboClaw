"""Detect left-gripper open events in a screw-insertion episode.

A gripper-open event fires when the action trace at ``gripper_dim`` crosses
upward through ``open_threshold`` while the detector is armed. After firing,
the detector disarms and only re-arms once BOTH gates are satisfied:
  - ``value < reset_threshold`` has been observed at least once since the
    last event (sticky — the dip does not have to be on the same frame as
    re-arming); and
  - ``min_separation_frames`` have elapsed since the last event.
The two gates are independent, so a brief reset followed by a long plateau
above the threshold still re-arms once the debounce window has passed.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from roboclaw.data.dataset_pipeline.critical_phase import CriticalEvent


@dataclass(frozen=True)
class GripperEventConfig:
    open_threshold: float
    reset_threshold: float
    min_separation_frames: int


class GripperEventDetector:
    def __init__(self, config: GripperEventConfig) -> None:
        if config.reset_threshold > config.open_threshold:
            raise ValueError(
                f"reset_threshold ({config.reset_threshold}) must be <= "
                f"open_threshold ({config.open_threshold})"
            )
        if config.min_separation_frames < 0:
            raise ValueError("min_separation_frames must be >= 0")
        self.config = config

    def detect(
        self,
        episode_index: int,
        trace: np.ndarray,
        episode_length: int,
    ) -> list[CriticalEvent]:
        events: list[CriticalEvent] = []
        armed = True
        last_event_frame: int | None = None
        reset_seen = False
        for frame, raw_value in enumerate(trace):
            value = float(raw_value)
            armed, reset_seen = self._maybe_rearm(
                armed, reset_seen, value, frame, last_event_frame
            )
            if armed and value >= self.config.open_threshold:
                events.append(
                    CriticalEvent(
                        episode_index=episode_index,
                        event_frame=frame,
                        episode_length=episode_length,
                    )
                )
                armed = False
                last_event_frame = frame
                reset_seen = False
        return events

    def _maybe_rearm(
        self,
        armed: bool,
        reset_seen: bool,
        value: float,
        frame: int,
        last_event_frame: int | None,
    ) -> tuple[bool, bool]:
        if armed or last_event_frame is None:
            return armed, reset_seen
        if value < self.config.reset_threshold:
            reset_seen = True
        gap_ok = (frame - last_event_frame) >= self.config.min_separation_frames
        if reset_seen and gap_ok:
            return True, reset_seen
        return False, reset_seen
