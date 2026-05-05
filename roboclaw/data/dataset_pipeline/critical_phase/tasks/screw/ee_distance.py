"""Inter-EE distance provider interface for the screw task.

Bimanual screw insertion only counts as a critical event when the two
end-effectors are close enough to one another. Computing this distance from
joint state requires forward kinematics that lives on the
``shuyuan/traj-viz`` branch; until that lands, we ship a Protocol so the
pipeline can plumb a real provider through ``run(..., ee_provider=...)`` and
a stub that fails loudly if the user forgets to inject one.
"""
from __future__ import annotations

from typing import Protocol

import numpy as np
import pyarrow as pa


class EpisodeEEDistanceProvider(Protocol):
    """Return per-frame inter-EE distance, in meters, for a single episode."""

    def distance_trace(
        self,
        parquet: pa.Table,
        episode_index: int,
        num_frames: int,
    ) -> np.ndarray: ...


class NotImplementedEEDistanceProvider:
    """Default stub: refuses to fabricate distances. Real provider lands later."""

    def distance_trace(
        self,
        parquet: pa.Table,
        episode_index: int,
        num_frames: int,
    ) -> np.ndarray:
        raise NotImplementedError(
            "Bimanual EE distance computation lands via shuyuan/traj-viz; "
            "supply a real EpisodeEEDistanceProvider to enable screw event detection."
        )
