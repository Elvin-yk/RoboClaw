from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.curation import serializers as curation_serializers
from roboclaw.http.routes import curation as curation_routes


def _write_demo_dataset(root: Path, total_episodes: int = 1) -> Path:
    dataset_path = root / "demo"
    (dataset_path / "meta").mkdir(parents=True)
    (dataset_path / "videos" / "chunk-000" / "episode_000000").mkdir(parents=True)

    info = {
        "total_episodes": total_episodes,
        "total_frames": total_episodes * 2,
        "fps": 30,
        "robot_type": "so101",
        "features": {
            "action": {"names": ["joint_1", "joint_2"]},
            "observation.state": {"names": ["joint_1", "joint_2"]},
        },
    }
    (dataset_path / "meta" / "info.json").write_text(
        json.dumps(info),
        encoding="utf-8",
    )
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        "".join(
            json.dumps({"episode_index": index, "length": 1.0, "task": "pick"}) + "\n"
            for index in range(total_episodes)
        ),
        encoding="utf-8",
    )
    (dataset_path / "videos" / "chunk-000" / "episode_000000" / "front.mp4").write_bytes(
        b"",
    )

    return dataset_path


def _build_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[TestClient, Path]:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    dataset_path = _write_demo_dataset(dataset_root)
    info = json.loads((dataset_path / "meta" / "info.json").read_text(encoding="utf-8"))
    video_path = dataset_path / "videos" / "chunk-000" / "episode_000000" / "front.mp4"

    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )

    def _fake_load_episode_data(
        _dataset_path: Path,
        _episode_index: int,
        *,
        include_videos: bool = True,
    ) -> dict[str, object]:
        assert include_videos is False
        return {
            "info": info,
            "episode_meta": {"episode_index": 0, "length": 1.0, "task": "pick"},
            "rows": [
                {
                    "timestamp": 0.0,
                    "frame_index": 0,
                    "action": [0.1, 0.2],
                    "observation.state": [0.0, 0.1],
                    "task": "pick",
                },
                {
                    "timestamp": 1.0,
                    "frame_index": 1,
                    "action": [0.3, 0.4],
                    "observation.state": [0.2, 0.3],
                    "task": "pick",
                },
            ],
            "video_files": [video_path],
        }

    monkeypatch.setattr(curation_serializers, "load_episode_data", _fake_load_episode_data)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    return TestClient(app), dataset_path
