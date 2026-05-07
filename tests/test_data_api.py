from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.api import register_data_routes
from roboclaw.data.application import DataService


def _create_dataset(root: Path, dataset_id: str, *, episodes: int = 2, frames: int = 20, with_data: bool = False) -> Path:
    dataset_path = root / dataset_id
    meta = dataset_path / "meta"
    meta.mkdir(parents=True)
    info = {
        "total_episodes": episodes,
        "total_frames": frames,
        "fps": 30,
        "robot_type": "so100",
        "features": {"observation.state": {"dtype": "float32"}, "action": {"dtype": "float32"}},
        "chunks_size": 1000,
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
    }
    (meta / "info.json").write_text(json.dumps(info), encoding="utf-8")
    episode_length = frames // episodes
    rows = [
        json.dumps({
            "episode_index": index,
            "length": episode_length,
            "dataset_from_index": index * episode_length,
            "dataset_to_index": (index + 1) * episode_length,
            "data/chunk_index": 0,
            "data/file_index": 0,
        })
        for index in range(episodes)
    ]
    (meta / "episodes.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")
    if with_data:
        import pyarrow as pa
        import pyarrow.parquet as pq

        data_rows = []
        for frame_index in range(frames):
            episode_index = min(frame_index // episode_length, episodes - 1)
            data_rows.append({
                "index": frame_index,
                "episode_index": episode_index,
                "frame_index": frame_index - episode_index * episode_length,
                "timestamp": frame_index / 30,
            })
        data_path = dataset_path / "data" / "chunk-000" / "file-000.parquet"
        data_path.parent.mkdir(parents=True)
        pq.write_table(pa.Table.from_pylist(data_rows), data_path)
    return dataset_path


def _client(root: Path) -> TestClient:
    app = FastAPI()
    register_data_routes(app, DataService(root_resolver=lambda: root))
    return TestClient(app)


def _wait_job(client: TestClient, job_id: str) -> dict:
    deadline = time.time() + 5
    while time.time() < deadline:
        payload = client.get(f"/api/data/jobs/{job_id}").json()
        if payload["phase"] in {"completed", "failed", "cancelled"}:
            return payload
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} did not finish")


