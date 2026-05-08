from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from roboclaw.data.infrastructure.filesystem import DataRepository

from .jobs import DataJobCoordinator, DataJobHandle


class DataAnnotationService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def workspace(self, *, package_id: str, episode_index: int) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        package = self.repository.read_package(package_id)
        return {
            "package": package.to_dict(),
            "episode_index": episode_index,
            "episode": self._episode_meta(path, episode_index),
            "annotations": self._load_annotation(path, episode_index),
            "prototypes": self._load_json(path / ".data" / "annotation" / "prototypes" / "latest.json", default={}),
            "propagation": self._load_json(path / ".data" / "annotation" / "propagation" / "latest.json", default={}),
        }

    def save_annotations(
        self,
        *,
        package_id: str,
        episode_index: int,
        task_context: dict[str, Any],
        annotations: list[dict[str, Any]],
    ) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        payload = {
            "package_id": package_id,
            "episode_index": episode_index,
            "task_context": task_context,
            "annotations": annotations,
        }
        target = self._annotation_path(path, episode_index)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        self.repository.state_store.set_gate(
            path,
            object_type="package",
            key="annotate",
            status="running",
            message="Annotations saved",
        )
        self.repository.state_store.set_package_stage(path, "annotating")
        return payload

    def start_prototype_run(
        self,
        *,
        package_id: str,
        cluster_count: int | None,
        candidate_limit: int,
        episode_indices: list[int] | None,
        quality_filter_mode: str,
    ) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            indices = episode_indices or self._episode_indices(path)
            limited = indices[: max(1, candidate_limit)]
            count = cluster_count or min(8, max(1, len(limited)))
            prototypes = [
                {
                    "prototype_id": f"prototype_{index + 1}",
                    "episode_index": episode_index,
                    "quality_filter_mode": quality_filter_mode,
                }
                for index, episode_index in enumerate(limited[:count])
            ]
            payload = {"package_id": package_id, "prototypes": prototypes, "candidate_count": len(limited)}
            await asyncio.to_thread(self._write_json, path / ".data" / "annotation" / "prototypes" / "latest.json", payload)
            await handle.update(processed=len(limited), message="Prototype discovery completed")
            return payload

        job = self.jobs.start(
            kind="prototype",
            target_type="package",
            target_id=package_id,
            total=len(episode_indices or self._episode_indices(path)),
            message="Queued prototype discovery",
            runner=runner,
        )
        return job.to_dict()

    def start_propagation_run(self, *, package_id: str, source_episode_index: int) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            source = self._load_annotation(path, source_episode_index)
            annotations = source.get("annotations", [])
            task_context = source.get("task_context", {})
            propagated: list[int] = []
            for index, episode_index in enumerate(self._episode_indices(path), start=1):
                if episode_index == source_episode_index or handle.cancelled:
                    continue
                payload = {
                    "package_id": package_id,
                    "episode_index": episode_index,
                    "source_episode_index": source_episode_index,
                    "task_context": task_context,
                    "annotations": annotations,
                }
                self._annotation_path(path, episode_index).parent.mkdir(parents=True, exist_ok=True)
                self._annotation_path(path, episode_index).write_text(
                    json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                propagated.append(episode_index)
                await handle.item({"episode_index": episode_index})
                await handle.update(processed=index, message=f"Propagated episode {episode_index}")
            result = {
                "package_id": package_id,
                "source_episode_index": source_episode_index,
                "propagated_episode_indices": propagated,
            }
            self._write_json(path / ".data" / "annotation" / "propagation" / "latest.json", result)
            self.repository.state_store.set_gate(
                path,
                object_type="package",
                key="annotate",
                status="passed",
                message="Semantic annotations propagated",
                details={"propagated": len(propagated)},
            )
            self.repository.state_store.set_package_stage(path, "annotated")
            return result

        job = self.jobs.start(
            kind="propagation",
            target_type="package",
            target_id=package_id,
            total=len(self._episode_indices(path)),
            message="Queued semantic propagation",
            runner=runner,
        )
        return job.to_dict()

    def _episode_indices(self, package_path: Path) -> list[int]:
        return [int(row.get("episode_index", index) or index) for index, row in enumerate(self._episodes(package_path))]

    def _episodes(self, package_path: Path) -> list[dict[str, Any]]:
        path = package_path / "meta" / "episodes.jsonl"
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _episode_meta(self, package_path: Path, episode_index: int) -> dict[str, Any]:
        for row in self._episodes(package_path):
            if int(row.get("episode_index", -1) or -1) == episode_index:
                return row
        return {"episode_index": episode_index}

    def _annotation_path(self, package_path: Path, episode_index: int) -> Path:
        return package_path / ".data" / "annotations" / f"ep_{episode_index}.json"

    def _load_annotation(self, package_path: Path, episode_index: int) -> dict[str, Any]:
        return self._load_json(
            self._annotation_path(package_path, episode_index),
            default={"episode_index": episode_index, "task_context": {}, "annotations": []},
        )

    def _load_json(self, path: Path, *, default: dict[str, Any]) -> dict[str, Any]:
        if not path.is_file():
            return default
        return json.loads(path.read_text(encoding="utf-8"))

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
