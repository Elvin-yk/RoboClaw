from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.curation import exports as curation_exports
from roboclaw.data.curation.state import save_prototype_results, save_quality_results
from roboclaw.http.routes import curation as curation_routes
from tests.curation_api_helpers import _build_client


def test_workflow_publish_endpoints_build_quality_and_text_parquet(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)
    written: list[tuple[str, list[dict[str, object]]]] = []

    def _fake_write_parquet(path: Path, rows: list[dict[str, object]]) -> dict[str, object]:
        written.append((str(path), rows))
        return {"path": str(path), "row_count": len(rows)}

    monkeypatch.setattr(curation_exports, "write_parquet_rows", _fake_write_parquet)

    save_quality_results(
        dataset_path,
        {
            "total": 1,
            "passed": 1,
            "failed": 0,
            "overall_score": 92.5,
            "episodes": [
                {
                    "episode_index": 0,
                    "passed": True,
                    "score": 92.5,
                    "validators": {
                        "metadata": {"passed": True, "score": 100.0},
                        "timing": {"passed": True, "score": 90.0},
                        "trajectory_dtw": {"passed": True, "score": 100.0},
                    },
                    "issues": [],
                }
            ],
            "selected_validators": ["metadata", "timing", "trajectory_dtw"],
        },
    )

    save_prototype_results(
        dataset_path,
        {
            "candidate_count": 1,
            "entry_count": 1,
            "cluster_count": 1,
            "refinement": {
                "clusters": [
                    {
                        "cluster_index": 0,
                        "prototype_record_key": "0",
                        "anchor_record_key": "0",
                        "member_count": 1,
                        "members": [{"record_key": "0"}],
                    }
                ],
            },
        },
    )

    client.post(
        "/api/curation/annotations",
        json={
            "dataset": "demo",
            "episode_index": 0,
            "task_context": {"label": "Pick", "text": "pick"},
            "annotations": [
                {
                    "id": "ann-1",
                    "label": "approach",
                    "category": "movement",
                    "color": "#ff8a5b",
                    "startTime": 0.0,
                    "endTime": 0.5,
                    "text": "approach object",
                    "tags": ["manual"],
                    "source": "user",
                }
            ],
        },
    )

    quality_publish = client.post("/api/curation/quality-publish", json={"dataset": "demo"})
    assert quality_publish.status_code == 200
    assert quality_publish.json()["row_count"] == 1

    text_publish = client.post(
        "/api/curation/text-annotations-publish",
        json={"dataset": "demo"},
    )
    assert text_publish.status_code == 200
    assert text_publish.json()["row_count"] == 1

    assert written[0][0].endswith("meta/quality_results.parquet")
    assert written[0][1][0]["episode_index"] == 0
    assert written[0][1][0]["trajectory_dtw_score"] == 100.0
    assert written[1][0].endswith("meta/text_annotations.parquet")
    assert written[1][1][0]["annotation_id"] == "ann-1"


def test_workflow_datasets_preserve_nested_hf_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    nested = dataset_root / "cadene" / "droid_1.0.1" / "meta"
    nested.mkdir(parents=True)
    (nested / "info.json").write_text(
        json.dumps({"total_episodes": 2, "total_frames": 20, "fps": 10, "robot_type": "aloha"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )
    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)

    response = client.get("/api/curation/datasets")
    assert response.status_code == 200
    payload = response.json()
    assert payload[0]["id"] == "cadene/droid_1.0.1"
    assert payload[0]["label"] == "cadene/droid_1.0.1"

    # Detail route must handle the nested name with slash
    detail = client.get("/api/curation/datasets/cadene/droid_1.0.1")
    assert detail.status_code == 200
    assert detail.json()["id"] == "cadene/droid_1.0.1"


def test_workflow_datasets_preserve_deep_recorder_names(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    nested = dataset_root / "4090-a" / "local" / "rec_20260501_102204" / "meta"
    nested.mkdir(parents=True)
    (nested / "info.json").write_text(
        json.dumps({"total_episodes": 4, "total_frames": 30151, "fps": 30, "robot_type": "so101"}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )
    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)

    response = client.get("/api/curation/datasets")
    assert response.status_code == 200
    payload = response.json()
    assert payload[0]["id"] == "4090-a/local/rec_20260501_102204"
    assert payload[0]["label"] == "4090-a/local/rec_20260501_102204"

    detail = client.get("/api/curation/datasets/4090-a/local/rec_20260501_102204")
    assert detail.status_code == 200
    assert detail.json()["id"] == "4090-a/local/rec_20260501_102204"


def test_resolve_dataset_path_rejects_traversal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )
    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)

    response = client.get(
        "/api/curation/state",
        params={"dataset": "../../etc/passwd"},
    )
    assert response.status_code == 404


def test_workflow_import_hf_dataset_job(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()

    def _fake_snapshot_download(*, repo_id: str, local_dir: str, **_: object) -> str:
        target_dir = Path(local_dir)
        (target_dir / "meta").mkdir(parents=True, exist_ok=True)
        (target_dir / "meta" / "info.json").write_text(
            json.dumps({"total_episodes": 1, "total_frames": 2, "fps": 30}),
            encoding="utf-8",
        )
        return str(target_dir)

    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )
    monkeypatch.setattr("huggingface_hub.snapshot_download", _fake_snapshot_download)
    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)

    queued = client.post(
        "/api/curation/datasets/import-hf",
        json={"dataset_id": "cadene/droid_1.0.1", "include_videos": False},
    )
    assert queued.status_code == 200
    job_id = queued.json()["job_id"]

    final_payload = None
    for _ in range(100):
        status = client.get(f"/api/curation/datasets/import-status/{job_id}")
        assert status.status_code == 200
        final_payload = status.json()
        if final_payload["status"] in {"completed", "error"}:
            break
        time.sleep(0.02)

    assert final_payload is not None
    assert final_payload["status"] == "completed"
    assert final_payload["imported_dataset_id"] == "cadene/droid_1.0.1"


def test_workflow_dataset_detail_uses_remote_dataset_info(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    monkeypatch.setattr(
        curation_routes,
        "datasets_root",
        lambda: dataset_root,
    )

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    client = TestClient(app)

    monkeypatch.setattr(
        "roboclaw.data.explorer.remote.build_remote_dataset_info",
        lambda dataset: {
            "name": dataset,
            "total_episodes": 2,
            "total_frames": 20,
            "fps": 30,
            "episode_lengths": [8, 12],
            "features": ["action"],
            "robot_type": "aloha",
            "source_dataset": dataset,
        },
    )

    response = client.get("/api/curation/datasets/cadene/droid_1.0.1")
    assert response.status_code == 200
    payload = response.json()
    assert payload["id"] == "cadene/droid_1.0.1"
    assert payload["kind"] == "remote"
    assert payload["stats"]["total_episodes"] == 2
