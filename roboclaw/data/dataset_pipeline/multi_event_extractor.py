"""Orchestrate scan -> build -> extract for the multi-event extractor.

Stage 1 assumes the source dataset stores its rows in a single parquet file
at ``<root>/data/chunk-000/file-000.parquet``. ``run`` returns the report
plus the output dataset path (``None`` for ``--dry-run``). The lerobot
helper used to materialize the new dataset is imported lazily so dry-run
flows and unit tests do not require lerobot to be installed.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from roboclaw.data.curation.state import load_dataset_info

from .critical_window_builder import (
    CriticalInterval,
    CriticalWindowBuilder,
    ExtractionReport,
    OverlapPolicy,
    WindowSpec,
)
from .gripper_events import GripperEvent, GripperEventConfig, GripperEventDetector


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


def load_dataset_fps(dataset_root: Path) -> float:
    info = load_dataset_info(dataset_root)
    if not info:
        raise FileNotFoundError(
            f"meta/info.json not found or empty under {dataset_root}"
        )
    fps = info.get("fps")
    if not isinstance(fps, (int, float)) or isinstance(fps, bool):
        raise ValueError(f"meta/info.json missing numeric 'fps' (got {fps!r})")
    fps_value = float(fps)
    if fps_value <= 0:
        raise ValueError(f"invalid fps {fps_value!r} in {dataset_root}")
    return fps_value


def resolve_single_data_parquet(dataset_root: Path) -> Path:
    candidate = dataset_root / "data" / "chunk-000" / "file-000.parquet"
    if not candidate.is_file():
        raise FileNotFoundError(
            f"expected single-file parquet at {candidate}; multi-chunk "
            f"datasets are not supported in stage 1"
        )
    return candidate


def scan_gripper_events(
    data_parquet: Path,
    gripper_dim: int,
    detector: GripperEventDetector,
    exclude_episodes: set[int],
) -> tuple[dict[int, list[GripperEvent]], dict[int, int]]:
    df = pq.read_table(
        str(data_parquet), columns=["episode_index", "frame_index", "action"]
    ).to_pandas()
    events_by_ep: dict[int, list[GripperEvent]] = {}
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


def extract_event_windows_dataset(
    source_root: Path,
    output_root: Path,
    intervals: list[CriticalInterval],
    source_repo_id: str,
    output_repo_id: str,
    task: str,
    vcodec: str,
) -> Path:
    from lerobot.utils.critical_phase_extraction_fast import (
        extract_critical_phase_dataset_direct,
    )

    result = extract_critical_phase_dataset_direct(
        source_repo_id=source_repo_id,
        source_root=source_root,
        output_repo_id=output_repo_id,
        output_root=output_root,
        intervals=[iv.as_lerobot_tuple() for iv in intervals],
        task=task,
        vcodec=vcodec,
    )
    if result is None:
        raise RuntimeError(
            "extract_critical_phase_dataset_direct returned None; "
            "output dataset was not created"
        )
    return Path(result)


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
