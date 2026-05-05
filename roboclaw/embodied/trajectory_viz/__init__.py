"""SO101 trajectory visualization framework assets and static metadata.

Holds the canonical SO101 URDF + STL meshes plus the static `ArmModel` /
`DualArmSceneSpec` descriptors that drive the dashboard 3D replay viewer.
This package is data-free at runtime — episode loading lives in
`roboclaw.data.trajectory_viz`.
"""

from roboclaw.embodied.trajectory_viz.model import ArmModel, SO101_FOLLOWER
from roboclaw.embodied.trajectory_viz.scene import DualArmSceneSpec, DUAL_SO101_SCENE

__all__ = ["ArmModel", "SO101_FOLLOWER", "DualArmSceneSpec", "DUAL_SO101_SCENE"]
