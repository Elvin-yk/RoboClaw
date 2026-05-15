from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RobotSceneSpec:
    left_base_xyz: tuple[float, float, float]
    right_base_xyz: tuple[float, float, float]

    def to_dict(self) -> dict[str, list[float]]:
        return {
            "left_base_xyz": list(self.left_base_xyz),
            "right_base_xyz": list(self.right_base_xyz),
        }


@dataclass(frozen=True)
class RobotVisualizationSpec:
    model: str
    asset_id: str
    asset_version: str
    joint_order: tuple[str, ...]
    ee_link: str
    scene: RobotSceneSpec
    trajectory_schema: str

    def to_manifest_fields(self) -> dict[str, Any]:
        return {
            "model": self.model,
            "asset_version": self.asset_version,
            "joint_order": list(self.joint_order),
            "ee_link": self.ee_link,
            "scene": self.scene.to_dict(),
            "trajectory_schema": self.trajectory_schema,
        }


SO101_VISUALIZATION_SPEC = RobotVisualizationSpec(
    model="so101",
    asset_id="so101",
    asset_version="2026.05.15",
    joint_order=(
        "shoulder_pan",
        "shoulder_lift",
        "elbow_flex",
        "wrist_flex",
        "wrist_roll",
        "gripper",
    ),
    ee_link="gripper",
    scene=RobotSceneSpec(
        left_base_xyz=(0.0, 0.115, 0.0),
        right_base_xyz=(0.0, -0.115, 0.0),
    ),
    trajectory_schema="bimanual_prefixed_joint_degrees",
)

ROBOT_VISUALIZATION_SPECS: dict[str, RobotVisualizationSpec] = {
    SO101_VISUALIZATION_SPEC.model: SO101_VISUALIZATION_SPEC,
}


def get_robot_visualization_spec(model: str) -> RobotVisualizationSpec:
    normalized = model.strip().lower()
    spec = ROBOT_VISUALIZATION_SPECS.get(normalized)
    if spec is None:
        raise KeyError(model)
    return spec
