"""End-to-end critical-phase extraction for the screw-insertion task.

Coordinates: scan source parquet → run gripper detector → build intervals via
the generic window builder → call the generic extractor. The lerobot helper
used to materialize the new dataset is imported lazily inside the extractor
so dry-run flows and unit tests do not require lerobot to be installed.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    CriticalWindowBuilder,
    ExtractionReport,
    OverlapPolicy,
    WindowSpec,
    extract_event_windows_dataset,
    load_dataset_fps,
    resolve_single_data_parquet,
)

from .events import GripperEventConfig, GripperEventDetector


@dataclass(frozen=True)
class ExtractionRequest:
    src: Path
    dst: Path
    task: str
    gripper_dim: int
    event_config: GripperEventConfig
    pre_event_seconds: float
    overlap_policy: OverlapPolicy
    min_events_per_episode: int
    exclude_episodes: set[int]
    source_repo_id: str = "local/trim_src"
    output_repo_id: str = "local/trim_out"
    vcodec: str = "h264"
    dry_run: bool = False


def scan_gripper_events(
    data_parquet: Path,
    gripper_dim: int,
    detector: GripperEventDetector,
    exclude_episodes: set[int],
) -> tuple[dict[int, list[CriticalEvent]], dict[int, int]]:
    df = pq.read_table(
        str(data_parquet), columns=["episode_index", "frame_index", "action"]
    ).to_pandas()
    events_by_ep: dict[int, list[CriticalEvent]] = {}
    episode_lengths: dict[int, int] = {}
    for ep_idx_raw, grp in df.groupby("episode_index", sort=True):
        ep_idx = int(ep_idx_raw)
        if ep_idx in exclude_episodes:
            continue
        ordered = grp.sort_values("frame_index", kind="stable")
        action_arr = np.stack(ordered["action"].to_numpy())
        episode_length = int(action_arr.shape[0])
        episode_lengths[ep_idx] = episode_length
        trace = action_arr[:, gripper_dim].astype(np.float64, copy=False)
        events = detector.detect(ep_idx, trace, episode_length)
        if events:
            events_by_ep[ep_idx] = events
    return events_by_ep, episode_lengths


def run(request: ExtractionRequest) -> tuple[ExtractionReport, Path | None]:
    if not request.src.exists():
        raise FileNotFoundError(f"source dataset not found: {request.src}")
    if request.dst.exists():
        raise FileExistsError(
            f"destination already exists, refusing to overwrite: {request.dst}"
        )

    fps = load_dataset_fps(request.src)
    data_parquet = resolve_single_data_parquet(request.src)
    detector = GripperEventDetector(request.event_config)
    events_by_ep, episode_lengths = scan_gripper_events(
        data_parquet=data_parquet,
        gripper_dim=request.gripper_dim,
        detector=detector,
        exclude_episodes=request.exclude_episodes,
    )

    builder = CriticalWindowBuilder(
        WindowSpec(
            pre_event_seconds=request.pre_event_seconds,
            fps=fps,
            overlap_policy=request.overlap_policy,
            min_events_per_episode=request.min_events_per_episode,
        )
    )
    intervals, report = builder.build(events_by_ep, episode_lengths)

    if request.dry_run:
        return report, None

    output_path = extract_event_windows_dataset(
        source_root=request.src,
        output_root=request.dst,
        intervals=intervals,
        source_repo_id=request.source_repo_id,
        output_repo_id=request.output_repo_id,
        task=request.task,
        vcodec=request.vcodec,
    )
    return report, output_path
