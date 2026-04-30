from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from roboclaw.data.curation import propagation_history
from roboclaw.data.curation import service as curation_service
from roboclaw.data.curation.state import (
    load_quality_results,
    load_workflow_state,
    save_prototype_results,
    save_quality_results,
    save_workflow_state,
)
from tests.curation_api_helpers import _build_client, _write_demo_dataset


def test_duplicate_propagation_run_keeps_existing_task(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run() -> None:
        dataset_path = _write_demo_dataset(tmp_path)
        service = curation_service.CurationService()
        started = asyncio.Event()
        release = asyncio.Event()
        calls: list[int] = []

        async def _fake_to_thread(
            _function: object,
            source_episode_index: int,
        ) -> dict[str, object]:
            calls.append(source_episode_index)
            started.set()
            await release.wait()
            curation_service._update_stage_summary(
                dataset_path,
                "annotation",
                {
                    "source_episode_index": source_episode_index,
                    "target_count": 0,
                    "annotated_count": 1,
                },
            )
            return {"source_episode_index": source_episode_index}

        monkeypatch.setattr(curation_service.asyncio, "to_thread", _fake_to_thread)

        first = await service.start_propagation_run(dataset_path, "demo", 0)
        assert first == {"status": "started"}
        await asyncio.wait_for(started.wait(), timeout=1)

        running_state = load_workflow_state(dataset_path)
        assert running_state["stages"]["annotation"]["status"] == "running"

        second = await service.start_propagation_run(dataset_path, "demo", 0)
        assert second == {"status": "already_running"}
        assert calls == [0]

        duplicate_state = load_workflow_state(dataset_path)
        assert duplicate_state["stages"]["annotation"]["status"] == "running"

        task = service._active_stage_task(dataset_path, "annotation")
        assert task is not None
        release.set()
        await asyncio.wait_for(task, timeout=1)

        completed_state = load_workflow_state(dataset_path)
        assert completed_state["stages"]["annotation"]["status"] == "completed"

    asyncio.run(_run())


def test_propagation_source_history_accumulates_across_runs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _run() -> None:
        dataset_path = _write_demo_dataset(tmp_path)
        service = curation_service.CurationService()
        calls: list[int] = []

        async def _fake_to_thread(
            _function: object,
            source_episode_index: int,
        ) -> dict[str, object]:
            calls.append(source_episode_index)
            previous_results = curation_service.load_propagation_results(dataset_path)
            state = load_workflow_state(dataset_path)
            annotation_stage = state["stages"]["annotation"]
            source_history = propagation_history.collect_propagated_source_episodes(
                annotation_stage,
                previous_results,
                source_episode_index,
            )
            curation_service.save_propagation_results(
                dataset_path,
                {
                    "source_episode_index": source_episode_index,
                    "source_episode_indices": source_history,
                    "target_count": 0,
                    "propagated": [],
                },
            )
            annotation_stage["propagated_source_episodes"] = source_history
            save_workflow_state(dataset_path, state)
            curation_service._update_stage_summary(
                dataset_path,
                "annotation",
                {
                    "source_episode_index": source_episode_index,
                    "propagated_source_episodes": source_history,
                    "target_count": 0,
                },
            )
            return {"source_episode_index": source_episode_index}

        monkeypatch.setattr(curation_service.asyncio, "to_thread", _fake_to_thread)

        first = await service.start_propagation_run(dataset_path, "demo", 1)
        assert first == {"status": "started"}
        first_task = service._active_stage_task(dataset_path, "annotation")
        assert first_task is not None
        await asyncio.wait_for(first_task, timeout=1)

        second = await service.start_propagation_run(dataset_path, "demo", 2)
        assert second == {"status": "started"}
        second_task = service._active_stage_task(dataset_path, "annotation")
        assert second_task is not None
        await asyncio.wait_for(second_task, timeout=1)

        state = load_workflow_state(dataset_path)
        results = curation_service.load_propagation_results(dataset_path)
        assert calls == [1, 2]
        assert state["stages"]["annotation"]["propagated_source_episodes"] == [1, 2]
        assert results is not None
        assert results["source_episode_indices"] == [1, 2]

    asyncio.run(_run())


def test_workflow_state_recovers_propagated_sources_from_saved_annotations(
    tmp_path: Path,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=2)
    curation_service.save_annotations(
        dataset_path,
        1,
        {
            "episode_index": 1,
            "task_context": {
                "source": "propagation",
                "source_episode_index": 0,
            },
            "annotations": [
                {
                    "id": "ann-1",
                    "label": "Pick",
                    "startTime": 0.0,
                    "endTime": 0.5,
                    "source": "dtw_propagated",
                },
            ],
        },
    )

    state = curation_service.CurationService().get_workflow_state(dataset_path)

    assert state["stages"]["annotation"]["propagated_source_episodes"] == [0]
    assert load_workflow_state(dataset_path)["stages"]["annotation"][
        "propagated_source_episodes"
    ] == [0]


def test_quality_pause_request_marks_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)
    save_quality_results(
        dataset_path,
        {
            "total": 3,
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
                },
            ],
            "selected_validators": ["metadata"],
        },
    )

    state = load_workflow_state(dataset_path)
    state["stages"]["quality_validation"]["status"] = "running"
    state["stages"]["quality_validation"]["selected_validators"] = ["metadata"]
    state["stages"]["quality_validation"]["active_run_id"] = "run-1"
    save_workflow_state(dataset_path, state)

    response = client.post("/api/curation/quality-pause", json={"dataset": "demo"})
    assert response.status_code == 200
    assert response.json()["status"] == "paused"

    updated = load_workflow_state(dataset_path)
    quality_stage = updated["stages"]["quality_validation"]
    assert quality_stage["status"] == "paused"
    assert quality_stage["pause_requested"] is False
    assert quality_stage["active_run_id"] is None
    assert quality_stage["summary"]["completed"] == 1
    assert quality_stage["summary"]["remaining"] == 2


