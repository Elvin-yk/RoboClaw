"""Episode-side trajectory extraction for the SO101 dual-arm replay viewer.

Reuses `roboclaw.data.curation.episode_loader` for parquet/info loading and
`roboclaw.data.explorer.dual_source` for source resolution. The framework
side (URDF + scene constants) lives in `roboclaw.embodied.trajectory_viz`.

Offline EE-distance helpers (`DualArmKinematics`, `summarize_distance_series`,
etc.) live alongside the trajectory builder so callers can do FK + filter +
stats without crossing into the FE code.
"""

from roboclaw.data.trajectory_viz.distance_series import (
    BelowThresholdRange,
    DistanceStats,
    downsample_distance_series,
    find_below_threshold_ranges,
    summarize_distance_series,
)
from roboclaw.data.trajectory_viz.kinematics import DualArmKinematics, EpisodeEEDistanceProvider
from roboclaw.data.trajectory_viz.schemas import (
    ArmTrajectory,
    QualityFlag,
    SceneSpec,
    So101ModelResponse,
    TrajectoryPayload,
)
from roboclaw.data.trajectory_viz.so101_mapper import map_so101_dual_arm_episode
from roboclaw.data.trajectory_viz.sources import resolve_episode_dataset
from roboclaw.data.trajectory_viz.trajectory import build_trajectory_payload

__all__ = [
    "ArmTrajectory",
    "BelowThresholdRange",
    "DistanceStats",
    "DualArmKinematics",
    "EpisodeEEDistanceProvider",
    "QualityFlag",
    "SceneSpec",
    "So101ModelResponse",
    "TrajectoryPayload",
    "build_trajectory_payload",
    "downsample_distance_series",
    "find_below_threshold_ranges",
    "map_so101_dual_arm_episode",
    "resolve_episode_dataset",
    "summarize_distance_series",
]
