"""Tests for ``roboclaw.data.trajectory_viz.kinematics``.

Skipped automatically when ``placo`` is not installed (it is an optional
``kinematics`` extra of lerobot).
"""

from __future__ import annotations

import numpy as np
import pytest

pytest.importorskip("placo")

from roboclaw.data.trajectory_viz.kinematics import DualArmKinematics  # noqa: E402
from roboclaw.embodied.trajectory_viz.model import SO101_FOLLOWER  # noqa: E402
from roboclaw.embodied.trajectory_viz.scene import DUAL_SO101_SCENE  # noqa: E402


def _zero_joints() -> np.ndarray:
    return np.zeros(len(SO101_FOLLOWER.joint_order), dtype=np.float64)


def _expected_base_distance() -> float:
    left = np.asarray(DUAL_SO101_SCENE.left_base_xyz)
    right = np.asarray(DUAL_SO101_SCENE.right_base_xyz)
    return float(np.linalg.norm(left - right))


def test_zero_joints_distance_equals_arm_separation() -> None:
    kin = DualArmKinematics.for_so101()
    distance = kin.distance_at_frame(_zero_joints(), _zero_joints())
    # With both arms at zero pose the EE pose in the URDF root frame is identical;
    # only the per-arm base offset differs.
    assert distance == pytest.approx(_expected_base_distance(), abs=1e-6)
    assert distance == pytest.approx(DUAL_SO101_SCENE.arm_separation_m, abs=1e-6)


def test_distance_is_symmetric_when_arms_and_bases_swap_together() -> None:
    """Both arms share one URDF, so per-arm world EE = base + f(joints).

    Swapping joints alone breaks the mapping (left base + f(R) != right base + f(L)),
    but swapping joints AND base offsets together must produce the identical
    distance.
    """
    left_joints = np.array([10.0, -5.0, 12.0, 3.0, -7.0, 0.0])
    right_joints = np.array([0.0, 8.0, -4.0, 2.0, 6.0, -3.0])
    forward = DualArmKinematics.for_so101()
    swapped = DualArmKinematics(
        urdf_path=SO101_FOLLOWER.asset_dir / SO101_FOLLOWER.urdf_filename,
        joint_names=list(SO101_FOLLOWER.joint_order),
        ee_link=SO101_FOLLOWER.ee_link,
        left_base_xyz=DUAL_SO101_SCENE.right_base_xyz,
        right_base_xyz=DUAL_SO101_SCENE.left_base_xyz,
    )
    d_forward = forward.distance_at_frame(left_joints, right_joints)
    d_swapped = swapped.distance_at_frame(right_joints, left_joints)
    assert d_forward == pytest.approx(d_swapped, abs=1e-6)


def test_compute_distance_series_matches_per_frame_calls() -> None:
    kin = DualArmKinematics.for_so101()
    rng = np.random.default_rng(seed=0)
    j = len(SO101_FOLLOWER.joint_order)
    left = rng.uniform(-30.0, 30.0, size=(4, j))
    right = rng.uniform(-30.0, 30.0, size=(4, j))
    series = kin.compute_distance_series(left, right)
    assert series.shape == (4,)
    assert series.dtype == np.float32
    for i in range(4):
        per_frame = kin.distance_at_frame(left[i], right[i])
        assert series[i] == pytest.approx(per_frame, abs=1e-6)


def test_wrong_joint_count_raises() -> None:
    kin = DualArmKinematics.for_so101()
    bad = np.zeros(len(SO101_FOLLOWER.joint_order) - 1)
    with pytest.raises(ValueError):
        kin.distance_at_frame(bad, _zero_joints())


def test_compute_distance_series_wrong_J_raises() -> None:
    kin = DualArmKinematics.for_so101()
    j = len(SO101_FOLLOWER.joint_order)
    # (T=4, J-1) — wrong second dim, including the (T=0) edge.
    with pytest.raises(ValueError):
        kin.compute_distance_series(np.zeros((4, j - 1)), np.zeros((4, j - 1)))
    with pytest.raises(ValueError):
        kin.compute_distance_series(np.zeros((0, j - 1)), np.zeros((0, j - 1)))


def test_for_so101_factory_no_args_zero_joints_distance() -> None:
    kin = DualArmKinematics.for_so101()
    distance = kin.distance_at_frame(_zero_joints(), _zero_joints())
    assert distance == pytest.approx(DUAL_SO101_SCENE.arm_separation_m, abs=1e-6)
