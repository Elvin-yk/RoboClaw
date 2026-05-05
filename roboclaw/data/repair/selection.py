"""Dataset filtering & metadata extraction for the repair UI.

The web UI lists datasets by tag/date/task before deciding what to diagnose.
This module uses the shared local discovery layer to detect dataset directories
and :func:`roboclaw.data.repair.status.ensure_status` to hydrate the persistent
tag.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from roboclaw.data.local_discovery import iter_dataset_dirs

from .io import load_info
from .schemas import DatasetRepairDataset, DatasetRepairFilter, TagFilter
from .status import RepairTag, ensure_status

_DATE_RE = re.compile(r"(20\d{6})(?:[_-]?(\d{6}))?")


def list_datasets(
    root: Path,
    filters: DatasetRepairFilter,
    *,
    id_root: Path | None = None,
) -> list[DatasetRepairDataset]:
    """Scan local dataset containers and return datasets matching *filters*.

    Discovery is metadata-only and recursively finds LeRobot roots such as
    ``4090-a/local/rec_*`` without reading parquet or video payloads.
    """
    if not root.exists():
        return []

    datasets: list[DatasetRepairDataset] = []
    record_root = id_root or root
    for dataset_dir in _iter_dataset_dirs(root):
        record = _build_record(dataset_dir, record_root)
        if _passes_filters(record, filters):
            datasets.append(record)

    datasets.sort(
        key=lambda item: item.created_date or "",
        reverse=True,
    )
    return datasets


def _iter_dataset_dirs(root: Path):
    yield from iter_dataset_dirs(root)


def _build_record(dataset_dir: Path, root: Path) -> DatasetRepairDataset:
    relative = dataset_dir.relative_to(root).as_posix()
    status = ensure_status(dataset_dir)
    info = _load_info_or_none(dataset_dir)
    return DatasetRepairDataset(
        id=relative,
        name=dataset_dir.name,
        path=str(dataset_dir),
        created_date=_extract_date(dataset_dir, info),
        task=_extract_task(dataset_dir, info),
        tag=status.tag,
        last_damage_type=status.last_damage_type,  # type: ignore[arg-type]
        repairable=status.repairable,
        cleaned_dataset_id=status.cleaned_dataset_id,
    )


def _load_info_or_none(dataset_dir: Path) -> dict | None:
    info_path = dataset_dir / "meta" / "info.json"
    if not info_path.exists():
        return None
    return load_info(dataset_dir)


def _passes_filters(
    record: DatasetRepairDataset,
    filters: DatasetRepairFilter,
) -> bool:
    if not matches_date(record.created_date, filters.date_from, filters.date_to):
        return False
    if not matches_task(record.task, filters.task):
        return False
    return matches_tag(record.tag, filters.tag)


def _extract_date(dataset_dir: Path, info: dict | None) -> str | None:
    """Priority: info.json > directory name regex > directory mtime."""
    info_date = _date_from_info(info)
    if info_date is not None:
        return info_date
    name_date = _date_from_name(dataset_dir.name)
    if name_date is not None:
        return name_date
    return _date_from_mtime(dataset_dir)


def _date_from_name(name: str) -> str | None:
    match = _DATE_RE.search(name)
    if match is None:
        return None
    raw = match.group(1)
    return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"


def _date_from_info(info: dict | None) -> str | None:
    if info is None:
        return None
    raw = info.get("created_at") or info.get("created_date")
    if not isinstance(raw, str) or not raw:
        return None
    return raw[:10]


def _date_from_mtime(dataset_dir: Path) -> str | None:
    stat = dataset_dir.stat()
    return datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).strftime("%Y-%m-%d")


def _extract_task(dataset_dir: Path, info: dict | None) -> str | None:
    """Priority: tasks.jsonl > episodes.jsonl > info.json > dataset directory name."""
    task = _task_from_tasks_jsonl(dataset_dir)
    if task is not None:
        return task
    task = _task_from_episodes_jsonl(dataset_dir)
    if task is not None:
        return task
    task = _task_from_info(info)
    if task is not None:
        return task
    return dataset_dir.name


def _task_from_tasks_jsonl(dataset_dir: Path) -> str | None:
    return _first_jsonl_field(dataset_dir / "meta" / "tasks.jsonl", ("task", "task_name"))


def _task_from_episodes_jsonl(dataset_dir: Path) -> str | None:
    payload = _first_jsonl_payload(dataset_dir / "meta" / "episodes.jsonl")
    if payload is None:
        return None
    for key in ("tasks", "task"):
        value = _coerce_task(payload.get(key))
        if value is not None:
            return value
    return None


def _task_from_info(info: dict | None) -> str | None:
    if info is None:
        return None
    for key in ("task", "task_name", "tasks"):
        value = _coerce_task(info.get(key))
        if value is not None:
            return value
    return None


def _first_jsonl_payload(path: Path) -> dict | None:
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            stripped = line.strip()
            if not stripped:
                continue
            return json.loads(stripped)
    return None


def _first_jsonl_field(path: Path, keys: tuple[str, ...]) -> str | None:
    payload = _first_jsonl_payload(path)
    if payload is None:
        return None
    for key in keys:
        value = _coerce_task(payload.get(key))
        if value is not None:
            return value
    return None


def _coerce_task(raw: object) -> str | None:
    """Accept str or list-of-str (LeRobot occasionally writes ``tasks: [...]``)."""
    if isinstance(raw, str) and raw:
        return raw
    if isinstance(raw, list) and raw:
        first = raw[0]
        if isinstance(first, str) and first:
            return first
    return None


def matches_date(
    date_str: str | None,
    date_from: str | None,
    date_to: str | None,
) -> bool:
    if date_from is None and date_to is None:
        return True
    if date_str is None:
        return False
    if date_from is not None and date_str < date_from:
        return False
    if date_to is not None and date_str > date_to:
        return False
    return True


def matches_task(task: str | None, query: str | None) -> bool:
    if not query:
        return True
    if task is None:
        return False
    return query.lower() in task.lower()


def matches_tag(tag: RepairTag, target: TagFilter) -> bool:
    if target == "all":
        return True
    return tag == target
