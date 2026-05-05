"""Tests for ``DatasetRepairService`` output-dir semantics.

These cover the rules introduced in Phase 3:

- in-place damage types repair against ``output_dir`` only — original is left
  untouched,
- ``force=False`` against an existing ``output_dir`` is a no-op skip,
- HEALTHY/EMPTY_SHELL early-returns must not create ``output_dir``,
- dry-run must not create ``output_dir``,
- ``force=True`` against an existing ``output_dir`` overwrites cleanly.
"""

from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from roboclaw.data.repair.repairers import DatasetRepairService, prepare_output_dir
from roboclaw.data.repair.types import DamageType, DiagnosisResult, TmpVideo


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


def _meta_stale_diagnosis(dataset_dir: Path) -> DiagnosisResult:
    return DiagnosisResult(
        dataset_dir=dataset_dir,
        damage_type=DamageType.META_STALE,
        repairable=True,
        details={"n_parquet_rows": 3},
    )


class TestPrepareOutputDir:
    def test_force_replaces_existing_directory(self, tmp_path: Path) -> None:
        target = tmp_path / "existing"
        target.mkdir()
        (target / "marker").write_text("old", encoding="utf-8")

        proceed = prepare_output_dir(target, force=True)

        assert proceed is True
        assert not target.exists()

    def test_no_force_blocks_existing_directory(self, tmp_path: Path) -> None:
        target = tmp_path / "existing"
        target.mkdir()
        (target / "marker").write_text("keep", encoding="utf-8")

        proceed = prepare_output_dir(target, force=False)

        assert proceed is False
        assert (target / "marker").read_text(encoding="utf-8") == "keep"

    def test_absent_target_proceeds(self, tmp_path: Path) -> None:
        target = tmp_path / "absent"

        proceed = prepare_output_dir(target, force=False)

        assert proceed is True
        assert not target.exists()


