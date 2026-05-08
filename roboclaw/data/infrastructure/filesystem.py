from __future__ import annotations

import json
import shutil
from pathlib import Path, PurePosixPath
from typing import Any, Callable

from roboclaw.data.domain.models import Dataset, DatasetPackage, DatasetStats, Gate
from roboclaw.data.paths import datasets_root

from .state_store import DataStateStore


class DataRepository:
    def __init__(
        self,
        root_resolver: Callable[[], Path] | None = None,
        state_store: DataStateStore | None = None,
    ) -> None:
        self._root_resolver = root_resolver or datasets_root
        self.state_store = state_store or DataStateStore()

    @property
    def root(self) -> Path:
        return self._root_resolver().expanduser()

    @property
    def packages_root(self) -> Path:
        return self.root / "packages"

    def list_datasets(self) -> list[Dataset]:
        root = self.root
        if not root.is_dir():
            return []
        return [self.read_dataset(dataset_id) for dataset_id, _path in self._iter_dataset_entries()]

    def read_dataset(self, dataset_id: str) -> Dataset:
        path = self.resolve_dataset_path(dataset_id)
        return self._dataset_from_path(dataset_id, path)

    def delete_dataset(self, dataset_id: str) -> None:
        path = self.resolve_dataset_path(dataset_id)
        shutil.rmtree(path)

    def list_packages(self) -> list[DatasetPackage]:
        if not self.packages_root.is_dir():
            return []
        packages = [
            self.read_package(entry.name)
            for entry in sorted(self.packages_root.iterdir())
            if entry.is_dir() and self._is_package_dir(entry)
        ]
        return sorted(packages, key=lambda item: item.id)

    def read_package(self, package_id: str) -> DatasetPackage:
        path = self.resolve_package_path(package_id)
        return self._package_from_path(package_id, path)

    def resolve_dataset_path(self, dataset_id: str) -> Path:
        safe = self._safe_relative(dataset_id)
        root = self.root.resolve()
        candidates = [(self.root / safe.as_posix()).resolve()]
        if "/" not in dataset_id:
            candidates.append((self.root / "local" / dataset_id).resolve())
        for candidate in candidates:
            candidate.relative_to(root)
            if self._is_dataset_dir(candidate):
                return candidate
        raise FileNotFoundError(f"Dataset '{dataset_id}' not found")

    def resolve_package_path(self, package_id: str) -> Path:
        safe = self._safe_relative(package_id)
        if len(safe.parts) != 1:
            raise ValueError(f"Invalid package id: {package_id!r}")
        path = (self.packages_root / safe.as_posix()).resolve()
        path.relative_to(self.packages_root.resolve())
        if not self._is_package_dir(path):
            raise FileNotFoundError(f"DatasetPackage '{package_id}' not found")
        return path

    def package_path_for_create(self, package_id: str) -> Path:
        safe = self._safe_relative(package_id)
        if len(safe.parts) != 1:
            raise ValueError(f"Invalid package id: {package_id!r}")
        path = (self.packages_root / safe.as_posix()).resolve()
        path.relative_to(self.packages_root.resolve())
        return path

    def _iter_dataset_entries(self) -> list[tuple[str, Path]]:
        root = self.root
        if not root.is_dir():
            return []
        entries: list[tuple[str, Path]] = []
        for entry in sorted(root.iterdir()):
            if not entry.is_dir() or entry.name == "packages":
                continue
            if self._is_dataset_dir(entry):
                entries.append((entry.relative_to(root).as_posix(), entry))
                continue
            for child in sorted(entry.iterdir()):
                if child.is_dir() and self._is_dataset_dir(child):
                    entries.append((child.relative_to(root).as_posix(), child))
        return entries

    def _dataset_from_path(self, dataset_id: str, path: Path) -> Dataset:
        info = self._read_info(path)
        state = self.state_store.load_dataset_state(path)
        return Dataset(
            id=dataset_id,
            name=path.name,
            label=path.name if dataset_id.startswith("local/") else dataset_id,
            path=path,
            real_path=path.resolve(),
            stage=state["lifecycle_stage"],
            stats=self._stats_from_info(path, info),
            gates={key: Gate(**gate) for key, gate in state["gates"].items()},
            updated_at=str(state.get("updated_at") or ""),
        )

    def _package_from_path(self, package_id: str, path: Path) -> DatasetPackage:
        info = self._read_info(path)
        state = self.state_store.load_package_state(path)
        return DatasetPackage(
            id=package_id,
            name=path.name,
            label=path.name,
            path=path,
            real_path=path.resolve(),
            dataset_ids=[str(item) for item in state.get("dataset_ids") or []],
            groups={
                str(key): [str(item) for item in value]
                for key, value in (state.get("groups") or {}).items()
            },
            stage=state["lifecycle_stage"],
            stats=self._stats_from_info(path, info),
            gates={key: Gate(**gate) for key, gate in state["gates"].items()},
            evaluation_summary=dict(state.get("evaluation_summary") or {}),
            updated_at=str(state.get("updated_at") or ""),
        )

    def _read_info(self, root: Path) -> dict[str, Any]:
        path = root / "meta" / "info.json"
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _stats_from_info(self, root: Path, info: dict[str, Any]) -> DatasetStats:
        episode_lengths: list[int] = []
        episodes_path = root / "meta" / "episodes.jsonl"
        if episodes_path.is_file():
            for raw_line in episodes_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if line:
                    payload = json.loads(line)
                    episode_lengths.append(int(payload.get("length", 0) or 0))
        return DatasetStats(
            total_episodes=int(info.get("total_episodes", 0) or 0),
            total_frames=int(info.get("total_frames", 0) or 0),
            fps=int(info.get("fps", 0) or 0),
            robot_type=str(info.get("robot_type", "")),
            features=tuple((info.get("features") or {}).keys()),
            episode_lengths=tuple(episode_lengths),
            task_description=self._task_description(root, info),
        )

    def _task_description(self, root: Path, info: dict[str, Any]) -> str:
        info_text = self._task_text(info)
        if info_text:
            return info_text
        tasks_path = root / "meta" / "tasks.jsonl"
        if not tasks_path.is_file():
            return ""
        for raw_line in tasks_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line:
                continue
            task_text = self._task_text(json.loads(line))
            if task_text:
                return task_text
        return ""

    def _task_text(self, payload: dict[str, Any]) -> str:
        for key in ("task_description", "task", "description", "task_desc"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        tasks = payload.get("tasks")
        if isinstance(tasks, list):
            return self._first_task_list_text(tasks)
        if isinstance(tasks, dict):
            return self._task_text(tasks)
        return ""

    def _first_task_list_text(self, tasks: list[Any]) -> str:
        for item in tasks:
            if isinstance(item, str) and item.strip():
                return item.strip()
            if isinstance(item, dict):
                task_text = self._task_text(item)
                if task_text:
                    return task_text
        return ""

    def _is_dataset_dir(self, path: Path) -> bool:
        return path.is_dir() and (path / "meta" / "info.json").is_file()

    def _is_package_dir(self, path: Path) -> bool:
        return self._is_dataset_dir(path) and self.state_store.load_package_state(path).get("object_type") == "package"

    def _safe_relative(self, value: str) -> PurePosixPath:
        path = PurePosixPath(value.strip())
        if (
            not value.strip()
            or path.is_absolute()
            or any(part in {"", ".", ".."} for part in path.parts)
        ):
            raise ValueError(f"Invalid data id: {value!r}")
        return path
