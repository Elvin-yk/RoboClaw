"""Smoke tests for the multi-event extractor orchestrator.

Use a synthetic in-memory parquet so we never touch a real dataset, never
import lerobot, and can verify both detector wiring and reporting end to end.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from roboclaw.data.dataset_pipeline.critical_window_builder import OverlapPolicy
from roboclaw.data.dataset_pipeline.gripper_events import GripperEventConfig
from roboclaw.data.dataset_pipeline.multi_event_extractor import (
    ExtractionRequest,
    load_dataset_fps,
    resolve_single_data_parquet,
    run,
)


_GRIPPER_DIM = 5
_ACTION_DIM = 6


def _make_action(gripper_value: float) -> list[float]:
    a = [0.0] * _ACTION_DIM
    a[_GRIPPER_DIM] = gripper_value
    return a


def _episode_trace(num_frames: int, peak_frames: list[int], peak_value: float = 12.0) -> np.ndarray:
    trace = np.zeros(num_frames, dtype=np.float64)
    for s in peak_frames:
        end = min(num_frames, s + 3)
        trace[s:end] = peak_value
    return trace


def _write_dataset(
    root: Path,
    fps: float,
    episodes: dict[int, list[int]],
    num_frames: int = 600,
) -> Path:
    (root / "meta").mkdir(parents=True, exist_ok=True)
    (root / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
    info = {"fps": fps, "robot_type": "synthetic", "total_episodes": len(episodes)}
    (root / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    rows_episode: list[int] = []
    rows_frame: list[int] = []
    rows_action: list[list[float]] = []
    for ep_idx in sorted(episodes.keys()):
        trace = _episode_trace(num_frames, episodes[ep_idx])
        for f in range(num_frames):
            rows_episode.append(ep_idx)
            rows_frame.append(f)
            rows_action.append(_make_action(float(trace[f])))
    table = pa.table(
        {
            "episode_index": pa.array(rows_episode, type=pa.int64()),
            "frame_index": pa.array(rows_frame, type=pa.int64()),
            "action": pa.array(rows_action, type=pa.list_(pa.float32())),
        }
    )
    parquet_path = root / "data" / "chunk-000" / "file-000.parquet"
    pq.write_table(table, parquet_path)
    return parquet_path


def _request(src: Path, dst: Path, *, min_events: int = 5, dry_run: bool = True) -> ExtractionRequest:
    return ExtractionRequest(
        src=src,
        dst=dst,
        task="synthetic",
        gripper_dim=_GRIPPER_DIM,
        event_config=GripperEventConfig(
            open_threshold=10.0, reset_threshold=10.0, min_separation_frames=5
        ),
        pre_event_seconds=2.0,
        overlap_policy=OverlapPolicy.KEEP,
        min_events_per_episode=min_events,
        exclude_episodes=set(),
        dry_run=dry_run,
    )


@pytest.fixture
def tiny_dataset(tmp_path: Path) -> Path:
    src = tmp_path / "src"
    peaks = [50, 150, 250, 350, 450]
    _write_dataset(src, fps=30.0, episodes={0: peaks, 1: peaks})
    return src


def test_dry_run_returns_report_without_lerobot_import(
    tiny_dataset: Path, tmp_path: Path
) -> None:
    for mod in [k for k in sys.modules if k == "lerobot" or k.startswith("lerobot.")]:
        sys.modules.pop(mod, None)
    dst = tmp_path / "dst"
    report, output_path = run(_request(tiny_dataset, dst, dry_run=True))
    assert output_path is None
    assert not any(k == "lerobot" or k.startswith("lerobot.") for k in sys.modules)
    assert report.source_episode_count == 2
    assert report.output_segment_count == 10
    assert report.episodes_with_fewer_than_min_events == {}


def test_dry_run_warns_when_episode_has_few_events(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write_dataset(src, fps=30.0, episodes={0: [50, 150, 250], 1: [50, 150, 250, 350, 450]})
    dst = tmp_path / "dst"
    report, output_path = run(_request(src, dst, min_events=5, dry_run=True))
    assert output_path is None
    assert report.episodes_with_fewer_than_min_events == {0: 3}
    assert report.output_segment_count == 3 + 5


def test_load_dataset_fps_reads_meta_info(tmp_path: Path) -> None:
    root = tmp_path / "ds"
    (root / "meta").mkdir(parents=True)
    (root / "meta" / "info.json").write_text(json.dumps({"fps": 25.0}), encoding="utf-8")
    assert load_dataset_fps(root) == 25.0


def test_resolve_single_data_parquet_missing_raises(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        resolve_single_data_parquet(tmp_path)
