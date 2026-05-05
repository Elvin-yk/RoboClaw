"""Unit tests for the bimanual SO101 episode mapper."""

from __future__ import annotations

import pytest

from roboclaw.data.trajectory_viz.so101_mapper import (
    SchemaError,
    SO101_JOINT_ORDER,
    build_feature_layout,
    map_so101_dual_arm_episode,
)


def _bimanual_names() -> list[str]:
    names: list[str] = []
    for side in ("left", "right"):
        for joint in SO101_JOINT_ORDER:
            names.append(f"{side}_{joint}.pos")
    return names


def _info(names: list[str]) -> dict:
    return {
        "features": {
            "observation.state": {"dtype": "float32", "shape": [len(names)], "names": names},
            "action": {"dtype": "float32", "shape": [len(names)], "names": names},
        },
    }


def test_layout_accepts_bimanual_so101_schema() -> None:
    layout = build_feature_layout(_info(_bimanual_names()), "state")
    assert layout.expected_size == 12
    assert layout.side_joint_to_index[("left", "shoulder_pan")] == 0
    assert layout.side_joint_to_index[("right", "gripper")] == 11


def test_layout_rejects_unknown_signal() -> None:
    with pytest.raises(SchemaError):
        build_feature_layout(_info(_bimanual_names()), "ghost")


def test_layout_rejects_missing_side() -> None:
    bad = [n for n in _bimanual_names() if not n.startswith("right_")]
    with pytest.raises(SchemaError):
        build_feature_layout(_info(bad), "state")


def test_layout_rejects_unknown_joint() -> None:
    bad = list(_bimanual_names())
    bad[5] = "left_thumb.pos"
    with pytest.raises(SchemaError):
        build_feature_layout(_info(bad), "state")


def test_map_episode_splits_into_left_right_columns() -> None:
    info = _info(_bimanual_names())
    rows = [
        {
            "observation.state": [float(i + frame * 0.1) for i in range(12)],
            "timestamp": frame * (1.0 / 30),
            "frame_index": frame,
        }
        for frame in range(4)
    ]
    mapped = map_so101_dual_arm_episode(info=info, rows=rows, signal="state")
    assert len(mapped.time_s) == 4
    assert mapped.frame_index == [0, 1, 2, 3]
    # left_shoulder_pan column (index 0) values per frame: 0.0, 0.1, 0.2, 0.3
    assert mapped.arms["left"]["shoulder_pan"] == pytest.approx([0.0, 0.1, 0.2, 0.3])
    # right_gripper column (index 11)
    assert mapped.arms["right"]["gripper"] == pytest.approx([11.0, 11.1, 11.2, 11.3])


def test_map_episode_emits_quality_flag_for_out_of_limit() -> None:
    info = _info(_bimanual_names())
    # left_shoulder_lift index = 1, urdf upper ≈ ±100°, so 200° trips it.
    row = [0.0] * 12
    row[1] = 200.0
    rows = [{"observation.state": row, "timestamp": 0.0, "frame_index": 0}]
    mapped = map_so101_dual_arm_episode(info=info, rows=rows, signal="state")
    assert any(
        f["arm"] == "left" and f["joint"] == "shoulder_lift" and f["code"] == "out_of_urdf_limit"
        for f in mapped.quality_flags
    )


def test_map_episode_rejects_wrong_vector_size() -> None:
    info = _info(_bimanual_names())
    rows = [{"observation.state": [0.0] * 11, "timestamp": 0.0, "frame_index": 0}]
    with pytest.raises(SchemaError):
        map_so101_dual_arm_episode(info=info, rows=rows, signal="state")
