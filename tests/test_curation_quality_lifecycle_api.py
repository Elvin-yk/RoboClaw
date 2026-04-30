from __future__ import annotations

import json
from pathlib import Path

import pytest

from roboclaw.data import dataset_sessions
from roboclaw.data.curation import exports as curation_exports
from roboclaw.data.curation import service as curation_service
from roboclaw.data.curation.state import (
    load_workflow_state,
    save_quality_results,
    save_workflow_state,
    set_stage_pause_requested,
)
from tests.curation_api_helpers import _build_client, _write_demo_dataset


def test_quality_batch_can_pause_and_resume(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    dataset_path = _write_demo_dataset(dataset_root, total_episodes=3)
    service = curation_service._LegacyCurationService(dataset_path, "demo")

    def _fake_run_quality_validators(
        target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        if episode_index == 0:
            set_stage_pause_requested(target_dataset_path, "quality_validation", True)
        return {
            "passed": episode_index != 1,
            "score": 100.0 if episode_index != 1 else 50.0,
            "validators": {
                "metadata": {
                    "passed": episode_index != 1,
                    "score": 100.0 if episode_index != 1 else 50.0,
                },
            },
            "issues": [] if episode_index != 1 else [{"check_name": "fps", "passed": False}],
        }

    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)

    paused = service.run_quality_batch(["metadata"], threshold_overrides={"metadata_min_duration_s": 1.0})
    assert paused["episodes"][0]["episode_index"] == 0
    assert len(paused["episodes"]) == 1

    paused_state = load_workflow_state(dataset_path)
    assert paused_state["stages"]["quality_validation"]["status"] == "paused"
    assert paused_state["stages"]["quality_validation"]["pause_requested"] is False
    assert paused_state["stages"]["quality_validation"]["summary"]["completed"] == 1

    resumed = service.run_quality_batch(
        ["metadata"],
        episode_indices=[1, 2],
        threshold_overrides={"metadata_min_duration_s": 1.0},
        resume_existing=True,
    )
    assert resumed["total"] == 3
    assert [episode["episode_index"] for episode in resumed["episodes"]] == [0, 1, 2]

    resumed_state = load_workflow_state(dataset_path)
    assert resumed_state["stages"]["quality_validation"]["status"] == "completed"
    assert resumed_state["stages"]["quality_validation"]["summary"]["completed"] == 3


def test_quality_resume_empty_remaining_does_not_rerun_base_checks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=2)
    save_quality_results(
        dataset_path,
        {
            "total": 2,
            "passed": 2,
            "failed": 0,
            "overall_score": 100.0,
            "episodes": [
                {
                    "episode_index": 0,
                    "passed": True,
                    "score": 100.0,
                    "validators": {"metadata": {"passed": True, "score": 100.0}},
                    "issues": [],
                },
                {
                    "episode_index": 1,
                    "passed": True,
                    "score": 100.0,
                    "validators": {"metadata": {"passed": True, "score": 100.0}},
                    "issues": [],
                },
            ],
            "selected_validators": ["metadata"],
        },
    )

    def _unexpected_run_quality_validators(*_args: object, **_kwargs: object) -> dict[str, object]:
        raise AssertionError("resume with an empty remaining list must not rerun base validators")

    monkeypatch.setattr(curation_service, "run_quality_validators", _unexpected_run_quality_validators)

    result = curation_service._LegacyCurationService(dataset_path, "demo").run_quality_batch(
        ["metadata"],
        episode_indices=[],
        resume_existing=True,
    )

    assert result["total"] == 2
    assert [episode["episode_index"] for episode in result["episodes"]] == [0, 1]
    state = load_workflow_state(dataset_path)
    assert state["stages"]["quality_validation"]["status"] == "completed"
    assert state["stages"]["quality_validation"]["summary"]["completed"] == 2


