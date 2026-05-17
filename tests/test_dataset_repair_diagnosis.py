from __future__ import annotations

import json
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.types import DamageKind, IntegrityStatus, RepairStrategy


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
    pq.write_table(pa.table({"task_index": [0], "task": ["task"]}), meta_dir / "tasks.parquet")
    calibration_dir = dataset_dir / "calibration" / "bimanual_followers"
    calibration_dir.mkdir(parents=True, exist_ok=True)
    (calibration_dir / "bimanual_left.json").write_text("{}", encoding="utf-8")
    (calibration_dir / "bimanual_right.json").write_text("{}", encoding="utf-8")


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


def _write_complete_metadata(dataset_dir: Path, *, length: int = 3) -> None:
    meta_dir = dataset_dir / "meta"
    (meta_dir / "stats.json").write_text("{}", encoding="utf-8")
    episodes_dir = meta_dir / "episodes" / "chunk-000"
    episodes_dir.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.table({
            "episode_index": [0],
            "tasks": [["task"]],
            "length": [length],
            "data/chunk_index": [0],
            "data/file_index": [0],
            "dataset_from_index": [0],
            "dataset_to_index": [length],
            "videos/observation.images.front/chunk_index": [0],
            "videos/observation.images.front/file_index": [0],
            "videos/observation.images.front/from_timestamp": [0.0],
            "videos/observation.images.front/to_timestamp": [length / 30],
        }),
        episodes_dir / "file-000.parquet",
    )
    manifest = {
        "schema_version": 1,
        "entries": [
            {"relative_path": "bimanual_followers/bimanual_left.json"},
            {"relative_path": "bimanual_followers/bimanual_right.json"},
        ],
    }
    (dataset_dir / "calibration" / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


class TestDatasetDiagnosis:
    def test_tmp_videos_without_parquet_is_incomplete(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "tmp_stuck"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_recovery(dataset_dir, 2)
        tmp_dir = dataset_dir / "tmpabc"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_000.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.repairable is False

    def test_plain_dataset_with_tmp_videos_is_incomplete(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_tmp_stuck"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        tmp_dir = dataset_dir / "tmpabc"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_000.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.repairable is False
        assert diagnosis.details["n_tmp_videos"] == 1

    def test_plain_dataset_ignores_recovery_frame_mismatch(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_with_recovery_artifacts"
        _write_info(dataset_dir, total_frames=3)
        _write_recovery(dataset_dir, 4)
        _write_images(dataset_dir, 3)
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir)
        _write_complete_metadata(dataset_dir)

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.HEALTHY

    def test_plain_dataset_ignores_cp_log(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "plain_missing_cp"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, 3)
        _write_images(dataset_dir, 3)
        _write_video(dataset_dir)
        _write_complete_metadata(dataset_dir)
        (dataset_dir.parent / "plain_missing_cp.log").write_text(
            "[CP] END at episode 0, frame 2 (segment: 1-2, 1 frames, status=success)\n",
            encoding="utf-8",
        )

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.HEALTHY

    def test_unmatched_structure_error_is_unknown_damage(self, tmp_path: Path) -> None:
        dataset_dir = tmp_path / "unknown_damage"
        _write_info(dataset_dir)
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir)
        _write_complete_metadata(dataset_dir)
        (dataset_dir / "meta" / "stats.json").write_text("{bad-json", encoding="utf-8")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.damage_kind is DamageKind.UNKNOWN_DAMAGE
        assert diagnosis.repair_strategy is RepairStrategy.NONE
        assert diagnosis.repairable is False

    def test_missing_camera_video_with_tmp_details_is_incomplete(self, tmp_path: Path) -> None:
        """Two declared cameras, one has its mp4 in videos/, the other only has
        a tmp file matching its key. The top-level diagnosis stays incomplete.
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

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.repairable is True
        assert diagnosis.details["n_recoverable_tmp_videos"] == 1
        recoverable = diagnosis.details["recoverable_tmp_videos"]
        assert [tmp.video_key for tmp in recoverable] == ["observation.images.side"]
        assert recoverable[0].episode_index == 0

    def test_streaming_tmp_with_canonical_present_is_incomplete(
        self, tmp_path: Path
    ) -> None:
        """A ``<key>_streaming.mp4`` whose canonical mp4 already exists is
        garbage residue; the top-level diagnosis stays incomplete.
        """
        dataset_dir = tmp_path / "streaming_with_canonical"
        _write_info(dataset_dir, total_episodes=0, total_frames=0)
        _write_parquet(dataset_dir, 3)
        _write_video(dataset_dir)
        tmp_dir = dataset_dir / "tmpzzz"
        tmp_dir.mkdir(parents=True)
        (tmp_dir / "observation.images.front_streaming.mp4").write_bytes(b"mp4")

        diagnosis = diagnose_dataset(dataset_dir)

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.details["n_recoverable_tmp_videos"] == 0
        # The streaming filename is parsed correctly even though it isn't recoverable.
        assert {tmp.video_key for tmp in diagnosis.details["tmp_videos"]} == {
            "observation.images.front",
        }

    def test_streaming_tmp_with_missing_canonical_is_recoverable(
        self, tmp_path: Path
    ) -> None:
        """A ``<key>_streaming.mp4`` whose canonical doesn't exist is what the
        ``rec_20260422`` style of damage looks like. The top-level diagnosis is
        incomplete, with tmp details preserved for debugging.
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

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
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

        assert diagnosis.integrity_status is IntegrityStatus.STRUCTURE_INCOMPLETE
        assert diagnosis.details["n_tmp_videos"] == 2
        assert diagnosis.details["n_recoverable_tmp_videos"] == 2
        assert {tmp.video_key for tmp in diagnosis.details["recoverable_tmp_videos"]} == {
            "observation.images.right_front",
            "observation.images.right_wrist",
        }
