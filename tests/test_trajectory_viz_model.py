"""Drift guard: SO101_FOLLOWER joint limits must match the shipped URDF.

The Python metadata is hardcoded for fast access; the URDF is the visual+FK
source of truth. If they diverge, the renderer and the quality-flag math will
disagree about what counts as "out of limit".
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

import pytest

from roboclaw.embodied.trajectory_viz.model import SO101_FOLLOWER


def _urdf_revolute_limits() -> dict[str, tuple[float, float]]:
    tree = ET.parse(SO101_FOLLOWER.asset_dir / SO101_FOLLOWER.urdf_filename)
    out: dict[str, tuple[float, float]] = {}
    for joint in tree.getroot().iter("joint"):
        if joint.get("type") != "revolute":
            continue
        name = joint.get("name") or ""
        limit = joint.find("limit")
        if limit is None:
            continue
        lower = float(limit.get("lower", "0"))
        upper = float(limit.get("upper", "0"))
        out[name] = (lower, upper)
    return out


def test_so101_python_limits_match_urdf() -> None:
    urdf = _urdf_revolute_limits()
    for joint, expected in SO101_FOLLOWER.joint_limits_rad.items():
        assert joint in urdf, f"URDF missing revolute joint {joint!r}"
        urdf_lower, urdf_upper = urdf[joint]
        assert expected.lower_rad == pytest.approx(urdf_lower, abs=1e-5), joint
        assert expected.upper_rad == pytest.approx(urdf_upper, abs=1e-5), joint
