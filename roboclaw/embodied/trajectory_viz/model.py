"""Static SO101 arm-model metadata for the trajectory replay viewer."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from roboclaw.embodied.embodiment.arm.registry import get_runtime_spec


ASSETS_DIR = Path(__file__).parent / "assets"
SO101_ASSET_SUBPATH = "so101"
SO101_URDF_FILENAME = "so101_new_calib.urdf"


@dataclass(frozen=True)
class JointLimit:
    lower_rad: float
    upper_rad: float


@dataclass(frozen=True)
class ArmModel:
    """Renderer-facing description of one arm model.

    Joint values from datasets are interpreted as **degrees** for every joint
    (LeRobot SO101 `use_degrees=True` convention, including the gripper revolute
    joint). The browser converts to radians before applying to the URDF.
    """

    name: str
    asset_subpath: str
    urdf_filename: str
    ee_link: str
    joint_order: tuple[str, ...]
    joint_unit: str
    joint_limits_rad: dict[str, JointLimit]

    @property
    def asset_dir(self) -> Path:
        return ASSETS_DIR / self.asset_subpath


SO101_FOLLOWER = ArmModel(
    name="so101_follower",
    asset_subpath=SO101_ASSET_SUBPATH,
    urdf_filename=SO101_URDF_FILENAME,
    ee_link="gripper_frame_link",
    joint_order=get_runtime_spec("so101").default_joint_names,
    joint_unit="degrees",
    joint_limits_rad={
        "shoulder_pan": JointLimit(-1.91986, 1.91986),
        "shoulder_lift": JointLimit(-1.74533, 1.74533),
        "elbow_flex": JointLimit(-1.69, 1.69),
        "wrist_flex": JointLimit(-1.65806, 1.65806),
        "wrist_roll": JointLimit(-2.74385, 2.84121),
        "gripper": JointLimit(-0.174533, 1.74533),
    },
)
