from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from roboclaw.data.repair.schemas import DatasetRepairFilter, DiagnoseRequest
from roboclaw.data.repair.service import DatasetRepairCoordinator, JobConflictError
from roboclaw.data.repair.types import DamageType, DiagnosisResult


def _write_info(dataset_dir: Path) -> None:
    meta = dataset_dir / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "info.json").write_text(
        json.dumps({"total_episodes": 1, "total_frames": 1, "fps": 30, "features": {}}),
        encoding="utf-8",
    )


def _make_dataset(root: Path, name: str) -> Path:
    dataset_dir = root / name
    _write_info(dataset_dir)
    return dataset_dir


def _make_diagnose(damage_by_id: dict[str, DamageType]):
    def fn(dataset_dir: Path) -> DiagnosisResult:
        return DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=damage_by_id[dataset_dir.name],
            repairable=damage_by_id[dataset_dir.name] != DamageType.HEALTHY,
            details={},
        )

    return fn


async def _wait_for_phase(
    coordinator: DatasetRepairCoordinator,
    job_id: str,
    target,
    *,
    timeout: float = 2.0,
) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        job = await coordinator.get_job(job_id)
        if job is not None and job.phase in target:
            return
        await asyncio.sleep(0.01)
    raise AssertionError(
        f"phase did not reach {target}; current={job.phase if job else None}"
    )


async def test_start_diagnosis_returns_diagnosing_phase(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.HEALTHY}),
    )

    job = await coord.start_diagnosis(DiagnoseRequest())

    assert job.phase == "diagnosing"
    assert job.processed == 0
    assert job.total == 1


async def test_diagnosis_completes_with_summary(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")
    b = _make_dataset(tmp_path, "b")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose(
            {a.name: DamageType.HEALTHY, b.name: DamageType.FRAME_MISMATCH}
        ),
    )

    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "completed"
    assert final.summary.healthy == 1
    assert final.summary.frame_mismatch == 1
    assert final.summary.unrepairable == 0
    assert all(item.status == "done" for item in final.items)


async def test_second_start_raises_job_conflict(tmp_path: Path) -> None:
    import threading

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow_diagnose(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        if not release.wait(timeout=2.0):
            raise TimeoutError("release event never set")
        return DiagnosisResult(
            dataset_dir=dataset_dir, damage_type=DamageType.HEALTHY, repairable=True, details={}
        )

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=slow_diagnose)
    job = await coord.start_diagnosis(DiagnoseRequest())
    while not started.is_set():
        await asyncio.sleep(0.01)

    with pytest.raises(JobConflictError):
        await coord.start_diagnosis(DiagnoseRequest())

    release.set()
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})


async def test_cancel_marks_remaining_items(tmp_path: Path) -> None:
    import threading

    _make_dataset(tmp_path, "a")
    _make_dataset(tmp_path, "b")
    _make_dataset(tmp_path, "c")

    started = threading.Event()
    release = threading.Event()

    def gated(dataset_dir: Path) -> DiagnosisResult:
        if dataset_dir.name == "a":
            started.set()
            release.wait(timeout=2.0)
        return DiagnosisResult(
            dataset_dir=dataset_dir, damage_type=DamageType.HEALTHY, repairable=True, details={}
        )

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=gated)
    job = await coord.start_diagnosis(DiagnoseRequest())
    while not started.is_set():
        await asyncio.sleep(0.01)

    cancelling = await coord.cancel(job.job_id)
    assert cancelling.phase == "cancelling"

    release.set()
    await _wait_for_phase(coord, job.job_id, {"cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "cancelled"
    cancelled_items = [item for item in final.items if item.status == "cancelled"]
    assert len(cancelled_items) >= 1


async def test_stream_events_emits_snapshot_then_items_then_complete(
    tmp_path: Path,
) -> None:
    a = _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.HEALTHY}),
    )
    job = await coord.start_diagnosis(DiagnoseRequest())

    events: list[dict] = []
    async for event in coord.stream_events(job.job_id):
        events.append(event)
        if event["type"] == "complete":
            break

    types = [event["type"] for event in events]
    assert types[0] == "snapshot"
    assert "complete" == types[-1]
    assert "item" in types


async def test_diagnose_failure_marks_item_failed(tmp_path: Path) -> None:
    _make_dataset(tmp_path, "a")
    _make_dataset(tmp_path, "b")

    def diagnose(dataset_dir: Path) -> DiagnosisResult:
        if dataset_dir.name == "a":
            raise FileNotFoundError("missing meta")
        return DiagnosisResult(
            dataset_dir=dataset_dir, damage_type=DamageType.HEALTHY, repairable=True, details={}
        )

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=diagnose)
    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "completed"
    statuses = {item.dataset_id: item.status for item in final.items}
    assert statuses["a"] == "failed"
    assert statuses["b"] == "done"
    error_item = next(item for item in final.items if item.status == "failed")
    assert error_item.error and "missing meta" in error_item.error


async def test_list_datasets_uses_filters_root(tmp_path: Path) -> None:
    other_root = tmp_path / "second"
    other_root.mkdir()
    _make_dataset(other_root, "z")
    coord = DatasetRepairCoordinator(tmp_path)

    items = await coord.list_datasets(DatasetRepairFilter(root=str(other_root)))

    assert {item.id for item in items} == {"z"}


async def test_list_datasets_rejects_root_outside_scan_anchor(tmp_path: Path) -> None:
    """``filters.root`` must not be allowed to escape the configured scan area."""
    scan_root = tmp_path / "scan"
    scan_root.mkdir()
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    coord = DatasetRepairCoordinator(scan_root)

    with pytest.raises(ValueError, match="must be inside"):
        await coord.list_datasets(DatasetRepairFilter(root=str(outside)))


async def test_list_datasets_accepts_root_inside_scan_anchor(tmp_path: Path) -> None:
    scan_root = tmp_path / "scan"
    scan_root.mkdir()
    inside = scan_root / "subdir"
    inside.mkdir()
    coord = DatasetRepairCoordinator(scan_root)

    # Equal to anchor and a child both pass.
    await coord.list_datasets(DatasetRepairFilter(root=str(scan_root)))
    await coord.list_datasets(DatasetRepairFilter(root=str(inside)))


async def test_late_subscriber_to_failed_job_receives_structured_error(tmp_path: Path) -> None:
    """When a job has already failed, ``stream_events`` must emit
    ``{"job": ..., "error": ...}`` for the terminal ``error`` event so late
    subscribers see the same shape as live failures.
    """
    _make_dataset(tmp_path, "a")

    def _diagnose(_path: Path) -> DiagnosisResult:
        # RuntimeError bypasses ``ITEM_BOUNDARY_EXCEPTIONS`` and bubbles into
        # the worker's except clause — the path that flips the job to ``failed``.
        raise RuntimeError("boom from diagnose")

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_diagnose)
    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "failed"
    assert final.error == "boom from diagnose"

    events: list[dict] = []
    async for event in coord.stream_events(job.job_id):
        events.append(event)

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    payload = error_events[0]["data"]
    assert isinstance(payload, dict)
    assert "job" in payload and "error" in payload
    assert payload["error"] == "boom from diagnose"
