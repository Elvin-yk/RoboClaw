from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .io import (
    build_video_path,
    count_images_per_camera,
    count_video_files,
    find_log_for_dataset,
    get_video_keys,
    load_info,
    min_images_per_camera,
    parse_cp_from_log,
    read_recovery_rows,
    safe_read_parquet_metadata,
    safe_read_parquet_table,
    scan_parquet_files,
)
from .types import DamageType, DiagnosisResult, TmpVideo

log = logging.getLogger(__name__)


def parse_tmp_video_filename(mp4_path: Path) -> tuple[str, int | None]:
    """Recover ``(video_key, episode_index)`` from a stuck tmp mp4 filename.

    Mirrors the two lerobot writer naming patterns; falls back to the bare
    stem when neither matches.
    """
    stem = mp4_path.stem
    if stem.endswith("_streaming"):
        return stem[: -len("_streaming")], None
    parts = stem.rsplit("_", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0], int(parts[1])
    return stem, None


def find_tmp_videos(dataset_dir: Path) -> list[TmpVideo]:
    """Walk top-level ``tmp*/`` dirs and return every stuck mp4 found.

    Multiple files per video_key are common (different episodes from batch
    encoding, or per-episode streaming residue from repeated crashes); each
    file is its own ``TmpVideo`` entry — callers decide how to group.
    """
    result: list[TmpVideo] = []
    if not dataset_dir.exists():
        return result
    for tmp_dir in sorted(dataset_dir.iterdir()):
        if not tmp_dir.is_dir() or not tmp_dir.name.startswith("tmp"):
            continue
        for mp4_path in sorted(tmp_dir.glob("*.mp4")):
            video_key, episode_index = parse_tmp_video_filename(mp4_path)
            result.append(
                TmpVideo(video_key=video_key, path=mp4_path, episode_index=episode_index)
            )
    return result


def find_recoverable_tmp_videos(
    tmp_videos: list[TmpVideo],
    video_keys: list[str],
    dataset_dir: Path,
) -> list[TmpVideo]:
    """Subset of *tmp_videos* whose key is declared in *video_keys* and whose
    canonical ``videos/<key>/`` location has no mp4 yet.
    """
    declared = set(video_keys)
    return [
        tmp
        for tmp in tmp_videos
        if tmp.video_key in declared and not _has_canonical_video(dataset_dir, tmp.video_key)
    ]


def _has_canonical_video(dataset_dir: Path, video_key: str) -> bool:
    canonical = dataset_dir / "videos" / video_key
    return canonical.exists() and any(canonical.rglob("*.mp4"))


def has_frame_mismatch(recovery_count: int, images_per_camera: dict[str, int]) -> bool:
    if recovery_count <= 0 or not images_per_camera:
        return False
    return any(count != recovery_count for count in images_per_camera.values())


def records_critical_phase_intervals(info: dict[str, Any]) -> bool:
    fields = info.get("rlt_episode_metadata_fields")
    return isinstance(fields, dict) and "rl_intervals" in fields


def truncate_target_frames(n_recovery_lines: int, image_floor: int, n_parquet_rows: int) -> int:
    candidates = [value for value in [n_recovery_lines, image_floor, n_parquet_rows] if value > 0]
    return min(candidates) if candidates else 0


def is_repairable(damage_type: DamageType, details: dict[str, Any]) -> bool:
    if damage_type == DamageType.CRASH_NO_SAVE:
        return details["n_recovery_lines"] > 0 and details["min_images_per_camera"] > 0
    if damage_type == DamageType.TMP_VIDEOS_STUCK:
        return details["n_recovery_lines"] > 0 and details["n_tmp_videos"] > 0
    if damage_type == DamageType.PARTIAL_TMP_VIDEOS_STUCK:
        return details["n_recoverable_tmp_videos"] > 0 and details["n_parquet_rows"] > 0
    if damage_type == DamageType.PARQUET_NO_VIDEO:
        return details["n_parquet_rows"] > 0 and details["min_images_per_camera"] > 0
    if damage_type == DamageType.META_STALE:
        return details["n_parquet_rows"] > 0
    if damage_type == DamageType.FRAME_MISMATCH:
        return details["truncate_target_frames"] > 0
    if damage_type == DamageType.MISSING_CP:
        return details.get("n_log_cp", 0) > 0
    return False


def _classify_damage(
    total_episodes: int,
    n_recovery_lines: int,
    image_floor: int,
    n_parquet_rows: int,
    n_video_files: int,
    video_keys: list[str],
    tmp_videos: dict[str, Path],
    n_recoverable_tmp_videos: int,
    images_per_camera: dict[str, int],
    records_cp_intervals: bool,
    has_cp_intervals: bool,
    log_cp_intervals: list[dict[str, Any]],
) -> DamageType:
    if total_episodes == 0 and n_parquet_rows == 0 and n_recovery_lines == 0 and image_floor == 0 and not tmp_videos:
        return DamageType.EMPTY_SHELL
    if n_video_files == 0 and tmp_videos:
        return DamageType.TMP_VIDEOS_STUCK
    if n_recoverable_tmp_videos > 0 and n_parquet_rows > 0:
        return DamageType.PARTIAL_TMP_VIDEOS_STUCK
    if records_cp_intervals and n_parquet_rows == 0 and n_video_files == 0 and (n_recovery_lines > 0 or image_floor > 0):
        return DamageType.CRASH_NO_SAVE
    if n_parquet_rows > 0 and n_video_files == 0 and video_keys:
        return DamageType.PARQUET_NO_VIDEO
    if total_episodes == 0 and n_parquet_rows > 0 and n_video_files > 0:
        return DamageType.META_STALE
    if records_cp_intervals and has_frame_mismatch(n_recovery_lines, images_per_camera):
        return DamageType.FRAME_MISMATCH
    if records_cp_intervals and not has_cp_intervals and log_cp_intervals and n_parquet_rows > 0:
        return DamageType.MISSING_CP
    return DamageType.HEALTHY


