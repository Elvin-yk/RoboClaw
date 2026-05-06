"""Pydantic response schemas for /api/trajectory-viz/*."""

from __future__ import annotations

from pydantic import BaseModel


class JointLimitDeg(BaseModel):
    lower_deg: float
    upper_deg: float


class SceneSpec(BaseModel):
    arm_separation_m: float
    left_base_xyz: tuple[float, float, float]
    right_base_xyz: tuple[float, float, float]
    forward_axis: str
    lateral_axis: str
    up_axis: str


class So101ModelResponse(BaseModel):
    model: str
    urdf_url: str
    asset_base_url: str
    ee_link: str
    joint_order: tuple[str, ...]
    joint_unit: str
    joint_limits_deg: dict[str, JointLimitDeg]
    scene: SceneSpec


class ArmTrajectory(BaseModel):
    joint_degrees: dict[str, list[float]]


class QualityFlag(BaseModel):
    frame: int
    arm: str
    joint: str
    code: str
    value: float


class TrajectoryUnits(BaseModel):
    arm_joints: str = "degrees"
    gripper: str = "degrees"


class TrajectoryArms(BaseModel):
    left: ArmTrajectory
    right: ArmTrajectory


class TrajectoryPayload(BaseModel):
    dataset: str
    source: str
    episode_index: int
    signal: str
    fps: float
    frame_count: int
    duration_s: float
    time_s: list[float]
    frame_index: list[int]
    units: TrajectoryUnits
    arms: TrajectoryArms
    quality_flags: list[QualityFlag]
