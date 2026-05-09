from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

from roboclaw.data.domain.models import Dataset
from roboclaw.data.infrastructure.filesystem import DataRepository

from .jobs import DataJobCoordinator, DataJobHandle


class DataLibraryService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def list_datasets(self) -> list[dict[str, Any]]:
        return [dataset.to_dict() for dataset in self.repository.list_datasets()]

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        return self.repository.read_dataset(dataset_id).to_dict()

    def delete_dataset(self, dataset_id: str) -> dict[str, str]:
        self.repository.delete_dataset(dataset_id)
        return {"status": "deleted", "dataset_id": dataset_id}

    def start_import(
        self,
        *,
        dataset_id: str,
        include_videos: bool,
        force: bool,
    ) -> dict[str, Any]:
        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            await handle.update(message="Downloading dataset snapshot")
            dataset = await asyncio.to_thread(
                self._import_remote_dataset,
                dataset_id,
                include_videos=include_videos,
                force=force,
            )
            await handle.item({"dataset_id": dataset.id, "path": str(dataset.path)})
            return {"dataset": dataset.to_dict()}

        job = self.jobs.start(
            kind="import",
            target_type="dataset",
            target_id=dataset_id,
            total=1,
            message="Queued dataset import",
            runner=runner,
        )
        return job.to_dict()

    def _import_remote_dataset(
        self,
        dataset_id: str,
        *,
        include_videos: bool,
        force: bool,
    ) -> Dataset:
        target = self.repository.root / dataset_id
        target = target.resolve()
        target.relative_to(self.repository.root.resolve())
        target.parent.mkdir(parents=True, exist_ok=True)
        if force and target.exists():
            shutil.rmtree(target)

        from huggingface_hub import snapshot_download

        patterns = ["meta/**", "README*"]
        if include_videos:
            patterns.append("videos/**")
        snapshot_download(
            repo_id=dataset_id,
            repo_type="dataset",
            local_dir=str(target),
            allow_patterns=patterns,
        )
        state = self.repository.state_store.load_dataset_state(target)
        self.repository.state_store.write_dataset_state(target, state)
        return self.repository.read_dataset(dataset_id)
