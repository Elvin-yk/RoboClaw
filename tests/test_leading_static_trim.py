from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from roboclaw.data.cleaning import LeadingStaticTrimConfig, LeadingStaticTrimService
from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.types import IntegrityStatus


def _write_dataset(
    dataset_dir: Path,
    *,
    fps: int = 10,
    episode_actions: list[list[float]],
    with_video: bool = False,
    video_file_indices: list[int] | None = None,
) -> None:
    meta_dir = dataset_dir / "meta"
    meta_dir.mkdir(parents=True)
    features = {
        "observation.state": {"dtype": "float32", "shape": [1], "names": None},
        "action": {"dtype": "float32", "shape": [1], "names": None},
        "episode_index": {"dtype": "int64", "shape": [1], "names": None},
    }
    if with_video:
        features["observation.images.front"] = {
            "dtype": "video",
            "shape": [16, 16, 3],
            "names": ["height", "width", "channel"],
        }
    info = {
        "total_episodes": len(episode_actions),
        "total_frames": sum(len(actions) for actions in episode_actions),
        "fps": fps,
        "robot_type": "test_bot",
        "features": features,
        "chunks_size": 1000,
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
    }
    if with_video:
        info["video_path"] = "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"
    (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")
    pq.write_table(pa.Table.from_pylist([{"task_index": 0, "task": "task"}]), meta_dir / "tasks.parquet")
    (meta_dir / "stats.json").write_text("{}", encoding="utf-8")

    rows: list[dict] = []
    episodes: list[dict] = []
    video_offsets: dict[int, int] = {}
    video_lengths: dict[int, int] = {}
    global_index = 0
    if with_video and video_file_indices is None:
        video_file_indices = list(range(len(episode_actions)))
    if video_file_indices is not None and len(video_file_indices) != len(episode_actions):
        raise ValueError("video_file_indices must match episode_actions length")
    for episode_index, actions in enumerate(episode_actions):
        start = global_index
        for frame_index, action in enumerate(actions):
            rows.append({
                "index": global_index,
                "episode_index": episode_index,
                "frame_index": frame_index,
                "timestamp": frame_index / fps,
                "task_index": 0,
                "observation.state": [action],
                "action": [action],
            })
            global_index += 1
        entry = {
            "episode_index": episode_index,
            "tasks": ["task"],
            "length": len(actions),
            "data/chunk_index": 0,
            "data/file_index": 0,
            "dataset_from_index": start,
            "dataset_to_index": global_index,
        }
        if with_video:
            file_index = int(video_file_indices[episode_index]) if video_file_indices is not None else episode_index
            video_from_frame = video_offsets.get(file_index, 0)
            video_to_frame = video_from_frame + len(actions)
            video_offsets[file_index] = video_to_frame
            video_lengths[file_index] = video_to_frame
            entry.update({
                "videos/observation.images.front/chunk_index": 0,
                "videos/observation.images.front/file_index": file_index,
                "videos/observation.images.front/from_timestamp": video_from_frame / fps,
                "videos/observation.images.front/to_timestamp": video_to_frame / fps,
            })
        episodes.append(entry)

    if with_video:
        for file_index, frame_count in sorted(video_lengths.items()):
            _write_mp4(
                dataset_dir / "videos" / "observation.images.front" / "chunk-000" / f"file-{file_index:03d}.mp4",
                frames=frame_count,
                fps=fps,
            )

    data_path = dataset_dir / "data" / "chunk-000" / "file-000.parquet"
    data_path.parent.mkdir(parents=True)
    pq.write_table(pa.Table.from_pylist(rows), data_path)
    episodes_path = meta_dir / "episodes" / "chunk-000" / "file-000.parquet"
    episodes_path.parent.mkdir(parents=True)
    pq.write_table(pa.Table.from_pylist(episodes), episodes_path)


def _write_mp4(path: Path, *, frames: int, fps: int) -> None:
    av = pytest.importorskip("av")
    path.parent.mkdir(parents=True, exist_ok=True)
    container = av.open(str(path), mode="w")
    stream = container.add_stream("mpeg4", rate=Fraction(fps, 1))
    stream.width = 16
    stream.height = 16
    stream.pix_fmt = "yuv420p"
    for index in range(frames):
        image = np.full((16, 16, 3), index % 255, dtype=np.uint8)
        frame = av.VideoFrame.from_ndarray(image, format="rgb24")
        for packet in stream.encode(frame):
            container.mux(packet)
    for packet in stream.encode():
        container.mux(packet)
    container.close()


def _read_rows(path: Path) -> list[dict]:
    return pq.read_table(path).to_pylist()


def _count_video_frames(path: Path) -> int:
    av = pytest.importorskip("av")
    container = av.open(str(path))
    count = sum(1 for _frame in container.decode(video=0))
    container.close()
    return count


def test_no_static_prefix_is_no_change(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(dataset_dir, episode_actions=[[float(index) for index in range(12)]])

    result = LeadingStaticTrimService().trim(
        dataset_dir,
        output_dir=tmp_path / "out",
        force=False,
    )

    assert result.status == "no_change"
    assert result.changed is False
    assert not (tmp_path / "out").exists()


def test_static_prefix_is_trimmed_and_reindexed(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(dataset_dir, episode_actions=[[0.0] * 9 + [float(index) for index in range(1, 12)]])
    output_dir = tmp_path / "out"

    result = LeadingStaticTrimService().trim(dataset_dir, output_dir=output_dir, force=False)

    assert result.status == "trimmed"
    assert result.decisions[0].keep_from_frame == 4
    assert result.total_trimmed_frames == 4
    assert diagnose_dataset(output_dir).integrity_status is IntegrityStatus.HEALTHY
    rows = _read_rows(output_dir / "data" / "chunk-000" / "file-000.parquet")
    assert rows[0]["index"] == 0
    assert rows[0]["frame_index"] == 0
    assert rows[0]["timestamp"] == 0.0
    assert len(rows) == result.total_output_frames
    assert not (output_dir / "meta" / "episodes.jsonl").exists()
    assert not (output_dir / "meta" / "leading_static_trim.json").exists()


def test_no_motion_episode_is_dropped(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    moving = [0.0] * 9 + [float(index) for index in range(1, 12)]
    _write_dataset(dataset_dir, episode_actions=[[0.0] * 20, moving])
    output_dir = tmp_path / "out"

    result = LeadingStaticTrimService().trim(dataset_dir, output_dir=output_dir, force=False)

    assert result.status == "trimmed"
    assert result.dropped_episode_indices == [0]
    assert result.total_output_episodes == 1
    episodes = _read_rows(output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
    assert episodes[0]["episode_index"] == 0
    assert episodes[0]["source_episode_index"] == 1


def test_all_no_motion_fails_without_output(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(dataset_dir, episode_actions=[[0.0] * 20, [1.0] * 20])
    output_dir = tmp_path / "out"

    result = LeadingStaticTrimService().trim(dataset_dir, output_dir=output_dir, force=False)

    assert result.status == "failed"
    assert result.error == "leading_static_trim removed every episode"
    assert not output_dir.exists()


def test_missing_action_column_fails(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(dataset_dir, episode_actions=[[float(index) for index in range(12)]])
    data_path = dataset_dir / "data" / "chunk-000" / "file-000.parquet"
    rows = _read_rows(data_path)
    for row in rows:
        row.pop("action", None)
    pq.write_table(pa.Table.from_pylist(rows), data_path)

    with pytest.raises(ValueError, match="requires an action column"):
        LeadingStaticTrimService().trim(dataset_dir, output_dir=tmp_path / "out", force=False)


def test_video_is_clipped_to_trimmed_episode_length(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(
        dataset_dir,
        episode_actions=[[0.0] * 9 + [float(index) for index in range(1, 12)]],
        with_video=True,
    )
    output_dir = tmp_path / "out"

    result = LeadingStaticTrimService().trim(
        dataset_dir,
        output_dir=output_dir,
        config=LeadingStaticTrimConfig(vcodec="mpeg4"),
        force=False,
    )

    assert result.status == "trimmed"
    output_video = output_dir / "videos" / "observation.images.front" / "chunk-000" / "file-000.mp4"
    assert _count_video_frames(output_video) == result.total_output_frames


def test_shared_video_layout_is_preserved_with_updated_clip_offsets(tmp_path: Path) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(
        dataset_dir,
        episode_actions=[
            [0.0] * 9 + [float(index) for index in range(1, 12)],
            [0.0] * 9 + [float(index) for index in range(1, 12)],
            [0.0] * 9 + [float(index) for index in range(1, 12)],
        ],
        with_video=True,
        video_file_indices=[0, 0, 0],
    )
    output_dir = tmp_path / "out"

    result = LeadingStaticTrimService().trim(
        dataset_dir,
        output_dir=output_dir,
        config=LeadingStaticTrimConfig(vcodec="mpeg4"),
        force=False,
    )

    assert result.status == "trimmed"
    output_videos = sorted((output_dir / "videos" / "observation.images.front" / "chunk-000").glob("*.mp4"))
    assert [path.name for path in output_videos] == ["file-000.mp4"]
    assert _count_video_frames(output_videos[0]) == result.total_output_frames
    info = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
    assert info["total_videos"] == 1
    episodes = _read_rows(output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
    expected_start = 0.0
    for episode in episodes:
        assert episode["videos/observation.images.front/file_index"] == 0
        assert episode["videos/observation.images.front/from_timestamp"] == expected_start
        expected_start = episode["videos/observation.images.front/to_timestamp"]
    assert expected_start == result.total_output_frames / 10
    assert diagnose_dataset(output_dir).integrity_status is IntegrityStatus.HEALTHY


def test_multiple_source_videos_are_grouped_once_each(tmp_path: Path, monkeypatch) -> None:
    dataset_dir = tmp_path / "src"
    _write_dataset(
        dataset_dir,
        episode_actions=[
            [0.0] * 9 + [float(index) for index in range(1, 12)],
            [0.0] * 9 + [float(index) for index in range(1, 12)],
            [0.0] * 9 + [float(index) for index in range(1, 12)],
        ],
        with_video=True,
        video_file_indices=[0, 0, 1],
    )
    output_dir = tmp_path / "out"
    service = LeadingStaticTrimService()
    source_calls: list[Path] = []
    original_rewrite = service._rewrite_video_source

    def rewrite_spy(source_path: Path, *args, **kwargs):
        source_calls.append(source_path)
        return original_rewrite(source_path, *args, **kwargs)

    monkeypatch.setattr(service, "_rewrite_video_source", rewrite_spy)

    result = service.trim(
        dataset_dir,
        output_dir=output_dir,
        config=LeadingStaticTrimConfig(vcodec="mpeg4"),
        force=False,
    )

    assert result.status == "trimmed"
    assert [path.name for path in source_calls] == ["file-000.mp4", "file-001.mp4"]
    output_videos = sorted((output_dir / "videos" / "observation.images.front" / "chunk-000").glob("*.mp4"))
    assert [path.name for path in output_videos] == ["file-000.mp4", "file-001.mp4"]
    info = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
    assert info["total_videos"] == 2
    episodes = _read_rows(output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet")
    assert [episode["videos/observation.images.front/file_index"] for episode in episodes] == [0, 0, 1]
    assert episodes[0]["videos/observation.images.front/from_timestamp"] == 0.0
    assert episodes[1]["videos/observation.images.front/from_timestamp"] == episodes[0]["videos/observation.images.front/to_timestamp"]
    assert episodes[2]["videos/observation.images.front/from_timestamp"] == 0.0
