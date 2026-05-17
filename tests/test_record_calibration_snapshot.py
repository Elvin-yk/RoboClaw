from __future__ import annotations

import json
from pathlib import Path

import pytest

from roboclaw.embodied.command.calibration_snapshot import (
    apply_record_calibration_snapshot,
    build_record_calibration_snapshot_plan,
)
from roboclaw.embodied.embodiment.manifest import Manifest


def test_record_calibration_snapshot_writes_flat_files_and_manifest(tmp_path: Path) -> None:
    calibration_dir = tmp_path / "calibration_source" / "F001"
    calibration_dir.mkdir(parents=True)
    (calibration_dir / "F001.json").write_text('{"ok": true}', encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps({
            "version": 2,
            "arms": [
                {
                    "alias": "left_follower",
                    "type": "so101_follower",
                    "port": "/tmp/left_follower",
                    "calibration_dir": str(calibration_dir),
                    "calibrated": True,
                    "side": "left",
                }
            ],
            "hands": [],
            "cameras": [],
            "datasets": {"root": str(tmp_path / "datasets")},
            "policies": {"root": ""},
        }),
        encoding="utf-8",
    )

    dataset_root = tmp_path / "datasets" / "local" / "demo"
    dataset_root.mkdir(parents=True)
    plan = build_record_calibration_snapshot_plan(dataset_root, Manifest(path=manifest_path))

    apply_record_calibration_snapshot(dataset_root, plan)

    assert (dataset_root / "calibration" / "F001.json").read_text(encoding="utf-8") == '{"ok": true}'
    assert not (dataset_root / "calibration" / "bimanual_followers").exists()
    manifest = json.loads((dataset_root / "calibration" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["entries"] == [
        {
            "alias": "left_follower",
            "role": "follower",
            "side": "left",
            "arm_type": "so101_follower",
            "id": "F001",
            "relative_path": "F001.json",
        }
    ]


def test_record_calibration_snapshot_requires_created_dataset_root(tmp_path: Path) -> None:
    dataset_root = tmp_path / "datasets" / "local" / "demo"

    with pytest.raises(FileNotFoundError):
        apply_record_calibration_snapshot(dataset_root, {"schema_version": 1, "entries": []})
