from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .io import (
    build_video_path_from_indices,
    count_images_per_camera,
    count_video_files,
    get_video_keys,
    load_info,
    min_images_per_camera,
    safe_read_parquet_metadata,
    safe_read_parquet_table,
    scan_parquet_files,
)
from .types import DamageKind, DiagnosisResult, IntegrityStatus, RepairStrategy, TmpVideo

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


def verify_complete_dataset_structure(dataset_dir: Path, info: dict[str, Any] | None = None) -> list[str]:
    errors: list[str] = []
    info_path = dataset_dir / "meta" / "info.json"
    if info is None:
        if not info_path.exists():
            return ["missing meta/info.json"]
        try:
            info = load_info(dataset_dir)
        except (json.JSONDecodeError, OSError) as exc:
            return [f"unreadable meta/info.json: {exc}"]

    total_episodes = int(info.get("total_episodes", 0) or 0)
    total_frames = int(info.get("total_frames", 0) or 0)
    if total_episodes <= 0:
        errors.append(f"total_episodes={total_episodes} (expected > 0)")
    if total_frames <= 0:
        errors.append(f"total_frames={total_frames} (expected > 0)")

    errors.extend(_required_metadata_errors(dataset_dir))

    data_rows = _data_row_count(dataset_dir, errors)
    if data_rows == 0:
        errors.append("missing data parquet rows")
    elif total_frames > 0 and data_rows != total_frames:
        errors.append(f"parquet row sum {data_rows} != info total_frames {total_frames}")

    episode_rows = _episode_row_count(dataset_dir, errors)
    if episode_rows == 0:
        errors.append("missing meta/episodes parquet rows")
    elif total_episodes > 0 and episode_rows != total_episodes:
        errors.append(f"episode row sum {episode_rows} != info total_episodes {total_episodes}")

    errors.extend(_video_structure_errors(dataset_dir, info))
    return errors


