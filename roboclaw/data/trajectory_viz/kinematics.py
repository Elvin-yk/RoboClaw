"""Headless dual-arm forward kinematics for SO101.

Python parallel of ``ui/src/domains/curation/trajectory-viz/kinematics.ts``.
Two ``RobotKinematics`` instances (one per arm) share the same SO101 URDF;
the per-arm world-frame base offset comes from ``DUAL_SO101_SCENE``.

Distance is reported in meters between the left and right ``ee_link`` origins.
``RobotKinematics.forward_kinematics`` returns the EE pose in the URDF's own
root frame (the URDF has no per-side base translation), so this module adds
each arm's world-frame base offset on top before differencing.

Invariants
----------
- Per-arm base offsets are pure translations. Adding ``base_xyz`` to the EE
  translation column is equivalent to wrapping the URDF in the FE
  ``THREE.Group`` only as long as the FE / scene constants stay translation-
  only with identity rotation. If ``DualArmSceneSpec`` ever grows a base
  orientation, both this module and the FE must switch to full 4x4 transforms.
- Not thread-safe: each ``RobotKinematics`` mutates placo solver state on
  every ``forward_kinematics`` call. Use one ``DualArmKinematics`` per worker.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from lerobot.model.kinematics import RobotKinematics
from roboclaw.embodied.trajectory_viz.model import SO101_FOLLOWER
from roboclaw.embodied.trajectory_viz.scene import DUAL_SO101_SCENE


class DualArmKinematics:
    """Headless dual-arm forward kinematics for a single SO101 model.

    Parameters
    ----------
    urdf_path: Path or str pointing at the shared SO101 URDF.
    joint_names: Joint name order matching the input arrays. Same list is used
        for both arms.
    ee_link: URDF link to read the EE pose from (default ``gripper_frame_link``).
    left_base_xyz / right_base_xyz: per-arm world-frame base translation in
        meters.
    """

    def __init__(
        self,
        urdf_path: str | Path,
        joint_names: list[str],
        ee_link: str = "gripper_frame_link",
        left_base_xyz: tuple[float, float, float] = (0.0, 0.115, 0.0),
        right_base_xyz: tuple[float, float, float] = (0.0, -0.115, 0.0),
    ) -> None:
        urdf_str = str(urdf_path)
        self._joint_names = list(joint_names)
        self._ee_link = ee_link
        self._left_base = np.asarray(left_base_xyz, dtype=np.float64)
        self._right_base = np.asarray(right_base_xyz, dtype=np.float64)
        self._left = RobotKinematics(
            urdf_path=urdf_str,
            target_frame_name=ee_link,
            joint_names=self._joint_names,
        )
        self._right = RobotKinematics(
            urdf_path=urdf_str,
            target_frame_name=ee_link,
            joint_names=self._joint_names,
        )

    @classmethod
    def for_so101(cls) -> "DualArmKinematics":
        """Wire the bundled SO101 URDF + dual-arm scene constants."""
        urdf_path = SO101_FOLLOWER.asset_dir / SO101_FOLLOWER.urdf_filename
        return cls(
            urdf_path=urdf_path,
            joint_names=list(SO101_FOLLOWER.joint_order),
            ee_link=SO101_FOLLOWER.ee_link,
            left_base_xyz=DUAL_SO101_SCENE.left_base_xyz,
            right_base_xyz=DUAL_SO101_SCENE.right_base_xyz,
        )

    @property
    def joint_names(self) -> list[str]:
        return list(self._joint_names)

    def distance_at_frame(self, left_deg: np.ndarray, right_deg: np.ndarray) -> float:
        """Distance between left/right EE for a single frame (meters)."""
        left_pos = self._ee_world_position(self._left, left_deg, self._left_base)
        right_pos = self._ee_world_position(self._right, right_deg, self._right_base)
        return float(np.linalg.norm(left_pos - right_pos))

    def compute_distance_series(
        self, left_deg: np.ndarray, right_deg: np.ndarray
    ) -> np.ndarray:
        """Distance per frame for ``(T, J)`` joint trajectories.

        Returns a float32 ndarray of length ``T``. Mismatched shapes raise.
        """
        left = np.asarray(left_deg)
        right = np.asarray(right_deg)
        if left.ndim != 2 or right.ndim != 2:
            raise ValueError(
                f"left_deg/right_deg must be 2-D (T, J); got shapes {left.shape}, {right.shape}"
            )
        if left.shape != right.shape:
            raise ValueError(
                f"left_deg/right_deg shapes differ: {left.shape} vs {right.shape}"
            )
        expected_j = len(self._joint_names)
        if left.shape[1] != expected_j:
            raise ValueError(
                f"left_deg/right_deg second dim must equal len(joint_names)={expected_j}; got {left.shape[1]}"
            )
        total = left.shape[0]
        out = np.empty(total, dtype=np.float32)
        for i in range(total):
            out[i] = self.distance_at_frame(left[i], right[i])
        return out

    def _ee_world_position(
        self, arm: RobotKinematics, joints_deg: np.ndarray, base_xyz: np.ndarray
    ) -> np.ndarray:
        joints = np.asarray(joints_deg, dtype=np.float64)
        if joints.shape != (len(self._joint_names),):
            raise ValueError(
                f"Expected joint vector of shape ({len(self._joint_names)},); got {joints.shape}"
            )
        transform = arm.forward_kinematics(joints)
        return transform[:3, 3] + base_xyz


class EpisodeEEDistanceProvider:
    """Adapter exposing the offline-pipeline ``distance_trace`` contract.

    The input is a single bimanual action vector of shape ``(num_frames, 12)``
    — 6 left joints followed by 6 right joints, in degrees, ordered to match
    ``DualArmKinematics.joint_names``. The output is a ``float64`` distance
    series of length ``num_frames`` (meters).

    ``episode_index`` is accepted for the contract but unused: forward
    kinematics is stateless across episodes; the caller already has the
    relevant action slice for the episode.
    """

    def __init__(self, kinematics: DualArmKinematics | None = None) -> None:
        self._kinematics = kinematics if kinematics is not None else DualArmKinematics.for_so101()
        self._joint_count = len(self._kinematics.joint_names)

    @property
    def kinematics(self) -> DualArmKinematics:
        return self._kinematics

    def distance_trace(
        self,
        episode_index: int,  # noqa: ARG002 — informational; FK is stateless
        action: np.ndarray,
        num_frames: int,
    ) -> np.ndarray:
        del episode_index
        expected_dim = 2 * self._joint_count
        if action.shape != (num_frames, expected_dim):
            raise ValueError(
                f"action must have shape ({num_frames}, {expected_dim}); got {action.shape}"
            )
        left = action[:, : self._joint_count]
        right = action[:, self._joint_count :]
        series = self._kinematics.compute_distance_series(left, right)
        return series.astype(np.float64, copy=False)