def test_quality_pause_cancels_active_task_without_error(tmp_path: Path) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=2)
    service = curation_service.CurationService()

    async def _run() -> None:
        started = asyncio.Event()

        async def _task() -> None:
            state = load_workflow_state(dataset_path)
            stage = state["stages"]["quality_validation"]
            stage["status"] = "running"
            stage["active_run_id"] = "run-1"
            save_workflow_state(dataset_path, state)
            started.set()
            await asyncio.sleep(30)

        service._register_workflow_task(dataset_path, "quality_validation", _task())
        await started.wait()
        task = service._active_stage_task(dataset_path, "quality_validation")
        assert task is not None

        response = service.pause_quality_run(dataset_path, "demo")
        assert response == {"status": "paused", "pause_requested": False}
        with pytest.raises(asyncio.CancelledError):
            await task

        updated = load_workflow_state(dataset_path)
        quality_stage = updated["stages"]["quality_validation"]
        assert quality_stage["status"] == "paused"
        assert quality_stage["pause_requested"] is False
        assert quality_stage["active_run_id"] is None

    asyncio.run(_run())


def test_stale_quality_run_does_not_overwrite_paused_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_demo_dataset(tmp_path, total_episodes=2)
    service = curation_service.CurationService()
    legacy = curation_service._LegacyCurationService(dataset_path, "demo")
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
                },
            ],
            "selected_validators": ["metadata"],
        },
    )

    def _fake_run_quality_validators(
        target_dataset_path: Path,
        episode_index: int,
        *,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
    ) -> dict[str, object]:
        service.pause_quality_run(target_dataset_path, "demo")
        return {
            "passed": False,
            "score": 10.0,
            "validators": {"metadata": {"passed": False, "score": 10.0}},
            "issues": [{"check_name": "metadata", "passed": False}],
        }

    monkeypatch.setattr(curation_service, "run_quality_validators", _fake_run_quality_validators)

    result = legacy.run_quality_batch(
        ["metadata"],
        episode_indices=[1],
        resume_existing=True,
        run_id="run-1",
    )

    assert [episode["episode_index"] for episode in result["episodes"]] == [0]
    updated = load_workflow_state(dataset_path)
    quality_stage = updated["stages"]["quality_validation"]
    assert quality_stage["status"] == "paused"
    assert quality_stage["active_run_id"] is None
    assert quality_stage["summary"]["completed"] == 1
    assert load_quality_results(dataset_path)["episodes"][0]["episode_index"] == 0


