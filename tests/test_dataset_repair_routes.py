from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.repair.service import DatasetRepairCoordinator
from roboclaw.data.repair.types import DamageType, DiagnosisResult, RepairResult
from roboclaw.http.routes.dataset_repair import register_dataset_repair_routes


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


def _build_app(coord: DatasetRepairCoordinator) -> FastAPI:
    app = FastAPI()
    register_dataset_repair_routes(app, coord)
    return app


def _healthy(dataset_dir: Path) -> DiagnosisResult:
    return DiagnosisResult(
        dataset_dir=dataset_dir,
        damage_type=DamageType.HEALTHY,
        repairable=True,
        details={},
    )


def test_list_datasets_route(tmp_path: Path) -> None:
    _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)
    client = TestClient(_build_app(coord))

    response = client.get("/api/dataset-repair/datasets")

    assert response.status_code == 200
    payload = response.json()
    assert payload["root"] == str(tmp_path)
    assert {item["name"] for item in payload["datasets"]} == {"a"}


def test_list_datasets_route_rejects_root_outside_scan_anchor(tmp_path: Path) -> None:
    outside_root = tmp_path.parent / f"{tmp_path.name}-outside"
    dataset_dir = _make_dataset(outside_root, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)
    client = TestClient(_build_app(coord))

    response = client.get(
        "/api/dataset-repair/datasets",
        params={"root": str(outside_root)},
    )

    assert response.status_code == 400
    assert "inside" in response.json()["detail"]
    assert not (dataset_dir / "meta" / "repair_status.json").exists()


def test_diagnose_route_rejects_root_outside_scan_anchor(tmp_path: Path) -> None:
    outside_root = tmp_path.parent / f"{tmp_path.name}-outside"
    _make_dataset(outside_root, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)
    client = TestClient(_build_app(coord))

    response = client.post(
        "/api/dataset-repair/diagnose",
        json={"filters": {"root": str(outside_root)}},
    )

    assert response.status_code == 400
    assert "inside" in response.json()["detail"]


def test_repair_route_rejects_root_outside_scan_anchor(tmp_path: Path) -> None:
    outside_root = tmp_path.parent / f"{tmp_path.name}-outside"
    _make_dataset(outside_root, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_meta_stale, repair_fn=_stub_repair)
    client = TestClient(_build_app(coord))

    response = client.post(
        "/api/dataset-repair/repair",
        json={"filters": {"root": str(outside_root)}},
    )

    assert response.status_code == 400
    assert "inside" in response.json()["detail"]


async def test_diagnose_then_jobs_current(tmp_path: Path) -> None:
    import httpx

    _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)
    app = _build_app(coord)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/dataset-repair/diagnose", json={})
        assert response.status_code == 200
        job = response.json()
        assert job["phase"] == "diagnosing"
        assert job["total"] == 1

        for _ in range(40):
            await asyncio.sleep(0.05)
            snap = await client.get(f"/api/dataset-repair/jobs/{job['job_id']}")
            assert snap.status_code == 200
            if snap.json()["phase"] in ("completed", "failed", "cancelled"):
                break

        final = (await client.get(f"/api/dataset-repair/jobs/{job['job_id']}")).json()
        assert final["phase"] == "completed"


