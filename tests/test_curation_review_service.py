from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from roboclaw.data.curation.review import service as review_service_module
from roboclaw.data.curation.review.models import (
    CommitDeletionRequest,
    ReviewMark,
    ReviewState,
)
from roboclaw.data.curation.review.service import OutputDatasetExistsError, ReviewService


def _write_dataset(
    root: Path,
    dataset_id: str,
    *,
    total_episodes: int = 3,
    fps: int = 30,
    extra_info: dict[str, Any] | None = None,
) -> Path:
    dataset_path = root / dataset_id
    (dataset_path / "meta").mkdir(parents=True)
    info: dict[str, Any] = {
        "total_episodes": total_episodes,
        "total_frames": total_episodes * 4,
        "fps": fps,
        "robot_type": "so101",
        "features": {"action": {"names": ["g"]}},
    }
    if extra_info:
        info.update(extra_info)
    (dataset_path / "meta" / "info.json").write_text(
        json.dumps(info), encoding="utf-8"
    )
    lines = [
        json.dumps(
            {"episode_index": i, "length": 4.0, "task": "pick"}
        )
        for i in range(total_episodes)
    ]
    (dataset_path / "meta" / "episodes.jsonl").write_text(
        "\n".join(lines) + "\n", encoding="utf-8"
    )
    return dataset_path


def _make_service(
    root: Path,
    summaries: list[dict[str, Any]],
) -> ReviewService:
    def _resolver(dataset_id: str) -> Path:
        return root / dataset_id

    return ReviewService(
        dataset_path_resolver=_resolver,
        list_summaries=lambda: summaries,
        datasets_root_provider=lambda: root,
    )


def test_list_candidate_datasets_filters_by_critical_only(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "regular_dataset")
    _write_dataset(tmp_path, "foo_critical_phase")
    _write_dataset(
        tmp_path,
        "stage_marker_dataset",
        extra_info={"stage": "critical_phase"},
    )
    summaries = [
        {"id": "regular_dataset", "label": "Regular"},
        {"id": "foo_critical_phase", "label": "Foo CP"},
        {"id": "stage_marker_dataset", "label": "Stage CP"},
    ]
    service = _make_service(tmp_path, summaries)

    only_critical = service.list_candidate_datasets(critical_only=True)
    assert {item.id for item in only_critical} == {
        "foo_critical_phase",
        "stage_marker_dataset",
    }

    everything = service.list_candidate_datasets(critical_only=False)
    assert {item.id for item in everything} == {
        "regular_dataset",
        "foo_critical_phase",
        "stage_marker_dataset",
    }


def test_list_candidate_datasets_skips_broken_silently(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "good_critical_phase")
    summaries = [
        {"id": "good_critical_phase"},
        {"id": "missing_dataset"},
    ]
    service = _make_service(tmp_path, summaries)
    result = service.list_candidate_datasets(critical_only=True)
    assert [item.id for item in result] == ["good_critical_phase"]