class DatasetDiagnosisService:
    def diagnose(self, dataset_dir: Path) -> DiagnosisResult:
        info = load_info(dataset_dir)
        total_episodes = int(info.get("total_episodes", 0))
        total_frames = int(info.get("total_frames", 0))
        records_cp_intervals = records_critical_phase_intervals(info)
        n_recovery_lines = len(read_recovery_rows(dataset_dir)) if records_cp_intervals else 0
        images_per_camera = count_images_per_camera(dataset_dir)
        image_floor = min_images_per_camera(images_per_camera)
        n_parquet_files, _episode_count, n_parquet_rows = scan_parquet_files(dataset_dir)
        n_video_files = count_video_files(dataset_dir)
        video_keys = get_video_keys(info)
        tmp_videos = find_tmp_videos(dataset_dir)
        recoverable_tmp_videos = find_recoverable_tmp_videos(tmp_videos, video_keys, dataset_dir)
        has_cp_intervals = records_cp_intervals and (dataset_dir / "critical_phase_intervals.json").exists()
        log_path = find_log_for_dataset(dataset_dir) if records_cp_intervals else None
        log_cp_intervals = parse_cp_from_log(log_path) if log_path and not has_cp_intervals else []

        details: dict[str, Any] = {
            "info_total_episodes": total_episodes,
            "info_total_frames": total_frames,
            "records_critical_phase_intervals": records_cp_intervals,
            "n_recovery_lines": n_recovery_lines,
            "images_per_camera": images_per_camera,
            "min_images_per_camera": image_floor,
            "n_parquet_files": n_parquet_files,
            "n_parquet_rows": n_parquet_rows,
            "n_video_files": n_video_files,
            "n_video_keys": len(video_keys),
            "n_tmp_videos": len(tmp_videos),
            "tmp_videos": tmp_videos,
            "n_recoverable_tmp_videos": len(recoverable_tmp_videos),
            "recoverable_tmp_videos": recoverable_tmp_videos,
            "truncate_target_frames": truncate_target_frames(
                n_recovery_lines=n_recovery_lines,
                image_floor=image_floor,
                n_parquet_rows=n_parquet_rows,
            ),
            "has_cp": has_cp_intervals,
            "n_log_cp": len(log_cp_intervals),
            "log_cp_intervals": log_cp_intervals,
            "log_path": log_path,
        }

        damage_type = _classify_damage(
            total_episodes=total_episodes,
            n_recovery_lines=n_recovery_lines,
            image_floor=image_floor,
            n_parquet_rows=n_parquet_rows,
            n_video_files=n_video_files,
            video_keys=video_keys,
            tmp_videos=tmp_videos,
            n_recoverable_tmp_videos=len(recoverable_tmp_videos),
            images_per_camera=images_per_camera,
            records_cp_intervals=records_cp_intervals,
            has_cp_intervals=has_cp_intervals,
            log_cp_intervals=log_cp_intervals,
        )
        return DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=damage_type,
            repairable=is_repairable(damage_type, details),
            details=details,
        )

    def verify(self, dataset_dir: Path) -> list[str]:
        errors: list[str] = []
        info_path = dataset_dir / "meta" / "info.json"
        if not info_path.exists():
            return ["info.json missing"]

        try:
            info = load_info(dataset_dir)
        except (json.JSONDecodeError, OSError) as exc:
            log.exception("Unable to read %s", info_path)
            return [f"info.json unreadable: {exc}"]

        total_episodes = int(info.get("total_episodes", 0))
        total_frames = int(info.get("total_frames", 0))
        if total_episodes <= 0:
            errors.append(f"total_episodes={total_episodes} (expected > 0)")
        if total_frames <= 0:
            errors.append(f"total_frames={total_frames} (expected > 0)")

        parquet_rows = 0
        from roboclaw.data.local_discovery import iter_data_files

        for parquet_path in iter_data_files(dataset_dir / "data", "*.parquet"):
            metadata = safe_read_parquet_metadata(parquet_path)
            table = safe_read_parquet_table(parquet_path)
            if metadata is None or table is None:
                errors.append(f"unreadable parquet: {parquet_path.relative_to(dataset_dir)}")
                continue
            parquet_rows += metadata.num_rows

        if parquet_rows != total_frames:
            errors.append(f"parquet row sum {parquet_rows} != info total_frames {total_frames}")

        for video_key in get_video_keys(info):
            for episode_index in range(total_episodes):
                video_path = build_video_path(dataset_dir, info, video_key, episode_index)
                if not video_path.exists():
                    errors.append(f"missing video: {video_path.relative_to(dataset_dir)}")

        return errors


_DIAGNOSIS_SERVICE = DatasetDiagnosisService()


def diagnose_dataset(dataset_dir: Path) -> DiagnosisResult:
    return _DIAGNOSIS_SERVICE.diagnose(dataset_dir)


def verify_repaired_dataset(dataset_dir: Path) -> list[str]:
    return _DIAGNOSIS_SERVICE.verify(dataset_dir)