async def _wait_for_thread_event(event: threading.Event, *, timeout: float = 2.0) -> None:
    """Poll a ``threading.Event`` from async code without blocking the loop.

    ``event.wait(timeout)`` is a synchronous block that prevents the worker
    coroutine — scheduled by the route handler we just awaited — from running.
    Polling with ``await asyncio.sleep`` lets the loop interleave the worker.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if event.is_set():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("event was not set within timeout")


async def test_diagnose_conflict_returns_409(tmp_path: Path) -> None:
    import httpx

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        release.wait(timeout=2.0)
        return _healthy(dataset_dir)

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=slow)
    app = _build_app(coord)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.post("/api/dataset-repair/diagnose", json={})
        assert first.status_code == 200
        await _wait_for_thread_event(started)

        second = await client.post("/api/dataset-repair/diagnose", json={})
        assert second.status_code == 409
        detail = second.json()["detail"]
        assert detail["phase"] in ("diagnosing", "cancelling")

    release.set()


def test_jobs_current_when_idle(tmp_path: Path) -> None:
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)
    client = TestClient(_build_app(coord))

    response = client.get("/api/dataset-repair/jobs/current")
    assert response.status_code == 200
    assert response.json() == {"job": None}


async def test_jobs_current_when_active(tmp_path: Path) -> None:
    import httpx

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        release.wait(timeout=2.0)
        return _healthy(dataset_dir)

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=slow)
    app = _build_app(coord)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        started_resp = await client.post("/api/dataset-repair/diagnose", json={})
        assert started_resp.status_code == 200
        await _wait_for_thread_event(started)

        current = await client.get("/api/dataset-repair/jobs/current")
        assert current.status_code == 200
        body = current.json()
        assert body["job"] is not None
        assert body["job"]["phase"] in ("diagnosing", "completed")

    release.set()


async def test_stream_events_yields_snapshot_then_complete(tmp_path: Path) -> None:
    _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_healthy)

    from roboclaw.data.repair.schemas import DiagnoseRequest

    job = await coord.start_diagnosis(DiagnoseRequest())

    seen: list[str] = []
    async for event in coord.stream_events(job.job_id):
        seen.append(event["type"])
        if event["type"] == "complete":
            break

    assert seen[0] == "snapshot"
    assert seen[-1] == "complete"


# ----------------------------- /repair endpoint ------------------------------


def _meta_stale(dataset_dir: Path) -> DiagnosisResult:
    return DiagnosisResult(
        dataset_dir=dataset_dir,
        damage_type=DamageType.META_STALE,
        repairable=True,
        details={"n_parquet_rows": 1},
    )


def _stub_repair(diagnosis: DiagnosisResult, **_kwargs) -> RepairResult:
    return RepairResult(diagnosis.dataset_dir, diagnosis.damage_type, "repaired")


async def test_repair_endpoint_returns_repairing_then_completes(tmp_path: Path) -> None:
    import httpx

    _make_dataset(tmp_path, "a")
    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=_meta_stale, repair_fn=_stub_repair)
    app = _build_app(coord)

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post("/api/dataset-repair/repair", json={})
        assert response.status_code == 200
        job = response.json()
        assert job["kind"] == "repair"
        assert job["phase"] == "repairing"
        assert job["total"] == 1

        for _ in range(40):
            await asyncio.sleep(0.05)
            snap = await client.get(f"/api/dataset-repair/jobs/{job['job_id']}")
            assert snap.status_code == 200
            if snap.json()["phase"] in ("completed", "failed", "cancelled"):
                break

        final = (await client.get(f"/api/dataset-repair/jobs/{job['job_id']}")).json()
        assert final["phase"] == "completed"


async def test_repair_conflict_returns_409(tmp_path: Path) -> None:
    import httpx

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        release.wait(timeout=2.0)
        return _meta_stale(dataset_dir)

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=slow, repair_fn=_stub_repair)
    app = _build_app(coord)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.post("/api/dataset-repair/repair", json={})
        assert first.status_code == 200
        await _wait_for_thread_event(started)

        second = await client.post("/api/dataset-repair/repair", json={})
        assert second.status_code == 409
        detail = second.json()["detail"]
        assert detail["phase"] in ("repairing", "cancelling")

    release.set()


async def test_diagnose_blocks_repair_via_409(tmp_path: Path) -> None:
    """Both endpoints share the same lock — a running diagnose blocks repair."""
    import httpx

    _make_dataset(tmp_path, "a")
    started = threading.Event()
    release = threading.Event()

    def slow(dataset_dir: Path) -> DiagnosisResult:
        started.set()
        release.wait(timeout=2.0)
        return _healthy(dataset_dir)

    coord = DatasetRepairCoordinator(tmp_path, diagnose_fn=slow, repair_fn=_stub_repair)
    app = _build_app(coord)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        first = await client.post("/api/dataset-repair/diagnose", json={})
        assert first.status_code == 200
        await _wait_for_thread_event(started)

        second = await client.post("/api/dataset-repair/repair", json={})
        assert second.status_code == 409

    release.set()