def test_load_state_for_unmarked_dataset(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase")
    service = _make_service(tmp_path, [])
    state = service.load_state("local/foo_critical_phase")
    assert state.dataset_id == "local/foo_critical_phase"
    assert state.marks == {}


def test_summarize_counts_reviewed_and_abnormal(tmp_path: Path) -> None:
    service = _make_service(tmp_path, [])
    state = ReviewState(
        dataset_id="x",
        version=1,
        updated_at="now",
        marks={
            0: ReviewMark(0, abnormal=True, updated_at="now"),
            2: ReviewMark(2, abnormal=False, updated_at="now"),
            5: ReviewMark(5, abnormal=True, updated_at="now"),
        },
        commits=[],
    )
    summary = service.summarize(state, total_episodes=10)
    assert summary.total_episodes == 10
    assert summary.reviewed == 3
    assert summary.abnormal == 2


def test_list_episodes_pagination(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=5)
    service = _make_service(tmp_path, [])
    page1 = service.list_episodes("local/foo_critical_phase", page=1, page_size=2)
    assert page1["page"] == 1
    assert page1["page_size"] == 2
    assert page1["total_episodes"] == 5
    assert [e["episode_index"] for e in page1["episodes"]] == [0, 1]
    assert all(e["mark"] is None for e in page1["episodes"])

    service.set_mark("local/foo_critical_phase", 0, abnormal=True)
    page1_with_mark = service.list_episodes(
        "local/foo_critical_phase", page=1, page_size=2
    )
    assert page1_with_mark["episodes"][0]["mark"]["abnormal"] is True
    assert page1_with_mark["summary"]["abnormal"] == 1


def test_get_episode_detail_uses_load_episode_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset_path = _write_dataset(tmp_path, "local/foo_critical_phase")
    video_path = dataset_path / "videos" / "chunk-000" / "ep_000000" / "front.mp4"
    video_path.parent.mkdir(parents=True)
    video_path.write_bytes(b"")

    captured: dict[str, Any] = {}

    def _fake_load_episode_data(
        target_dataset_path: Path,
        episode_index: int,
        *,
        include_videos: bool = True,
    ) -> dict[str, Any]:
        captured["dataset_path"] = target_dataset_path
        captured["episode_index"] = episode_index
        captured["include_videos"] = include_videos
        return {
            "episode_meta": {"episode_index": episode_index, "length": 4.0},
            "video_files": [video_path],
        }

    monkeypatch.setattr(
        review_service_module, "load_episode_data", _fake_load_episode_data
    )
    service = _make_service(tmp_path, [])
    detail = service.get_episode_detail("local/foo_critical_phase", 1)

    assert captured["dataset_path"].resolve() == dataset_path.resolve()
    assert captured["episode_index"] == 1
    assert captured["include_videos"] is True
    assert detail["episode_index"] == 1
    assert detail["videos"][0]["url"].startswith(
        "/api/curation/video/videos/chunk-000/ep_000000/front.mp4"
    )
    assert "dataset=local%2Ffoo_critical_phase" in detail["videos"][0]["url"]


def test_set_mark_persists_to_sidecar(tmp_path: Path) -> None:
    dataset_path = _write_dataset(tmp_path, "local/foo_critical_phase")
    service = _make_service(tmp_path, [])
    service.set_mark("local/foo_critical_phase", 1, abnormal=True)
    sidecar = dataset_path / ".workflow" / "review_marks.json"
    assert sidecar.exists()
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    assert payload["marks"]["1"]["abnormal"] is True


def test_commit_deletion_dry_run_skips_extractor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=3)
    service = _make_service(tmp_path, [])
    service.set_mark("local/foo_critical_phase", 1, abnormal=True)

    sys.modules.pop("lerobot", None)

    request = CommitDeletionRequest(
        dataset_id="local/foo_critical_phase",
        output_dataset_id="local/foo_clean",
        task="pick",
        dry_run=True,
    )
    result = service.commit_deletion(request)
    assert result.output_path is None
    assert result.kept_episode_indices == [0, 2]
    assert result.deleted_episode_indices == [1]
    assert "lerobot" not in sys.modules


def test_commit_deletion_rejects_empty_marks(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=2)
    service = _make_service(tmp_path, [])
    request = CommitDeletionRequest(
        dataset_id="local/foo_critical_phase",
        output_dataset_id="local/foo_clean",
        task="pick",
        dry_run=True,
    )
    with pytest.raises(ValueError, match="no abnormal marks"):
        service.commit_deletion(request)


def test_commit_deletion_rejects_when_all_episodes_marked(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=2)
    service = _make_service(tmp_path, [])
    service.set_marks_bulk(
        "local/foo_critical_phase", [(0, True), (1, True)]
    )
    request = CommitDeletionRequest(
        dataset_id="local/foo_critical_phase",
        output_dataset_id="local/foo_clean",
        task="pick",
        dry_run=True,
    )
    with pytest.raises(ValueError, match="empty dataset"):
        service.commit_deletion(request)


