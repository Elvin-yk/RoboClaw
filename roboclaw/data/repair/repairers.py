from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any

from roboclaw.data.curation.stats import compute_feature_stats

from .diagnosis import verify_repaired_dataset
from .io import (
    build_video_path,
    build_video_path_from_indices,
    get_video_keys,
    list_episode_dirs,
    load_info,
    safe_read_parquet_table,
    scan_parquet_files,
)
from .lerobot_adapter import LeRobotDatasetAdapter
from .types import (
    DiagnosisResult,
    IntegrityStatus,
    RepairResult,
    RepairStatus,
    RepairStrategy,
    TmpVideo,
)

log = logging.getLogger(__name__)


def group_tmp_videos_by_key(tmp_videos: list[TmpVideo]) -> dict[str, list[TmpVideo]]:
    """Group ``TmpVideo`` entries by ``video_key``.

    Each per-key list is sorted by ``(episode_index ?? 0, path)`` so callers
    that just want "the first match" get a deterministic order.
    """
    grouped: dict[str, list[TmpVideo]] = {}
    for tmp in tmp_videos:
        grouped.setdefault(tmp.video_key, []).append(tmp)
    for entries in grouped.values():
        entries.sort(key=lambda tmp: (tmp.episode_index if tmp.episode_index is not None else 0, str(tmp.path)))
    return grouped


def prepare_output_dir(output_dir: Path, *, force: bool) -> bool:
    """Reserve ``output_dir`` for a repair run.

    Returns ``True`` if the caller may proceed (``output_dir`` is now absent).
    Returns ``False`` if the directory already exists and ``force`` is not set.
    """
    if output_dir.exists() and force:
        shutil.rmtree(output_dir)
        return True
    return not output_dir.exists()


def parse_episode_index(episode_dir: Path) -> int:
    return int(episode_dir.name.split("-")[-1])


