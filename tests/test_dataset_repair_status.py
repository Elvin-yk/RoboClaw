from __future__ import annotations

import json
from pathlib import Path

import pytest

from roboclaw.data.repair.status import (
    DatasetRepairStatus,
    ensure_status,
    load_status,
    mark_checked,
    mark_dirty,
    record_diagnosis,
    status_path,
    write_status,
)


def _dataset(tmp_path: Path) -> Path:
    dataset_dir = tmp_path / "ds"
    dataset_dir.mkdir(parents=True, exist_ok=True)
    return dataset_dir


def test_ensure_status_writes_default_when_missing(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)

    status = ensure_status(dataset_dir)

    assert status.tag == "dirty"
    assert status_path(dataset_dir).exists()
    payload = json.loads(status_path(dataset_dir).read_text(encoding="utf-8"))
    assert payload["tag"] == "dirty"
    assert payload["schema_version"] == 1


def test_ensure_status_returns_existing(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)
    initial = DatasetRepairStatus(tag="checked", last_damage_type="healthy")
    write_status(dataset_dir, initial)

    loaded = ensure_status(dataset_dir)

    assert loaded.tag == "checked"
    assert loaded.last_damage_type == "healthy"


def test_write_status_is_atomic_under_replace_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dataset_dir = _dataset(tmp_path)
    existing = DatasetRepairStatus(tag="checked")
    write_status(dataset_dir, existing)
    original = json.loads(status_path(dataset_dir).read_text(encoding="utf-8"))

    real_replace = Path.replace

    def boom(self: Path, target):
        if self.suffix == ".tmp":
            raise OSError("simulated replace failure")
        return real_replace(self, target)

    monkeypatch.setattr(Path, "replace", boom)

    with pytest.raises(OSError):
        write_status(dataset_dir, DatasetRepairStatus(tag="dirty", last_damage_type="boom"))

    after = json.loads(status_path(dataset_dir).read_text(encoding="utf-8"))
    assert after == original


def test_mark_checked_writes_timestamp(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)

    status = mark_checked(dataset_dir, damage_type="healthy")

    assert status.tag == "checked"
    assert status.last_checked_at is not None
    assert status.last_damage_type == "healthy"


def test_mark_dirty_persists(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)
    mark_checked(dataset_dir, damage_type="healthy", repairable=False)

    status = mark_dirty(dataset_dir, source="local/rec_x")

    assert status.tag == "dirty"
    assert status.repairable is None
    assert status.source_dataset_id == "local/rec_x"


def test_record_diagnosis_healthy_marks_checked(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)

    status = record_diagnosis(
        dataset_dir,
        damage_type="healthy",
        repairable=False,
        job_id="job-1",
    )

    assert status.tag == "checked"
    assert status.last_damage_type == "healthy"
    assert status.repairable is False
    assert status.last_diagnosed_at is not None
    assert status.last_repair_job_id == "job-1"


def test_record_diagnosis_non_healthy_stays_dirty(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)

    status = record_diagnosis(
        dataset_dir,
        damage_type="frame_mismatch",
        repairable=True,
        job_id="job-2",
    )

    assert status.tag == "dirty"
    assert status.last_damage_type == "frame_mismatch"
    assert status.repairable is True
    assert status.last_diagnosed_at is not None
    assert status.last_checked_at is None


def test_load_status_propagates_json_decode_error(tmp_path: Path) -> None:
    dataset_dir = _dataset(tmp_path)
    path = status_path(dataset_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json", encoding="utf-8")

    with pytest.raises(json.JSONDecodeError):
        load_status(dataset_dir)
