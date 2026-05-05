"""Smoke tests for the screw extractor orchestrator with a compound detector.

Use a synthetic in-memory parquet so we never touch a real dataset, never
import lerobot, and can verify both detector wiring and reporting end to end.
The inter-EE distance trace is supplied via injectable provider stubs so we
can exercise both "always close" (degenerate to gripper-only) and
"always far" (zero events) baselines.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from roboclaw.data.dataset_pipeline.critical_phase import (
    OverlapPolicy,
    RisingEdgeConfig,
    load_dataset_fps,
    resolve_single_data_parquet,
)
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.cli import (
    main as cli_main,
)
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.detectors import (
    GripperEEEventConfig,
    GripperOpenMaskConfig,
)
from roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.pipeline import (
    ExtractionRequest,
    run,
)


_GRIPPER_DIM = 5
_ACTION_DIM = 6


class _CloseEEProvider:
    """Always-close provider: AND of (gripper, ee_close) collapses to gripper."""

    def distance_trace(
        self, episode_index: int, action: np.ndarray, num_frames: int
    ) -> np.ndarray:
        return np.zeros(num_frames, dtype=np.float64)


class _FarEEProvider:
    """Always-far provider: AND with gripper is identically False."""

    def distance_trace(
        self, episode_index: int, action: np.ndarray, num_frames: int
    ) -> np.ndarray:
        return np.full(num_frames, 1.0, dtype=np.float64)


def _make_action(gripper_value: float) -> list[float]:
    a = [0.0] * _ACTION_DIM
    a[_GRIPPER_DIM] = gripper_value
    return a


def _episode_trace(
    num_frames: int, peak_frames: list[int], peak_value: float = 12.0
) -> np.ndarray:
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
    shuffle: bool = False,
    rng_seed: int = 0,
) -> Path:
    (root / "meta").mkdir(parents=True, exist_ok=True)
    (root / "data" / "chunk-000").mkdir(parents=True, exist_ok=True)
    info = {"fps": fps, "robot_type": "synthetic", "total_episodes": len(episodes)}
    (root / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    rows_episode: list[int] = []
    rows_frame: list[int] = []
    rows_action: list[list[float]] = []
    rng = np.random.default_rng(rng_seed)
    for ep_idx in sorted(episodes.keys()):
        trace = _episode_trace(num_frames, episodes[ep_idx])
        order = np.arange(num_frames)
        if shuffle:
            order = rng.permutation(num_frames)
        for f in order.tolist():
            rows_episode.append(ep_idx)
            rows_frame.append(int(f))
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


def _request(
    src: Path,
    dst: Path,
    *,
    min_events: int = 5,
    dry_run: bool = True,
    ee_close_threshold_m: float = 0.5,
) -> ExtractionRequest:
    event_config = GripperEEEventConfig(
        gripper=GripperOpenMaskConfig(open_threshold=10.0, reset_threshold=10.0),
        ee_close_threshold_m=ee_close_threshold_m,
        edge=RisingEdgeConfig(min_separation_frames=5),
    )
    return ExtractionRequest(
        src=src,
        dst=dst,
        task="synthetic",
        gripper_dim=_GRIPPER_DIM,
        event_config=event_config,
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


def _purge_lerobot() -> None:
    for mod in [k for k in sys.modules if k == "lerobot" or k.startswith("lerobot.")]:
        sys.modules.pop(mod, None)


def test_close_ee_provider_collapses_to_gripper_only_baseline(
    tiny_dataset: Path, tmp_path: Path
) -> None:
    _purge_lerobot()
    dst = tmp_path / "dst"
    report, output_path = run(
        _request(tiny_dataset, dst, dry_run=True),
        _CloseEEProvider(),
    )
    assert output_path is None
    assert not any(k == "lerobot" or k.startswith("lerobot.") for k in sys.modules)
    assert report.source_episode_count == 2
    assert report.output_segment_count == 10
    assert report.episodes_with_fewer_than_min_events == {}


def test_far_ee_provider_emits_no_events(
    tiny_dataset: Path, tmp_path: Path
) -> None:
    dst = tmp_path / "dst"
    report, output_path = run(
        _request(tiny_dataset, dst, dry_run=True),
        _FarEEProvider(),
    )
    assert output_path is None
    assert report.source_episode_count == 2
    assert report.output_segment_count == 0
    assert sorted(report.episodes_with_no_events) == [0, 1]


def test_run_without_ee_provider_raises_type_error(
    tiny_dataset: Path, tmp_path: Path
) -> None:
    """``ee_provider`` is a required positional arg — no fallback stub."""
    _purge_lerobot()
    dst = tmp_path / "dst"
    with pytest.raises(TypeError):
        run(_request(tiny_dataset, dst, dry_run=True))  # type: ignore[call-arg]
    assert not any(k == "lerobot" or k.startswith("lerobot.") for k in sys.modules)


def test_close_ee_provider_warns_when_episode_has_few_events(tmp_path: Path) -> None:
    src = tmp_path / "src"
    _write_dataset(
        src,
        fps=30.0,
        episodes={0: [50, 150, 250], 1: [50, 150, 250, 350, 450]},
    )
    dst = tmp_path / "dst"
    report, output_path = run(
        _request(src, dst, min_events=5, dry_run=True),
        _CloseEEProvider(),
    )
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


class _ActionAwareEEProvider:
    """Returns 0 (close) when action[:, GRIPPER_DIM] >= peak; else 1 (far).

    Using the gripper-channel value as the "close-EE" signal lets us assert
    that the provider sees frames in canonical order: a shuffled parquet must
    be sorted by ``frame_index`` BEFORE the action array reaches the provider,
    otherwise the close-EE mask aligns to row order rather than frame order
    and the rising edges land at the wrong frame indices.
    """

    def __init__(self, peak_value: float) -> None:
        self._peak = peak_value

    def distance_trace(
        self, episode_index: int, action: np.ndarray, num_frames: int
    ) -> np.ndarray:
        gripper_col = action[:, _GRIPPER_DIM]
        return np.where(gripper_col >= self._peak, 0.0, 1.0)


def test_pipeline_handles_shuffled_frame_rows_in_parquet(tmp_path: Path) -> None:
    """Parquet rows are shuffled within each episode; pipeline must sort by
    ``frame_index`` before handing arrays to the detector or EE provider so
    events still land at the correct frame indices.
    """
    peaks = [50, 150, 250, 350, 450]
    src_ordered = tmp_path / "src_ordered"
    src_shuffled = tmp_path / "src_shuffled"
    _write_dataset(src_ordered, fps=30.0, episodes={0: peaks, 1: peaks}, shuffle=False)
    _write_dataset(
        src_shuffled, fps=30.0, episodes={0: peaks, 1: peaks}, shuffle=True, rng_seed=42
    )
    provider = _ActionAwareEEProvider(peak_value=12.0)

    report_ordered, _ = run(
        _request(src_ordered, tmp_path / "dst_ordered", dry_run=True),
        provider,
    )
    report_shuffled, _ = run(
        _request(src_shuffled, tmp_path / "dst_shuffled", dry_run=True),
        provider,
    )

    assert report_ordered.output_segment_count == report_shuffled.output_segment_count
    assert (
        report_ordered.episodes_with_fewer_than_min_events
        == report_shuffled.episodes_with_fewer_than_min_events
    )
    assert report_ordered.output_segment_count == 10


def test_cli_main_raises_not_implemented(tmp_path: Path) -> None:
    """CLI must refuse to run end-to-end: real EE provider lands later."""
    src = tmp_path / "src"
    src.mkdir()
    dst = tmp_path / "dst"
    argv = [
        "--src", str(src),
        "--dst", str(dst),
        "--task", "synthetic",
        "--gripper-dim", "5",
        "--open-threshold", "10.0",
        "--ee-close-threshold-m", "0.08",
    ]
    with pytest.raises(NotImplementedError, match="EpisodeEEDistanceProvider"):
        cli_main(argv)
