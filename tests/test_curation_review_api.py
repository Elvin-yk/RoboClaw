from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.curation.review.service import ReviewService
from roboclaw.http.routes import curation as curation_routes


def _write_dataset(
    root: Path,
    dataset_id: str,
    *,
    total_episodes: int = 3,
    extra_info: dict[str, Any] | None = None,
) -> Path:
    dataset_path = root / dataset_id
    (dataset_path / "meta").mkdir(parents=True)
    info: dict[str, Any] = {
        "total_episodes": total_episodes,
        "total_frames": total_episodes * 4,
        "fps": 30,
        "robot_type": "so101",
        "features": {"action": {"names": ["g"]}},
    }
    if extra_info:
        info.update(extra_info)
    (dataset_path / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        "\n".join(
            json.dumps({"episode_index": i, "length": 4.0, "task": "pick"})
            for i in range(total_episodes)
        )
        + "\n",
        encoding="utf-8",
    )
    return dataset_path


def _build_review_app(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    summaries: list[dict[str, Any]] | None = None,
) -> tuple[TestClient, Path]:
    dataset_root = tmp_path / "datasets"
    dataset_root.mkdir()
    monkeypatch.setattr(curation_routes, "datasets_root", lambda: dataset_root)

    summaries = summaries if summaries is not None else []

    def _resolver(dataset_id: str) -> Path:
        candidate = dataset_root / dataset_id
        if not candidate.is_dir():
            from fastapi import HTTPException

            raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found")
        return candidate

    review = ReviewService(
        dataset_path_resolver=_resolver,
        list_summaries=lambda: summaries,
        datasets_root_provider=lambda: dataset_root,
    )
    monkeypatch.setattr(curation_routes, "_review_service", review)

    app = FastAPI()
    curation_routes.register_curation_routes(app)
    return TestClient(app), dataset_root


def test_review_datasets_route_returns_filtered_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    summaries = [
        {"id": "good_critical_phase", "label": "Good"},
        {"id": "regular", "label": "Regular"},
    ]
    client, dataset_root = _build_review_app(tmp_path, monkeypatch, summaries)
    _write_dataset(dataset_root, "good_critical_phase")
    _write_dataset(dataset_root, "regular")

    response = client.get("/api/curation/review/datasets")
    assert response.status_code == 200
    payload = response.json()
    assert [item["id"] for item in payload] == ["good_critical_phase"]

    response_all = client.get("/api/curation/review/datasets?critical_only=false")
    assert response_all.status_code == 200
    assert {item["id"] for item in response_all.json()} == {"good_critical_phase", "regular"}


def test_review_state_route_returns_state_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase")

    response = client.get(
        "/api/curation/review/state", params={"dataset": "ds_critical_phase"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["state"]["dataset_id"] == "ds_critical_phase"
    assert body["state"]["marks"] == {}
    assert body["summary"]["total_episodes"] == 3
    assert body["summary"]["reviewed"] == 0


def test_review_set_mark_route_roundtrips(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase")

    put = client.put(
        "/api/curation/review/marks/0",
        json={"dataset": "ds_critical_phase", "abnormal": True},
    )
    assert put.status_code == 200
    assert put.json()["state"]["marks"]["0"]["abnormal"] is True

    state_resp = client.get(
        "/api/curation/review/state", params={"dataset": "ds_critical_phase"}
    )
    assert state_resp.status_code == 200
    assert state_resp.json()["summary"]["abnormal"] == 1


def test_review_bulk_marks_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase", total_episodes=4)

    response = client.put(
        "/api/curation/review/marks",
        json={
            "dataset": "ds_critical_phase",
            "marks": [
                {"episode_index": 0, "abnormal": False},
                {"episode_index": 2, "abnormal": True},
            ],
        },
    )
    assert response.status_code == 200
    marks = response.json()["state"]["marks"]
    assert marks["0"]["abnormal"] is False
    assert marks["2"]["abnormal"] is True


def test_review_commit_deletion_happy_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase", total_episodes=4)

    client.put(
        "/api/curation/review/marks/1",
        json={"dataset": "ds_critical_phase", "abnormal": True},
    )

    captured: dict[str, Any] = {}

    def _fake_extract(
        *,
        source_root: Path,
        output_root: Path,
        intervals: list[Any],
        source_repo_id: str,
        output_repo_id: str,
        task: str,
        vcodec: str,
    ) -> Path:
        captured["intervals"] = list(intervals)
        return output_root

    import roboclaw.data.dataset_pipeline.multi_event_extractor as me

    monkeypatch.setattr(me, "extract_event_windows_dataset", _fake_extract)

    response = client.post(
        "/api/curation/review/commit-deletion",
        json={
            "dataset_id": "ds_critical_phase",
            "output_dataset_id": "ds_clean",
            "task": "pick",
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["output_dataset"] == "ds_clean"
    assert body["output_path"].endswith("ds_clean")
    assert body["kept_episode_indices"] == [0, 2, 3]
    assert body["deleted_episode_indices"] == [1]
    assert len(captured["intervals"]) == 3


def test_review_commit_deletion_with_no_abnormal_marks_returns_400(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase")

    response = client.post(
        "/api/curation/review/commit-deletion",
        json={
            "dataset_id": "ds_critical_phase",
            "output_dataset_id": "ds_clean",
            "task": "pick",
        },
    )
    assert response.status_code == 400
    assert "no abnormal marks" in response.json()["detail"]


def test_review_commit_deletion_existing_output_returns_409(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    _write_dataset(dataset_root, "ds_critical_phase", total_episodes=3)
    (dataset_root / "ds_clean").mkdir()

    client.put(
        "/api/curation/review/marks/0",
        json={"dataset": "ds_critical_phase", "abnormal": True},
    )

    response = client.post(
        "/api/curation/review/commit-deletion",
        json={
            "dataset_id": "ds_critical_phase",
            "output_dataset_id": "ds_clean",
            "task": "pick",
        },
    )
    assert response.status_code == 409
    assert "already exists" in response.json()["detail"].lower()


def test_review_episode_route_returns_video_urls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, dataset_root = _build_review_app(tmp_path, monkeypatch)
    dataset_path = _write_dataset(dataset_root, "ds_critical_phase")
    video_path = dataset_path / "videos" / "chunk-000" / "ep_000000" / "front.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"")

    from roboclaw.data.curation.review import service as review_service_module

    def _fake_load_episode_data(
        target_dataset_path: Path,
        episode_index: int,
        *,
        include_videos: bool = True,
    ) -> dict[str, Any]:
        return {
            "episode_meta": {"episode_index": episode_index, "length": 4.0},
            "video_files": [video_path],
        }

    monkeypatch.setattr(
        review_service_module, "load_episode_data", _fake_load_episode_data
    )

    response = client.get(
        "/api/curation/review/episode",
        params={"dataset": "ds_critical_phase", "episode_index": 0},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["episode_index"] == 0
    assert payload["videos"]
    assert "/api/curation/video/" in payload["videos"][0]["url"]
    assert "dataset=ds_critical_phase" in payload["videos"][0]["url"]