def test_alignment_overview_combines_quality_and_alignment_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)

    save_quality_results(
        dataset_path,
        {
            "total": 2,
            "passed": 1,
            "failed": 1,
            "overall_score": 91.0,
            "episodes": [
                {
                    "episode_index": 0,
                    "passed": True,
                    "score": 98.0,
                    "validators": {"metadata": {"passed": True, "score": 100.0}},
                    "issues": [],
                },
                {
                    "episode_index": 1,
                    "passed": False,
                    "score": 84.0,
                    "validators": {"timing": {"passed": False, "score": 70.0}},
                    "issues": [{"check_name": "timing", "passed": False, "message": "bad timing"}],
                },
            ],
            "selected_validators": ["metadata", "timing"],
        },
    )
    save_prototype_results(
        dataset_path,
        {
            "candidate_count": 2,
            "entry_count": 2,
            "cluster_count": 1,
            "quality_filter_mode": "all",
            "selected_episode_indices": [0, 1],
            "refinement": {
                "anchor_record_keys": ["0"],
                "clusters": [],
            },
        },
    )
    curation_service.save_annotations(
        dataset_path,
        0,
        {
            "episode_index": 0,
            "task_context": {"label": "Pick", "text": "pick object"},
            "annotations": [
                {
                    "id": "ann-1",
                    "label": "Pick",
                    "category": "movement",
                    "color": "#ff8a5b",
                    "startTime": 0.0,
                    "endTime": 0.5,
                    "text": "pick object",
                    "tags": ["manual"],
                    "source": "user",
                }
            ],
        },
    )
    curation_service.save_propagation_results(
        dataset_path,
        {
            "source_episode_index": 0,
            "target_count": 1,
            "propagated": [
                {
                    "episode_index": 1,
                    "prototype_score": 0.88,
                    "alignment_method": "dtw",
                    "spans": [
                        {
                            "id": "ann-1",
                            "label": "Pick",
                            "startTime": 0.1,
                            "endTime": 0.4,
                            "source": "dtw_propagated",
                        }
                    ],
                }
            ],
        },
    )

    response = client.get(
        "/api/curation/alignment-overview",
        params={"dataset": "demo"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["total_checked"] == 2
    assert payload["summary"]["aligned_count"] == 2
    assert payload["summary"]["quality_filter_mode"] == "all"
    assert payload["distribution"]["issue_types"][0]["label"] == "timing"
    rows = {row["episode_index"]: row for row in payload["rows"]}
    assert rows[0]["alignment_status"] == "annotated"
    assert rows[0]["task"] == "pick object"
    assert rows[0]["semantic_task_text"] == "pick object"
    assert rows[0]["task_source"] == "semantic_supplement"
    assert rows[0]["task_is_supplemental"] is True
    assert rows[0]["annotation_spans"][0]["label"] == "Pick"
    assert rows[1]["alignment_status"] == "propagated"
    assert rows[1]["quality_status"] == "failed"
    assert rows[1]["task"] == "Pick"
    assert rows[1]["task_is_supplemental"] is True
    assert rows[1]["propagation_source_episode_index"] == 0
    assert rows[1]["propagation_alignment_method"] == "dtw"
    assert rows[1]["propagation_spans"][0]["label"] == "Pick"
    assert rows[1]["propagation_spans"][0]["dtw_start_delay_s"] == 0.1
    assert rows[1]["propagation_spans"][0]["duration_delta_s"] == -0.2


def test_alignment_overview_recovers_saved_propagated_annotations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)

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
        },
    )
    curation_service.save_annotations(
        dataset_path,
        0,
        {
            "episode_index": 0,
            "task_context": {"label": "Pick", "text": "pick object"},
            "annotations": [
                {
                    "id": "ann-1",
                    "label": "Pick",
                    "startTime": 1.0,
                    "endTime": 2.0,
                    "text": "pick object",
                    "source": "user",
                }
            ],
        },
    )
    curation_service.save_annotations(
        dataset_path,
        1,
        {
            "episode_index": 1,
            "task_context": {
                "source": "propagation",
                "source_episode_index": 0,
            },
            "annotations": [
                {
                    "id": "ann-1",
                    "label": "Pick",
                    "startTime": 1.25,
                    "endTime": 2.5,
                    "text": "pick object",
                    "source": "dtw_propagated",
                    "propagated": True,
                    "prototype_score": 0.5,
                }
            ],
        },
    )
    curation_service.save_propagation_results(
        dataset_path,
        {
            "source_episode_index": 0,
            "source_episode_indices": [0],
            "target_count": 0,
            "propagated": [],
        },
    )

    response = client.get(
        "/api/curation/alignment-overview",
        params={"dataset": "demo"},
    )

    assert response.status_code == 200
    rows = {row["episode_index"]: row for row in response.json()["rows"]}
    assert rows[1]["alignment_status"] == "propagated"
    assert rows[1]["propagated_count"] == 1
    assert rows[1]["propagation_source_episode_index"] == 0
    assert rows[1]["propagation_alignment_method"] == "dtw"
    assert rows[1]["propagation_spans"][0]["dtw_start_delay_s"] == 0.25
    assert rows[1]["propagation_spans"][0]["dtw_end_delay_s"] == 0.5


def test_alignment_overview_raw_mode_uses_dataset_episodes_without_quality_results(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, dataset_path = _build_client(tmp_path, monkeypatch)
    info = json.loads((dataset_path / "meta" / "info.json").read_text(encoding="utf-8"))
    info["total_episodes"] = 2
    (dataset_path / "meta" / "info.json").write_text(json.dumps(info), encoding="utf-8")
    save_prototype_results(
        dataset_path,
        {
            "candidate_count": 2,
            "entry_count": 2,
            "cluster_count": 1,
            "quality_filter_mode": "raw",
            "selected_episode_indices": [0, 1],
            "refinement": {
                "anchor_record_keys": ["0"],
                "clusters": [],
            },
        },
    )

    response = client.get(
        "/api/curation/alignment-overview",
        params={"dataset": "demo"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["total_checked"] == 2
    assert payload["summary"]["quality_filter_mode"] == "raw"
    assert [row["episode_index"] for row in payload["rows"]] == [0, 1]
    assert all(row["quality_status"] == "passed" for row in payload["rows"])
