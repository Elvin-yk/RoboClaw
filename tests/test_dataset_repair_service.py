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

    listed = await coord.list_datasets(DatasetRepairFilter())
    by_id = {item.id: item for item in listed}
    assert by_id["b"].last_damage_type == "frame_mismatch"
    assert by_id["b"].repairable is True


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


async def test_stream_events_uses_job_error_for_terminal_failure(tmp_path: Path) -> None:
    _make_dataset(tmp_path, "a")

    def diagnose(dataset_dir: Path) -> DiagnosisResult:
        raise RuntimeError(f"boom: {dataset_dir.name}")

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=diagnose)
    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"failed"})

    events: list[dict] = []
    async for event in coord.stream_events(job.job_id):
        events.append(event)

    assert [event["type"] for event in events] == ["snapshot", "job-error"]
    payload = events[-1]["data"]
    assert payload["job"]["phase"] == "failed"
    assert payload["job"]["error"] == "boom: a"
    assert payload["error"] == "boom: a"


async def test_late_subscriber_to_failed_job_receives_structured_job_error(
    tmp_path: Path,
) -> None:
    _make_dataset(tmp_path, "a")

    def diagnose(_dataset_dir: Path) -> DiagnosisResult:
        raise RuntimeError("boom from diagnose")

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=diagnose)
    job = await coord.start_diagnosis(DiagnoseRequest())
    await _wait_for_phase(coord, job.job_id, {"failed"})

    final = await coord.get_job(job.job_id)
    assert final is not None
    assert final.phase == "failed"
    assert final.error == "boom from diagnose"

    events: list[dict] = []
    async for event in coord.stream_events(job.job_id):
        events.append(event)

    job_error_events = [event for event in events if event["type"] == "job-error"]
    assert len(job_error_events) == 1
    payload = job_error_events[0]["data"]
    assert payload["job"]["phase"] == "failed"
    assert payload["error"] == "boom from diagnose"


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
    local_root = tmp_path / "local"
    local_root.mkdir()
    _make_dataset(local_root, "z")
    coord = DatasetRepairCoordinator(tmp_path)

    items = await coord.list_datasets(DatasetRepairFilter(root=str(local_root)))

    assert {item.id for item in items} == {"local/z"}


async def test_list_datasets_rejects_root_outside_datasets_root(tmp_path: Path) -> None:
    outside_root = tmp_path.parent / f"{tmp_path.name}-outside"
    dataset_dir = _make_dataset(outside_root, "z")
    coord = DatasetRepairCoordinator(tmp_path)

    with pytest.raises(ValueError, match="inside"):
        await coord.list_datasets(DatasetRepairFilter(root=str(outside_root)))

    assert not (dataset_dir / "meta" / "repair_status.json").exists()


async def test_cleaned_output_path_preserves_dataset_namespace(tmp_path: Path) -> None:
    _make_dataset(tmp_path / "local", "foo")
    _make_dataset(tmp_path / "org", "foo")
    coord = DatasetRepairCoordinator(
        tmp_path,
        diagnose_fn=_make_diagnose({"foo": DamageType.HEALTHY}),
    )

    job = await coord.start_diagnosis(DiagnoseRequest())

    output_paths = {item.dataset_id: item.output_path for item in job.items}
    assert output_paths["local/foo"] == str(tmp_path / "cleaned" / "local" / "foo")
    assert output_paths["org/foo"] == str(tmp_path / "cleaned" / "org" / "foo")


async def test_list_datasets_accepts_root_inside_datasets_root(tmp_path: Path) -> None:
    inside = tmp_path / "subdir"
    inside.mkdir()
    coord = DatasetRepairCoordinator(tmp_path)

    await coord.list_datasets(DatasetRepairFilter(root=str(tmp_path)))
    await coord.list_datasets(DatasetRepairFilter(root=str(inside)))
