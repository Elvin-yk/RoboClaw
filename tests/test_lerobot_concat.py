"""Tests for concat_lerobot_datasets (preflight + happy-path).

Happy-path test writes real LeRobot v3 datasets via ``LeRobotDataset.create``
and exercises the underlying ``aggregate_datasets`` plumbing. ffmpeg is
required and the test is skipped if absent.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from roboclaw.data.dataset_pipeline.concat import concat_lerobot_datasets


_TASK = "Concat test task"
_FFMPEG_MISSING = shutil.which("ffmpeg") is None
_skip_no_ffmpeg = pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg required")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    # LeRobotDataset.create copies <root.parents[2]>/calibration into the new
    # dataset and runs _flatten_calibration_snapshot, which expects time.txt.
    # An empty time.txt makes the snapshot a no-op.
    calibration = tmp_path / "calibration"
    calibration.mkdir()
    (calibration / "time.txt").write_text("")
    return tmp_path


def _make_lerobot_source(
    workspace: Path,
    name: str,
    num_episodes: int = 2,
    frames_per_episode: int = 3,
    task: str = _TASK,
) -> Path:
    import numpy as np
    from PIL import Image
    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    root = workspace / "lvl1" / "lvl2" / name
    ds = LeRobotDataset.create(
        repo_id=f"local/{name}",
        fps=30,
        features={
            "action": {
                "dtype": "float32",
                "shape": (6,),
                "names": ["a0", "a1", "a2", "a3", "a4", "a5"],
            },
            "observation.state": {
                "dtype": "float32",
                "shape": (6,),
                "names": ["s0", "s1", "s2", "s3", "s4", "s5"],
            },
            "observation.images.cam0": {
                "dtype": "video",
                "shape": (32, 32, 3),
                "names": ["height", "width", "channels"],
            },
        },
        root=root,
        robot_type="test",
        use_videos=True,
        vcodec="h264",
    )
    rng = np.random.default_rng(42)
    for _ in range(num_episodes):
        for _ in range(frames_per_episode):
            img = (rng.random((32, 32, 3)) * 255).astype("uint8")
            ds.add_frame(
                {
                    "task": task,
                    "action": np.zeros(6, dtype="float32"),
                    "observation.state": np.zeros(6, dtype="float32"),
                    "observation.images.cam0": Image.fromarray(img),
                }
            )
        ds.save_episode()
    ds.finalize()
    return root


def test_concat_rejects_empty_sources(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least one source"):
        concat_lerobot_datasets([], tmp_path / "dst", task=_TASK)


def test_concat_rejects_missing_source(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError, match="source dataset not found"):
        concat_lerobot_datasets(
            [tmp_path / "missing"], tmp_path / "dst", task=_TASK
        )


def test_concat_refuses_existing_dst(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    dst = tmp_path / "dst"
    dst.mkdir()
    with pytest.raises(FileExistsError, match="destination already exists"):
        concat_lerobot_datasets([src], dst, task=_TASK)


@_skip_no_ffmpeg
def test_concat_rejects_task_mismatch(workspace: Path) -> None:
    src = _make_lerobot_source(workspace, "src", task="Other task")
    with pytest.raises(ValueError, match="!= expected"):
        concat_lerobot_datasets([src], workspace / "dst", task=_TASK)


@_skip_no_ffmpeg
def test_concat_two_two_episode_datasets(workspace: Path) -> None:
    src_a = _make_lerobot_source(workspace, "src_a")
    src_b = _make_lerobot_source(workspace, "src_b")
    dst = workspace / "merged"
    out = concat_lerobot_datasets([src_a, src_b], dst, task=_TASK)
    assert out == dst

    info = json.loads((dst / "meta" / "info.json").read_text())
    assert info["total_episodes"] == 4
    assert info["total_frames"] == 12
    assert info["fps"] == 30
