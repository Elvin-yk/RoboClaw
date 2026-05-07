from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from roboclaw.data.repair import status as status_module
from roboclaw.data.repair.schemas import DatasetRepairFilter, DiagnoseRequest
from roboclaw.data.repair.service import DatasetRepairCoordinator, JobConflictError
from roboclaw.data.repair.types import DamageType, DiagnosisResult, RepairResult


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

    assert {item.id for item in items} == {"second/z"}


async def test_list_datasets_accepts_relative_filters_root(tmp_path: Path) -> None:
    local_root = tmp_path / "local"
    local_root.mkdir()
    _make_dataset(local_root, "z")
    coord = DatasetRepairCoordinator(tmp_path)

    items = await coord.list_datasets(DatasetRepairFilter(root="local"))

    assert {item.id for item in items} == {"local/z"}


# ----------------------------- start_repair ----------------------------------


def _make_repair_fn(damage_by_name: dict[str, DamageType], outcome: str = "repaired"):
    """Build a stub ``repair_fn`` that records the supplied ``output_dir``.

    The stub does not touch disk — it just emulates the contract the
    coordinator depends on.  Set ``outcome`` to ``"healthy"`` or ``"skipped"``
    to exercise the corresponding branches.
    """

    received: list[dict] = []

    def fn(diagnosis: DiagnosisResult, **kwargs) -> RepairResult:
        received.append({"dataset_dir": diagnosis.dataset_dir, **kwargs})
        damage = diagnosis.damage_type
        if damage == DamageType.HEALTHY:
            return RepairResult(diagnosis.dataset_dir, damage, "healthy")
        return RepairResult(diagnosis.dataset_dir, damage, outcome)

    fn.received = received  # type: ignore[attr-defined]
    return fn


async def test_start_repair_returns_repairing_phase(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        repair_fn=_make_repair_fn({a.name: DamageType.META_STALE}),
    )

    job = await coord.start_repair(DiagnoseRequest())

    assert job.kind == "repair"
    assert job.phase == "repairing"
    assert job.total == 1


async def test_repair_completes_and_passes_output_dir(tmp_path: Path) -> None:
    scan_root = tmp_path / "local"
    scan_root.mkdir()
    cleaned_root = tmp_path / "cleaned"
    nested_root = scan_root / "team"
    nested_root.mkdir()
    a = _make_dataset(nested_root, "a")
    repair_fn = _make_repair_fn({a.name: DamageType.META_STALE})
    coord = DatasetRepairCoordinator(
        scan_root,
        cleaned_root=cleaned_root,
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        repair_fn=repair_fn,
    )

    job = await coord.start_repair(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "completed"
    assert all(item.status == "done" for item in final.items)
    # Repair function must receive the cleaned-output path.
    assert len(repair_fn.received) == 1  # type: ignore[attr-defined]
    call = repair_fn.received[0]  # type: ignore[attr-defined]
    expected = cleaned_root / "team" / "a"
    assert call["output_dir"] == expected
    assert call["dry_run"] is False
    assert final.items[0].output_path == str(expected)


async def test_repair_writes_repair_status_with_cleaned_id(tmp_path: Path) -> None:
    scan_root = tmp_path / "local"
    scan_root.mkdir()
    a = _make_dataset(scan_root, "a")
    coord = DatasetRepairCoordinator(
        scan_root,
        cleaned_root=tmp_path / "cleaned",
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        repair_fn=_make_repair_fn({a.name: DamageType.META_STALE}, outcome="repaired"),
    )

    job = await coord.start_repair(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    status = status_module.load_status(a)
    assert status is not None
    assert status.tag == "checked"
    assert status.cleaned_dataset_id == "cleaned/a"
    assert status.last_damage_type == "meta_stale"
    assert status.repairable is True
    assert status.last_repair_job_id == job.job_id


async def test_repair_skipped_marks_item_done_with_error(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        repair_fn=_make_repair_fn({a.name: DamageType.META_STALE}, outcome="skipped"),
    )

    job = await coord.start_repair(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.items[0].status == "done"


async def test_repair_failure_marks_item_failed(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")

    def repair_fn(diagnosis, **_kwargs):
        return RepairResult(diagnosis.dataset_dir, diagnosis.damage_type, "failed", error="boom")

    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        repair_fn=repair_fn,
    )

    job = await coord.start_repair(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "completed"
    item = final.items[0]
    assert item.status == "failed"
    assert item.error == "boom"


async def test_repair_diagnose_failure_uses_item_boundary(tmp_path: Path) -> None:
    _make_dataset(tmp_path, "a")
    _make_dataset(tmp_path, "b")

    def diagnose(dataset_dir: Path) -> DiagnosisResult:
        if dataset_dir.name == "a":
            raise FileNotFoundError("missing meta")
        return DiagnosisResult(
            dataset_dir=dataset_dir, damage_type=DamageType.HEALTHY, repairable=True, details={}
        )

    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=diagnose,
        repair_fn=_make_repair_fn({"a": DamageType.HEALTHY, "b": DamageType.HEALTHY}),
    )
    job = await coord.start_repair(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    statuses = {item.dataset_id: item.status for item in final.items}
    assert statuses["a"] == "failed"
    assert statuses["b"] == "done"


async def test_repair_blocks_concurrent_start(tmp_path: Path) -> None:
    import threading

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow_diagnose(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        release.wait(timeout=2.0)
        return DiagnosisResult(
            dataset_dir=dataset_dir, damage_type=DamageType.META_STALE, repairable=True, details={}
        )

    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=slow_diagnose,
        repair_fn=_make_repair_fn({"a": DamageType.META_STALE}),
    )
    job = await coord.start_repair(DiagnoseRequest())
    while not started.is_set():
        await asyncio.sleep(0.01)

    with pytest.raises(JobConflictError):
        await coord.start_repair(DiagnoseRequest())

    release.set()
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})


async def test_log_sink_receives_job_lifecycle_events(tmp_path: Path) -> None:
    a = _make_dataset(tmp_path, "a")
    sink_lines: list[str] = []
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({a.name: DamageType.META_STALE}),
        log_sink=sink_lines.append,
    )

    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"completed", "failed", "cancelled"})

    joined = "\n".join(sink_lines)
    assert "[dataset-repair]" in joined
    assert f"job {job.job_id} starting" in joined
    assert "diagnosed damage=meta_stale" in joined
    assert f"job {job.job_id} completed" in joined


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
    ``{"job": ..., "error": ...}`` for the terminal ``job-error`` event so late
    subscribers see the same shape as live failures.
    """
    _make_dataset(tmp_path, "a")

    def _diagnose(_path: Path) -> DiagnosisResult:
        # RuntimeError is *not* in ``ITEM_BOUNDARY_EXCEPTIONS``, so it bubbles
        # out of ``_diagnose_one`` and into ``_run_worker``'s except clause —
        # the path that flips the job to ``failed``.
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

    error_events = [e for e in events if e["type"] == "job-error"]
    assert len(error_events) == 1
    payload = error_events[0]["data"]
    assert isinstance(payload, dict)
    assert "job" in payload and "error" in payload
    assert payload["error"] == "boom from diagnose"