def _required_metadata_errors(dataset_dir: Path) -> list[str]:
    errors: list[str] = []
    required_files = [
        "meta/info.json",
        "meta/stats.json",
        "meta/tasks.parquet",
    ]
    for relative in required_files:
        path = dataset_dir / relative
        if not path.is_file():
            errors.append(f"missing {relative}")
    for relative in ["meta/tasks.parquet"]:
        path = dataset_dir / relative
        if path.is_file() and safe_read_parquet_metadata(path) is None:
            errors.append(f"unreadable {relative}")
    stats_path = dataset_dir / "meta" / "stats.json"
    if stats_path.is_file():
        try:
            json.loads(stats_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            errors.append(f"unreadable meta/stats.json: {exc}")
    return errors


def _data_row_count(dataset_dir: Path, errors: list[str]) -> int:
    data_dir = dataset_dir / "data"
    if not data_dir.is_dir():
        errors.append("missing data/")
        return 0
    total_rows = 0
    for parquet_path in sorted(data_dir.rglob("*.parquet")):
        metadata = safe_read_parquet_metadata(parquet_path)
        table = safe_read_parquet_table(parquet_path)
        relative = parquet_path.relative_to(dataset_dir)
        if metadata is None or table is None:
            errors.append(f"unreadable parquet: {relative}")
            continue
        total_rows += metadata.num_rows
    return total_rows


def _episode_row_count(dataset_dir: Path, errors: list[str]) -> int:
    episodes_dir = dataset_dir / "meta" / "episodes"
    if not episodes_dir.is_dir():
        errors.append("missing meta/episodes/")
        return 0
    total_rows = 0
    for parquet_path in sorted(episodes_dir.rglob("*.parquet")):
        metadata = safe_read_parquet_metadata(parquet_path)
        table = safe_read_parquet_table(parquet_path)
        relative = parquet_path.relative_to(dataset_dir)
        if metadata is None or table is None:
            errors.append(f"unreadable parquet: {relative}")
            continue
        total_rows += metadata.num_rows
    return total_rows


def _video_structure_errors(dataset_dir: Path, info: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    video_keys = get_video_keys(info)
    if video_keys and not (dataset_dir / "videos").is_dir():
        errors.append("missing videos/")
        return errors
    episode_rows = _read_episode_rows(dataset_dir, errors)
    if not episode_rows:
        return errors
    expected_paths: set[Path] = set()
    for video_key in video_keys:
        chunk_column = f"videos/{video_key}/chunk_index"
        file_column = f"videos/{video_key}/file_index"
        for row in episode_rows:
            if chunk_column not in row or file_column not in row:
                errors.append(f"missing episode video index columns for {video_key}")
                break
            expected_paths.add(
                build_video_path_from_indices(
                    dataset_dir,
                    info,
                    video_key,
                    int(row[chunk_column]),
                    int(row[file_column]),
                )
            )
    for video_path in sorted(expected_paths):
        if not video_path.is_file():
            errors.append(f"missing video: {video_path.relative_to(dataset_dir)}")
    return errors


def _read_episode_rows(dataset_dir: Path, errors: list[str]) -> list[dict[str, Any]]:
    episodes_dir = dataset_dir / "meta" / "episodes"
    if not episodes_dir.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for parquet_path in sorted(episodes_dir.rglob("*.parquet")):
        table = safe_read_parquet_table(parquet_path)
        relative = parquet_path.relative_to(dataset_dir)
        if table is None:
            errors.append(f"unreadable parquet: {relative}")
            continue
        rows.extend(table.to_pylist())
    return rows


def _calibration_structure_warnings(dataset_dir: Path) -> list[str]:
    calibration_dir = dataset_dir / "calibration"
    if not calibration_dir.is_dir():
        return ["missing calibration/"]
    manifest_path = calibration_dir / "manifest.json"
    if not manifest_path.is_file():
        return ["missing calibration/manifest.json"]
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return [f"unreadable calibration/manifest.json: {exc}"]
    entries = manifest.get("entries")
    if not isinstance(entries, list) or not entries:
        return ["calibration/manifest.json has no entries"]
    errors: list[str] = []
    for index, entry in enumerate(entries):
        relative_path = entry.get("relative_path") if isinstance(entry, dict) else None
        if not isinstance(relative_path, str) or not relative_path:
            errors.append(f"calibration manifest entry {index} missing relative_path")
            continue
        if not (calibration_dir / relative_path).is_file():
            errors.append(f"missing calibration file: calibration/{relative_path}")
    return errors


def _data_episode_counts(dataset_dir: Path) -> dict[int, int]:
    counts: dict[int, int] = {}
    data_dir = dataset_dir / "data"
    if not data_dir.is_dir():
        return counts
    for parquet_path in sorted(data_dir.rglob("*.parquet")):
        table = safe_read_parquet_table(parquet_path, columns=["episode_index"])
        if table is None:
            continue
        for value in table["episode_index"].to_pylist():
            episode_index = int(value)
            counts[episode_index] = counts.get(episode_index, 0) + 1
    return counts


def _consistency_findings(
    info: dict[str, Any],
    data_episode_counts: dict[int, int],
    episode_rows: list[dict[str, Any]],
    tmp_videos: list[TmpVideo],
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    info_total_episodes = int(info.get("total_episodes", 0) or 0)
    info_total_frames = int(info.get("total_frames", 0) or 0)
    data_total_frames = sum(data_episode_counts.values())
    data_episode_indices = set(data_episode_counts)
    meta_by_episode = {
        int(row.get("episode_index", -1)): row
        for row in episode_rows
        if row.get("episode_index") is not None
    }
    meta_episode_indices = set(meta_by_episode)

    if data_episode_counts and info_total_episodes != len(data_episode_counts):
        errors.append(
            f"info total_episodes {info_total_episodes} != data episode count {len(data_episode_counts)}"
        )
    if data_episode_counts and info_total_frames != data_total_frames:
        errors.append(f"info total_frames {info_total_frames} != data row count {data_total_frames}")

    missing_in_meta = sorted(data_episode_indices - meta_episode_indices)
    if missing_in_meta:
        errors.append(f"data episodes missing from meta/episodes: {missing_in_meta}")
    stale_meta = sorted(meta_episode_indices - data_episode_indices)
    if stale_meta:
        errors.append(f"meta/episodes not present in data rows: {stale_meta}")

    for episode_index in sorted(data_episode_indices & meta_episode_indices):
        meta_length = int(meta_by_episode[episode_index].get("length", 0) or 0)
        data_length = data_episode_counts[episode_index]
        if meta_length != data_length:
            errors.append(
                f"episode {episode_index} meta length {meta_length} != data rows {data_length}"
            )

    if episode_rows:
        sorted_rows = sorted(episode_rows, key=lambda row: int(row.get("episode_index", 0) or 0))
        expected_start = 0
        for row in sorted_rows:
            episode_index = int(row.get("episode_index", 0) or 0)
            start = int(row.get("dataset_from_index", expected_start) or 0)
            end = int(row.get("dataset_to_index", start) or 0)
            length = int(row.get("length", max(end - start, 0)) or 0)
            if start != expected_start:
                errors.append(
                    f"episode {episode_index} dataset_from_index {start} != expected {expected_start}"
                )
            if end - start != length:
                errors.append(
                    f"episode {episode_index} range length {end - start} != length {length}"
                )
            expected_start = end
        if info_total_frames and expected_start != info_total_frames:
            errors.append(
                f"meta/episodes final dataset_to_index {expected_start} != info total_frames {info_total_frames}"
            )

    if tmp_videos:
        warnings.append(f"top-level tmp videos present: {len(tmp_videos)}")
    return errors, warnings


def _damage_findings(
    structure_errors: list[str],
    consistency_errors: list[str],
    tmp_videos: list[TmpVideo],
    recoverable_tmp_videos: list[TmpVideo],
) -> list[DamageKind]:
    findings: list[DamageKind] = []
    if any(error == "missing data/" or "missing data parquet rows" in error for error in structure_errors):
        findings.append(DamageKind.MISSING_DATA_ROWS)
    if any("missing meta/" in error or "missing episode video index columns" in error for error in structure_errors):
        findings.append(DamageKind.MISSING_METADATA)
    if any("data episodes missing from meta/episodes" in error for error in consistency_errors):
        findings.append(DamageKind.ORPHAN_DATA_EPISODES)
    if any(
        needle in error
        for error in consistency_errors
        for needle in (
            "info total_episodes",
            "info total_frames",
            "meta/episodes final dataset_to_index",
        )
    ):
        findings.append(DamageKind.STALE_INFO_TOTALS)
    if any(error.startswith("missing video:") for error in structure_errors):
        findings.append(DamageKind.MISSING_VIDEO_FILES)
    if recoverable_tmp_videos:
        findings.append(DamageKind.RECOVERABLE_TMP_VIDEOS)
    elif tmp_videos:
        findings.append(DamageKind.TMP_VIDEO_RESIDUE)
    if not findings and structure_errors:
        findings.append(DamageKind.UNKNOWN_DAMAGE)
    return _unique_damage_findings(findings)


def _unique_damage_findings(findings: list[DamageKind]) -> list[DamageKind]:
    unique: list[DamageKind] = []
    seen: set[DamageKind] = set()
    for finding in findings:
        if finding in seen:
            continue
        seen.add(finding)
        unique.append(finding)
    return unique


def _primary_damage_kind(integrity_status: IntegrityStatus, findings: list[DamageKind]) -> DamageKind:
    if integrity_status == IntegrityStatus.HEALTHY:
        return DamageKind.NONE
    if integrity_status == IntegrityStatus.EMPTY_SHELL:
        return DamageKind.EMPTY_SHELL
    priority = [
        DamageKind.MISSING_DATA_ROWS,
        DamageKind.RECOVERABLE_TMP_VIDEOS,
        DamageKind.ORPHAN_DATA_EPISODES,
        DamageKind.STALE_INFO_TOTALS,
        DamageKind.MISSING_VIDEO_FILES,
        DamageKind.MISSING_METADATA,
        DamageKind.TMP_VIDEO_RESIDUE,
        DamageKind.UNKNOWN_DAMAGE,
    ]
    for candidate in priority:
        if candidate in findings:
            return candidate
    return DamageKind.UNKNOWN_DAMAGE


def _repair_plan(
    data_episode_counts: dict[int, int],
    episode_rows: list[dict[str, Any]],
    consistency_errors: list[str],
) -> tuple[RepairStrategy, dict[str, Any] | None]:
    if not data_episode_counts:
        return RepairStrategy.NONE, None
    episode_indices = sorted(data_episode_counts)
    if episode_indices != list(range(episode_indices[-1] + 1)):
        return RepairStrategy.NONE, None
    meta_indices = {
        int(row.get("episode_index", -1))
        for row in episode_rows
        if row.get("episode_index") is not None
    }
    missing_episode_indices = [index for index in episode_indices if index not in meta_indices]
    needs_formalize = bool(missing_episode_indices) or any(
        needle in error
        for error in consistency_errors
        for needle in (
            "info total_episodes",
            "info total_frames",
            "meta/episodes final dataset_to_index",
        )
    )
    if not needs_formalize:
        return RepairStrategy.NONE, None
    strategy = RepairStrategy.FORMALIZE_DATA_EPISODES
    return strategy, {
        "strategy": strategy.value,
        "episode_indices": episode_indices,
        "missing_episode_indices": missing_episode_indices,
        "target_total_episodes": len(episode_indices),
        "target_total_frames": sum(data_episode_counts.values()),
        "episode_lengths": [data_episode_counts[index] for index in episode_indices],
    }


def is_repairable(integrity_status: IntegrityStatus, repair_strategy: RepairStrategy) -> bool:
    return (
        integrity_status == IntegrityStatus.STRUCTURE_INCOMPLETE
        and repair_strategy != RepairStrategy.NONE
    )


def _classify_integrity(
    total_episodes: int,
    image_floor: int,
    n_parquet_rows: int,
    tmp_videos: list[TmpVideo],
    structure_errors: list[str],
) -> IntegrityStatus:
    if not structure_errors:
        return IntegrityStatus.HEALTHY
    if total_episodes == 0 and n_parquet_rows == 0 and image_floor == 0 and not tmp_videos:
        return IntegrityStatus.EMPTY_SHELL
    return IntegrityStatus.STRUCTURE_INCOMPLETE


def _structure_repairable(dataset_dir: Path, n_parquet_rows: int) -> bool:
    return n_parquet_rows > 0


class DatasetDiagnosisService:
    def diagnose(self, dataset_dir: Path) -> DiagnosisResult:
        info = load_info(dataset_dir)
        total_episodes = int(info.get("total_episodes", 0))
        total_frames = int(info.get("total_frames", 0))
        images_per_camera = count_images_per_camera(dataset_dir)
        image_floor = min_images_per_camera(images_per_camera)
        n_parquet_files, _episode_count, n_parquet_rows = scan_parquet_files(dataset_dir)
        n_video_files = count_video_files(dataset_dir)
        video_keys = get_video_keys(info)
        tmp_videos = find_tmp_videos(dataset_dir)
        recoverable_tmp_videos = find_recoverable_tmp_videos(tmp_videos, video_keys, dataset_dir)
        structure_errors = verify_complete_dataset_structure(dataset_dir, info)
        episode_row_errors: list[str] = []
        episode_rows = _read_episode_rows(dataset_dir, episode_row_errors)
        data_episode_counts = _data_episode_counts(dataset_dir)
        consistency_errors, consistency_warnings = _consistency_findings(
            info,
            data_episode_counts,
            episode_rows,
            tmp_videos,
        )
        repair_strategy, plan = _repair_plan(data_episode_counts, episode_rows, consistency_errors)
        integrity_status = _classify_integrity(
            total_episodes=total_episodes,
            image_floor=image_floor,
            n_parquet_rows=n_parquet_rows,
            tmp_videos=tmp_videos,
            structure_errors=structure_errors,
        )
        damage_findings = _damage_findings(
            structure_errors,
            consistency_errors,
            tmp_videos,
            recoverable_tmp_videos,
        )
        damage_kind = _primary_damage_kind(integrity_status, damage_findings)

        details: dict[str, Any] = {
            "integrity_status": integrity_status.value,
            "damage_kind": damage_kind.value,
            "damage_findings": [finding.value for finding in damage_findings],
            "repair_strategy": repair_strategy.value,
            "info_total_episodes": total_episodes,
            "info_total_frames": total_frames,
            "data_episode_counts": data_episode_counts,
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
            "structure_errors": structure_errors,
            "structure_warnings": _calibration_structure_warnings(dataset_dir),
            "consistency_errors": consistency_errors,
            "consistency_warnings": consistency_warnings,
            "repair_plan": plan,
            "structure_repairable": _structure_repairable(dataset_dir, n_parquet_rows),
        }
        return DiagnosisResult(
            dataset_dir=dataset_dir,
            integrity_status=integrity_status,
            damage_kind=damage_kind,
            repair_strategy=repair_strategy,
            repairable=is_repairable(integrity_status, repair_strategy),
            details=details,
        )

    def verify(self, dataset_dir: Path) -> list[str]:
        info_path = dataset_dir / "meta" / "info.json"
        if not info_path.exists():
            return ["info.json missing"]

        try:
            info = load_info(dataset_dir)
        except (json.JSONDecodeError, OSError) as exc:
            log.exception("Unable to read %s", info_path)
            return [f"info.json unreadable: {exc}"]

        return verify_complete_dataset_structure(dataset_dir, info)


_DIAGNOSIS_SERVICE = DatasetDiagnosisService()


def diagnose_dataset(dataset_dir: Path) -> DiagnosisResult:
    return _DIAGNOSIS_SERVICE.diagnose(dataset_dir)


def verify_repaired_dataset(dataset_dir: Path) -> list[str]:
    return _DIAGNOSIS_SERVICE.verify(dataset_dir)
