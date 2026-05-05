"""Build a `TrajectoryPayload` from a resolved dataset path."""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException

from roboclaw.data.curation.episode_loader import load_episode_data
from roboclaw.data.trajectory_viz.schemas import (
    ArmTrajectory,
    QualityFlag,
    TrajectoryArms,
    TrajectoryPayload,
    TrajectoryUnits,
)
from roboclaw.data.trajectory_viz.so101_mapper import (
    SchemaError,
    map_so101_dual_arm_episode,
)
from roboclaw.data.trajectory_viz.sources import TrajectorySource


MAX_TRAJECTORY_FRAMES = 30_000


def _slice_arm(
    arm: dict[str, list[float]], start: int, end: int, stride: int
) -> dict[str, list[float]]:
    return {joint: series[start:end:stride] for joint, series in arm.items()}


def build_trajectory_payload(
    *,
    source: TrajectorySource,
    dataset_label: str,
    dataset_path: Path,
    episode_index: int,
    signal: str,
    start_frame: int | None,
    end_frame: int | None,
    stride: int,
) -> TrajectoryPayload:
    if stride < 1:
        raise HTTPException(status_code=422, detail="stride must be >= 1")
    episode = load_episode_data(dataset_path, episode_index, include_videos=False)
    info = episode["info"]
    rows = episode["rows"]
    if not rows:
        raise HTTPException(status_code=422, detail="Episode has no rows")

    try:
        mapped = map_so101_dual_arm_episode(info=info, rows=rows, signal=signal)
    except SchemaError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    full_count = len(mapped.time_s)
    start = 0 if start_frame is None else max(0, int(start_frame))
    end = full_count if end_frame is None else min(full_count, int(end_frame))
    if start >= end:
        raise HTTPException(status_code=422, detail="Empty frame window after slicing")

    sliced_count = (end - start + stride - 1) // stride
    if sliced_count > MAX_TRAJECTORY_FRAMES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Sliced episode has {sliced_count} frames (max {MAX_TRAJECTORY_FRAMES}); "
                "increase stride or narrow the frame window."
            ),
        )

    fps = float(info.get("fps", 30.0) or 30.0)
    time_s = mapped.time_s[start:end:stride]
    frame_index = mapped.frame_index[start:end:stride]
    arms = TrajectoryArms(
        left=ArmTrajectory(joint_degrees=_slice_arm(mapped.arms["left"], start, end, stride)),
        right=ArmTrajectory(joint_degrees=_slice_arm(mapped.arms["right"], start, end, stride)),
    )
    duration = (time_s[-1] - time_s[0]) if len(time_s) >= 2 else 0.0

    flags = [
        QualityFlag(**{**flag, "frame": (flag["frame"] - start) // stride})
        for flag in mapped.quality_flags
        if start <= flag["frame"] < end and (flag["frame"] - start) % stride == 0
    ]

    return TrajectoryPayload(
        dataset=dataset_label,
        source=source,
        episode_index=episode_index,
        signal=signal,
        fps=fps,
        frame_count=len(time_s),
        duration_s=duration,
        time_s=time_s,
        frame_index=frame_index,
        units=TrajectoryUnits(),
        arms=arms,
        quality_flags=flags,
    )
