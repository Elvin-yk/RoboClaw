from __future__ import annotations

import json
from enum import Enum
from pathlib import Path
from typing import Any

import pyarrow.compute as pc

from roboclaw.data.local_discovery import iter_data_files
from roboclaw.data.repair.diagnosis import diagnose_dataset, find_tmp_videos
from roboclaw.data.repair.io import (
    count_video_files,
    get_video_keys,
    load_info,
    safe_read_parquet_metadata,
    safe_read_parquet_table,
)


def build_diagnosis_payload(dataset_path: Path) -> dict[str, Any]:
    return diagnosis_payload_from_result(diagnose_dataset(dataset_path))


def diagnosis_payload_from_result(result: Any) -> dict[str, Any]:
    return {
        "damage_type": result.damage_type.value,
        "repairable": result.repairable,
        "details": _json_safe(result.details),
    }


def inspect_structure_summary(dataset_path: Path) -> dict[str, Any]:
    info = _read_info(dataset_path)
    total_episodes = _safe_int(info.get("total_episodes")) or 0
    total_frames = _safe_int(info.get("total_frames")) or 0
    issues = [] if info else [_issue("missing_info", "critical", "缺少 meta/info.json。")]
    return {
        "passed": not issues,
        "summary": True,
        "issues": issues,
        "counts": {
            "info_total_episodes": total_episodes,
            "info_total_frames": total_frames,
            "episode_metadata_count": 0,
            "episode_length_sum": 0,
            "parquet_files": 0,
            "parquet_rows": 0,
            "video_files": 0,
            "video_keys": _video_key_count(info),
            "tmp_videos": 0,
        },
    }


def inspect_structure(dataset_path: Path) -> dict[str, Any]:
    info = _read_info(dataset_path)
    parquet = _inspect_data_parquet(dataset_path)
    episodes = _inspect_episode_metadata(dataset_path)
    video_count = count_video_files(dataset_path)
    tmp_video_count = len(find_tmp_videos(dataset_path))
    video_key_count = _video_key_count(info)
    total_episodes = _safe_int(info.get("total_episodes")) or 0
    total_frames = _safe_int(info.get("total_frames")) or 0
    issues = _structure_issues(
        info=info,
        total_episodes=total_episodes,
        total_frames=total_frames,
        parquet=parquet,
        episodes=episodes,
        video_count=video_count,
        video_key_count=video_key_count,
        tmp_video_count=tmp_video_count,
    )
    return {
        "passed": not any(issue["level"] == "critical" for issue in issues),
        "issues": issues,
        "counts": {
            "info_total_episodes": total_episodes,
            "info_total_frames": total_frames,
            "episode_metadata_count": episodes["count"],
            "episode_length_sum": episodes["length_sum"],
            "parquet_files": parquet["files"],
            "parquet_rows": parquet["rows"],
            "video_files": video_count,
            "video_keys": video_key_count,
            "tmp_videos": tmp_video_count,
        },
    }


def _read_info(dataset_path: Path) -> dict[str, Any]:
    info_path = dataset_path / "meta" / "info.json"
    if not info_path.is_file():
        return {}
    return load_info(dataset_path)


def _inspect_data_parquet(dataset_path: Path) -> dict[str, Any]:
    rows = 0
    files = 0
    unreadable: list[str] = []
    for parquet_path in iter_data_files(dataset_path / "data", "*.parquet"):
        metadata = safe_read_parquet_metadata(parquet_path)
        if metadata is None:
            unreadable.append(parquet_path.relative_to(dataset_path).as_posix())
            continue
        files += 1
        rows += metadata.num_rows
    return {"files": files, "rows": rows, "unreadable": unreadable}


def _inspect_episode_metadata(dataset_path: Path) -> dict[str, Any]:
    jsonl_path = dataset_path / "meta" / "episodes.jsonl"
    if jsonl_path.is_file():
        return _inspect_episode_jsonl(dataset_path, jsonl_path)
    return _inspect_episode_parquets(dataset_path)


