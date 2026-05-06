from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.infrastructure.state_store import utc_now_iso

PACKAGE_DATA_PATH = "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet"
PACKAGE_VIDEO_PATH = "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4"


class DatasetPackageService:
    def __init__(self, repository: DataRepository) -> None:
        self.repository = repository

    def list_packages(self) -> list[dict[str, Any]]:
        return [package.to_dict() for package in self.repository.list_packages()]

    def get_package(self, package_id: str) -> dict[str, Any]:
        return self.repository.read_package(package_id).to_dict()

    def create_package(
        self,
        *,
        package_id: str,
        dataset_ids: list[str],
        groups: dict[str, list[str]],
        force: bool,
    ) -> dict[str, Any]:
        if not dataset_ids:
            raise ValueError("dataset_ids must not be empty")
        package_path = self.repository.package_path_for_create(package_id)
        if package_path.exists() and force:
            shutil.rmtree(package_path)
        if package_path.exists():
            raise FileExistsError(f"DatasetPackage '{package_id}' already exists")
        dataset_paths = [self.repository.resolve_dataset_path(dataset_id) for dataset_id in dataset_ids]
        for dataset_id, dataset_path in zip(dataset_ids, dataset_paths):
            dataset = self.repository._dataset_from_path(dataset_id, dataset_path)
            if dataset.stage != "clean":
                raise ValueError(f"Dataset '{dataset_id}' must be clean before packaging")

        package_path.mkdir(parents=True)
        self._materialize_package(package_path, dataset_ids, dataset_paths)
        state = self.repository.state_store.load_package_state(package_path)
        state.update({
            "object_type": "package",
            "lifecycle_stage": "assembled",
            "dataset_ids": dataset_ids,
            "groups": groups,
        })
        gates = state["gates"]
        gates["assemble"]["status"] = "passed"
        gates["assemble"]["message"] = "Package materialized"
        gates["assemble"]["updated_at"] = utc_now_iso()
        self.repository.state_store.write_package_state(package_path, state)
        return self.repository.read_package(package_id).to_dict()

    def update_package_gate(
        self,
        *,
        package_id: str,
        gate_key: str,
        status: str,
        message: str,
        details: dict[str, Any],
    ) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        state = self.repository.state_store.set_gate(
            path,
            object_type="package",
            key=gate_key,
            status=status,
            message=message,
            details=details,
        )
        return {"package": self.repository.read_package(package_id).to_dict(), "state": state}

    def _materialize_package(
        self,
        package_path: Path,
        dataset_ids: list[str],
        dataset_paths: list[Path],
    ) -> None:
        (package_path / "meta").mkdir(parents=True, exist_ok=True)
        (package_path / "sources").mkdir(parents=True, exist_ok=True)
        manifest: list[dict[str, Any]] = []
        output_chunks_size = self._first_chunks_size(dataset_paths)
        frame_index = 0
        parquet_file_index = 0
        copied_video_count = 0
        combined_info: dict[str, Any] = {
            "codebase_version": "roboclaw-data-package-v1",
            "robot_type": "",
            "fps": 0,
            "features": {},
            "total_episodes": 0,
            "total_frames": 0,
            "total_videos": 0,
            "chunks_size": output_chunks_size,
            "data_path": PACKAGE_DATA_PATH,
            "video_path": PACKAGE_VIDEO_PATH,
            "source_dataset_ids": dataset_ids,
            "episode_lengths": [],
            "splits": {"train": "0:0"},
        }
        combined_episodes: list[dict[str, Any]] = []
        next_episode_index = 0
        for dataset_id, dataset_path in zip(dataset_ids, dataset_paths):
            source_slug = self._safe_slug(dataset_id)
            source_root = package_path / "sources" / source_slug
            shutil.copytree(dataset_path, source_root, ignore=shutil.ignore_patterns(".data", ".workflow"))
            info = self._read_json(dataset_path / "meta" / "info.json")
            episodes = self._read_episode_meta(dataset_path, info)
            if not combined_info["robot_type"]:
                combined_info["robot_type"] = info.get("robot_type", "")
            if not combined_info["fps"]:
                combined_info["fps"] = int(info.get("fps", 0) or 0)
            features = info.get("features")
            if isinstance(features, dict):
                combined_info["features"].update(features)
            normalized_episodes = self._normalize_episode_meta(info, episodes)
            episode_index_map = {
                int(entry["episode_index"]): next_episode_index + index
                for index, entry in enumerate(normalized_episodes)
            }
            data_file_by_source_episode, frame_index, parquet_file_index = self._materialize_parquet_data(
                package_path=package_path,
                dataset_path=dataset_path,
                info=info,
                episodes=normalized_episodes,
                episode_index_map=episode_index_map,
                frame_index=frame_index,
                parquet_file_index=parquet_file_index,
                output_chunks_size=output_chunks_size,
            )
            for index, entry in enumerate(normalized_episodes):
                source_episode_index = int(entry["episode_index"])
                package_episode_index = next_episode_index + index
                length = int(entry.get("length", 0) or 0)
                package_frame_start = int(combined_info["total_frames"])
                package_entry = {
                    **entry,
                    **self._package_data_pointer(data_file_by_source_episode.get(source_episode_index)),
                    "episode_index": package_episode_index,
                    "source_dataset_id": dataset_id,
                    "source_episode_index": source_episode_index,
                    "dataset_from_index": package_frame_start,
                    "dataset_to_index": package_frame_start + length,
                }
                video_pointers = self._copy_episode_videos(
                    package_path=package_path,
                    dataset_path=dataset_path,
                    info=info,
                    source_episode=entry,
                    package_episode_index=package_episode_index,
                    output_chunks_size=output_chunks_size,
                )
                copied_video_count += len(video_pointers)
                package_entry.update(video_pointers)
                combined_episodes.append(package_entry)
                next_episode_index += 1
                combined_info["total_frames"] += length
                combined_info["episode_lengths"].append(length)
            manifest.append({
                "dataset_id": dataset_id,
                "path": str(dataset_path),
                "source_root": f"sources/{source_slug}",
                "episodes": len(normalized_episodes),
            })
        combined_info["total_episodes"] = len(combined_episodes)
        combined_info["total_videos"] = copied_video_count
        combined_info["splits"] = {"train": f"0:{len(combined_episodes)}"}
        (package_path / "meta" / "info.json").write_text(
            json.dumps(combined_info, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self._write_jsonl(package_path / "meta" / "episodes.jsonl", combined_episodes)
        (package_path / "meta" / "package_sources.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _read_episode_meta(self, dataset_path: Path, info: dict[str, Any]) -> list[dict[str, Any]]:
        jsonl_rows = self._read_jsonl(dataset_path / "meta" / "episodes.jsonl")
        if jsonl_rows:
            return jsonl_rows
        rows = self._read_parquet_rows(dataset_path / "meta" / "episodes")
        if rows:
            return rows
        return [
            {"episode_index": index, "length": 0}
            for index in range(int(info.get("total_episodes", 0) or 0))
        ]

    def _normalize_episode_meta(self, info: dict[str, Any], episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if episodes:
            return [
                {
                    **entry,
                    "episode_index": int(entry.get("episode_index", index) or index),
                    "length": int(entry.get("length", 0) or 0),
                }
                for index, entry in enumerate(sorted(episodes, key=lambda item: int(item.get("episode_index", 0) or 0)))
            ]
        return [
            {"episode_index": index, "length": 0}
            for index in range(int(info.get("total_episodes", 0) or 0))
        ]

    def _materialize_parquet_data(
        self,
        *,
        package_path: Path,
        dataset_path: Path,
        info: dict[str, Any],
        episodes: list[dict[str, Any]],
        episode_index_map: dict[int, int],
        frame_index: int,
        parquet_file_index: int,
        output_chunks_size: int,
    ) -> tuple[dict[int, tuple[int, int]], int, int]:
        data_files = sorted((dataset_path / "data").rglob("*.parquet"))
        data_file_by_episode: dict[int, tuple[int, int]] = {}
        for source_file in data_files:
            rows = self._read_parquet_table_rows(source_file)
            if not rows:
                continue
            source_episode = self._infer_source_episode_for_parquet(dataset_path, info, episodes, source_file)
            chunk_index = parquet_file_index // output_chunks_size
            file_index = parquet_file_index % output_chunks_size
            remapped_rows: list[dict[str, Any]] = []
            for row in rows:
                row_episode = self._coerce_episode_index(row.get("episode_index"), source_episode)
                if row_episode not in episode_index_map:
                    raise ValueError(f"Data parquet '{source_file}' references unknown episode {row_episode}")
                mapped_episode = episode_index_map[row_episode]
                row["episode_index"] = mapped_episode
                if "index" in row:
                    row["index"] = frame_index
                if "task_index" in row:
                    row["task_index"] = int(row.get("task_index", 0) or 0)
                frame_index += 1
                data_file_by_episode[row_episode] = (chunk_index, file_index)
                remapped_rows.append(row)
            output_file = package_path / PACKAGE_DATA_PATH.format(chunk_index=chunk_index, file_index=file_index)
            self._write_parquet_rows(output_file, remapped_rows)
            parquet_file_index += 1
        return data_file_by_episode, frame_index, parquet_file_index

    def _copy_episode_videos(
        self,
        *,
        package_path: Path,
        dataset_path: Path,
        info: dict[str, Any],
        source_episode: dict[str, Any],
        package_episode_index: int,
        output_chunks_size: int,
    ) -> dict[str, Any]:
        pointers: dict[str, Any] = {}
        source_episode_index = int(source_episode.get("episode_index", package_episode_index) or 0)
        chunk_index = package_episode_index // output_chunks_size
        file_index = package_episode_index % output_chunks_size
        for video_key in self._video_feature_keys(info):
            source_path = self._source_video_path(dataset_path, info, source_episode, video_key, source_episode_index)
            if not source_path.is_file():
                continue
            target_path = package_path / PACKAGE_VIDEO_PATH.format(
                video_key=video_key,
                chunk_index=chunk_index,
                file_index=file_index,
            )
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, target_path)
            prefix = f"videos/{video_key}/"
            pointers[f"{prefix}chunk_index"] = chunk_index
            pointers[f"{prefix}file_index"] = file_index
            for suffix in ("from_timestamp", "to_timestamp"):
                value = source_episode.get(f"{prefix}{suffix}", source_episode.get(f"video_{suffix}"))
                if value is not None:
                    pointers[f"{prefix}{suffix}"] = value
        return pointers

    def _source_video_path(
        self,
        dataset_path: Path,
        info: dict[str, Any],
        episode: dict[str, Any],
        video_key: str,
        episode_index: int,
    ) -> Path:
        source_chunks_size = int(info.get("chunks_size", 1000) or 1000)
        prefix = f"videos/{video_key}/"
        chunk_index = int(
            episode.get(f"{prefix}chunk_index", episode.get("video_chunk_index", episode_index // source_chunks_size))
            or 0
        )
        file_index = int(
            episode.get(f"{prefix}file_index", episode.get("video_file_index", episode_index % source_chunks_size))
            or 0
        )
        rendered = self._render_path_template(
            info.get("video_path") or PACKAGE_VIDEO_PATH,
            video_key=video_key,
            chunk_index=chunk_index,
            file_index=file_index,
            episode_index=episode_index,
            chunks_size=source_chunks_size,
        )
        return dataset_path / (rendered or PACKAGE_VIDEO_PATH.format(
            video_key=video_key,
            chunk_index=chunk_index,
            file_index=file_index,
        ))

    def _infer_source_episode_for_parquet(
        self,
        dataset_path: Path,
        info: dict[str, Any],
        episodes: list[dict[str, Any]],
        source_file: Path,
    ) -> int | None:
        relative = source_file.relative_to(dataset_path).as_posix()
        source_chunks_size = int(info.get("chunks_size", 1000) or 1000)
        for episode in episodes:
            episode_index = int(episode.get("episode_index", 0) or 0)
            chunk_index = int(
                episode.get("data/chunk_index", episode.get("data_chunk_index", episode_index // source_chunks_size))
                or 0
            )
            file_index = int(
                episode.get("data/file_index", episode.get("data_file_index", episode_index % source_chunks_size))
                or 0
            )
            rendered = self._render_path_template(
                info.get("data_path") or PACKAGE_DATA_PATH,
                chunk_index=chunk_index,
                file_index=file_index,
                episode_index=episode_index,
                chunks_size=source_chunks_size,
            )
            if rendered == relative:
                return episode_index
        return None

    def _package_data_pointer(self, pointer: tuple[int, int] | None) -> dict[str, int]:
        if pointer is None:
            return {}
        chunk_index, file_index = pointer
        return {"data/chunk_index": chunk_index, "data/file_index": file_index}

    def _first_chunks_size(self, dataset_paths: list[Path]) -> int:
        for dataset_path in dataset_paths:
            info = self._read_json(dataset_path / "meta" / "info.json")
            value = int(info.get("chunks_size", 0) or 0)
            if value > 0:
                return value
        return 1000

    def _video_feature_keys(self, info: dict[str, Any]) -> list[str]:
        features = info.get("features") or {}
        return [
            str(key)
            for key, config in features.items()
            if isinstance(config, dict) and config.get("dtype") == "video"
        ]

    def _read_parquet_rows(self, root: Path) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        if root.is_file() and root.suffix == ".parquet":
            rows.extend(self._read_parquet_table_rows(root))
        elif root.is_dir():
            for path in sorted(root.rglob("*.parquet")):
                rows.extend(self._read_parquet_table_rows(path))
        return rows

    def _read_parquet_table_rows(self, path: Path) -> list[dict[str, Any]]:
        import pyarrow.parquet as pq

        return pq.read_table(path).to_pylist()

    def _write_parquet_rows(self, path: Path, rows: list[dict[str, Any]]) -> None:
        import pyarrow as pa
        import pyarrow.parquet as pq

        path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(rows), path)

    def _coerce_episode_index(self, value: Any, fallback: int | None) -> int:
        if value is None:
            if fallback is None:
                raise ValueError("Parquet row has no episode_index and source episode cannot be inferred")
            return fallback
        return int(value)

    def _render_path_template(
        self,
        template: str,
        *,
        chunk_index: int,
        file_index: int,
        episode_index: int,
        chunks_size: int,
        video_key: str | None = None,
    ) -> str | None:
        values = {
            "chunk_index": chunk_index,
            "file_index": file_index,
            "episode_index": episode_index,
            "episode_chunk": episode_index // max(chunks_size, 1),
            "episode_file": episode_index % max(chunks_size, 1),
            "video_key": video_key or "",
        }
        try:
            return template.format(**values)
        except KeyError:
            return None

    def _write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> None:
        path.write_text(
            "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + ("\n" if rows else ""),
            encoding="utf-8",
        )

    def _safe_slug(self, value: str) -> str:
        return "".join(ch if ch.isalnum() or ch in {"-", "_"} else "_" for ch in value).strip("_") or "dataset"
