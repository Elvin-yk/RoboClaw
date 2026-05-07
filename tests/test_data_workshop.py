from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.workshop import storage as workshop_storage
from roboclaw.http.routes import data_workshop as data_workshop_routes


def _client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    datasets_root = tmp_path / "datasets"
    (datasets_root / "local").mkdir(parents=True)
    monkeypatch.setattr(data_workshop_routes, "datasets_root", lambda: datasets_root)
    monkeypatch.setattr(workshop_storage, "get_roboclaw_home", lambda: tmp_path / "home")
    app = FastAPI()
    data_workshop_routes.register_data_workshop_routes(app)
    return TestClient(app)


def _write_dataset(
    dataset_dir: Path,
    *,
    total_episodes: int = 1,
    total_frames: int = 2,
    parquet_rows: int = 2,
    episode_lengths: list[int] | None = None,
    video_keys: list[str] | None = None,
) -> None:
    video_keys = video_keys or ["observation.images.front"]
    episode_lengths = episode_lengths or [total_frames]
    (dataset_dir / "meta" / "episodes" / "chunk-000").mkdir(parents=True)
    (dataset_dir / "data" / "chunk-000").mkdir(parents=True)
    info = {
        "total_episodes": total_episodes,
        "total_frames": total_frames,
        "fps": 30,
        "robot_type": "so101",
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "observation.state": {"dtype": "float32", "shape": [2], "names": None},
            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            **{
                key: {"dtype": "video", "shape": [64, 64, 3], "names": None}
                for key in video_keys
            },
        },
    }
    (dataset_dir / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    pq.write_table(
        pa.table({
            "episode_index": list(range(total_episodes)),
            "length": episode_lengths,
        }),
        dataset_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet",
    )
    pq.write_table(
        pa.table({
            "episode_index": [0] * parquet_rows,
            "index": list(range(parquet_rows)),
            "timestamp": [index / 30 for index in range(parquet_rows)],
            "observation.state": [[0.0, 1.0] for _ in range(parquet_rows)],
        }),
        dataset_dir / "data" / "chunk-000" / "file-000.parquet",
    )
    for key in video_keys:
        video_path = dataset_dir / "videos" / key / "chunk-000" / "file-000.mp4"
        video_path.parent.mkdir(parents=True)
        video_path.write_bytes(b"mp4")


def _pass_required_gates(client: TestClient, dataset_id: str) -> None:
    for gate in ("repair_diagnosis", "manual_boundary_review", "quality_validation"):
        response = client.post(
            f"/api/data-workshop/datasets/{dataset_id}/gates/{gate}",
            json={"status": "passed", "message": "ok"},
        )
        assert response.status_code == 200


class TestDataWorkshop:
    def test_symlink_dataset_scan_returns_real_path(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        target = tmp_path / "archive" / "rec_demo"
        _write_dataset(target)
        link = tmp_path / "datasets" / "local" / "rec_demo"
        link.symlink_to(target, target_is_directory=True)

        response = client.get("/api/data-workshop/datasets")

        assert response.status_code == 200
        payload = response.json()
        assert payload[0]["id"] == "local/rec_demo"
        assert payload[0]["is_symlink"] is True
        assert payload[0]["real_path"] == str(target.resolve())

    def test_empty_shell_diagnose_moves_to_excluded_candidate(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        dataset_dir = tmp_path / "datasets" / "local" / "empty"
        (dataset_dir / "meta").mkdir(parents=True)
        (dataset_dir / "meta" / "info.json").write_text(
            json.dumps({"total_episodes": 0, "total_frames": 0, "fps": 30, "features": {}}),
            encoding="utf-8",
        )

        response = client.post("/api/data-workshop/datasets/local/empty/diagnose")

        assert response.status_code == 200
        payload = response.json()
        assert payload["stage"] == "excluded"
        assert payload["diagnosis"]["damage_type"] == "empty_shell"
        assert payload["gates"]["auto_prune"]["status"] == "passed"
        assert dataset_dir.exists()

    def test_frame_count_mismatch_is_critical(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        _write_dataset(
            tmp_path / "datasets" / "local" / "bad_frames",
            total_frames=2,
            parquet_rows=3,
            episode_lengths=[2],
        )

        response = client.get("/api/data-workshop/datasets/local/bad_frames")

        assert response.status_code == 200
        issues = response.json()["structure"]["issues"]
        assert any(issue["check"] == "frame_count_mismatch" for issue in issues)

    def test_repair_records_history_and_repaired_output(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        dataset_dir = tmp_path / "datasets" / "local" / "repairable"
        _write_dataset(dataset_dir)
        repaired_dir = dataset_dir.parent / "repairable_repaired"
        repaired_dir.mkdir()

        diagnosis = SimpleNamespace(
            dataset_dir=dataset_dir,
            damage_type=SimpleNamespace(value="meta_stale"),
            repairable=True,
            details={"n_parquet_rows": 2},
        )
        monkeypatch.setattr(data_workshop_routes._service, "resolve_dataset_path", lambda _id: dataset_dir)
        monkeypatch.setattr("roboclaw.data.workshop.service.diagnose_dataset", lambda _path: diagnosis)
        monkeypatch.setattr(
            "roboclaw.data.workshop.service.repair_dataset",
            lambda *_args, **_kwargs: SimpleNamespace(outcome="repaired", error=None),
        )

        response = client.post("/api/data-workshop/datasets/local/repairable/repair", json={})

        assert response.status_code == 200
        gate = response.json()["gates"]["repair"]
        assert gate["status"] == "passed"
        assert gate["details"]["repaired_path"] == str(repaired_dir)

    def test_successful_repair_refreshes_stale_structure_state(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        dataset_dir = tmp_path / "datasets" / "local" / "repairable_mismatch"
        _write_dataset(dataset_dir, total_frames=2, parquet_rows=3, episode_lengths=[3])

        diagnose = client.post("/api/data-workshop/datasets/local/repairable_mismatch/diagnose")
        assert diagnose.status_code == 200
        assert any(
            issue["check"] == "frame_count_mismatch"
            for issue in diagnose.json()["structure"]["issues"]
        )

        diagnosis = SimpleNamespace(
            dataset_dir=dataset_dir,
            damage_type=SimpleNamespace(value="meta_stale"),
            repairable=True,
            details={"n_parquet_rows": 3},
        )

        def repair_in_place(*_args: object, **_kwargs: object) -> SimpleNamespace:
            info_path = dataset_dir / "meta" / "info.json"
            info = json.loads(info_path.read_text(encoding="utf-8"))
            info["total_frames"] = 3
            info_path.write_text(json.dumps(info), encoding="utf-8")
            return SimpleNamespace(outcome="repaired", error=None)

        monkeypatch.setattr("roboclaw.data.workshop.service.diagnose_dataset", lambda _path: diagnosis)
        monkeypatch.setattr("roboclaw.data.workshop.service.repair_dataset", repair_in_place)

        repaired = client.post("/api/data-workshop/datasets/local/repairable_mismatch/repair", json={})

        assert repaired.status_code == 200
        assert repaired.json()["structure"]["passed"] is True

        manual_gate = client.post(
            "/api/data-workshop/datasets/local/repairable_mismatch/gates/manual_boundary_review",
            json={"status": "passed", "message": "ok"},
        )
        assert manual_gate.status_code == 200

    def test_critical_structure_failure_cannot_be_manually_overridden(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        _write_dataset(tmp_path / "datasets" / "local" / "bad", total_frames=2, parquet_rows=3)

        response = client.post(
            "/api/data-workshop/datasets/local/bad/gates/manual_boundary_review",
            json={"status": "passed", "message": "accept"},
        )

        assert response.status_code == 409

    def test_critical_structure_failure_blocks_quality_override(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        _write_dataset(tmp_path / "datasets" / "local" / "bad_quality", total_frames=2, parquet_rows=3)

        response = client.post(
            "/api/data-workshop/datasets/local/bad_quality/gates/quality_validation",
            json={"status": "passed", "message": "accept"},
        )

        assert response.status_code == 409

    def test_only_clean_datasets_can_create_assembly_and_upload_placeholder(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        client = _client(tmp_path, monkeypatch)
        _write_dataset(tmp_path / "datasets" / "local" / "clean")
        _write_dataset(tmp_path / "datasets" / "local" / "dirty")
        _pass_required_gates(client, "local/clean")
        promote = client.post("/api/data-workshop/datasets/local/clean/promote", json={"target_stage": "clean"})
        assert promote.status_code == 200

        dirty_attempt = client.post(
            "/api/data-workshop/assemblies",
            json={"name": "bad package", "dataset_ids": ["local/dirty"]},
        )
        assert dirty_attempt.status_code == 409

        create = client.post(
            "/api/data-workshop/assemblies",
            json={"name": "good package", "dataset_ids": ["local/clean"], "groups": {"task-a": ["local/clean"]}},
        )
        assert create.status_code == 200
        assembly = create.json()
        assert assembly["name"] == "good package"
        assert assembly["dataset_ids"] == ["local/clean"]

        upload = client.post(f"/api/data-workshop/assemblies/{assembly['id']}/upload", json={})
        assert upload.status_code == 200
        assert upload.json()["upload_task"]["status"] == "queued"
