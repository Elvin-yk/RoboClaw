"""Repair tag status file (``meta/repair_status.json``) read/write.

Atomic writes (``.tmp`` + ``Path.replace()``) are mandatory — recording and
diagnosis can race with reads.  Read failures (missing dir, corrupt JSON) are
**not** swallowed; callers see them.
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

RepairTag = Literal["dirty", "checked"]
HEALTHY_DAMAGE = "healthy"


@dataclass
class DatasetRepairStatus:
    schema_version: int = 1
    tag: RepairTag = "dirty"
    last_diagnosed_at: str | None = None
    last_checked_at: str | None = None
    last_repaired_at: str | None = None
    last_damage_type: str | None = None
    repairable: bool | None = None
    last_repair_job_id: str | None = None
    source_dataset_id: str | None = None
    cleaned_dataset_id: str | None = None
    diagnosis_hash: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def utc_now_iso() -> str:
    """ISO-8601 UTC timestamp with ``Z`` suffix, second precision."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def status_path(dataset_dir: Path) -> Path:
    return dataset_dir / "meta" / "repair_status.json"


def load_status(dataset_dir: Path) -> DatasetRepairStatus | None:
    """Read ``meta/repair_status.json``.

    Returns ``None`` if the file does not exist.  Lets ``json.JSONDecodeError``
    and ``OSError`` bubble up — broken status files are a hard failure, not a
    silent fallback.
    """
    path = status_path(dataset_dir)
    if not path.exists():
        return None
    payload = json.loads(path.read_text(encoding="utf-8"))
    return DatasetRepairStatus(**payload)


def write_status(dataset_dir: Path, status: DatasetRepairStatus) -> None:
    """Atomic write with a unique tmp name so concurrent writers don't clash."""
    path = status_path(dataset_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp_path.write_text(
        json.dumps(status.to_dict(), indent=2) + "\n",
        encoding="utf-8",
    )
    tmp_path.replace(path)


def ensure_status(
    dataset_dir: Path,
    default_tag: RepairTag = "dirty",
) -> DatasetRepairStatus:
    """Load or create a status file with ``default_tag``.

    If created, the file is written to disk before returning.
    """
    existing = load_status(dataset_dir)
    if existing is not None:
        return existing
    fresh = DatasetRepairStatus(tag=default_tag)
    write_status(dataset_dir, fresh)
    return fresh


def mark_dirty(
    dataset_dir: Path,
    source: str | None = None,
) -> DatasetRepairStatus:
    """Set ``tag=dirty`` and persist.  Stale diagnosis fields are cleared so the
    UI never shows ``tag=dirty`` next to ``last_damage_type=healthy``.
    """
    status = load_status(dataset_dir) or DatasetRepairStatus()
    status.tag = "dirty"
    status.last_damage_type = None
    status.repairable = None
    status.diagnosis_hash = None
    if source is not None:
        status.source_dataset_id = source
    write_status(dataset_dir, status)
    return status


def mark_checked(
    dataset_dir: Path,
    *,
    damage_type: str = HEALTHY_DAMAGE,
    repairable: bool | None = None,
    job_id: str | None = None,
    cleaned_dataset_id: str | None = None,
) -> DatasetRepairStatus:
    """Set ``tag=checked`` plus ``last_checked_at``.

    When the source dataset was cleaned into a sibling repaired copy, pass
    ``cleaned_dataset_id`` so downstream views can hop from the dirty record to
    its repaired output.
    """
    status = load_status(dataset_dir) or DatasetRepairStatus()
    status.tag = "checked"
    status.last_checked_at = utc_now_iso()
    status.last_damage_type = damage_type
    if repairable is not None:
        status.repairable = repairable
    if job_id is not None:
        status.last_repair_job_id = job_id
    if cleaned_dataset_id is not None:
        status.cleaned_dataset_id = cleaned_dataset_id
    write_status(dataset_dir, status)
    return status


def record_diagnosis(
    dataset_dir: Path,
    *,
    damage_type: str,
    repairable: bool | None = None,
    job_id: str | None = None,
    diagnosis_hash: str | None = None,
) -> DatasetRepairStatus:
    """Persist diagnosis outcome — single write whether healthy or not."""
    status = load_status(dataset_dir) or DatasetRepairStatus()
    now = utc_now_iso()
    status.last_diagnosed_at = now
    status.last_damage_type = damage_type
    status.repairable = repairable
    if damage_type == HEALTHY_DAMAGE:
        status.tag = "checked"
        status.last_checked_at = now
    else:
        status.tag = "dirty"
    if job_id is not None:
        status.last_repair_job_id = job_id
    if diagnosis_hash is not None:
        status.diagnosis_hash = diagnosis_hash
    write_status(dataset_dir, status)
    return status
