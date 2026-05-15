from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from roboclaw.data.curation.features import (
    build_joint_trajectory_payload,
    extract_action_names,
    extract_state_names,
)
from roboclaw.data.curation.validators import load_episode_data
from roboclaw.embodied.embodiment.arm.visualization import RobotVisualizationSpec

TrajectorySignal = Literal["action", "state"]
ArmName = Literal["left", "right"]
ARM_SIDES: tuple[ArmName, ...] = ("left", "right")
JOINT_POSITION_SUFFIX = ".pos"


def build_episode_robot_trajectory(
    dataset_path: Path,
    dataset_name: str,
    episode_index: int,
    *,
    source: str,
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[str, Any]:
    data = load_episode_data(dataset_path, episode_index, include_videos=False)
    rows = data.get("rows", [])
    if not rows:
        return _empty_payload(dataset_name, episode_index, source, signal, spec)

    info = data.get("info", {})
    trajectory = build_joint_trajectory_payload(
        rows,
        extract_action_names(info),
        extract_state_names(info),
        max_points=len(rows),
    )
    time_values = trajectory["time_values"]
    arms = _collect_arm_joint_degrees(trajectory["joint_trajectories"], signal, spec)
    duration_s = max(time_values[-1] - time_values[0], 0.0) if time_values else 0.0

    return {
        "model": spec.model,
        "dataset": dataset_name,
        "source": source,
        "episode_index": episode_index,
        "signal": signal,
        "fps": float(info.get("fps", 0) or 0),
        "frame_count": len(rows),
        "duration_s": duration_s,
        "time_s": time_values,
        "frame_index": trajectory["frame_values"],
        "joint_order": list(spec.joint_order),
        "arms": arms,
    }


def _empty_payload(
    dataset_name: str,
    episode_index: int,
    source: str,
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[str, Any]:
    return {
        "model": spec.model,
        "dataset": dataset_name,
        "source": source,
        "episode_index": episode_index,
        "signal": signal,
        "fps": 0.0,
        "frame_count": 0,
        "duration_s": 0.0,
        "time_s": [],
        "frame_index": [],
        "joint_order": list(spec.joint_order),
        "arms": {
            arm: {"joint_degrees": {joint: [] for joint in spec.joint_order}}
            for arm in ARM_SIDES
        },
    }


def _joint_trajectory_map(
    trajectories: list[dict[str, Any]],
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[ArmName, dict[str, list[float | None]]]:
    name_key = f"{signal}_name"
    value_key = f"{signal}_values"
    expected_joints = set(spec.joint_order)
    trajectory_map: dict[ArmName, dict[str, list[float | None]]] = {arm: {} for arm in ARM_SIDES}
    for trajectory in trajectories:
        feature_name = str(trajectory.get(name_key, ""))
        parsed = _parse_bimanual_feature_name(feature_name)
        if parsed is None:
            continue
        arm, joint_name = parsed
        values = trajectory.get(value_key, [])
        if joint_name in expected_joints and isinstance(values, list):
            trajectory_map[arm][joint_name] = values

    missing = [
        f"{arm}_{joint}{JOINT_POSITION_SUFFIX}"
        for arm in ARM_SIDES
        for joint in spec.joint_order
        if joint not in trajectory_map[arm]
    ]
    if missing:
        raise ValueError(f"Robot trajectory schema is missing required joints: {', '.join(missing)}")
    return trajectory_map


def _parse_bimanual_feature_name(feature_name: str) -> tuple[ArmName, str] | None:
    if not feature_name.endswith(JOINT_POSITION_SUFFIX):
        return None
    bare_name = feature_name.removesuffix(JOINT_POSITION_SUFFIX)
    for arm in ARM_SIDES:
        prefix = f"{arm}_"
        if bare_name.startswith(prefix):
            return arm, bare_name.removeprefix(prefix)
    return None


def _collect_arm_joint_degrees(
    trajectories: list[dict[str, Any]],
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[str, dict[str, dict[str, list[float | None]]]]:
    trajectory_map = _joint_trajectory_map(trajectories, signal, spec)
    return {
        arm: {
            "joint_degrees": {
                joint_name: trajectory_map[arm][joint_name]
                for joint_name in spec.joint_order
            }
        }
        for arm in ARM_SIDES
    }
