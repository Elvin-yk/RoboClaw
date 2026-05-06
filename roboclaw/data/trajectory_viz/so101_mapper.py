"""Map a LeRobot bimanual SO101 episode into per-arm joint columns.

Schema requirement: `info.json` exposes a 12-D `action` and 12-D
`observation.state` whose `names` follow the pattern `<side>_<joint>.pos` with
`side ∈ {left, right}` and `joint ∈ SO101_JOINT_ORDER`. Joint values are
interpreted as **degrees** (LeRobot SO101 `use_degrees=True`), including the
gripper. Mismatched schemas raise instead of being silently coerced.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from roboclaw.data.curation.features import resolve_frame_index, resolve_timestamp
from roboclaw.embodied.trajectory_viz.model import SO101_FOLLOWER


SO101_JOINT_ORDER: tuple[str, ...] = SO101_FOLLOWER.joint_order
SIDES: tuple[str, ...] = ("left", "right")
SUPPORTED_SIGNALS: tuple[str, ...] = ("state", "action")
_FEATURE_KEY_BY_SIGNAL = {"state": "observation.state", "action": "action"}


@dataclass(frozen=True)
class FeatureLayout:
    """Index map from `(side, joint)` → column index in the flat 12-D vector."""

    signal: str
    feature_key: str
    side_joint_to_index: dict[tuple[str, str], int]

    @property
    def expected_size(self) -> int:
        return len(self.side_joint_to_index)


@dataclass(frozen=True)
class MappedEpisode:
    """Per-arm joint columns plus quality flags for one episode + signal."""

    time_s: list[float]
    frame_index: list[int]
    arms: dict[str, dict[str, list[float]]]  # arms[side][joint] = [values]
    quality_flags: list[dict[str, Any]]


class SchemaError(ValueError):
    """Raised when a dataset cannot be mapped as bimanual SO101."""


def _parse_so101_pos_name(name: str) -> tuple[str, str] | None:
    if not name.endswith(".pos"):
        return None
    stem = name[: -len(".pos")]
    for joint in SO101_JOINT_ORDER:
        suffix = f"_{joint}"
        if stem.endswith(suffix):
            side = stem[: -len(suffix)]
            if side in SIDES:
                return side, joint
    return None


def build_feature_layout(info: dict[str, Any], signal: str) -> FeatureLayout:
    if signal not in SUPPORTED_SIGNALS:
        raise SchemaError(f"Unsupported signal '{signal}'; expected one of {SUPPORTED_SIGNALS}")
    feature_key = _FEATURE_KEY_BY_SIGNAL[signal]
    feature = info.get("features", {}).get(feature_key)
    if not isinstance(feature, dict):
        raise SchemaError(f"Dataset features missing '{feature_key}'")
    names = feature.get("names")
    if not isinstance(names, list) or not names:
        raise SchemaError(f"Dataset feature '{feature_key}' has no names list")

    layout: dict[tuple[str, str], int] = {}
    for index, raw_name in enumerate(names):
        parsed = _parse_so101_pos_name(str(raw_name))
        if parsed is None:
            raise SchemaError(
                f"Feature name '{raw_name}' does not match bimanual SO101 pattern <side>_<joint>.pos"
            )
        if parsed in layout:
            raise SchemaError(f"Duplicate feature for {parsed[0]}/{parsed[1]}")
        layout[parsed] = index

    expected = {(side, joint) for side in SIDES for joint in SO101_JOINT_ORDER}
    missing = expected - layout.keys()
    if missing:
        examples = ", ".join(sorted(f"{s}_{j}" for s, j in missing))
        raise SchemaError(f"Bimanual SO101 layout missing entries: {examples}")
    if layout.keys() != expected:
        extra = ", ".join(sorted(f"{s}_{j}" for s, j in layout.keys() - expected))
        raise SchemaError(f"Unexpected SO101 features: {extra}")
    return FeatureLayout(signal=signal, feature_key=feature_key, side_joint_to_index=layout)


def _flag_out_of_limits(
    side: str, joint: str, frame: int, value_deg: float
) -> dict[str, Any] | None:
    limit = SO101_FOLLOWER.joint_limits_rad[joint]
    lower_deg = math.degrees(limit.lower_rad)
    upper_deg = math.degrees(limit.upper_rad)
    if value_deg < lower_deg or value_deg > upper_deg:
        return {
            "frame": frame,
            "arm": side,
            "joint": joint,
            "code": "out_of_urdf_limit",
            "value": float(value_deg),
        }
    return None


def map_so101_dual_arm_episode(
    *, info: dict[str, Any], rows: list[dict[str, Any]], signal: str
) -> MappedEpisode:
    layout = build_feature_layout(info, signal)
    arms = {side: {joint: [] for joint in SO101_JOINT_ORDER} for side in SIDES}
    time_s: list[float] = []
    frame_index: list[int] = []
    quality_flags: list[dict[str, Any]] = []

    for frame_idx, row in enumerate(rows):
        vector = row.get(layout.feature_key)
        if vector is None:
            raise SchemaError(f"Row {frame_idx} missing '{layout.feature_key}'")
        seq = list(vector)
        if len(seq) != layout.expected_size:
            raise SchemaError(
                f"Row {frame_idx} '{layout.feature_key}' has size {len(seq)}, expected {layout.expected_size}"
            )

        ts = resolve_timestamp(row)
        time_s.append(float(ts) if ts is not None else float(frame_idx))
        frame_index.append(resolve_frame_index(row, frame_idx))

        for (side, joint), column in layout.side_joint_to_index.items():
            value = float(seq[column])
            arms[side][joint].append(value)
            flag = _flag_out_of_limits(side, joint, frame_idx, value)
            if flag is not None:
                quality_flags.append(flag)

    return MappedEpisode(
        time_s=time_s,
        frame_index=frame_index,
        arms=arms,
        quality_flags=quality_flags,
    )
