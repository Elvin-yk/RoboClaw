"""Routes for the SO101 dual-arm trajectory replay viewer.

Lives under `/api/trajectory-viz/*` to avoid collision with `/api/replay/*`,
which drives real follower-arm hardware. This module never touches
`EmbodiedService.start_replay` or any executor.
"""

from __future__ import annotations

import math

from fastapi import FastAPI, HTTPException
from starlette.staticfiles import StaticFiles

from roboclaw.data.trajectory_viz.schemas import (
    JointLimitDeg,
    SceneSpec,
    So101ModelResponse,
    TrajectoryPayload,
)
from roboclaw.data.trajectory_viz.sources import resolve_episode_dataset
from roboclaw.data.trajectory_viz.trajectory import build_trajectory_payload
from roboclaw.embodied.trajectory_viz.model import SO101_FOLLOWER
from roboclaw.embodied.trajectory_viz.scene import DUAL_SO101_SCENE


ASSET_URL_PREFIX = "/api/trajectory-viz/assets/so101"


def _so101_model_response() -> So101ModelResponse:
    limits = {
        joint: JointLimitDeg(
            lower_deg=math.degrees(limit.lower_rad),
            upper_deg=math.degrees(limit.upper_rad),
        )
        for joint, limit in SO101_FOLLOWER.joint_limits_rad.items()
    }
    return So101ModelResponse(
        model=SO101_FOLLOWER.name,
        urdf_url=f"{ASSET_URL_PREFIX}/{SO101_FOLLOWER.urdf_filename}",
        asset_base_url=f"{ASSET_URL_PREFIX}/",
        ee_link=SO101_FOLLOWER.ee_link,
        joint_order=SO101_FOLLOWER.joint_order,
        joint_unit=SO101_FOLLOWER.joint_unit,
        joint_limits_deg=limits,
        scene=SceneSpec(
            arm_separation_m=DUAL_SO101_SCENE.arm_separation_m,
            left_base_xyz=DUAL_SO101_SCENE.left_base_xyz,
            right_base_xyz=DUAL_SO101_SCENE.right_base_xyz,
            forward_axis=DUAL_SO101_SCENE.forward_axis,
            lateral_axis=DUAL_SO101_SCENE.lateral_axis,
            up_axis=DUAL_SO101_SCENE.up_axis,
        ),
    )


def register_trajectory_viz_routes(app: FastAPI) -> None:
    asset_dir = SO101_FOLLOWER.asset_dir
    if not asset_dir.is_dir():
        raise RuntimeError(f"SO101 asset directory not found at {asset_dir}")
    app.mount(
        ASSET_URL_PREFIX,
        StaticFiles(directory=str(asset_dir)),
        name="trajectory-viz-so101-assets",
    )

    @app.get("/api/trajectory-viz/model/so101", response_model=So101ModelResponse)
    async def get_so101_model() -> So101ModelResponse:
        return _so101_model_response()

    @app.get("/api/trajectory-viz/trajectory", response_model=TrajectoryPayload)
    async def get_trajectory(
        source: str = "local",
        dataset: str | None = None,
        path: str | None = None,
        episode_index: int = 0,
        signal: str = "state",
        start_frame: int | None = None,
        end_frame: int | None = None,
        stride: int = 1,
    ) -> TrajectoryPayload:
        if signal not in ("state", "action"):
            raise HTTPException(status_code=422, detail="signal must be 'state' or 'action'")
        resolved_source, dataset_label, dataset_path = resolve_episode_dataset(
            source=source, dataset=dataset, path=path
        )
        return build_trajectory_payload(
            source=resolved_source,
            dataset_label=dataset_label,
            dataset_path=dataset_path,
            episode_index=episode_index,
            signal=signal,
            start_frame=start_frame,
            end_frame=end_frame,
            stride=stride,
        )
