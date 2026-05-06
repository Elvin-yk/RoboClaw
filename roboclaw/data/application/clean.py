from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any

from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.repairers import repair_dataset
from roboclaw.data.repair.types import DamageType

from .jobs import DataJobCoordinator, DataJobHandle
from .serialization import json_ready


class DataCleanService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def start_run(
        self,
        *,
        dataset_ids: list[str],
        task: str,
        vcodec: str,
        force: bool,
    ) -> dict[str, Any]:
        if not dataset_ids:
            raise ValueError("dataset_ids must not be empty")
        target_id = ",".join(dataset_ids)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            results: list[dict[str, Any]] = []
            for index, dataset_id in enumerate(dataset_ids, start=1):
                if handle.cancelled:
                    break
                await handle.update(processed=index - 1, message=f"Cleaning {dataset_id}")
                result = await asyncio.to_thread(
                    self._clean_dataset,
                    dataset_id,
                    task=task,
                    vcodec=vcodec,
                    force=force,
                )
                results.append(result)
                await handle.item(result)
                await handle.update(processed=index, message=f"Cleaned {dataset_id}")
            return {"datasets": results}

        job = self.jobs.start(
            kind="clean",
            target_type="dataset",
            target_id=target_id,
            total=len(dataset_ids),
            message="Queued data clean run",
            runner=runner,
        )
        return job.to_dict()

    def update_dataset_gate(
        self,
        *,
        dataset_id: str,
        gate_key: str,
        status: str,
        message: str,
        details: dict[str, Any],
    ) -> dict[str, Any]:
        path = self.repository.resolve_dataset_path(dataset_id)
        state = self.repository.state_store.set_gate(
            path,
            object_type="dataset",
            key=gate_key,
            status=status,
            message=message,
            details=details,
        )
        if gate_key == "review" and status == "passed":
            state = self.repository.state_store.set_dataset_stage(path, "clean")
        if gate_key == "review" and status in {"failed", "needs_review"}:
            state = self.repository.state_store.set_dataset_stage(path, "needs_review")
        return {"dataset": self.repository.read_dataset(dataset_id).to_dict(), "state": state}

    def _clean_dataset(self, dataset_id: str, *, task: str, vcodec: str, force: bool) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        self.repository.state_store.set_dataset_stage(dataset_path, "inspecting")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="running",
            message="Inspecting dataset artifacts",
        )
        diagnosis = diagnose_dataset(dataset_path)
        diagnosis_payload = {
            "damage_type": diagnosis.damage_type.value,
            "repairable": diagnosis.repairable,
            "details": json_ready(diagnosis.details),
        }
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="passed",
            message="Inspection completed",
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="diagnose",
            status="passed",
            message=diagnosis.damage_type.value,
            details=diagnosis_payload,
        )

        if diagnosis.damage_type == DamageType.HEALTHY:
            self.repository.state_store.set_gate(
                dataset_path,
                object_type="dataset",
                key="clean",
                status="passed",
                message="Dataset is already clean",
                details=diagnosis_payload,
            )
            self.repository.state_store.set_gate(
                dataset_path,
                object_type="dataset",
                key="review",
                status="passed",
                message="No manual review required",
            )
            self.repository.state_store.set_dataset_stage(dataset_path, "clean")
            return {"dataset_id": dataset_id, "outcome": "clean", "diagnosis": diagnosis_payload}

        if not diagnosis.repairable:
            self.repository.state_store.set_gate(
                dataset_path,
                object_type="dataset",
                key="clean",
                status="failed",
                message="Dataset is not automatically repairable",
                details=diagnosis_payload,
            )
            self.repository.state_store.set_gate(
                dataset_path,
                object_type="dataset",
                key="review",
                status="needs_review",
                message="Manual review required",
            )
            self.repository.state_store.set_dataset_stage(dataset_path, "needs_review")
            return {"dataset_id": dataset_id, "outcome": "needs_review", "diagnosis": diagnosis_payload}

        self.repository.state_store.set_dataset_stage(dataset_path, "cleaning")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="running",
            message="Repairing dataset",
            details=diagnosis_payload,
        )
        output_dir = dataset_path.with_name(f".{dataset_path.name}.cleaning")
        result = repair_dataset(
            diagnosis,
            task=task,
            vcodec=vcodec,
            dry_run=False,
            force=force,
            output_dir=output_dir,
        )
        result_payload = {
            "damage_type": result.damage_type.value if result.damage_type else None,
            "outcome": result.outcome,
            "error": result.error,
        }
        if result.outcome != "repaired":
            if output_dir.exists():
                shutil.rmtree(output_dir)
            self.repository.state_store.set_gate(
                dataset_path,
                object_type="dataset",
                key="clean",
                status="failed",
                message=result.error or result.outcome,
                details=result_payload,
            )
            self.repository.state_store.set_dataset_stage(dataset_path, "needs_review")
            return {"dataset_id": dataset_id, "outcome": "needs_review", "diagnosis": diagnosis_payload, "repair": result_payload}

        self._replace_dataset(dataset_path, output_dir)
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="passed",
            message="Repair completed",
            details=result_payload,
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="review",
            status="passed",
            message="Automatic repair verified",
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "clean")
        return {"dataset_id": dataset_id, "outcome": "clean", "diagnosis": diagnosis_payload, "repair": result_payload}

    def _replace_dataset(self, dataset_path: Path, output_dir: Path) -> None:
        state_dir = dataset_path / ".data"
        preserved_state = output_dir / ".data"
        if preserved_state.exists():
            shutil.rmtree(preserved_state)
        if state_dir.exists():
            shutil.copytree(state_dir, preserved_state)
        backup_dir = dataset_path.with_name(f".{dataset_path.name}.replace_backup")
        if backup_dir.exists():
            shutil.rmtree(backup_dir)
        dataset_path.rename(backup_dir)
        output_dir.rename(dataset_path)
        shutil.rmtree(backup_dir)
