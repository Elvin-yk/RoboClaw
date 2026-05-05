from __future__ import annotations

import json
import os
from pathlib import Path

from roboclaw.data.repair.schemas import DatasetRepairFilter
from roboclaw.data.repair.selection import list_datasets


def _write_info(dataset_dir: Path, **overrides: object) -> None:
    meta_dir = dataset_dir / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    info = {
        "total_episodes": 1,
        "total_frames": 1,
        "fps": 30,
        "features": {
            "observation.state": {"dtype": "float32", "shape": [2], "names": None},
        },
    }
    info.update(overrides)
    (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")


def _set_mtime(path: Path, when: str) -> None:
    import datetime as dt

    timestamp = dt.datetime.strptime(when, "%Y-%m-%d").replace(
        tzinfo=dt.timezone.utc
    ).timestamp()
    os.utime(path, (timestamp, timestamp))


def _make_clean_table(tmp_path: Path) -> Path:
    dataset_dir = tmp_path / "clean_table_20260101_120000"
    _write_info(dataset_dir, created_at="2026-01-01T12:00:00Z")
    (dataset_dir / "meta" / "tasks.jsonl").write_text(
        json.dumps({"task": "clean_table"}) + "\n",
        encoding="utf-8",
    )
    return dataset_dir


def _make_pickup_only_dirname(tmp_path: Path) -> Path:
    dataset_dir = tmp_path / "pickup_red_block_20260201_103000"
    _write_info(dataset_dir)
    _set_mtime(dataset_dir, "2026-02-01")
    return dataset_dir


def _make_non_dataset(tmp_path: Path) -> Path:
    other = tmp_path / "not_a_dataset"
    other.mkdir()
    return other


def test_list_datasets_skips_non_dataset_dirs(tmp_path: Path) -> None:
    _make_clean_table(tmp_path)
    _make_non_dataset(tmp_path)

    items = list_datasets(tmp_path, DatasetRepairFilter())

    assert {item.name for item in items} == {"clean_table_20260101_120000"}


def test_task_filter_substring_match(tmp_path: Path) -> None:
    _make_clean_table(tmp_path)
    _make_pickup_only_dirname(tmp_path)

    items = list_datasets(tmp_path, DatasetRepairFilter(task="clean"))

    assert [item.task for item in items] == ["clean_table"]


def test_task_filter_excludes_pickup(tmp_path: Path) -> None:
    _make_clean_table(tmp_path)
    pickup = _make_pickup_only_dirname(tmp_path)

    items = list_datasets(tmp_path, DatasetRepairFilter(task="pickup"))

    assert {item.name for item in items} == {pickup.name}


def test_date_filter(tmp_path: Path) -> None:
    _make_clean_table(tmp_path)
    _make_pickup_only_dirname(tmp_path)

    early = list_datasets(
        tmp_path,
        DatasetRepairFilter(date_from="2026-01-15"),
    )
    assert {item.name for item in early} == {"pickup_red_block_20260201_103000"}

    late = list_datasets(
        tmp_path,
        DatasetRepairFilter(date_to="2026-01-15"),
    )
    assert {item.name for item in late} == {"clean_table_20260101_120000"}


def test_tag_filter(tmp_path: Path) -> None:
    clean = _make_clean_table(tmp_path)
    _make_pickup_only_dirname(tmp_path)

    list_datasets(tmp_path, DatasetRepairFilter())

    from roboclaw.data.repair.status import mark_checked

    mark_checked(clean, damage_type="healthy")

    dirty_only = list_datasets(tmp_path, DatasetRepairFilter(tag="dirty"))
    assert {item.name for item in dirty_only} == {"pickup_red_block_20260201_103000"}

    checked_only = list_datasets(tmp_path, DatasetRepairFilter(tag="checked"))
    assert {item.name for item in checked_only} == {"clean_table_20260101_120000"}

    every = list_datasets(tmp_path, DatasetRepairFilter(tag="all"))
    assert {item.name for item in every} == {
        "clean_table_20260101_120000",
        "pickup_red_block_20260201_103000",
    }


def test_list_datasets_returns_persisted_repairability(tmp_path: Path) -> None:
    clean = _make_clean_table(tmp_path)

    from roboclaw.data.repair.status import record_diagnosis

    record_diagnosis(clean, damage_type="frame_mismatch", repairable=True)

    items = list_datasets(tmp_path, DatasetRepairFilter())

    assert len(items) == 1
    assert items[0].last_damage_type == "frame_mismatch"
    assert items[0].repairable is True


def test_sort_by_created_date_desc(tmp_path: Path) -> None:
    _make_clean_table(tmp_path)
    _make_pickup_only_dirname(tmp_path)

    items = list_datasets(tmp_path, DatasetRepairFilter())

    assert [item.name for item in items] == [
        "pickup_red_block_20260201_103000",
        "clean_table_20260101_120000",
    ]


def test_nested_local_layout_is_listed(tmp_path: Path) -> None:
    parent = tmp_path / "local"
    parent.mkdir()
    nested = parent / "rec_20260301_120000"
    _write_info(nested, created_at="2026-03-01T12:00:00Z")

    items = list_datasets(tmp_path, DatasetRepairFilter())

    assert {item.id for item in items} == {"local/rec_20260301_120000"}


def test_deep_recorder_container_layout_is_listed(tmp_path: Path) -> None:
    nested = tmp_path / "4090-a" / "local" / "rec_20260501_102204"
    _write_info(nested, created_at="2026-05-01T10:22:04Z")

    items = list_datasets(tmp_path, DatasetRepairFilter())

    assert {item.id for item in items} == {"4090-a/local/rec_20260501_102204"}