def test_quality_batch_cleans_remote_video_cache_after_last_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = tmp_path / "session:remote:cache-demo"
    (dataset_path / "meta").mkdir(parents=True)
    video_dir = dataset_path / "videos" / "observation.images.front" / "chunk-000"
    video_dir.mkdir(parents=True)
    first_video = video_dir / "file-000.mp4"
    second_video = video_dir / "file-001.mp4"
    first_video.write_bytes(b"first")
    second_video.write_bytes(b"second")
    info = {
        "total_episodes": 3,
        "total_frames": 3,
        "fps": 30,
        "robot_type": "so101",
        "chunks_size": 1000,
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "observation.images.front": {
                "dtype": "video",
                "shape": [480, 640, 3],
                "info": {"video.fps": 30, "video.width": 640, "video.height": 480},
            }
        },
    }
    (dataset_path / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        "\n".join(
            [
                json.dumps({
                    "episode_index": 0,
                    "length": 1.0,
                    "videos/observation.images.front/chunk_index": 0,
                    "videos/observation.images.front/file_index": 0,
                }),
                json.dumps({
                    "episode_index": 1,
                    "length": 1.0,
                    "videos/observation.images.front/chunk_index": 0,
                    "videos/observation.images.front/file_index": 0,
                }),
                json.dumps({
                    "episode_index": 2,
                    "length": 1.0,
                    "videos/observation.images.front/chunk_index": 0,
                    "videos/observation.images.front/file_index": 1,
                }),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    cleanup_calls: list[tuple[int, list[int]]] = []

    def _fake_run_quality_validators(
        _target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        return {
            "passed": True,
            "score": 100.0,
            "validators": {"metadata": {"passed": True, "score": 100.0}},
            "issues": [],
        }

    original_cleanup = curation_service._cleanup_completed_remote_episode_assets

    def _spy_cleanup(
        target_dataset_path: Path,
        target_info: dict[str, object],
        completed_episode_index: int,
        remaining_episode_indices: set[int],
    ) -> dict[str, object]:
        result = original_cleanup(
            target_dataset_path,
            target_info,
            completed_episode_index,
            remaining_episode_indices,
        )
        cleanup_calls.append((completed_episode_index, sorted(remaining_episode_indices)))
        return result

    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)
    monkeypatch.setattr(curation_service, "_cleanup_completed_remote_episode_assets", _spy_cleanup)

    result = curation_service._LegacyCurationService(dataset_path, dataset_path.name).run_quality_batch(["metadata"])

    assert result["total"] == 3
    assert cleanup_calls == [(0, [1, 2]), (1, [2]), (2, [])]
    assert not first_video.exists()
    assert not second_video.exists()
    assert not (dataset_path / "videos").exists()


def test_quality_batch_cleans_real_remote_session_dataset_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    remote_root = tmp_path / "dataset-sessions" / "remote"
    dataset_path = remote_root / "cache-demo" / "dataset"
    (dataset_path / "meta").mkdir(parents=True)
    video_dir = dataset_path / "videos" / "observation.images.front" / "chunk-000"
    video_dir.mkdir(parents=True)
    video_path = video_dir / "file-000.mp4"
    video_path.write_bytes(b"remote")
    info = {
        "total_episodes": 1,
        "total_frames": 1,
        "fps": 30,
        "robot_type": "so101",
        "chunks_size": 1000,
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "observation.images.front": {
                "dtype": "video",
                "shape": [480, 640, 3],
                "info": {"video.fps": 30, "video.width": 640, "video.height": 480},
            }
        },
    }
    (dataset_path / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        json.dumps({
            "episode_index": 0,
            "length": 1.0,
            "videos/observation.images.front/chunk_index": 0,
            "videos/observation.images.front/file_index": 0,
        })
        + "\n",
        encoding="utf-8",
    )

    def _fake_run_quality_validators(
        _target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        return {
            "passed": True,
            "score": 100.0,
            "validators": {"metadata": {"passed": True, "score": 100.0}},
            "issues": [],
        }

    monkeypatch.setattr(dataset_sessions, "_session_root", lambda: tmp_path / "dataset-sessions")
    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)

    result = curation_service._LegacyCurationService(dataset_path, "session:remote:cache-demo").run_quality_batch(["metadata"])

    assert result["total"] == 1
    assert not video_path.exists()
    assert not (dataset_path / "videos").exists()


def test_quality_resume_cleans_completed_remote_video_cache(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = tmp_path / "session:remote:resume-demo"
    (dataset_path / "meta").mkdir(parents=True)
    video_dir = dataset_path / "videos" / "observation.images.front" / "chunk-000"
    video_dir.mkdir(parents=True)
    completed_video = video_dir / "file-000.mp4"
    remaining_video = video_dir / "file-001.mp4"
    completed_video.write_bytes(b"completed")
    remaining_video.write_bytes(b"remaining")
    info = {
        "total_episodes": 2,
        "total_frames": 2,
        "fps": 30,
        "robot_type": "so101",
        "chunks_size": 1000,
        "video_path": "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
        "features": {
            "observation.images.front": {
                "dtype": "video",
                "shape": [480, 640, 3],
                "info": {"video.fps": 30, "video.width": 640, "video.height": 480},
            }
        },
    }
    (dataset_path / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        "\n".join(
            [
                json.dumps({
                    "episode_index": 0,
                    "length": 1.0,
                    "videos/observation.images.front/chunk_index": 0,
                    "videos/observation.images.front/file_index": 0,
                }),
                json.dumps({
                    "episode_index": 1,
                    "length": 1.0,
                    "videos/observation.images.front/chunk_index": 0,
                    "videos/observation.images.front/file_index": 1,
                }),
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    save_quality_results(
        dataset_path,
        {
            "total": 2,
            "passed": 1,
            "failed": 0,
            "overall_score": 100.0,
            "episodes": [
                {
                    "episode_index": 0,
                    "passed": True,
                    "score": 100.0,
                    "validators": {"metadata": {"passed": True, "score": 100.0}},
                    "issues": [],
                }
            ],
            "selected_validators": ["metadata"],
        },
    )

    def _fake_run_quality_validators(
        _target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        assert not completed_video.exists()
        assert remaining_video.exists()
        return {
            "passed": True,
            "score": 100.0,
            "validators": {"metadata": {"passed": True, "score": 100.0}},
            "issues": [],
        }

    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)

    result = curation_service._LegacyCurationService(dataset_path, dataset_path.name).run_quality_batch(
        ["metadata"],
        episode_indices=[1],
        resume_existing=True,
    )

    assert result["total"] == 2
    assert not completed_video.exists()
    assert not remaining_video.exists()


def test_quality_batch_keeps_local_dataset_videos(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=1)
    video_path = dataset_path / "videos" / "chunk-000" / "episode_000000" / "front.mp4"
    video_path.write_bytes(b"local")

    def _fake_run_quality_validators(
        _target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        return {
            "passed": True,
            "score": 100.0,
            "validators": {"metadata": {"passed": True, "score": 100.0}},
            "issues": [],
        }

    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)

    curation_service._LegacyCurationService(dataset_path, "demo").run_quality_batch(["metadata"])

    assert video_path.read_bytes() == b"local"


def test_delete_quality_results_clears_artifacts_and_stage(
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

    working_parquet = curation_exports.workflow_quality_parquet_path(dataset_path)
    working_parquet.parent.mkdir(parents=True, exist_ok=True)
    working_parquet.write_bytes(b"working")

    published_parquet = curation_exports.dataset_quality_parquet_path(dataset_path)
    published_parquet.parent.mkdir(parents=True, exist_ok=True)
    published_parquet.write_bytes(b"published")

    state = load_workflow_state(dataset_path)
    state["stages"]["quality_validation"] = {
        "status": "completed",
        "selected_validators": ["metadata"],
        "latest_run": {"id": "quality-run-1"},
        "summary": {"total": 1, "passed": 1},
    }
    save_workflow_state(dataset_path, state)

    response = client.delete(
        "/api/curation/quality-results",
        params={"dataset": "demo"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "deleted"
    assert len(payload["removed_paths"]) == 3

    assert not (dataset_path / ".workflow" / "quality" / "latest.json").exists()
    assert not working_parquet.exists()
    assert not published_parquet.exists()

    refreshed_state = load_workflow_state(dataset_path)
    quality_stage = refreshed_state["stages"]["quality_validation"]
    assert quality_stage["status"] == "idle"
    assert quality_stage["selected_validators"] == []
    assert quality_stage["latest_run"] is None
    assert quality_stage["summary"] is None

    quality_response = client.get(
        "/api/curation/quality-results",
        params={"dataset": "demo"},
    )
    assert quality_response.status_code == 200
    assert quality_response.json()["episodes"] == []
