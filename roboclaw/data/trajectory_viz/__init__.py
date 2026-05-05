"""Episode-side trajectory extraction for the SO101 dual-arm replay viewer.

Reuses `roboclaw.data.curation.episode_loader` for parquet/info loading and
`roboclaw.data.explorer.dual_source` for source resolution. The framework
side (URDF + scene constants) lives in `roboclaw.embodied.trajectory_viz`.
"""

from roboclaw.data.trajectory_viz.schemas import (
    ArmTrajectory,
    QualityFlag,
    SceneSpec,
    So101ModelResponse,
    TrajectoryPayload,
)
from roboclaw.data.trajectory_viz.sources import resolve_episode_dataset
from roboclaw.data.trajectory_viz.so101_mapper import map_so101_dual_arm_episode
from roboclaw.data.trajectory_viz.trajectory import build_trajectory_payload

__all__ = [
    "ArmTrajectory",
    "QualityFlag",
    "SceneSpec",
    "So101ModelResponse",
    "TrajectoryPayload",
    "build_trajectory_payload",
    "map_so101_dual_arm_episode",
    "resolve_episode_dataset",
]
