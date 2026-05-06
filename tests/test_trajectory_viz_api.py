"""HTTP-level tests for /api/trajectory-viz/*.

Builds a minimal LeRobot-shaped fixture dataset on disk and serves it via a
FastAPI app with only the trajectory-viz routes registered.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.data.trajectory_viz.so101_mapper import SO101_JOINT_ORDER
from roboclaw.http.routes.trajectory_viz import register_trajectory_viz_routes


def _bimanual_names() -> list[str]:
    return [f"{side}_{j}.pos" for side in ("left", "right") for j in SO101_JOINT_ORDER]


def _write_fixture_dataset(root: Path) -> Path:
    ds_root = root / "fixture_ds"
    (ds_root / "data" / "chunk-000").mkdir(parents=True)
    (ds_root / "meta").mkdir(parents=True)
    names = _bimanual_names()
    info = {
        "codebase_version": "v3.0",
        "robot_type": "bi_so_follower",
        "total_episodes": 1,
        "total_frames": 5,
        "total_tasks": 1,
        "chunks_size": 1000,
        "fps": 30,
        "splits": {"train": "0:1"},
        "data_path": "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
        "features": {
            "observation.state": {"dtype": "float32", "shape": [12], "names": names},
            "action": {"dtype": "float32", "shape": [12], "names": names},
            "timestamp": {"dtype": "float32", "shape": [1], "names": None},
            "frame_index": {"dtype": "int64", "shape": [1], "names": None},
            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            "index": {"dtype": "int64", "shape": [1], "names": None},
            "task_index": {"dtype": "int64", "shape": [1], "names": None},
        },
    }
    (ds_root / "meta" / "info.json").write_text(json.dumps(info))
    episode_meta = {
        "episode_index": 0,
        "tasks": ["fixture"],
        "length": 5,
        "data/chunk_index": 0,
        "data/file_index": 0,
        "dataset_from_index": 0,
        "dataset_to_index": 5,
    }
    (ds_root / "meta" / "episodes.jsonl").write_text(json.dumps(episode_meta) + "\n")

    state = np.arange(5 * 12, dtype=np.float32).reshape(5, 12)
    action = state + 0.1
    table = pa.table(
        {
            "observation.state": pa.array(state.tolist()),
            "action": pa.array(action.tolist()),
            "timestamp": pa.array(np.arange(5, dtype=np.float32) / 30.0),
            "frame_index": pa.array(np.arange(5, dtype=np.int64)),
            "episode_index": pa.array(np.zeros(5, dtype=np.int64)),
            "index": pa.array(np.arange(5, dtype=np.int64)),
            "task_index": pa.array(np.zeros(5, dtype=np.int64)),
        }
    )
    pq.write_table(table, ds_root / "data" / "chunk-000" / "file-000.parquet")
    return ds_root


@pytest.fixture()
def client() -> TestClient:
    app = FastAPI()
    register_trajectory_viz_routes(app)
    return TestClient(app)


def test_model_endpoint_reports_so101_constants(client: TestClient) -> None:
    r = client.get("/api/trajectory-viz/model/so101")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model"] == "so101_follower"
    assert body["ee_link"] == "gripper_frame_link"
    assert body["joint_order"] == list(SO101_JOINT_ORDER)
    assert body["scene"]["arm_separation_m"] == pytest.approx(0.23)
    assert body["scene"]["left_base_xyz"] == [0.0, 0.115, 0.0]
    assert body["scene"]["forward_axis"] == "+X"
    assert body["urdf_url"].startswith("/api/trajectory-viz/assets/so101/")


def test_static_assets_served(client: TestClient) -> None:
    r = client.get("/api/trajectory-viz/assets/so101/so101_new_calib.urdf")
    assert r.status_code == 200
    assert b"<robot" in r.content


def test_trajectory_endpoint_returns_split_arms(tmp_path: Path, client: TestClient) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "path", "path": str(ds_root), "episode_index": 0, "signal": "state"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["frame_count"] == 5
    assert body["fps"] == 30.0
    assert body["arms"]["left"]["joint_degrees"]["shoulder_pan"] == pytest.approx(
        [0.0, 12.0, 24.0, 36.0, 48.0]
    )
    assert body["arms"]["right"]["joint_degrees"]["gripper"] == pytest.approx(
        [11.0, 23.0, 35.0, 47.0, 59.0]
    )


def test_trajectory_endpoint_rejects_unknown_signal(client: TestClient) -> None:
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "path", "path": "/tmp/none", "signal": "ghost"},
    )
    assert r.status_code == 422


def test_trajectory_endpoint_rejects_remote_source(client: TestClient) -> None:
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "remote", "dataset": "anything"},
    )
    assert r.status_code == 400


def test_trajectory_endpoint_supports_action_signal(tmp_path: Path, client: TestClient) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "path", "path": str(ds_root), "episode_index": 0, "signal": "action"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["signal"] == "action"
    # action is state + 0.1
    assert body["arms"]["left"]["joint_degrees"]["shoulder_pan"][0] == pytest.approx(0.1)


def test_trajectory_endpoint_slices_with_stride(tmp_path: Path, client: TestClient) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={
            "source": "path",
            "path": str(ds_root),
            "episode_index": 0,
            "signal": "state",
            "start_frame": 1,
            "end_frame": 5,
            "stride": 2,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["frame_count"] == 2
    assert body["frame_index"] == [1, 3]
    assert body["arms"]["left"]["joint_degrees"]["shoulder_pan"] == pytest.approx([12.0, 36.0])


def test_trajectory_endpoint_rejects_empty_window(tmp_path: Path, client: TestClient) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={
            "source": "path",
            "path": str(ds_root),
            "start_frame": 3,
            "end_frame": 3,
            "signal": "state",
        },
    )
    assert r.status_code == 422


def test_trajectory_endpoint_rejects_invalid_stride(tmp_path: Path, client: TestClient) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "path", "path": str(ds_root), "stride": 0, "signal": "state"},
    )
    assert r.status_code == 422


def test_trajectory_endpoint_enforces_max_frames(
    tmp_path: Path, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    ds_root = _write_fixture_dataset(tmp_path)
    monkeypatch.setattr("roboclaw.data.trajectory_viz.trajectory.MAX_TRAJECTORY_FRAMES", 2)
    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={"source": "path", "path": str(ds_root), "signal": "state"},
    )
    assert r.status_code == 413


def test_trajectory_endpoint_remaps_quality_flag_frame_after_slice(
    tmp_path: Path, client: TestClient
) -> None:
    """A flag triggered at original frame 4 must report remapped index after slicing."""
    ds_root = _write_fixture_dataset(tmp_path)
    # Override one row's left_shoulder_lift (column 1) to trip the URDF limit.
    import pyarrow as pa
    import pyarrow.parquet as pq

    pq_path = ds_root / "data" / "chunk-000" / "file-000.parquet"
    table = pq.read_table(pq_path).to_pandas()
    bad_row = list(table["observation.state"].iloc[4])
    bad_row[1] = 200.0  # 200° far above 100° limit
    table.at[4, "observation.state"] = bad_row
    pq.write_table(pa.Table.from_pandas(table), pq_path)

    r = client.get(
        "/api/trajectory-viz/trajectory",
        params={
            "source": "path",
            "path": str(ds_root),
            "signal": "state",
            "start_frame": 2,
            "stride": 2,
        },
    )
    assert r.status_code == 200
    flags = r.json()["quality_flags"]
    assert any(
        f["arm"] == "left" and f["joint"] == "shoulder_lift" and f["frame"] == 1
        for f in flags
    ), flags