def test_library_list_detail_delete_and_old_routes_are_not_registered(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    client = _client(tmp_path)

    listed = client.get("/api/data/library/datasets")
    assert listed.status_code == 200
    assert listed.json()[0]["id"] == "local/demo"
    assert listed.json()[0]["lifecycle_stage"] == "raw"

    detail = client.get("/api/data/library/datasets/local/demo")
    assert detail.status_code == 200
    assert detail.json()["stats"]["total_episodes"] == 2

    assert client.get("/api/datasets").status_code == 404
    assert client.get("/api/curation/datasets").status_code == 404
    assert client.get("/api/explorer/summary").status_code == 404
    assert client.get("/api/data-workshop/datasets").status_code == 404
    assert client.get("/api/dataset-repair/datasets").status_code == 404
    assert client.get("/api/data/quality/defaults").status_code == 404

    deleted = client.delete("/api/data/library/datasets/local/demo")
    assert deleted.status_code == 200
    assert not (tmp_path / "local" / "demo").exists()


def test_library_import_starts_data_job(monkeypatch, tmp_path: Path) -> None:
    def fake_snapshot_download(*, repo_id: str, repo_type: str, local_dir: str, allow_patterns: list[str]) -> str:
        assert repo_id == "remote/demo"
        assert repo_type == "dataset"
        assert "meta/**" in allow_patterns
        meta = Path(local_dir) / "meta"
        meta.mkdir(parents=True)
        (meta / "info.json").write_text(
            json.dumps({
                "total_episodes": 1,
                "total_frames": 10,
                "fps": 30,
                "robot_type": "so100",
                "features": {},
            }),
            encoding="utf-8",
        )
        return local_dir

    monkeypatch.setattr("huggingface_hub.snapshot_download", fake_snapshot_download)
    client = _client(tmp_path)

    started = client.post("/api/data/library/imports", json={"dataset_id": "remote/demo"})
    assert started.status_code == 200
    assert _wait_job(client, started.json()["job_id"])["phase"] == "completed"
    detail = client.get("/api/data/library/datasets/remote/demo")
    assert detail.status_code == 200
    assert detail.json()["lifecycle_stage"] == "raw"


def test_local_inspect_summary_details_and_episode_page(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    client = _client(tmp_path)

    summary = client.get("/api/data/inspect/summary", params={"source": "local", "dataset": "local/demo"})
    details = client.get("/api/data/inspect/details", params={"source": "local", "dataset": "local/demo"})
    episodes = client.get("/api/data/inspect/episodes", params={"source": "local", "dataset": "local/demo"})

    assert summary.status_code == 200
    assert summary.json()["dataset"] == "local/demo"
    assert details.status_code == 200
    assert details.json()["dataset"] == "local/demo"
    assert episodes.status_code == 200
    assert episodes.json()["total_episodes"] == 2


def test_clean_run_marks_healthy_dataset_clean(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    client = _client(tmp_path)

    diagnosis = client.post("/api/data/qc/diagnosis-runs", json={"dataset_ids": ["local/demo"]})
    assert diagnosis.status_code == 200
    assert _wait_job(client, diagnosis.json()["job_id"])["phase"] == "completed"
    diagnosed = client.get("/api/data/library/datasets/local/demo").json()
    assert diagnosed["lifecycle_stage"] == "raw"
    assert diagnosed["gates"]["inspect"]["status"] == "passed"
    assert diagnosed["gates"]["diagnose"]["status"] == "passed"

    started = client.post("/api/data/qc/runs", json={"dataset_ids": ["local/demo"]})
    assert started.status_code == 200
    job = _wait_job(client, started.json()["job_id"])

    assert job["phase"] == "completed"
    detail = client.get("/api/data/library/datasets/local/demo").json()
    assert detail["lifecycle_stage"] == "clean"
    assert detail["gates"]["inspect"]["status"] == "passed"
    assert detail["gates"]["clean"]["status"] == "passed"


def test_package_evaluation_annotation_upload_delete_and_overview(monkeypatch, tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/a", with_data=True)
    _create_dataset(tmp_path, "local/b", with_data=True)
    client = _client(tmp_path)
    for dataset_id in ("local/a", "local/b"):
        response = client.patch(
            f"/api/data/lifecycle/datasets/{dataset_id}/gates/review",
            json={"status": "passed", "message": "ready"},
        )
        assert response.status_code == 200

    package = client.post(
        "/api/data/packages",
        json={"package_id": "pkg_ab", "dataset_ids": ["local/a", "local/b"]},
    )
    assert package.status_code == 200
    assert package.json()["dataset_ids"] == ["local/a", "local/b"]
    assert (tmp_path / "packages" / "pkg_ab" / "meta" / "package_sources.json").is_file()
    package_data_files = sorted((tmp_path / "packages" / "pkg_ab" / "data").rglob("*.parquet"))
    assert len(package_data_files) == 2

    import pyarrow.parquet as pq

    package_rows = []
    for data_file in package_data_files:
        package_rows.extend(pq.read_table(data_file).to_pylist())
    assert sorted({row["episode_index"] for row in package_rows}) == [0, 1, 2, 3]
    assert [row["index"] for row in package_rows] == list(range(40))

    defaults = client.get("/api/data/evaluation/defaults", params={"package_id": "pkg_ab"})
    assert defaults.status_code == 200
    evaluation_job = client.post(
        "/api/data/evaluation/runs",
        json={"package_id": "pkg_ab", "selected_validators": []},
    )
    assert evaluation_job.status_code == 200
    assert _wait_job(client, evaluation_job.json()["job_id"])["phase"] == "completed"
    results = client.get("/api/data/evaluation/results", params={"package_id": "pkg_ab"}).json()
    assert results["results"]["total"] == 4
    package_detail = client.get("/api/data/packages/pkg_ab").json()
    assert package_detail["evaluation_summary"]["total"] == 4

    saved = client.post(
        "/api/data/annotation/annotations",
        json={
            "package_id": "pkg_ab",
            "episode_index": 0,
            "task_context": {"task": "pick"},
            "annotations": [{"text": "pick"}],
        },
    )
    assert saved.status_code == 200
    workspace = client.get("/api/data/annotation/workspace", params={"package_id": "pkg_ab", "episode_index": 0})
    assert workspace.status_code == 200
    assert workspace.json()["annotations"]["annotations"][0]["text"] == "pick"

    overview = client.get("/api/data/overview").json()
    assert overview["summary"]["dataset_count"] == 2
    assert overview["summary"]["package_count"] == 1

    upload_calls = []

    def fake_push_folder(**kwargs):
        upload_calls.append(kwargs)
        return "https://huggingface.co/datasets/acme/pkg_ab/commit/1"

    monkeypatch.setattr("roboclaw.embodied.service.hub.transfer.push_folder", fake_push_folder)
    upload = client.post(
        "/api/data/packages/pkg_ab/uploads",
        json={"repo_id": "acme/pkg_ab", "token": "hf_test", "private": True},
    )
    assert upload.status_code == 200
    assert _wait_job(client, upload.json()["job_id"])["phase"] == "completed"
    assert upload_calls[0]["local_path"] == tmp_path / "packages" / "pkg_ab"
    assert upload_calls[0]["repo_type"] == "dataset"
    assert upload_calls[0]["token"] == "hf_test"
    assert upload_calls[0]["private"] is True
    assert upload_calls[0]["ignore_patterns"] == [".data/*", "sources/*"]
    assert client.get("/api/data/packages/pkg_ab").json()["lifecycle_stage"] == "uploaded"

    deleted = client.delete("/api/data/packages/pkg_ab")
    assert deleted.status_code == 200
    assert not (tmp_path / "packages" / "pkg_ab").exists()


def test_data_job_sse_emits_snapshot_and_completion(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    client = _client(tmp_path)
    started = client.post("/api/data/qc/runs", json={"dataset_ids": ["local/demo"]})
    job_id = started.json()["job_id"]

    with client.stream("GET", f"/api/data/jobs/{job_id}/events") as response:
        assert response.status_code == 200
        text = "".join(response.iter_text())

    assert "event: snapshot" in text
    assert "event: complete" in text or "event: error" in text
