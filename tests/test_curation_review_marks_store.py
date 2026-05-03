from __future__ import annotations

import json
from pathlib import Path

import pytest

from roboclaw.data.curation.review.marks_store import ReviewMarksStore
from roboclaw.data.curation.review.models import ReviewMark, ReviewState


def _make_store(tmp_path: Path, dataset_id: str = "local/demo") -> ReviewMarksStore:
    dataset_path = tmp_path / "dataset"
    dataset_path.mkdir()
    return ReviewMarksStore(dataset_path, dataset_id)


def test_load_returns_empty_when_sidecar_missing(tmp_path: Path) -> None:
    store = _make_store(tmp_path)
    state = store.load()
    assert state.dataset_id == "local/demo"
    assert state.version == 1
    assert state.marks == {}
    assert state.commits == []
    assert isinstance(state.updated_at, str) and state.updated_at


def test_save_and_load_roundtrip(tmp_path: Path) -> None:
    store = _make_store(tmp_path, "local/foo")
    initial = ReviewState(
        dataset_id="local/foo",
        version=1,
        updated_at="will-be-overwritten",
        marks={3: ReviewMark(episode_index=3, abnormal=True, updated_at="x")},
        commits=[{"output_dataset_id": "local/foo_clean", "deleted_episode_indices": [3]}],
    )
    saved = store.save(initial)
    assert saved.updated_at != "will-be-overwritten"
    assert saved.marks[3].abnormal is True
    raw = json.loads(store.sidecar_path.read_text(encoding="utf-8"))
    assert raw["dataset_id"] == "local/foo"
    assert raw["marks"]["3"]["abnormal"] is True
    assert raw["commits"][0]["output_dataset_id"] == "local/foo_clean"

    reloaded = store.load()
    assert reloaded.dataset_id == "local/foo"
    assert reloaded.marks[3].abnormal is True
    assert reloaded.commits == [
        {"output_dataset_id": "local/foo_clean", "deleted_episode_indices": [3]}
    ]


def test_set_mark_creates_then_updates(tmp_path: Path) -> None:
    store = _make_store(tmp_path)
    after_first = store.set_mark(0, abnormal=True)
    assert after_first.marks[0].abnormal is True
    assert len(after_first.marks) == 1

    after_second = store.set_mark(0, abnormal=False)
    assert after_second.marks[0].abnormal is False
    assert len(after_second.marks) == 1
    assert after_second.marks[0].updated_at >= after_first.marks[0].updated_at


def test_set_marks_bulk_overwrites_existing(tmp_path: Path) -> None:
    store = _make_store(tmp_path)
    store.set_mark(1, abnormal=True)
    state = store.set_marks([(1, False), (2, True), (5, False)])
    assert state.marks[1].abnormal is False
    assert state.marks[2].abnormal is True
    assert state.marks[5].abnormal is False
    assert sorted(state.marks.keys()) == [1, 2, 5]


def test_append_commit_records_history(tmp_path: Path) -> None:
    store = _make_store(tmp_path)
    store.set_mark(0, abnormal=True)
    state = store.append_commit(
        {
            "output_dataset_id": "local/x_clean",
            "created_at": "2026-05-04T12:00:00Z",
            "deleted_episode_indices": [0],
        }
    )
    assert len(state.commits) == 1
    assert state.commits[0]["output_dataset_id"] == "local/x_clean"
    state2 = store.append_commit(
        {
            "output_dataset_id": "local/x_clean_v2",
            "deleted_episode_indices": [0, 1],
        }
    )
    assert len(state2.commits) == 2
    assert state2.commits[1]["output_dataset_id"] == "local/x_clean_v2"