class TestDatasetRepairServiceOutputDir:
    def test_in_place_damage_writes_only_to_output_dir(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, [0, 0, 1])
        _write_video(dataset_dir, 0)
        _write_video(dataset_dir, 1)
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        out_info = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        src_info = json.loads((dataset_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        assert out_info["total_frames"] == 3
        assert src_info["total_frames"] == 0  # original untouched

    def test_existing_output_dir_without_force_skips(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, [0])
        _write_video(dataset_dir)
        output_dir = tmp_path / "out"
        output_dir.mkdir()
        (output_dir / "guard").write_text("dont touch", encoding="utf-8")

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "skipped"
        assert "already exists" in (result.error or "")
        assert (output_dir / "guard").read_text(encoding="utf-8") == "dont touch"

    def test_existing_output_dir_with_force_replaces(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, [0, 0, 1])
        _write_video(dataset_dir, 0)
        _write_video(dataset_dir, 1)
        output_dir = tmp_path / "out"
        output_dir.mkdir()
        (output_dir / "stale").write_text("delete me", encoding="utf-8")

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=True,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        assert not (output_dir / "stale").exists()

    def test_healthy_does_not_create_output_dir(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        dataset_dir.mkdir()
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=DamageType.HEALTHY,
            repairable=True,
            details={},
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "healthy"
        assert not output_dir.exists()

    def test_empty_shell_does_not_create_output_dir(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        dataset_dir.mkdir()
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=DamageType.EMPTY_SHELL,
            repairable=False,
            details={},
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "skipped"
        assert not output_dir.exists()

    def test_unrepairable_does_not_create_output_dir(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        dataset_dir.mkdir()
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=DamageType.META_STALE,
            repairable=False,
            details={"n_parquet_rows": 0},
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "skipped"
        assert result.error == "unrepairable"
        assert not output_dir.exists()

    def test_dry_run_does_not_create_output_dir(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, [0])
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=True,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "skipped"
        assert result.error == "dry run"
        assert not output_dir.exists()

    def test_in_place_repair_strips_source_repair_status(self, tmp_path: Path) -> None:
        """Cleaned artifact must not inherit the source's repair_status.json."""
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, [0, 0, 1])
        _write_video(dataset_dir, 0)
        _write_video(dataset_dir, 1)
        # Pre-populate the source with a stale status that would survive copytree.
        (dataset_dir / "meta" / "repair_status.json").write_text(
            json.dumps({"schema_version": 1, "tag": "dirty"}),
            encoding="utf-8",
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        assert not (output_dir / "meta" / "repair_status.json").exists()
        # Source's status file is unchanged (Phase 3 does not touch the source disk).
        assert (dataset_dir / "meta" / "repair_status.json").exists()

    def test_in_place_repair_strips_top_level_tmp_dirs(self, tmp_path: Path) -> None:
        """Top-level ``tmp*/`` scratch dirs in the source must not survive into
        the cleaned artifact.
        """
        dataset_dir = tmp_path / "src"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, [0, 0, 1])
        _write_video(dataset_dir, 0)
        _write_video(dataset_dir, 1)
        tmp_dir = dataset_dir / "tmpxyz"
        tmp_dir.mkdir()
        (tmp_dir / "leftover.mp4").write_bytes(b"mp4")
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        assert not (output_dir / "tmpxyz").exists()
        # Source unchanged.
        assert (dataset_dir / "tmpxyz" / "leftover.mp4").exists()

    def test_meta_stale_drops_missing_video_keys(self, tmp_path: Path) -> None:
        """If info declares a video key with no mp4 anywhere, META_STALE repair
        drops the key so verify_repaired_dataset doesn't reject the result.
        """
        dataset_dir = tmp_path / "src"
        meta_dir = dataset_dir / "meta"
        meta_dir.mkdir(parents=True)
        info = {
            "total_episodes": 0,
            "total_frames": 0,
            "fps": 30,
            "features": {
                "observation.images.front": {"dtype": "video", "shape": [4, 4, 3], "names": None},
                "observation.images.missing": {"dtype": "video", "shape": [4, 4, 3], "names": None},
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        }
        (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")
        _write_parquet(dataset_dir, [0, 0, 0])
        _write_video(dataset_dir, 0)
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            _meta_stale_diagnosis(dataset_dir),
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        cleaned = json.loads((output_dir / "meta" / "info.json").read_text(encoding="utf-8"))
        assert "observation.images.missing" not in cleaned["features"]
        assert "observation.images.front" in cleaned["features"]

    def test_partial_tmp_videos_stuck_moves_recoverable_to_canonical(self, tmp_path: Path) -> None:
        """Recoverable tmp videos are copied to their canonical
        videos/<key>/chunk-000/file-000.mp4 location.
        """
        dataset_dir = tmp_path / "src"
        meta_dir = dataset_dir / "meta"
        meta_dir.mkdir(parents=True)
        info = {
            "total_episodes": 0,
            "total_frames": 0,
            "fps": 30,
            "features": {
                "observation.images.front": {"dtype": "video", "shape": [4, 4, 3], "names": None},
                "observation.images.side": {"dtype": "video", "shape": [4, 4, 3], "names": None},
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        }
        (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")
        _write_parquet(dataset_dir, [0, 0, 0])
        _write_video(dataset_dir, 0)  # only 'front' canonical
        tmp_dir = dataset_dir / "tmpxyz"
        tmp_dir.mkdir()
        side_mp4 = tmp_dir / "observation.images.side_000.mp4"
        side_mp4.write_bytes(b"sidempfourdata")
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=DamageType.PARTIAL_TMP_VIDEOS_STUCK,
            repairable=True,
            details={
                "n_parquet_rows": 3,
                "recoverable_tmp_videos": [
                    TmpVideo(
                        video_key="observation.images.side",
                        path=side_mp4,
                        episode_index=0,
                    ),
                ],
            },
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        assert result.outcome == "repaired"
        canonical_side = (
            output_dir / "videos" / "observation.images.side" / "chunk-000" / "file-000.mp4"
        )
        assert canonical_side.exists()
        assert canonical_side.read_bytes() == b"sidempfourdata"
        # Source's tmp dir is untouched.
        assert side_mp4.exists()
        # Cleaned artifact's tmp dir was scrubbed.
        assert not (output_dir / "tmpxyz").exists()

    def test_partial_tmp_videos_stuck_writes_each_episode_for_batch_naming(
        self, tmp_path: Path
    ) -> None:
        """Two ``<key>_<NNN>.mp4`` files for the same camera land at distinct
        canonical episodes (000, 001).
        """
        dataset_dir = tmp_path / "src"
        meta_dir = dataset_dir / "meta"
        meta_dir.mkdir(parents=True)
        info = {
            "total_episodes": 0,
            "total_frames": 0,
            "fps": 30,
            "features": {
                "observation.images.side": {"dtype": "video", "shape": [4, 4, 3], "names": None},
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        }
        (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")
        _write_parquet(dataset_dir, [0, 0, 0])
        # No canonical for 'side' — both episodes are stuck in tmp dirs.
        tmp0 = dataset_dir / "tmpaaa"
        tmp0.mkdir()
        (tmp0 / "observation.images.side_000.mp4").write_bytes(b"ep0")
        tmp1 = dataset_dir / "tmpbbb"
        tmp1.mkdir()
        (tmp1 / "observation.images.side_001.mp4").write_bytes(b"ep1")
        diagnosis = DiagnosisResult(
            dataset_dir=dataset_dir,
            damage_type=DamageType.PARTIAL_TMP_VIDEOS_STUCK,
            repairable=True,
            details={
                "n_parquet_rows": 3,
                "recoverable_tmp_videos": [
                    TmpVideo(
                        video_key="observation.images.side",
                        path=tmp0 / "observation.images.side_000.mp4",
                        episode_index=0,
                    ),
                    TmpVideo(
                        video_key="observation.images.side",
                        path=tmp1 / "observation.images.side_001.mp4",
                        episode_index=1,
                    ),
                ],
            },
        )
        output_dir = tmp_path / "out"

        result = DatasetRepairService().repair(
            diagnosis,
            task="task",
            vcodec="h264",
            dry_run=False,
            force=False,
            output_dir=output_dir,
        )

        # The parquet has only one episode, so verify will reject any second
        # canonical episode that doesn't exist; result is "failed" but the
        # canonical files have still been written, which is what we're testing.
        ep0 = output_dir / "videos" / "observation.images.side" / "chunk-000" / "file-000.mp4"
        ep1 = output_dir / "videos" / "observation.images.side" / "chunk-000" / "file-001.mp4"
        assert ep0.exists() and ep0.read_bytes() == b"ep0"
        assert ep1.exists() and ep1.read_bytes() == b"ep1"
        # And the result either repaired or failed-on-verify depending on parquet,
        # but the file relocation must have happened.
        assert result.outcome in {"repaired", "failed"}
