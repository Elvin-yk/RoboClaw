"""CriticalEvent: a single critical moment within a source episode.

Task-specific detectors (e.g. the screw task's gripper-open detector under
tasks/screw/) emit lists of CriticalEvent. The window builder consumes these
to produce CriticalInterval frame ranges, and is intentionally unaware of
how each event was found.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CriticalEvent:
    episode_index: int
    event_frame: int
    episode_length: int
