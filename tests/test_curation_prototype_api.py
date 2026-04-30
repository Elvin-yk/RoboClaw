from __future__ import annotations

from pathlib import Path

import pytest

from roboclaw.data.curation import service as curation_service
from roboclaw.data.curation.state import load_workflow_state
from roboclaw.http.routes import curation as curation_routes
from tests.curation_api_helpers import _build_client, _write_demo_dataset


def test_prototype_run_passes_selected_episode_indices_and_filter_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)
    captured: dict[str, object] = {}

    async def _fake_start_prototype_run(
        dataset_path: Path,
        dataset_name: str,
        cluster_count: int | None,
        candidate_limit: int | None,
        episode_indices: list[int] | None = None,
        quality_filter_mode: str = "passed",
    ) -> dict[str, str]:
        captured["dataset_path"] = dataset_path
        captured["dataset_name"] = dataset_name
        captured["cluster_count"] = cluster_count
        captured["candidate_limit"] = candidate_limit
        captured["episode_indices"] = episode_indices
        captured["quality_filter_mode"] = quality_filter_mode
        return {"status": "started"}

    monkeypatch.setattr(curation_routes, "_service", curation_service.CurationService())
    monkeypatch.setattr(curation_routes._service, "start_prototype_run", _fake_start_prototype_run)

    response = client.post(
        "/api/curation/prototype-run",
        json={
            "dataset": "demo",
            "cluster_count": 3,
            "candidate_limit": 40,
            "episode_indices": [0, 2, 5],
            "quality_filter_mode": "all",
        },
    )

    assert response.status_code == 200
    assert captured["dataset_name"] == "demo"
    assert captured["cluster_count"] == 3
    assert captured["candidate_limit"] == 40
    assert captured["episode_indices"] == [0, 2, 5]
    assert captured["quality_filter_mode"] == "all"


def test_prototype_run_uses_all_candidates_by_default(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)
    captured: dict[str, object] = {}

    async def _fake_start_prototype_run(
        dataset_path: Path,
        dataset_name: str,
        cluster_count: int | None,
        candidate_limit: int | None,
        episode_indices: list[int] | None = None,
        quality_filter_mode: str = "passed",
    ) -> dict[str, str]:
        captured["candidate_limit"] = candidate_limit
        return {"status": "started"}

    monkeypatch.setattr(curation_routes, "_service", curation_service.CurationService())
    monkeypatch.setattr(curation_routes._service, "start_prototype_run", _fake_start_prototype_run)

    response = client.post(
        "/api/curation/prototype-run",
        json={
            "dataset": "demo",
            "cluster_count": None,
            "quality_filter_mode": "raw",
        },
    )

    assert response.status_code == 200
    assert captured["candidate_limit"] is None


def test_prototype_run_keeps_explicit_large_candidate_limit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, _dataset_path = _build_client(tmp_path, monkeypatch)
    captured: dict[str, object] = {}

    async def _fake_start_prototype_run(
        dataset_path: Path,
        dataset_name: str,
        cluster_count: int | None,
        candidate_limit: int | None,
        episode_indices: list[int] | None = None,
        quality_filter_mode: str = "passed",
    ) -> dict[str, str]:
        captured["candidate_limit"] = candidate_limit
        return {"status": "started"}

    monkeypatch.setattr(curation_routes, "_service", curation_service.CurationService())
    monkeypatch.setattr(curation_routes._service, "start_prototype_run", _fake_start_prototype_run)

    response = client.post(
        "/api/curation/prototype-run",
        json={
            "dataset": "demo",
            "candidate_limit": 271,
            "quality_filter_mode": "raw",
        },
    )

    assert response.status_code == 200
    assert captured["candidate_limit"] == 271


def test_prototype_discovery_raw_mode_uses_all_dataset_episodes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=271)
    captured: dict[str, object] = {}

    def _fake_build_canonical_entries(
        _dataset_path: Path,
        episode_indices: list[int],
        _progress_callback: object = None,
    ) -> list[dict[str, object]]:
        captured["episode_indices"] = list(episode_indices)
        return [
            {
                "record_key": str(index),
                "episode_index": index,
                "sequence": [[float(index)]],
                "quality": {"passed": True, "score": 100.0},
            }
            for index in episode_indices
        ]

    def _fake_discover_grouped_prototypes(
        entries: list[dict[str, object]],
        *,
        cluster_count: int | None = None,
        progress_callback: object = None,
    ) -> dict[str, object]:
        return {
            "clustering": {"cluster_count": 1},
            "refinement": {
                "cluster_count": 1,
                "anchor_record_keys": ["0"],
                "clusters": [
                    {
                        "cluster_index": 0,
                        "prototype_record_key": "0",
                        "anchor_record_key": "0",
                        "member_count": len(entries),
                        "members": [
                            {"record_key": entry["record_key"], "episode_index": entry["episode_index"]}
                            for entry in entries
                        ],
                    }
                ],
            },
            "group_count": 1,
        }

    monkeypatch.setattr(curation_service, "_build_canonical_entries", _fake_build_canonical_entries)
    monkeypatch.setattr(curation_service, "discover_grouped_prototypes", _fake_discover_grouped_prototypes)

    result = curation_service._LegacyCurationService(dataset_path, "demo").run_prototype_discovery(
        quality_filter_mode="raw",
    )

    assert captured["episode_indices"] == list(range(271))
    assert result["quality_filter_mode"] == "raw"
    assert result["selected_episode_indices"] == list(range(271))
    assert result["candidate_count"] == 271
    state = load_workflow_state(dataset_path)
    prototype_stage = state["stages"]["prototype_discovery"]
    assert prototype_stage["selected_episode_indices"] == list(range(271))
    assert prototype_stage["summary"]["candidate_count"] == 271
    assert prototype_stage["summary"]["entry_count"] == 271


def test_prototype_discovery_loads_trajectory_without_videos(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=1)
    captured: dict[str, object] = {}

    def _fake_load_episode_data(
        _dataset_path: Path,
        episode_index: int,
        *,
        include_videos: bool = True,
    ) -> dict[str, object]:
        captured["include_videos"] = include_videos
        return {
            "info": {
                "robot_type": "so101",
                "features": {
                    "action": {"names": ["joint_1"]},
                    "observation.state": {"names": ["joint_1"]},
                },
            },
            "episode_meta": {"episode_index": episode_index, "task": "pick"},
            "rows": [
                {
                    "timestamp": 0.0,
                    "action": [0.0],
                    "observation.state": [0.0],
                    "task": "pick",
                },
                {
                    "timestamp": 0.1,
                    "action": [1.0],
                    "observation.state": [1.0],
                    "task": "pick",
                },
            ],
            "video_files": [],
        }

    def _fake_discover_grouped_prototypes(
        entries: list[dict[str, object]],
        *,
        cluster_count: int | None = None,
        progress_callback: object = None,
    ) -> dict[str, object]:
        return {
            "clustering": {"cluster_count": 1},
            "refinement": {
                "cluster_count": 1,
                "anchor_record_keys": ["0"],
                "clusters": [],
            },
            "group_count": 1,
        }

    monkeypatch.setattr(curation_service, "load_episode_data", _fake_load_episode_data)
    monkeypatch.setattr(curation_service, "discover_grouped_prototypes", _fake_discover_grouped_prototypes)

    result = curation_service._LegacyCurationService(dataset_path, "demo").run_prototype_discovery(
        episode_indices=[0],
    )

    assert captured["include_videos"] is False
    assert result["entry_count"] == 1
