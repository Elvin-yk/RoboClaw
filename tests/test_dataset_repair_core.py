from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

from roboclaw.data.repair.repairers import DatasetRepairService
from roboclaw.data.repair.types import DamageKind, DiagnosisResult, IntegrityStatus, RepairStrategy


def _write_info(dataset_dir: Path, *, total_episodes: int = 0, total_frames: int = 0) -> None:
    meta_dir = dataset_dir / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    info = {
        "total_episodes": total_episodes,
        "total_frames": total_frames,
        "fps": 30,
        "features": {
            "observation.images.front": {"dtype": "video", "shape": [4, 4, 3], "names": None},
            "observation.state": {"dtype": "float32", "shape": [2], "names": None},
            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
        },
    }
    (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")
    pq.write_table(pa.table({"task_index": [0], "task": ["task"]}), meta_dir / "tasks.parquet")
    calibration_dir = dataset_dir / "calibration" / "bimanual_followers"
    calibration_dir.mkdir(parents=True, exist_ok=True)
    (calibration_dir / "bimanual_left.json").write_text("{}", encoding="utf-8")
    (calibration_dir / "bimanual_right.json").write_text("{}", encoding="utf-8")


def _write_recovery(dataset_dir: Path, count: int) -> None:
    rows = [json.dumps({"observation.state": [index, index + 1]}) for index in range(count)]
    (dataset_dir / "recovery_frames.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")


def _write_images(dataset_dir: Path, count: int) -> None:
    image_dir = dataset_dir / "images" / "observation.images.front" / "episode-000000"
    image_dir.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        Image.new("RGB", (4, 4), (index, index, index)).save(image_dir / f"frame-{index:06d}.png")


def _write_parquet(dataset_dir: Path, episodes: list[int]) -> None:
    data_dir = dataset_dir / "data" / "chunk-000"
    data_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "episode_index": episodes,
            "observation.state": [[0.0, 1.0] for _ in episodes],
        }
    )
    pq.write_table(table, data_dir / "file-000.parquet")


def _write_video(dataset_dir: Path, episode_index: int = 0) -> None:
    video_dir = dataset_dir / "videos" / "observation.images.front" / "chunk-000"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / f"file-{episode_index:03d}.mp4").write_bytes(b"mp4")


class TestDatasetRepairCore:
    def test_meta_stale_refreshes_info_totals(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "meta_stale"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, [0, 0, 1])
        _write_video(dataset_dir, 0)
        _write_video(dataset_dir, 1)
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            integrity_status=IntegrityStatus.STRUCTURE_INCOMPLETE,
            damage_kind=DamageKind.STALE_INFO_TOTALS,
            repair_strategy=RepairStrategy.FORMALIZE_DATA_EPISODES,
            repairable=True,
            details={"n_parquet_rows": 3},
        )
        output_dir = tmp_path / "meta_stale_out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        info = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        original = json.loads((dataset_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        assert result.status == "repaired"
        assert info["total_episodes"] == 2
        assert info["total_frames"] == 3
        assert info["splits"] == {"train": "0:2"}
        # Original must be untouched.
        assert original["total_episodes"] == 0
        assert original["total_frames"] == 0

    def test_structure_incomplete_writes_missing_metadata(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "structure_incomplete"
        _write_info(dataset_dir, total_episodes=1, total_frames=3)
        _write_parquet(dataset_dir, [0, 0, 0])
        _write_video(dataset_dir)
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            integrity_status=IntegrityStatus.STRUCTURE_INCOMPLETE,
            damage_kind=DamageKind.MISSING_METADATA,
            repair_strategy=RepairStrategy.FORMALIZE_DATA_EPISODES,
            repairable=True,
            details={"n_parquet_rows": 3},
        )
        output_dir = tmp_path / "structure_incomplete_out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.status == "repaired"
        assert (output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet").is_file()
        assert (output_dir / "meta" / "stats.json").is_file()
        assert (output_dir / "calibration" / "manifest.json").is_file()

    def test_structure_incomplete_formalizes_orphan_episode_without_copying_data(
        self,
        tmp_path: Path,
    ) -> None:
        dataset_dir = tmp_path / "orphan_episode"
        _write_info(dataset_dir, total_episodes=1, total_frames=2)
        _write_parquet(dataset_dir, [0, 0, 1, 1, 1])
        _write_video(dataset_dir)
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            integrity_status=IntegrityStatus.STRUCTURE_INCOMPLETE,
            damage_kind=DamageKind.ORPHAN_DATA_EPISODES,
            repair_strategy=RepairStrategy.FORMALIZE_DATA_EPISODES,
            repairable=True,
            details={"n_parquet_rows": 5, "data_episode_counts": {0: 2, 1: 3}},
        )
        output_dir = tmp_path / "orphan_episode_out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        info = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        episodes = pq.read_table(output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet").to_pylist()
        original = json.loads((dataset_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        assert result.status == "repaired"
        assert info["total_episodes"] == 2
        assert info["total_frames"] == 5
        assert [row["episode_index"] for row in episodes] == [0, 1]
        assert [row["length"] for row in episodes] == [2, 3]
        assert (output_dir / "data" / "chunk-000" / "file-000.parquet").is_symlink()
        assert not (output_dir / "meta" / "info.json").is_symlink()
        assert original["total_episodes"] == 1
        assert original["total_frames"] == 2
