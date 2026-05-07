from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.types import DamageType


def _write_info(dataset_dir: Path, **overrides: object) -> None:
    info = {
        "total_episodes": 1,
        "total_frames": 3,
        "fps": 30,
        "features": {
            "observation.images.front": {
                "dtype": "video",
                "shape": [64, 64, 3],
                "names": ["height", "width", "channel"],
            },
            "observation.state": {"dtype": "float32", "shape": [2], "names": None},
            "episode_index": {"dtype": "int64", "shape": [1], "names": None},
        },
    }
    info.update(overrides)
    meta_dir = dataset_dir / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    (meta_dir / "info.json").write_text(json.dumps(info), encoding="utf-8")


def _write_rlt_info(dataset_dir: Path, **overrides: object) -> None:
    _write_info(
        dataset_dir,
        rlt_episode_metadata_fields={
            "rl_intervals": "List of {start_frame, end_frame, outcome} for each RL phase.",
            "human_intervention_intervals": "List of {start_frame, end_frame} for each human intervention segment.",
        },
        **overrides,
    )


def _write_recovery(dataset_dir: Path, count: int) -> None:
    rows = [json.dumps({"observation.state": [float(index), float(index + 1)]}) for index in range(count)]
    (dataset_dir / "recovery_frames.jsonl").write_text("\n".join(rows) + "\n", encoding="utf-8")


def _write_images(dataset_dir: Path, count: int, camera: str = "observation.images.front") -> None:
    image_dir = dataset_dir / "images" / camera / "episode-000000"
    image_dir.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        Image.new("RGB", (8, 8), (index, index, index)).save(image_dir / f"frame-{index:06d}.png")


def _write_parquet(dataset_dir: Path, rows: int, episodes: list[int] | None = None) -> None:
    if episodes is None:
        episodes = [0] * rows
    data_dir = dataset_dir / "data" / "chunk-000"
    data_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "episode_index": episodes,
            "observation.state": [[0.0, 1.0] for _ in episodes],
        }
    )
    pq.write_table(table, data_dir / "file-000.parquet")


def _write_video(dataset_dir: Path, episode_index: int = 0, camera: str = "observation.images.front") -> None:
    video_dir = dataset_dir / "videos" / camera / "chunk-000"
    video_dir.mkdir(parents=True, exist_ok=True)
    (video_dir / f"file-{episode_index:03d}.mp4").write_bytes(b"mp4")