class DatasetRepairService:
    def __init__(self, adapter: LeRobotDatasetAdapter | None = None) -> None:
        self._adapter = adapter or LeRobotDatasetAdapter()

    def repair(
        self,
        diagnosis: DiagnosisResult,
        *,
        task: str,
        vcodec: str,
        dry_run: bool,
        force: bool,
        output_dir: Path,
    ) -> RepairResult:
        dataset_dir = diagnosis.dataset_dir
        damage_kind = diagnosis.damage_kind
        repair_strategy = diagnosis.repair_strategy

        if diagnosis.integrity_status == IntegrityStatus.HEALTHY:
            return RepairResult(dataset_dir, damage_kind, repair_strategy, RepairStatus.HEALTHY)
        if diagnosis.integrity_status == IntegrityStatus.EMPTY_SHELL:
            return RepairResult(
                dataset_dir,
                damage_kind,
                repair_strategy,
                RepairStatus.SKIPPED,
                error="empty shell -- nothing to recover",
            )
        if not diagnosis.repairable:
            return RepairResult(dataset_dir, damage_kind, repair_strategy, RepairStatus.SKIPPED, error="unrepairable")
        if dry_run:
            return RepairResult(dataset_dir, damage_kind, repair_strategy, RepairStatus.SKIPPED, error="dry run")

        if not prepare_output_dir(output_dir, force=force):
            return RepairResult(
                dataset_dir,
                damage_kind,
                repair_strategy,
                RepairStatus.SKIPPED,
                error=f"{output_dir} already exists",
            )

        self._materialize_symlink_tree(dataset_dir, output_dir)
        self._scrub_cleaned(output_dir)

        result = self._dispatch_repair(
            diagnosis,
            task=task,
            vcodec=vcodec,
            output_dir=output_dir,
        )
        if result.status != RepairStatus.REPAIRED:
            return result

        verify_errors = verify_repaired_dataset(output_dir)
        if not verify_errors:
            return result
        return RepairResult(
            dataset_dir,
            damage_kind,
            repair_strategy,
            RepairStatus.FAILED,
            error="; ".join(verify_errors),
        )

    def _dispatch_repair(
        self,
        diagnosis: DiagnosisResult,
        *,
        task: str,
        vcodec: str,
        output_dir: Path,
    ) -> RepairResult:
        dataset_dir = diagnosis.dataset_dir
        if diagnosis.repair_strategy == RepairStrategy.FORMALIZE_DATA_EPISODES:
            self._repair_structure_incomplete(output_dir, diagnosis)
            return RepairResult(
                dataset_dir,
                diagnosis.damage_kind,
                diagnosis.repair_strategy,
                RepairStatus.REPAIRED,
            )
        return RepairResult(
            dataset_dir,
            diagnosis.damage_kind,
            diagnosis.repair_strategy,
            RepairStatus.SKIPPED,
            error=f"unsupported repair strategy: {diagnosis.repair_strategy.value}",
        )

    def _materialize_symlink_tree(self, source_dir: Path, output_dir: Path) -> None:
        output_dir.mkdir(parents=True, exist_ok=False)
        for entry in sorted(source_dir.iterdir()):
            if entry.name in {".status", ".data", ".workflow"}:
                continue
            if entry.is_dir() and entry.name.startswith("tmp"):
                continue
            target = output_dir / entry.name
            if entry.is_dir():
                self._materialize_symlink_tree(entry, target)
                continue
            target.symlink_to(entry.resolve())

    def _prepare_write_path(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() or path.is_symlink():
            path.unlink()

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        self._prepare_write_path(path)
        path.write_text(json.dumps(payload, indent=4) + "\n", encoding="utf-8")

    def _write_info(self, dataset_dir: Path, info: dict[str, Any]) -> None:
        self._write_json(dataset_dir / "meta" / "info.json", info)

    def _repair_parquet_no_video(self, dataset_dir: Path, *, vcodec: str) -> None:
        info = load_info(dataset_dir)
        images_dir = dataset_dir / "images"
        fps = int(info["fps"])
        for video_key in get_video_keys(info):
            episode_dirs = list_episode_dirs(images_dir / video_key)
            if not episode_dirs:
                raise FileNotFoundError(
                    f"No PNG episode directories found for video key {video_key} in {dataset_dir}"
                )
            for episode_dir in episode_dirs:
                self._adapter.encode_video_frames(
                    frames_dir=episode_dir,
                    video_path=build_video_path(dataset_dir, info, video_key, parse_episode_index(episode_dir)),
                    fps=fps,
                    vcodec=vcodec,
                )

    def _patch_info_totals_from_parquet(self, dataset_dir: Path) -> tuple[int, int]:
        info = load_info(dataset_dir)
        _n_files, total_episodes, total_frames = scan_parquet_files(dataset_dir)
        info["total_episodes"] = total_episodes
        info["total_frames"] = total_frames
        info["splits"] = {"train": f"0:{total_episodes}"} if total_episodes > 0 else {}
        self._write_info(dataset_dir, info)
        return total_episodes, total_frames

    def _repair_meta_stale(self, dataset_dir: Path) -> None:
        self._patch_info_totals_from_parquet(dataset_dir)
        self._drop_missing_video_keys(dataset_dir)
        self._complete_dataset_structure(dataset_dir)

    def _repair_structure_incomplete(self, dataset_dir: Path, diagnosis: DiagnosisResult) -> None:
        self._patch_info_totals_from_parquet(dataset_dir)
        self._copy_tmp_videos_for_missing_episodes(dataset_dir, diagnosis)
        self._drop_missing_video_keys(dataset_dir)
        self._complete_dataset_structure(dataset_dir)

    def _repair_partial_tmp_videos_stuck(
        self,
        dataset_dir: Path,
        diagnosis: DiagnosisResult,
    ) -> None:
        """Move recoverable tmp videos into their canonical ``videos/<key>/``
        location, then patch totals and drop any video keys still missing.

        ``dataset_dir`` here is the cleaned output (already scrubbed of tmp/).
        Recoverable tmp paths point at the source dataset's tmp directory,
        which still exists on disk.

        Multiple stuck files for the same key are written to distinct
        canonical episode slots: ``_<NNN>``-named files keep their parsed
        episode index, ``_streaming.mp4`` files are sequenced from 0.
        """
        info = load_info(dataset_dir)
        recoverable: list[TmpVideo] = diagnosis.details["recoverable_tmp_videos"]
        recoverable_by_key = group_tmp_videos_by_key(recoverable)
        for video_key, entries in recoverable_by_key.items():
            self._copy_tmp_videos_to_canonical(dataset_dir, info, video_key, entries)
        self._patch_info_totals_from_parquet(dataset_dir)
        self._drop_missing_video_keys(dataset_dir)
        self._complete_dataset_structure(dataset_dir)

    def _copy_tmp_videos_to_canonical(
        self,
        dataset_dir: Path,
        info: dict[str, Any],
        video_key: str,
        entries: list[TmpVideo],
    ) -> None:
        streaming_index = 0
        for tmp in entries:
            if tmp.episode_index is not None:
                episode_index = tmp.episode_index
            else:
                episode_index = streaming_index
                streaming_index += 1
            dst_mp4 = build_video_path(dataset_dir, info, video_key, episode_index)
            dst_mp4.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(tmp.path, dst_mp4)

    def _copy_tmp_videos_for_missing_episodes(
        self,
        dataset_dir: Path,
        diagnosis: DiagnosisResult,
    ) -> None:
        plan = diagnosis.details.get("repair_plan") or {}
        missing_episode_indices = [int(value) for value in plan.get("missing_episode_indices") or []]
        if not missing_episode_indices:
            return
        data_lengths = {
            int(key): int(value)
            for key, value in dict(diagnosis.details.get("data_episode_counts") or {}).items()
        }
        tmp_by_key = group_tmp_videos_by_key(list(diagnosis.details.get("tmp_videos") or []))
        info = load_info(dataset_dir)
        for video_key in get_video_keys(info):
            entries = tmp_by_key.get(video_key) or []
            if not entries:
                continue
            used: set[Path] = set()
            for episode_index in missing_episode_indices:
                entry = self._matching_tmp_video(entries, data_lengths.get(episode_index, 0), used)
                if entry is None:
                    continue
                used.add(entry.path)
                file_index = self._next_video_file_index(dataset_dir, video_key)
                if not any((dataset_dir / "videos" / video_key).rglob("*.mp4")):
                    file_index = 0
                target = build_video_path_from_indices(dataset_dir, info, video_key, 0, file_index)
                self._prepare_write_path(target)
                shutil.copy2(entry.path, target)

    def _matching_tmp_video(
        self,
        entries: list[TmpVideo],
        expected_frames: int,
        used: set[Path],
    ) -> TmpVideo | None:
        for entry in entries:
            if entry.path in used:
                continue
            if expected_frames <= 0 or self._video_frame_count(entry.path) in {0, expected_frames}:
                return entry
        return None

    def _next_video_file_index(self, dataset_dir: Path, video_key: str) -> int:
        indices = [
            self._parse_index(path.stem, "file")
            for path in (dataset_dir / "videos" / video_key).rglob("file-*.mp4")
        ]
        return max(indices, default=-1) + 1

    def _drop_missing_video_keys(self, dataset_dir: Path) -> None:
        """Remove declared video features that have no mp4 file on disk.

        Without this, ``verify_repaired_dataset`` flags every cleaned artifact
        whose source declared more cameras than were actually recorded.
        """
        info = load_info(dataset_dir)
        features = info.get("features", {})
        missing = [
            key
            for key, feature in features.items()
            if feature.get("dtype") == "video"
            and not any((dataset_dir / "videos" / key).rglob("*.mp4"))
        ]
        if not missing:
            return
        for key in missing:
            features.pop(key, None)
        self._write_info(dataset_dir, info)

    def _scrub_cleaned(self, dataset_dir: Path) -> None:
        """Strip artifacts that should not survive into the cleaned copy:
        the source's stale repair_status.json and any top-level ``tmp*/``
        scratch directories left over from interrupted recordings.
        """
        stale_status = dataset_dir / "meta" / "repair_status.json"
        if stale_status.exists():
            stale_status.unlink()
        for entry in dataset_dir.iterdir():
            if entry.is_dir() and entry.name.startswith("tmp"):
                shutil.rmtree(entry)
        self._curate_calibration_snapshot(dataset_dir)

    def _complete_dataset_structure(self, dataset_dir: Path) -> None:
        self._write_episode_metadata_from_parquet(dataset_dir)
        self._write_stats_from_parquet(dataset_dir)
        self._curate_calibration_snapshot(dataset_dir)

    def _write_episode_metadata_from_parquet(self, dataset_dir: Path) -> None:
        import pyarrow as pa
        import pyarrow.parquet as pq

        info = load_info(dataset_dir)
        fps = int(info.get("fps", 30) or 30)
        task_by_index = self._load_tasks(dataset_dir)
        episodes: dict[int, dict[str, Any]] = {}
        for parquet_path in sorted((dataset_dir / "data").rglob("*.parquet")):
            table = safe_read_parquet_table(parquet_path)
            if table is None:
                continue
            rows = table.to_pylist()
            data_chunk_index = self._parse_index(parquet_path.parent.name, "chunk")
            data_file_index = self._parse_index(parquet_path.stem, "file")
            for local_row_index, row in enumerate(rows):
                episode_index = int(row.get("episode_index", 0) or 0)
                global_index = int(row.get("index", local_row_index) or 0)
                task_index = int(row.get("task_index", 0) or 0)
                entry = episodes.setdefault(episode_index, {
                    "episode_index": episode_index,
                    "tasks": [task_by_index.get(task_index, "")],
                    "length": 0,
                    "data/chunk_index": data_chunk_index,
                    "data/file_index": data_file_index,
                    "dataset_from_index": global_index,
                    "dataset_to_index": global_index + 1,
                })
                entry["length"] += 1
                entry["dataset_from_index"] = min(int(entry["dataset_from_index"]), global_index)
                entry["dataset_to_index"] = max(int(entry["dataset_to_index"]), global_index + 1)
        for episode_index, entry in episodes.items():
            for video_key in get_video_keys(info):
                entry.update(
                    self._video_pointer_for_episode(
                        dataset_dir,
                        info,
                        video_key,
                        entry,
                        fps=fps,
                    )
                )
        episodes_path = dataset_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet"
        episodes_root = dataset_dir / "meta" / "episodes"
        if episodes_root.exists() or episodes_root.is_symlink():
            shutil.rmtree(episodes_root)
        episodes_path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist([episodes[key] for key in sorted(episodes)]), episodes_path)

    def _video_pointer_for_episode(
        self,
        dataset_dir: Path,
        info: dict[str, Any],
        video_key: str,
        episode: dict[str, Any],
        *,
        fps: int,
    ) -> dict[str, Any]:
        episode_index = int(episode["episode_index"])
        length = int(episode["length"])
        from_index = int(episode["dataset_from_index"])
        to_index = int(episode["dataset_to_index"])
        video_files = sorted((dataset_dir / "videos" / video_key).rglob("*.mp4"))
        if not video_files:
            return {}

        shared = self._shared_video_file(video_files, to_index)
        if shared is not None:
            chunk_index, file_index = self._chunk_file_indices(shared)
            return self._video_pointer(video_key, chunk_index, file_index, from_index, to_index, fps)

        exact = self._exact_episode_video(video_files, episode_index, length)
        if exact is not None:
            chunk_index, file_index = self._chunk_file_indices(exact)
            return self._video_pointer(video_key, chunk_index, file_index, 0, length, fps)

        first = video_files[0]
        frame_count = self._video_frame_count(first)
        if frame_count == 0 or frame_count >= to_index:
            chunk_index, file_index = self._chunk_file_indices(first)
            return self._video_pointer(video_key, chunk_index, file_index, from_index, to_index, fps)
        return {}

    def _shared_video_file(self, video_files: list[Path], required_frames: int) -> Path | None:
        for path in video_files:
            frame_count = self._video_frame_count(path)
            if frame_count >= required_frames:
                return path
        return None

    def _exact_episode_video(
        self,
        video_files: list[Path],
        episode_index: int,
        expected_frames: int,
    ) -> Path | None:
        for path in video_files:
            if self._parse_index(path.stem, "file") == episode_index:
                return path
        for path in video_files:
            if self._video_frame_count(path) == expected_frames:
                return path
        return None

    def _video_pointer(
        self,
        video_key: str,
        chunk_index: int,
        file_index: int,
        from_frame: int,
        to_frame: int,
        fps: int,
    ) -> dict[str, Any]:
        prefix = f"videos/{video_key}"
        from_timestamp = from_frame / fps if fps > 0 else 0.0
        to_timestamp = to_frame / fps if fps > 0 else 0.0
        return {
            f"{prefix}/chunk_index": chunk_index,
            f"{prefix}/file_index": file_index,
            f"{prefix}/from_timestamp": from_timestamp,
            f"{prefix}/to_timestamp": to_timestamp,
        }

    def _chunk_file_indices(self, path: Path) -> tuple[int, int]:
        return (
            self._parse_index(path.parent.name, "chunk"),
            self._parse_index(path.stem, "file"),
        )

    def _video_frame_count(self, path: Path) -> int:
        import cv2

        capture = cv2.VideoCapture(str(path))
        frames = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        capture.release()
        return frames

    def _write_stats_from_parquet(self, dataset_dir: Path) -> None:
        info = load_info(dataset_dir)
        rows: list[dict[str, Any]] = []
        for parquet_path in sorted((dataset_dir / "data").rglob("*.parquet")):
            table = safe_read_parquet_table(parquet_path)
            if table is not None:
                rows.extend(table.to_pylist())
        stats_path = dataset_dir / "meta" / "stats.json"
        self._prepare_write_path(stats_path)
        stats_path.write_text(json.dumps(compute_feature_stats(info, rows), indent=4) + "\n", encoding="utf-8")

    def _load_tasks(self, dataset_dir: Path) -> dict[int, str]:
        tasks_path = dataset_dir / "meta" / "tasks.parquet"
        if not tasks_path.is_file():
            return {}
        table = safe_read_parquet_table(tasks_path)
        if table is None:
            return {}
        result: dict[int, str] = {}
        for row in table.to_pylist():
            result[int(row.get("task_index", 0) or 0)] = str(row.get("task", ""))
        return result

    def _parse_index(self, value: str, prefix: str) -> int:
        marker = f"{prefix}-"
        if value.startswith(marker):
            return int(value[len(marker):])
        return 0

    def _curate_calibration_snapshot(self, dataset_dir: Path) -> None:
        calibration_dir = dataset_dir / "calibration"
        if not calibration_dir.is_dir():
            return
        selected = self._select_calibration_files(calibration_dir)
        if not selected:
            return
        payloads = [
            (relative_path, source_path.read_bytes())
            for relative_path, source_path in selected
        ]
        shutil.rmtree(calibration_dir)
        calibration_dir.mkdir(parents=True, exist_ok=True)
        entries: list[dict[str, str]] = []
        for relative_path, payload in payloads:
            target = calibration_dir / relative_path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)
            entries.append({"relative_path": relative_path.as_posix()})
        manifest = {"schema_version": 1, "entries": entries}
        (calibration_dir / "manifest.json").write_text(
            json.dumps(manifest, indent=4) + "\n",
            encoding="utf-8",
        )

    def _select_calibration_files(self, calibration_dir: Path) -> list[tuple[Path, Path]]:
        selected: list[tuple[Path, Path]] = []
        for source in sorted(calibration_dir.glob("*.json")):
            if source.name == "manifest.json" or source.name.startswith("._"):
                continue
            selected.append((Path(source.name), source))
        if selected:
            return selected
        for source in sorted(calibration_dir.glob("*/*.json")):
            if source.name == "manifest.json" or source.name.startswith("._"):
                continue
            selected.append((Path(f"{source.parent.name}_{source.name}"), source))
        return selected


_REPAIR_SERVICE = DatasetRepairService()


def repair_dataset(
    diagnosis: DiagnosisResult,
    *,
    task: str,
    vcodec: str,
    dry_run: bool,
    force: bool,
    output_dir: Path,
) -> RepairResult:
    return _REPAIR_SERVICE.repair(
        diagnosis,
        task=task,
        vcodec=vcodec,
        dry_run=dry_run,
        force=force,
        output_dir=output_dir,
    )
