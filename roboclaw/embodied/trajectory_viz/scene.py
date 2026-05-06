"""Static dual-arm scene constants for the trajectory replay viewer.

Two SO101 follower arms face the same direction, mounted side-by-side on a
shared baseline with 0.23 m horizontal separation. Convention:

  +X: forward (the direction both arms face)
  +Y: operator left
  +Z: up
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class DualArmSceneSpec:
    arm_separation_m: float
    left_base_xyz: tuple[float, float, float]
    right_base_xyz: tuple[float, float, float]
    forward_axis: str
    lateral_axis: str
    up_axis: str


DUAL_SO101_SCENE = DualArmSceneSpec(
    arm_separation_m=0.23,
    left_base_xyz=(0.0, 0.115, 0.0),
    right_base_xyz=(0.0, -0.115, 0.0),
    forward_axis="+X",
    lateral_axis="+Y",
    up_axis="+Z",
)
