"""Task-agnostic rising-edge detector over a boolean trace.

Given a per-frame boolean ``mask`` (e.g. "is the gripper open AND are the EE
endpoints close enough?"), emit one :class:`CriticalEvent` per rising edge,
with optional debounce. The detector is intentionally task-blind: callers are
responsible for assembling the boolean mask from whatever signals they like.

State machine (single pass, O(N)):
  - ``armed`` starts True. While armed, the first ``True`` sample fires an
    event and disarms the detector.
  - After firing, the detector re-arms only once BOTH conditions hold:
      * ``reset_seen`` (a ``False`` sample has been observed since the last
        event) — skipped entirely when ``require_low_between_events=False``;
      * ``frame - last_event_frame >= min_separation_frames``.
  - The two gates are independent and sticky, so a brief ``False`` followed
    by a long plateau of ``True`` still re-arms once the debounce elapses.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .event import CriticalEvent


@dataclass(frozen=True)
class RisingEdgeConfig:
    min_separation_frames: int
    require_low_between_events: bool = True


class RisingEdgeDetector:
    def __init__(self, config: RisingEdgeConfig) -> None:
        if config.min_separation_frames < 0:
            raise ValueError(
                f"min_separation_frames must be >= 0 (got {config.min_separation_frames})"
            )
        self.config = config

    def detect(
        self,
        episode_index: int,
        mask: np.ndarray,
        episode_length: int,
    ) -> list[CriticalEvent]:
        self._validate_mask(mask, episode_length)
        events: list[CriticalEvent] = []
        armed = True
        last_event_frame: int | None = None
        reset_seen = False
        for frame in range(episode_length):
            value = bool(mask[frame])
            armed, reset_seen = self._maybe_rearm(
                armed, reset_seen, value, frame, last_event_frame
            )
            if armed and value:
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

    def _validate_mask(self, mask: np.ndarray, episode_length: int) -> None:
        if mask.dtype != np.bool_:
            raise ValueError(f"mask dtype must be bool (got {mask.dtype})")
        if mask.shape != (episode_length,):
            raise ValueError(
                f"mask shape {mask.shape} does not match episode_length "
                f"({episode_length},)"
            )

    def _maybe_rearm(
        self,
        armed: bool,
        reset_seen: bool,
        value: bool,
        frame: int,
        last_event_frame: int | None,
    ) -> tuple[bool, bool]:
        if armed or last_event_frame is None:
            return armed, reset_seen
        if not value:
            reset_seen = True
        gap_ok = (frame - last_event_frame) >= self.config.min_separation_frames
        low_ok = reset_seen or not self.config.require_low_between_events
        if low_ok and gap_ok:
            return True, reset_seen
        return False, reset_seen
