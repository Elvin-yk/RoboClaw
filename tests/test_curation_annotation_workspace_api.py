from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.curation import bridge as curation_bridge
from roboclaw.data.curation import serializers as curation_serializers
from roboclaw.data.curation.state import (
    load_workflow_state,
    save_prototype_results,
    save_quality_results,
    save_workflow_state,
)
from roboclaw.data.curation.validators import validate_metadata
from roboclaw.http.routes import curation as curation_routes
from tests.curation_api_helpers import _build_client, _write_demo_dataset


def test_annotation_save_versions_and_updates_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)
    body = {
        "dataset": "demo",
        "episode_index": 0,
        "task_context": {"label": "Pick", "text": "pick the object"},
        "annotations": [
            {
                "id": "ann-1",
                "label": "Pick",
                "category": "movement",
                "color": "#ff8a5b",
                "startTime": 0.0,
                "endTime": 0.7,
                "text": "pick the object",
                "tags": ["manual"],
                "source": "user",
            }
        ],
    }

    first = client.post("/api/curation/annotations", json=body)
    assert first.status_code == 200
    first_payload = first.json()
    assert first_payload["version_number"] == 1
    assert first_payload["episode_index"] == 0
    assert first_payload["task_context"]["label"] == "Pick"

    second = client.post("/api/curation/annotations", json=body)
    assert second.status_code == 200
    second_payload = second.json()
    assert second_payload["version_number"] == 2

    state_response = client.get("/api/curation/state", params={"dataset": "demo"})
    assert state_response.status_code == 200
    stage = state_response.json()["stages"]["annotation"]
    assert stage["annotated_episodes"] == [0]
    assert stage["summary"]["annotated_count"] == 1
    assert stage["summary"]["last_saved_episode_index"] == 0


def test_workflow_state_save_writes_json_atomically(tmp_path: Path) -> None:
    dataset_path = _write_demo_dataset(tmp_path)
    state = load_workflow_state(dataset_path)
    state["stages"]["prototype_discovery"]["summary"] = {"candidate_count": 271}

    save_workflow_state(dataset_path, state)

    workflow_dir = dataset_path / ".workflow"
    assert not list(workflow_dir.glob("*.tmp"))
    assert load_workflow_state(dataset_path)["stages"]["prototype_discovery"]["summary"] == {
        "candidate_count": 271,
    }


def test_legacy_propagation_result_serializes_source_history() -> None:
    payload = curation_serializers.serialize_propagation_results(
        {
            "source_episode_index": 2,
            "target_count": 0,
            "propagated": [],
        },
    )

    assert payload["source_episode_indices"] == [2]


def test_quality_defaults_adapt_to_dataset_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    dataset_path = _write_demo_dataset(dataset_root)
    info_path = dataset_path / "meta" / "info.json"
    info = json.loads(info_path.read_text(encoding="utf-8"))
    info["features"]["observation.images.front"] = {
        "dtype": "video",
        "shape": [480, 640, 3],
    }
    info["features"]["observation.images.wrist"] = {
        "dtype": "video",
        "shape": [480, 640, 3],
    }
    info_path.write_text(json.dumps(info), encoding="utf-8")
    monkeypatch.setattr(curation_routes, "datasets_root", lambda: dataset_root)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)
    response = client.get("/api/curation/quality-defaults", params={"dataset": "demo"})

    assert response.status_code == 200
    payload = response.json()
    assert "trajectory_dtw" in payload["selected_validators"]
    assert "visual" in payload["selected_validators"]
    assert payload["threshold_overrides"]["metadata_require_videos"] == 1.0
    assert payload["threshold_overrides"]["visual_min_video_count"] == 2.0
    assert payload["threshold_overrides"]["visual_min_resolution_width"] == 640.0
    assert payload["threshold_overrides"]["visual_min_resolution_height"] == 480.0
    assert payload["checks"]["task_descriptions_present"] is True


def test_metadata_validator_checks_task_description(tmp_path: Path) -> None:
    dataset_path = tmp_path / "demo"
    dataset_path.mkdir()
    parquet_path = dataset_path / "data.parquet"
    parquet_path.write_bytes(b"placeholder")

    result = validate_metadata(
        {
            "dataset_path": dataset_path,
            "info": {
                "fps": 30,
                "robot_type": "so101",
                "features": {"action": {"names": ["joint"]}},
            },
            "episode_meta": {"episode_index": 0, "length": 2.0},
            "rows": [],
            "parquet_path": parquet_path,
            "video_files": [],
        },
        threshold_overrides={"metadata_require_videos": 0.0},
    )

    issues = {issue["check_name"]: issue for issue in result["issues"]}
    assert issues["task_description"]["passed"] is False


