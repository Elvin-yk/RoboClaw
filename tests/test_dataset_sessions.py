from __future__ import annotations

import json
from pathlib import Path

import pytest

from roboclaw.data import dataset_sessions


def test_session_handle_rejects_path_segments() -> None:
    handle = "session:remote:../../outside"

    assert dataset_sessions.parse_session_handle(handle) is None
    with pytest.raises(ValueError, match="Invalid dataset session handle"):
        dataset_sessions.resolve_session_dataset_path(handle)


def test_uploaded_directory_session_rejects_path_escape(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dataset_sessions, "get_roboclaw_home", lambda: tmp_path)

    with pytest.raises(ValueError, match="Invalid uploaded file path"):
        dataset_sessions.create_uploaded_directory_session(files=[("../escape.txt", b"x")])
    with pytest.raises(ValueError, match="Invalid uploaded file path"):
        dataset_sessions.create_uploaded_directory_session(files=[("../dataset2/escape.txt", b"x")])

    assert not (tmp_path / "cache" / "escape.txt").exists()
    local_sessions = tmp_path / "cache" / "dataset-sessions" / "local_directory"
    assert not list(local_sessions.glob("*/dataset2/escape.txt"))


def test_remote_session_rolls_back_partial_download(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dataset_sessions, "get_roboclaw_home", lambda: tmp_path)

    def fail_snapshot_download(
        *,
        repo_id: str,
        repo_type: str,
        local_dir: str,
        allow_patterns: list[str],
    ) -> None:
        dataset_dir = Path(local_dir)
        (dataset_dir / "meta").mkdir(parents=True)
        (dataset_dir / "meta" / "partial.json").write_text("{}", encoding="utf-8")
        raise RuntimeError("download failed")

    monkeypatch.setattr(dataset_sessions, "snapshot_download", fail_snapshot_download)

    with pytest.raises(RuntimeError, match="download failed"):
        dataset_sessions.register_remote_dataset_session("owner/dataset")

    remote_sessions = tmp_path / "cache" / "dataset-sessions" / "remote"
    assert not remote_sessions.exists() or not list(remote_sessions.iterdir())
    assert dataset_sessions.list_session_dataset_summaries() == []


def test_local_dataset_options_include_deep_container_layout(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset_root = tmp_path / "datasets"
    dataset_dir = dataset_root / "4090-a" / "local" / "rec_20260501_102204"
    (dataset_dir / "meta").mkdir(parents=True)
    (dataset_dir / "meta" / "info.json").write_text(
        json.dumps({"total_episodes": 4, "total_frames": 30151, "fps": 30, "features": {}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(dataset_sessions, "_datasets_root", lambda: dataset_root)
    monkeypatch.setattr(dataset_sessions, "_session_root", lambda: tmp_path / "sessions")

    options = dataset_sessions.list_local_dataset_options()

    assert options == [
        {
            "id": "4090-a/local/rec_20260501_102204",
            "label": "4090-a/local/rec_20260501_102204",
            "path": str(dataset_dir.resolve()),
            "source": "local",
            "source_kind": "workspace",
        }
    ]
    assert dataset_sessions.resolve_dataset_handle_or_workspace(
        "4090-a/local/rec_20260501_102204"
    ) == dataset_dir.resolve()


def test_local_path_session_references_existing_dataset_without_copy(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dataset_sessions, "get_roboclaw_home", lambda: tmp_path / "home")
    source_dir = tmp_path / "source" / "rec_20260501_102204"
    (source_dir / "meta").mkdir(parents=True)
    (source_dir / "meta" / "info.json").write_text(
        json.dumps({"total_episodes": 4, "total_frames": 30151, "fps": 30, "features": {}}),
        encoding="utf-8",
    )

    payload = dataset_sessions.create_local_path_session(path=source_dir, display_name="demo")

    assert payload["dataset_name"].startswith("session:local_path:")
    assert payload["display_name"] == "demo"
    assert payload["local_path"] == str(source_dir.resolve())
    assert dataset_sessions.resolve_session_dataset_path(payload["dataset_name"]) == source_dir.resolve()
    assert not (tmp_path / "home" / "cache" / "dataset-sessions" / "local_path" / "dataset").exists()


def test_local_path_session_discovers_container_datasets_without_copy(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dataset_sessions, "get_roboclaw_home", lambda: tmp_path / "home")
    container = tmp_path / "roboclaw_0501_datasets_20260502"
    dataset_a = container / "4090-a" / "local" / "rec_20260501_102204"
    dataset_b = container / "4090-b" / "local" / "rec_20260501_102512"
    for dataset_dir, total_frames in ((dataset_a, 30151), (dataset_b, 24000)):
        (dataset_dir / "meta").mkdir(parents=True)
        (dataset_dir / "meta" / "info.json").write_text(
            json.dumps({"total_episodes": 4, "total_frames": total_frames, "fps": 30, "features": {}}),
            encoding="utf-8",
        )

    payload = dataset_sessions.create_local_path_session(path=container)

    assert payload["dataset_name"].startswith("session:local_collection:")
    assert payload["local_path"] == str(container.resolve())
    assert payload["dataset_count"] == 2
    assert [item["label"] for item in payload["datasets"]] == [
        "roboclaw_0501_datasets_20260502 (all datasets)",
        "4090-a/local/rec_20260501_102204",
        "4090-b/local/rec_20260501_102512",
    ]
    assert [item["path"] for item in payload["datasets"]] == [
        str(container.resolve()),
        str(dataset_a.resolve()),
        str(dataset_b.resolve()),
    ]
    assert payload["datasets"][0]["is_collection"] is True
    assert payload["datasets"][0]["source_kind"] == "local_path_collection"
    assert payload["datasets"][1]["id"].startswith("session:local_path:")
    assert dataset_sessions.resolve_session_dataset_path(payload["datasets"][2]["id"]) == dataset_b.resolve()
    collection_summary = dataset_sessions.get_dataset_summary(payload["dataset_name"])
    assert collection_summary["dataset_count"] == 2
    assert collection_summary["total_episodes"] == 8
    assert collection_summary["total_frames"] == 54151
    assert dataset_sessions.resolve_session_dataset_path(payload["dataset_name"]) == container.resolve()
    assert not (tmp_path / "home" / "cache" / "dataset-sessions" / "local_path" / "dataset").exists()
