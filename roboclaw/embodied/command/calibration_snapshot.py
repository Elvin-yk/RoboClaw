"""Calibration snapshot helpers for recording datasets.

This module lives outside the LeRobot engine submodule. It prepares a small
plan in the parent RoboClaw process and applies it inside the wrapper process
as soon as LeRobot creates the dataset root, before any episode is recorded.
"""

from __future__ import annotations

import json
import os
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from loguru import logger

from roboclaw.embodied.command.helpers import resolve_action_arms
from roboclaw.embodied.embodiment.manifest.binding import ArmBinding

CALIBRATION_SNAPSHOT_ENV = "ROBOCLAW_RECORD_CALIBRATION_SNAPSHOT"


def build_record_calibration_snapshot_plan(
    dataset_root: Path,
    manifest: Any,
    *,
    arms: str = "",
) -> dict[str, Any]:
    entries: list[dict[str, str]] = []
    seen: set[Path] = set()
    for arm in resolve_action_arms(manifest, arms):
        source = _arm_calibration_file(arm)
        if not source.is_file():
            logger.warning("Recording calibration file is missing for {}: {}", arm.alias, source)
            continue
        resolved = source.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        entries.append({
            "alias": arm.alias,
            "role": arm.role.value,
            "side": arm.side,
            "arm_type": arm.arm_type,
            "id": arm.arm_id,
            "source_path": str(resolved),
            "relative_path": source.name,
        })
    return {
        "schema_version": 1,
        "dataset_root": str(dataset_root.expanduser()),
        "entries": entries,
    }


@contextmanager
def record_calibration_snapshot_env(
    dataset_root: Path,
    manifest: Any,
    *,
    arms: str = "",
) -> Iterator[None]:
    previous = os.environ.get(CALIBRATION_SNAPSHOT_ENV)
    plan = build_record_calibration_snapshot_plan(dataset_root, manifest, arms=arms)
    os.environ[CALIBRATION_SNAPSHOT_ENV] = json.dumps(plan)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(CALIBRATION_SNAPSHOT_ENV, None)
        else:
            os.environ[CALIBRATION_SNAPSHOT_ENV] = previous


def apply_record_calibration_snapshot_from_env(dataset_root: Path) -> None:
    raw = os.environ.get(CALIBRATION_SNAPSHOT_ENV)
    if not raw:
        return
    plan = json.loads(raw)
    planned_root = Path(plan["dataset_root"]).expanduser().resolve()
    if planned_root != dataset_root.expanduser().resolve():
        return
    apply_record_calibration_snapshot(dataset_root, plan)


def apply_record_calibration_snapshot(dataset_root: Path, plan: dict[str, Any]) -> None:
    if not dataset_root.is_dir():
        raise FileNotFoundError(f"Dataset root is not created yet: {dataset_root}")
    calibration_dir = dataset_root / "calibration"
    if calibration_dir.exists():
        shutil.rmtree(calibration_dir)
    calibration_dir.mkdir(exist_ok=True)

    manifest_entries: list[dict[str, str]] = []
    for entry in plan.get("entries", []):
        source = Path(entry["source_path"])
        relative_path = Path(entry["relative_path"]).name
        target = calibration_dir / relative_path
        shutil.copy2(source, target)
        manifest_entries.append({
            key: str(value)
            for key, value in entry.items()
            if key != "source_path"
        })

    (calibration_dir / "manifest.json").write_text(
        json.dumps({"schema_version": 1, "entries": manifest_entries}, indent=4) + "\n",
        encoding="utf-8",
    )


def _arm_calibration_file(arm: ArmBinding) -> Path:
    calibration_dir = Path(arm.calibration_dir).expanduser()
    return calibration_dir / f"{arm.arm_id}.json"
