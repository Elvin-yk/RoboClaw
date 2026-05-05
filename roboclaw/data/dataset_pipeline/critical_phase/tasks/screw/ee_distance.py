"""EE-distance provider contract for screw critical-event detection."""
from __future__ import annotations

from typing import Protocol

import numpy as np


class EpisodeEEDistanceProvider(Protocol):
    """Per-episode bimanual EE distance (meters).

    The pipeline owns frame ordering: ``action`` is sorted by ``frame_index``
    and ``action[i]`` corresponds to frame ``i`` of the episode. Providers
    return a length-``num_frames`` 1-D float64 array of inter-EE distance.
    """
    def distance_trace(
        self,
        episode_index: int,
        action: np.ndarray,
        num_frames: int,
    ) -> np.ndarray: ...
