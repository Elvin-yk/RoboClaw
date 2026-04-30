from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .bridge import read_parquet_rows
from .episode_loader import _extract_timestamps
from .features import resolve_task_value
from .task_descriptions import payload_has_task_description, value_has_task_description
from .validation_core import (
    finalize_validator,
    is_present,
    make_issue,
    merge_threshold_overrides,
    safe_float,
)


def validate_metadata(
    data: dict[str, Any],
    threshold_overrides: dict[str, float] | None = None,
) -> dict[str, Any]:
    operator_name = "metadata"
    thresholds = merge_threshold_overrides(threshold_overrides)
    info = data["info"]
    episode_meta = data["episode_meta"]
    issues: list[dict[str, Any]] = []

    if not info:
        require_info = thresholds["metadata_require_info_json"] >= 0.5
        issues.append(make_issue(
            operator_name=operator_name,
            check_name="info.json",
            passed=not require_info,
            message="Missing meta/info.json",
            level="critical",
        ))
        return finalize_validator(operator_name, issues)

    episode_index = data.get("episode_meta", {}).get("episode_index")
    _check_episode_identity(issues, operator_name, episode_meta, episode_index, thresholds)
    _check_info_fields(issues, operator_name, info)
    _check_data_files(issues, operator_name, data, thresholds)
    _check_task_description(issues, operator_name, data, thresholds)
    _check_duration(issues, operator_name, data, episode_meta, thresholds)

    return finalize_validator(operator_name, issues, details={"info": info, "episode_meta": episode_meta})


def _check_episode_identity(
    issues: list[dict[str, Any]],
    operator_name: str,
    episode_meta: dict[str, Any],
    episode_index: int,
    thresholds: dict[str, float],
) -> None:
    has_identity = episode_meta.get("episode_index") is not None
    required = thresholds["metadata_require_episode_metadata"] >= 0.5
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="episode identity",
        passed=has_identity or not required,
        message=f"episode_index={'present' if has_identity else 'missing'} in episode metadata",
        level="major" if required and not has_identity else "minor",
    ))


def _check_info_fields(
    issues: list[dict[str, Any]],
    operator_name: str,
    info: dict[str, Any],
) -> None:
    required = [("robot_type", "major"), ("fps", "major")]
    recommended = [("features", "minor")]
    for field, level in required + recommended:
        value = info.get(field)
        present = is_present(value)
        issues.append(make_issue(
            operator_name=operator_name,
            check_name=field,
            passed=present,
            message=f"{field}={'present' if present else 'missing'}",
            level=level if not present else "minor",
            value={"field": field, "value": value},
        ))


def _check_data_files(
    issues: list[dict[str, Any]],
    operator_name: str,
    data: dict[str, Any],
    thresholds: dict[str, float],
) -> None:
    require_data_files = thresholds["metadata_require_data_files"] >= 0.5
    require_videos = thresholds["metadata_require_videos"] >= 0.5
    parquet_path = data.get("parquet_path")
    parquet_exists = isinstance(parquet_path, Path) and parquet_path.exists()
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="parquet_data",
        passed=parquet_exists or not require_data_files,
        message=f"parquet data={'exists' if parquet_exists else 'missing'}",
        level="major" if require_data_files else "minor",
    ))
    has_videos = bool(data.get("video_files", []))
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="videos",
        passed=has_videos or not require_videos,
        message=f"video files={'found' if has_videos else 'missing'}",
        level="major" if require_videos and not has_videos else "minor",
    ))


def _check_task_description(
    issues: list[dict[str, Any]],
    operator_name: str,
    data: dict[str, Any],
    thresholds: dict[str, float],
) -> None:
    required = thresholds["metadata_require_task_description"] >= 0.5
    present = _has_task_description(data)
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="task_description",
        passed=present or not required,
        message=f"task description={'present' if present else 'missing'}",
        level="major" if required and not present else "minor",
    ))


def _has_task_description(data: dict[str, Any]) -> bool:
    episode_meta = data.get("episode_meta") or {}
    if payload_has_task_description(episode_meta):
        return True

    task_index = episode_meta.get("task_index")
    dataset_path = data.get("dataset_path")
    if task_index is not None and isinstance(dataset_path, Path):
        if _task_index_has_description(dataset_path, task_index):
            return True

    for row in data.get("rows", [])[:20]:
        value = resolve_task_value(row)
        if value_has_task_description(value):
            return True
        row_task_index = row.get("task_index")
        if row_task_index is not None and isinstance(dataset_path, Path):
            if _task_index_has_description(dataset_path, row_task_index):
                return True
    return False


def _task_index_has_description(dataset_path: Path, task_index: Any) -> bool:
    expected = safe_float(task_index)
    if expected is None:
        return False
    for row in _load_task_rows(dataset_path):
        row_index = safe_float(row.get("task_index"))
        if row_index is None or int(row_index) != int(expected):
            continue
        if _task_row_has_description(row):
            return True
    return False


def _load_task_rows(dataset_path: Path) -> list[dict[str, Any]]:
    tasks_jsonl = dataset_path / "meta" / "tasks.jsonl"
    if tasks_jsonl.is_file():
        rows: list[dict[str, Any]] = []
        for line in tasks_jsonl.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(payload, dict):
                rows.append(payload)
        return rows
    tasks_parquet = dataset_path / "meta" / "tasks.parquet"
    if tasks_parquet.is_file():
        return read_parquet_rows(tasks_parquet)
    return []


def _task_row_has_description(row: dict[str, Any]) -> bool:
    return payload_has_task_description(row)


def _check_duration(
    issues: list[dict[str, Any]],
    operator_name: str,
    data: dict[str, Any],
    episode_meta: dict[str, Any],
    thresholds: dict[str, float],
) -> None:
    duration = _derive_episode_duration_s(data, episode_meta)
    issues.append(make_issue(
        operator_name=operator_name,
        check_name="length",
        passed=duration >= thresholds["metadata_min_duration_s"],
        message=f"Episode length {duration}",
        level="major",
        value={"length": duration},
    ))


def _derive_episode_duration_s(
    data: dict[str, Any],
    episode_meta: dict[str, Any],
) -> float:
    timestamps = _extract_timestamps(data.get("rows", []))
    if len(timestamps) >= 2:
        return max(timestamps[-1] - timestamps[0], 0.0)

    for key, value in episode_meta.items():
        if not key.endswith("/to_timestamp"):
            continue
        end_time = safe_float(value)
        if end_time is None:
            continue
        start_key = key.replace("/to_timestamp", "/from_timestamp")
        start_time = safe_float(episode_meta.get(start_key)) or 0.0
        return max(end_time - start_time, 0.0)

    raw_length = safe_float(episode_meta.get("length")) or 0.0
    fps = safe_float(data.get("info", {}).get("fps"))
    if fps and fps > 0 and raw_length > fps:
        return max(raw_length / fps, 0.0)
    return max(raw_length, 0.0)