def _inspect_episode_jsonl(dataset_path: Path, jsonl_path: Path) -> dict[str, Any]:
    count = 0
    length_sum = 0
    unreadable: list[str] = []
    with jsonl_path.open(encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            row = json.loads(line)
            count += 1
            length_sum += _safe_int(row.get("length")) or 0
    return {"count": count, "length_sum": length_sum, "unreadable": unreadable}


def _inspect_episode_parquets(dataset_path: Path) -> dict[str, Any]:
    count = 0
    length_sum = 0
    unreadable: list[str] = []
    for parquet_path in iter_data_files(dataset_path / "meta" / "episodes", "*.parquet"):
        table = safe_read_parquet_table(parquet_path, columns=["length"])
        if table is None:
            unreadable.append(parquet_path.relative_to(dataset_path).as_posix())
            continue
        count += table.num_rows
        total = pc.sum(table["length"]).as_py()
        length_sum += _safe_int(total) or 0
    return {"count": count, "length_sum": length_sum, "unreadable": unreadable}


def _structure_issues(
    *,
    info: dict[str, Any],
    total_episodes: int,
    total_frames: int,
    parquet: dict[str, Any],
    episodes: dict[str, Any],
    video_count: int,
    video_key_count: int,
    tmp_video_count: int,
) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    _check_empty_or_missing_info(issues, info, parquet, video_count, tmp_video_count)
    _check_unreadable_files(issues, parquet, episodes)
    _check_frame_counts(issues, total_frames, parquet, episodes)
    _check_episode_counts(issues, total_episodes, episodes)
    _check_video_presence(issues, total_episodes, video_key_count, video_count, tmp_video_count)
    return issues


def _check_empty_or_missing_info(
    issues: list[dict[str, Any]],
    info: dict[str, Any],
    parquet: dict[str, Any],
    video_count: int,
    tmp_video_count: int,
) -> None:
    if info:
        return
    if parquet["rows"] == 0 and video_count == 0 and tmp_video_count == 0:
        issues.append(_issue("empty_shell", "critical", "目录没有可用 LeRobot 数据。"))
        return
    issues.append(_issue("missing_info", "critical", "缺少 meta/info.json。"))


def _check_unreadable_files(
    issues: list[dict[str, Any]],
    parquet: dict[str, Any],
    episodes: dict[str, Any],
) -> None:
    for path in parquet["unreadable"]:
        issues.append(_issue("unreadable_parquet", "critical", f"数据 parquet 不可读: {path}"))
    for path in episodes["unreadable"]:
        issues.append(_issue("unreadable_episode_meta", "critical", f"episode 元数据不可读: {path}"))


def _check_frame_counts(
    issues: list[dict[str, Any]],
    total_frames: int,
    parquet: dict[str, Any],
    episodes: dict[str, Any],
) -> None:
    if total_frames > 0 and parquet["rows"] == 0:
        issues.append(_issue("missing_parquet", "critical", "info 声明有帧，但 data parquet 为空。"))
    if total_frames > 0 and parquet["rows"] > 0 and total_frames != parquet["rows"]:
        message = f"info.total_frames={total_frames} 与 parquet rows={parquet['rows']} 不一致。"
        issues.append(_issue("frame_count_mismatch", "critical", message))
    if episodes["length_sum"] > 0 and total_frames > 0 and episodes["length_sum"] != total_frames:
        message = f"episode length sum={episodes['length_sum']} 与 info.total_frames={total_frames} 不一致。"
        issues.append(_issue("episode_length_mismatch", "critical", message))


def _check_episode_counts(
    issues: list[dict[str, Any]],
    total_episodes: int,
    episodes: dict[str, Any],
) -> None:
    if total_episodes > 0 and episodes["count"] == 0:
        issues.append(_issue("missing_episode_meta", "critical", "缺少 episode 元数据。"))
    if total_episodes > 0 and episodes["count"] > 0 and total_episodes != episodes["count"]:
        message = f"info.total_episodes={total_episodes} 与 episode metadata count={episodes['count']} 不一致。"
        issues.append(_issue("episode_count_mismatch", "critical", message))


def _check_video_presence(
    issues: list[dict[str, Any]],
    total_episodes: int,
    video_key_count: int,
    video_count: int,
    tmp_video_count: int,
) -> None:
    if total_episodes > 0 and video_key_count > 0 and video_count < video_key_count:
        message = f"视频文件数 {video_count} 少于视频流数量 {video_key_count}。"
        issues.append(_issue("missing_videos", "critical", message))
    if tmp_video_count > 0:
        issues.append(_issue("tmp_videos", "major", f"发现 {tmp_video_count} 个 tmp 视频文件。"))


def _video_key_count(info: dict[str, Any]) -> int:
    features = info.get("features") if isinstance(info.get("features"), dict) else {}
    return len(get_video_keys({"features": features})) if features else 0


def _issue(check: str, level: str, message: str) -> dict[str, Any]:
    return {"check": check, "level": level, "message": message}


def _safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _json_safe(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value