def test_metadata_validator_accepts_episode_tasks_list(tmp_path: Path) -> None:
    dataset_path = tmp_path / "demo"
    dataset_path.mkdir()
    parquet_path = dataset_path / "data.parquet"
    parquet_path.write_bytes(b"placeholder")

    result = validate_metadata(
        {
            "dataset_path": dataset_path,
            "info": {
                "fps": 30,
                "robot_type": "so101",
                "features": {"action": {"names": ["joint"]}},
            },
            "episode_meta": {
                "episode_index": 0,
                "length": 2.0,
                "tasks": ["pick the yellow cube"],
            },
            "rows": [],
            "parquet_path": parquet_path,
            "video_files": [],
        },
        threshold_overrides={"metadata_require_videos": 0.0},
    )

    issues = {issue["check_name"]: issue for issue in result["issues"]}
    assert issues["task_description"]["passed"] is True


def test_quality_defaults_accept_task_descriptions_from_episode_tasks_list(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    dataset_path = _write_demo_dataset(dataset_root)
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        json.dumps(
            {
                "episode_index": 0,
                "length": 1.0,
                "tasks": ["pick the yellow cube"],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(curation_routes, "datasets_root", lambda: dataset_root)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)
    response = client.get("/api/curation/quality-defaults", params={"dataset": "demo"})

    assert response.status_code == 200
    assert response.json()["checks"]["task_descriptions_present"] is True


def test_quality_defaults_reads_nested_episode_parquet_metadata(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    dataset_path = _write_demo_dataset(dataset_root)
    (dataset_path / "meta" / "episodes.jsonl").unlink()
    episode_parquet = dataset_path / "meta" / "episodes" / "chunk-000" / "file-000.parquet"
    curation_bridge.write_parquet_rows(
        episode_parquet,
        [
            {
                "episode_index": 0,
                "length": 30,
                "tasks": ["pick the yellow cube"],
            }
        ],
    )
    monkeypatch.setattr(curation_routes, "datasets_root", lambda: dataset_root)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)
    response = client.get("/api/curation/quality-defaults", params={"dataset": "demo"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["checks"]["episode_metadata_present"] is True
    assert payload["checks"]["task_descriptions_present"] is True


def test_annotation_workspace_returns_video_and_joint_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)

    response = client.get(
        "/api/curation/annotation-workspace",
        params={"dataset": "demo", "episode_index": 0},
    )
    assert response.status_code == 200
    payload = response.json()

    assert payload["summary"]["record_key"] == "0"
    assert payload["summary"]["duration_s"] == 1.0
    assert payload["videos"][0]["path"].endswith("front.mp4")
    assert payload["videos"][0]["from_timestamp"] == 0
    assert payload["videos"][0]["to_timestamp"] == 1.0
    assert payload["joint_trajectory"]["frame_values"] == [0, 1]
    assert len(payload["joint_trajectory"]["joint_trajectories"]) == 2
    assert payload["annotations"]["version_number"] == 0


def test_annotation_workspace_uses_shared_video_clip_bounds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_path = dataset_root / "demo"
    video_path = (
        dataset_path
        / "videos"
        / "observation.images.front"
        / "chunk-000"
        / "file-000.mp4"
    )
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"")
    info = {
        "fps": 30,
        "robot_type": "so101",
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "action": {"names": ["gripper.pos"]},
            "observation.state": {"names": ["gripper.pos"]},
            "observation.images.front": {"dtype": "video"},
        },
    }
    episode_meta = {
        "episode_index": 1,
        "task": "pick",
        "videos/observation.images.front/chunk_index": 0,
        "videos/observation.images.front/file_index": 0,
        "videos/observation.images.front/from_timestamp": 25.633333333333333,
        "videos/observation.images.front/to_timestamp": 51.4,
    }

    monkeypatch.setattr(curation_routes, "datasets_root", lambda: dataset_root)
    def _fake_load_episode_data(
        _dataset_path: Path,
        _episode_index: int,
        *,
        include_videos: bool = True,
    ) -> dict[str, object]:
        assert include_videos is False
        return {
            "info": info,
            "episode_meta": episode_meta,
            "rows": [
                {
                    "timestamp": 0.0,
                    "frame_index": 0,
                    "action": [1.0],
                    "observation.state": [1.0],
                    "task": "pick",
                },
                {
                    "timestamp": 1.0,
                    "frame_index": 30,
                    "action": [2.0],
                    "observation.state": [2.0],
                    "task": "pick",
                },
            ],
            "video_files": [],
        }

    monkeypatch.setattr(curation_serializers, "load_episode_data", _fake_load_episode_data)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    response = TestClient(app).get(
        "/api/curation/annotation-workspace",
        params={"dataset": "demo", "episode_index": 1},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["videos"][0]["path"] == (
        "videos/observation.images.front/chunk-000/file-000.mp4"
    )
    assert payload["videos"][0]["stream"] == "front"
    assert payload["videos"][0]["from_timestamp"] == 25.633333333333333
    assert payload["videos"][0]["to_timestamp"] == 51.4


def test_workflow_result_endpoints_serialize_ui_shapes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)

    save_quality_results(
        dataset_path,
        {
            "total": 1,
            "passed": 1,
            "failed": 0,
            "overall_score": 92.5,
            "episodes": [{"episode_index": 0, "passed": True, "score": 92.5}],
            "selected_validators": ["metadata"],
        },
    )
    save_prototype_results(
        dataset_path,
        {
            "candidate_count": 1,
            "entry_count": 1,
            "cluster_count": 1,
            "refinement": {
                "anchor_record_keys": ["0"],
                "clusters": [
                    {
                        "cluster_index": 0,
                        "prototype_record_key": "0",
                        "anchor_record_key": "0",
                        "member_count": 1,
                        "members": [
                            {
                                "record_key": "0",
                                "distance_to_prototype": 0.0,
                                "distance_to_barycenter": 0.0,
                                "quality": {"score": 92.5, "passed": True},
                            }
                        ],
                    }
                ],
            },
        },
    )

    quality_response = client.get(
        "/api/curation/quality-results",
        params={"dataset": "demo"},
    )
    assert quality_response.status_code == 200
    assert quality_response.json()["overall_score"] == 92.5

    prototype_response = client.get(
        "/api/curation/prototype-results",
        params={"dataset": "demo"},
    )
    assert prototype_response.status_code == 200
    prototype_payload = prototype_response.json()
    assert prototype_payload["anchor_record_keys"] == ["0"]
    assert prototype_payload["clusters"][0]["anchor_record_key"] == "0"
    assert prototype_payload["clusters"][0]["members"][0]["episode_index"] == 0


def test_curation_dataset_list_includes_session_datasets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)

    monkeypatch.setattr(
        curation_routes,
        "list_curation_dataset_summaries",
        lambda: [
            {
                "name": "demo",
                "display_name": "demo",
                "source_kind": "workspace",
                "total_episodes": 1,
                "total_frames": 2,
                "fps": 30,
                "robot_type": "so101",
            },
            {
                "name": "session:remote:abc123",
                "display_name": "cadene/droid_1.0.1",
                "source_kind": "remote_session",
                "total_episodes": 3,
                "total_frames": 42,
                "fps": 30,
                "robot_type": "so101",
            },
        ],
    )

    response = client.get("/api/curation/datasets")
    assert response.status_code == 200
    payload = response.json()
    assert payload[1]["name"] == "session:remote:abc123"
    assert payload[1]["display_name"] == "cadene/droid_1.0.1"


def test_quality_detail_can_resolve_session_dataset(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)

    monkeypatch.setattr(
        curation_routes,
        "resolve_dataset_path",
        lambda name: dataset_path if name == "session:remote:abc123" else (tmp_path / name),
    )

    save_quality_results(
        dataset_path,
        {
            "total": 1,
            "passed": 1,
            "failed": 0,
            "overall_score": 100,
            "episodes": [{"episode_index": 0, "passed": True, "score": 100}],
            "selected_validators": ["metadata"],
        },
    )

    response = client.get(
        "/api/curation/quality-results",
        params={"dataset": "session:remote:abc123"},
    )
    assert response.status_code == 200
    assert response.json()["overall_score"] == 100
