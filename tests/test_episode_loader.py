import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi import HTTPException

from roboclaw.data.application.inspect import DataInspectService
from roboclaw.data.curation.episode_loader import load_episode_data


def test_load_episode_data_allows_materialized_video_symlink(tmp_path: Path):
    source_video = tmp_path / "source.mp4"
    source_video.write_bytes(b"not-a-real-video")

    dataset = tmp_path / "artifact" / "dataset"
    (dataset / "meta" / "episodes" / "chunk-000").mkdir(parents=True)
    (dataset / "data" / "chunk-000").mkdir(parents=True)
    video_path = dataset / "videos" / "observation.images.cam" / "chunk-000" / "file-000.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.symlink_to(source_video)

    info = {
        "total_episodes": 1,
        "total_frames": 1,
        "fps": 30,
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "observation.images.cam": {"dtype": "video", "shape": [480, 640, 3]},
            "episode_index": {"dtype": "int64", "shape": [1]},
            "index": {"dtype": "int64", "shape": [1]},
        },
    }
    (dataset / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    pq.write_table(
        pa.Table.from_pylist([{
            "episode_index": 0,
            "index": 0,
            "frame_index": 0,
            "timestamp": 0.0,
            "task_index": 0,
        }]),
        dataset / "data" / "chunk-000" / "file-000.parquet",
    )
    pq.write_table(
        pa.Table.from_pylist([{
            "episode_index": 0,
            "length": 1,
            "data/chunk_index": 0,
            "data/file_index": 0,
            "dataset_from_index": 0,
            "dataset_to_index": 1,
            "videos/observation.images.cam/chunk_index": 0,
            "videos/observation.images.cam/file_index": 0,
            "videos/observation.images.cam/from_timestamp": 0.0,
            "videos/observation.images.cam/to_timestamp": 1 / 30,
        }]),
        dataset / "meta" / "episodes" / "chunk-000" / "file-000.parquet",
    )

    data = load_episode_data(dataset, 0)

    assert data["video_files"] == [video_path]


def test_inspect_child_path_allows_materialized_symlink(tmp_path: Path):
    source_video = tmp_path / "source.mp4"
    source_video.write_bytes(b"not-a-real-video")
    artifact = tmp_path / "artifact"
    symlink = artifact / "videos" / "camera" / "chunk-000" / "file-000.mp4"
    symlink.parent.mkdir(parents=True)
    symlink.symlink_to(source_video)

    service = DataInspectService(repository=None)  # type: ignore[arg-type]

    assert service._resolve_child_path(artifact, "videos/camera/chunk-000/file-000.mp4") == symlink
    with pytest.raises(HTTPException):
        service._resolve_child_path(artifact, "../source.mp4")