class TestDatasetDiagnosis:
    def test_tmp_videos_stuck_wins_before_crash_no_save(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "tmp_stuck"
        _write_rlt_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_recovery(dataset_dir, 2)
        tmp_dir = dataset_dir / "tmpabc"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_000.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.TMP_VIDEOS_STUCK
        assert diagnosis.repairable is True

    def test_plain_dataset_detects_tmp_videos_stuck_without_recovery(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_tmp_stuck"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        tmp_dir = dataset_dir / "tmpabc"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_000.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.TMP_VIDEOS_STUCK
        assert diagnosis.repairable is False
        assert diagnosis.details["records_critical_phase_intervals"] is False
        assert diagnosis.details["n_recovery_lines"] == 0
        assert diagnosis.details["n_tmp_videos"] == 1

    def test_missing_cp_detected_from_log_when_data_present(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "missing_cp"
        _write_rlt_info(dataset_dir)
        _write_parquet(dataset_dir, 3)
        _write_images(dataset_dir, 3)
        _write_video(dataset_dir)
        (dataset_dir.parent / "missing_cp.log").write_text(
            "[CP] END at episode 0, frame 2 (segment: 1-2, 1 frames, outcome=success)\n",
            encoding="utf-8",
        )

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.MISSING_CP
        assert diagnosis.details["n_log_cp"] == 1

    def test_frame_mismatch_uses_smallest_available_count(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "frame_mismatch"
        _write_rlt_info(dataset_dir, total_frames=4)
        _write_recovery(dataset_dir, 4)
        _write_images(dataset_dir, 3)
        _write_parquet(dataset_dir, 2)
        _write_video(dataset_dir)

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.FRAME_MISMATCH
        assert diagnosis.details["truncate_target_frames"] == 2

    def test_plain_dataset_ignores_recovery_frame_mismatch(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_with_recovery_artifacts"
        _write_info(dataset_dir, total_frames=3)
        _write_recovery(dataset_dir, 4)
        _write_images(dataset_dir, 3)
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir)

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.HEALTHY
        assert diagnosis.details["records_critical_phase_intervals"] is False
        assert diagnosis.details["n_recovery_lines"] == 0

    def test_plain_dataset_ignores_cp_log(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_missing_cp"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, 3)
        _write_images(dataset_dir, 3)
        _write_video(dataset_dir)
        (dataset_dir.parent / "plain_missing_cp.log").write_text(
            "[CP] END at episode 0, frame 2 (segment: 1-2, 1 frames, outcome=success)\n",
            encoding="utf-8",
        )

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.HEALTHY
        assert diagnosis.details["records_critical_phase_intervals"] is False
        assert diagnosis.details["log_path"] is None

    def test_partial_tmp_videos_stuck_when_one_camera_missing_video(self, tmp_path: Path) -> None:
        """Two declared cameras, one has its mp4 in videos/, the other only has
        a tmp file matching its key. Should classify as PARTIAL_TMP_VIDEOS_STUCK.
        """
        dataset_dir = tmp_path / "partial_stuck"
        _write_info(
            dataset_dir,
            total_episodes=0,
            total_frames=0,
            features={
                "observation.images.front": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.images.side": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        )
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir, camera="observation.images.front")
        tmp_dir = dataset_dir / "tmpabc"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.side_000.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.PARTIAL_TMP_VIDEOS_STUCK
        assert diagnosis.repairable is True
        assert diagnosis.details["n_recoverable_tmp_videos"] == 1
        recoverable = diagnosis.details["recoverable_tmp_videos"]
        assert [tmp.video_key for tmp in recoverable] == ["observation.images.side"]
        assert recoverable[0].episode_index == 0

    def test_streaming_tmp_with_canonical_present_falls_back_to_meta_stale(
        self, tmp_path: Path
    ) -> None:
        """A ``<key>_streaming.mp4`` whose canonical mp4 already exists is
        garbage (residue from a finalized episode); the dataset still
        classifies as META_STALE because info totals are stale.
        """
        dataset_dir = tmp_path / "streaming_with_canonical"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir)
        tmp_dir = dataset_dir / "tmpzzz"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_streaming.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.META_STALE
        assert diagnosis.details["n_recoverable_tmp_videos"] == 0
        # The streaming filename is parsed correctly even though it isn't recoverable.
        assert {tmp.video_key for tmp in diagnosis.details["tmp_videos"]} == {
            "observation.images.front",
        }

    def test_streaming_tmp_with_missing_canonical_is_recoverable(
        self, tmp_path: Path
    ) -> None:
        """A ``<key>_streaming.mp4`` whose canonical doesn't exist is what the
        ``rec_20260422`` style of damage looks like: PARTIAL_TMP_VIDEOS_STUCK,
        with the streaming file's video_key parsed by stripping ``_streaming``.
        """
        dataset_dir = tmp_path / "streaming_missing_canonical"
        _write_info(
            dataset_dir,
            total_episodes=0,
            total_frames=0,
            features={
                "observation.images.front": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.images.right_front": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        )
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir, camera="observation.images.front")
        tmp_dir = dataset_dir / "tmploht2yz9"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.right_front_streaming.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.PARTIAL_TMP_VIDEOS_STUCK
        recoverable = diagnosis.details["recoverable_tmp_videos"]
        assert [tmp.video_key for tmp in recoverable] == ["observation.images.right_front"]
        assert recoverable[0].episode_index is None  # streaming pattern carries no episode

    def test_multiple_tmp_dirs_for_multiple_cameras(self, tmp_path: Path) -> None:
        """Real-world scenario: 3 declared cameras, 1 has its canonical mp4
        and the other 2 each left their own ``tmp*/`` dir. ``find_tmp_videos``
        must return both stuck files; ``find_recoverable_tmp_videos`` keeps
        both because their canonicals are missing.
        """
        dataset_dir = tmp_path / "multi_tmp"
        _write_info(
            dataset_dir,
            total_episodes=0,
            total_frames=0,
            features={
                "observation.images.front": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.images.right_front": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.images.right_wrist": {
                    "dtype": "video",
                    "shape": [64, 64, 3],
                    "names": ["height", "width", "channel"],
                },
                "observation.state": {"dtype": "float32", "shape": [2], "names": None},
                "episode_index": {"dtype": "int64", "shape": [1], "names": None},
            },
        )
        _write_parquet(dataset_dir, 5)
        _write_video(dataset_dir, camera="observation.images.front")
        for tmp_name, key in (
            ("tmpzl1tmnp3", "observation.images.right_front"),
            ("tmpfm6tjx_i", "observation.images.right_wrist"),
        ):
            tmp_dir = dataset_dir / tmp_name
            tmp_dir.mkdir(parents=True)
            (tmp_dir / f"{key}_streaming.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.damage_type is DamageType.PARTIAL_TMP_VIDEOS_STUCK
        assert diagnosis.details["n_tmp_videos"] == 2
        assert diagnosis.details["n_recoverable_tmp_videos"] == 2
        assert {tmp.video_key for tmp in diagnosis.details["recoverable_tmp_videos"]} == {
            "observation.images.right_front",
            "observation.images.right_wrist",
        }