def test_commit_deletion_rejects_existing_output(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=3)
    (tmp_path / "local/foo_clean").mkdir(parents=True)
    service = _make_service(tmp_path, [])
    service.set_mark("local/foo_critical_phase", 0, abnormal=True)
    request = CommitDeletionRequest(
        dataset_id="local/foo_critical_phase",
        output_dataset_id="local/foo_clean",
        task="pick",
        dry_run=False,
    )
    with pytest.raises(OutputDatasetExistsError, match="already exists"):
        service.commit_deletion(request)


def test_commit_deletion_calls_extractor_with_kept_intervals(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=4)
    service = _make_service(tmp_path, [])
    service.set_mark("local/foo_critical_phase", 1, abnormal=True)

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
        captured["source_root"] = source_root
        captured["output_root"] = output_root
        captured["task"] = task
        captured["vcodec"] = vcodec
        captured["source_repo_id"] = source_repo_id
        captured["output_repo_id"] = output_repo_id
        return output_root

    import roboclaw.data.dataset_pipeline.critical_phase as me

    monkeypatch.setattr(me, "extract_event_windows_dataset", _fake_extract)

    request = CommitDeletionRequest(
        dataset_id="local/foo_critical_phase",
        output_dataset_id="local/foo_clean",
        task="pick",
        source_repo_id="local/src",
        output_repo_id="local/out",
        vcodec="h264",
        dry_run=False,
    )
    result = service.commit_deletion(request)

    assert captured["task"] == "pick"
    assert captured["vcodec"] == "h264"
    assert captured["source_repo_id"] == "local/src"
    assert captured["output_repo_id"] == "local/out"
    intervals_tuples = [iv.as_lerobot_tuple() for iv in captured["intervals"]]
    assert intervals_tuples == [(0, 0, 4), (2, 0, 4), (3, 0, 4)]
    assert result.output_path is not None
    sidecar = (tmp_path / "local/foo_critical_phase" / ".workflow" / "review_marks.json")
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    assert len(payload["commits"]) == 1
    assert payload["commits"][0]["deleted_episode_indices"] == [1]


def test_commit_deletion_does_not_append_commit_when_extractor_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_path = _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=2)
    service = _make_service(tmp_path, [{"id": "local/foo_critical_phase"}])
    service.set_mark("local/foo_critical_phase", 1, True)

    def _failing_extractor(**_kwargs: Any) -> Path:
        raise RuntimeError("synthetic extractor failure")

    monkeypatch.setattr(
        review_service_module, "extract_event_windows_dataset", _failing_extractor, raising=False
    )
    import roboclaw.data.dataset_pipeline.critical_phase as extractor_module
    monkeypatch.setattr(extractor_module, "extract_event_windows_dataset", _failing_extractor)

    with pytest.raises(RuntimeError, match="synthetic extractor failure"):
        service.commit_deletion(
            CommitDeletionRequest(
                dataset_id="local/foo_critical_phase",
                output_dataset_id="local/foo_clean",
                task="pick",
            )
        )

    sidecar = dataset_path / ".workflow" / "review_marks.json"
    payload = json.loads(sidecar.read_text(encoding="utf-8"))
    assert payload["commits"] == []


def test_commit_deletion_rejects_output_inside_source(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=2)
    service = _make_service(tmp_path, [{"id": "local/foo_critical_phase"}])
    service.set_mark("local/foo_critical_phase", 1, True)
    with pytest.raises(ValueError, match="inside source dataset"):
        service.commit_deletion(
            CommitDeletionRequest(
                dataset_id="local/foo_critical_phase",
                output_dataset_id="local/foo_critical_phase/sub",
                task="pick",
            )
        )


def test_commit_deletion_rejects_marks_for_unknown_episodes(tmp_path: Path) -> None:
    _write_dataset(tmp_path, "local/foo_critical_phase", total_episodes=2)
    service = _make_service(tmp_path, [{"id": "local/foo_critical_phase"}])
    service.set_mark("local/foo_critical_phase", 999, True)
    with pytest.raises(ValueError, match="not in dataset"):
        service.commit_deletion(
            CommitDeletionRequest(
                dataset_id="local/foo_critical_phase",
                output_dataset_id="local/foo_clean",
                task="pick",
            )
        )
