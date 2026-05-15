from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from roboclaw.data.curation.features import (
    extract_action_names,
    extract_state_names,
    resolve_action_vector,
    resolve_frame_index,
    resolve_state_vector,
    resolve_timestamp,
)
from roboclaw.data.curation.validators import load_episode_data
from roboclaw.embodied.embodiment.arm.visualization import RobotVisualizationSpec

TrajectorySignal = Literal["action", "state"]
ArmName = Literal["left", "right"]


def build_episode_robot_trajectory(
    dataset_path: Path,
    dataset_name: str,
    episode_index: int,
    *,
    source: str,
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[str, Any]:
    data = load_episode_data(dataset_path, episode_index)
    rows = data.get("rows", [])
    if not rows:
        return _empty_payload(dataset_name, episode_index, source, signal, spec)

    info = data.get("info", {})
    feature_names = _feature_names(info, signal)
    index_map = _joint_index_map(feature_names, spec)
    time_values = _time_values(rows)
    frame_values = [resolve_frame_index(row, index) for index, row in enumerate(rows)]
    arms = _collect_arm_joint_degrees(rows, index_map, signal, spec)
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
        "frame_index": frame_values,
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
            "left": {"joint_degrees": {joint: [] for joint in spec.joint_order}},
            "right": {"joint_degrees": {joint: [] for joint in spec.joint_order}},
        },
    }


def _feature_names(info: dict[str, Any], signal: TrajectorySignal) -> list[str]:
    return extract_action_names(info) if signal == "action" else extract_state_names(info)


def _joint_index_map(
    feature_names: list[str],
    spec: RobotVisualizationSpec,
) -> dict[ArmName, dict[str, int]]:
    expected_joints = set(spec.joint_order)
    index_map: dict[ArmName, dict[str, int]] = {"left": {}, "right": {}}
    for index, feature_name in enumerate(feature_names):
        parsed = _parse_bimanual_feature_name(feature_name)
        if parsed is None:
            continue
        arm, joint_name = parsed
        if joint_name in expected_joints:
            index_map[arm][joint_name] = index

    missing = [
        f"{arm}_{joint}.pos"
        for arm in ("left", "right")
        for joint in spec.joint_order
        if joint not in index_map[arm]
    ]
    if missing:
        raise ValueError(f"Robot trajectory schema is missing required joints: {', '.join(missing)}")
    return index_map


def _parse_bimanual_feature_name(feature_name: str) -> tuple[ArmName, str] | None:
    if not feature_name.endswith(".pos"):
        return None
    bare_name = feature_name.removesuffix(".pos")
    for arm in ("left", "right"):
        prefix = f"{arm}_"
        if bare_name.startswith(prefix):
            return arm, bare_name.removeprefix(prefix)
    return None


def _time_values(rows: list[dict[str, Any]]) -> list[float]:
    values: list[float] = []
    for index, row in enumerate(rows):
        timestamp = resolve_timestamp(row)
        values.append(float(timestamp) if timestamp is not None else float(index))
    return values


def _collect_arm_joint_degrees(
    rows: list[dict[str, Any]],
    index_map: dict[ArmName, dict[str, int]],
    signal: TrajectorySignal,
    spec: RobotVisualizationSpec,
) -> dict[str, dict[str, dict[str, list[float | None]]]]:
    joint_degrees: dict[ArmName, dict[str, list[float | None]]] = {
        "left": {joint: [] for joint in spec.joint_order},
        "right": {joint: [] for joint in spec.joint_order},
    }
    for row in rows:
        vector = resolve_action_vector(row) if signal == "action" else resolve_state_vector(row)
        for arm in ("left", "right"):
            for joint_name in spec.joint_order:
                joint_degrees[arm][joint_name].append(_vector_value(vector, index_map[arm][joint_name]))

    return {
        "left": {"joint_degrees": joint_degrees["left"]},
        "right": {"joint_degrees": joint_degrees["right"]},
    }


def _vector_value(vector: list[Any], index: int) -> float | None:
    if index >= len(vector):
        return None
    value = vector[index]
    if value is None:
        return None
    return float(value)
