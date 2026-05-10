from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4

from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.infrastructure.state_store import utc_now_iso
from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.repairers import repair_dataset
from roboclaw.data.repair.types import DamageType

from .jobs import DataJobCoordinator, DataJobHandle
from .serialization import json_ready


class DataCleanService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def start_auto_clean_run(
        self,
        *,
        dataset_ids: list[str],
        chain_id: str = "default",
        task: str = "",
        vcodec: str = "libx264",
        force: bool = True,
    ) -> dict[str, Any]:
        if not dataset_ids:
            raise ValueError("dataset_ids must not be empty")
        target_id = ",".join(dataset_ids)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            results: list[dict[str, Any]] = []
            for index, dataset_id in enumerate(dataset_ids, start=1):
                if handle.cancelled:
                    break
                await handle.update(processed=index - 1, message=f"Auto cleaning {dataset_id}")
                result = await asyncio.to_thread(
                    self._auto_clean_dataset,
                    dataset_id,
                    chain_id=chain_id,
                    task=task,
                    vcodec=vcodec,
                    force=force,
                )
                results.append(result)
                await handle.item(result)
                await handle.update(processed=index, message=f"Auto clean finished for {dataset_id}")
            return {"datasets": results}

        job = self.jobs.start(
            kind="auto_clean",
            target_type="dataset",
            target_id=target_id,
            total=len(dataset_ids),
            message="Queued automatic cleaning run",
            runner=runner,
        )
        return job.to_dict()

    def start_diagnosis_run(self, *, dataset_ids: list[str]) -> dict[str, Any]:
        if not dataset_ids:
            raise ValueError("dataset_ids must not be empty")
        target_id = ",".join(dataset_ids)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            results: list[dict[str, Any]] = []
            for index, dataset_id in enumerate(dataset_ids, start=1):
                if handle.cancelled:
                    break
                await handle.update(processed=index - 1, message=f"Diagnosing {dataset_id}")
                result = await asyncio.to_thread(self._diagnose_dataset, dataset_id)
                results.append(result)
                await handle.item(result)
                await handle.update(processed=index, message=f"Diagnosed {dataset_id}")
            return {"datasets": results}

        job = self.jobs.start(
            kind="diagnose",
            target_type="dataset",
            target_id=target_id,
            total=len(dataset_ids),
            message="Queued data diagnosis run",
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
            self.repository.state_store.set_dataset_active_output(
                path,
                {"kind": "source", "dataset_id": dataset_id},
            )
            state = self.repository.state_store.set_dataset_stage(path, "clean")
        if gate_key == "review" and status in {"failed", "needs_review"}:
            next_stage = "excluded" if status == "failed" else "needs_review"
            state = self.repository.state_store.set_dataset_stage(path, next_stage)
        return {"dataset": self.repository.read_dataset(dataset_id).to_dict(), "state": state}

    def start_manual_review_session(
        self,
        *,
        dataset_id: str,
        chain_id: str = "default",
    ) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        run = self._start_qc_run(
            dataset_path,
            dataset_id=dataset_id,
            lane="manual_review",
            chain_id=chain_id,
        )
        return {"run_id": run["run_id"], "session": run, "dataset": self.repository.read_dataset(dataset_id).to_dict()}

    def save_manual_review_decision(
        self,
        *,
        session_id: str,
        decision: str,
        message: str,
        details: dict[str, Any],
    ) -> dict[str, Any]:
        if decision not in {"passed", "rejected", "needs_rework"}:
            raise ValueError("decision must be passed, rejected, or needs_rework")
        dataset_id, dataset_path = self._find_dataset_run(session_id)
        run = self.repository.state_store.load_dataset_run(dataset_path, session_id)
        gate_status = {
            "passed": "passed",
            "rejected": "failed",
            "needs_rework": "needs_review",
        }[decision]
        stage = {
            "passed": "clean",
            "rejected": "excluded",
            "needs_rework": "needs_review",
        }[decision]
        decision_payload = {
            "decision": decision,
            "message": message,
            "details": details,
            "decided_at": utc_now_iso(),
        }
        run["status"] = "completed"
        run["decision"] = decision_payload
        run["updated_at"] = utc_now_iso()
        self.repository.state_store.write_dataset_run(dataset_path, run)
        self.repository.state_store.append_dataset_event(
            dataset_path,
            {"type": "manual_review_decision", "run_id": session_id, **decision_payload},
        )
        self.repository.state_store.set_dataset_qc_lane(
            dataset_path,
            lane="manual_review",
            payload={
                "status": gate_status,
                "chain_id": run["chain_id"],
                "last_run_id": session_id,
                "decision": decision_payload,
            },
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="review",
            status=gate_status,
            message=message or f"Manual review {decision}",
            details=decision_payload,
        )
        if decision == "passed":
            state = self.repository.state_store.load_dataset_state(dataset_path)
            if state.get("active_output", {}).get("kind") != "artifact":
                self.repository.state_store.set_dataset_active_output(
                    dataset_path,
                    {"kind": "source", "dataset_id": dataset_id},
                )
        self.repository.state_store.set_dataset_stage(dataset_path, stage)
        return {"session": run, "dataset": self.repository.read_dataset(dataset_id).to_dict()}

    def get_qc_run(self, *, dataset_id: str, run_id: str) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        return json_ready(self.repository.state_store.load_dataset_run(dataset_path, run_id))

    def _diagnose_dataset(self, dataset_id: str) -> dict[str, Any]:
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
        diagnosis_payload = self._diagnosis_payload(diagnosis)
        self.repository.state_store.write_dataset_report(
            dataset_path,
            category="diagnosis",
            name=f"{uuid4().hex}.json",
            payload=diagnosis_payload,
        )
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
        self.repository.state_store.set_dataset_stage(dataset_path, "raw")
        return {"dataset_id": dataset_id, "diagnosis": diagnosis_payload}

    def _auto_clean_dataset(
        self,
        dataset_id: str,
        *,
        chain_id: str,
        task: str,
        vcodec: str,
        force: bool,
    ) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        run = self._start_qc_run(
            dataset_path,
            dataset_id=dataset_id,
            lane="auto_clean",
            chain_id=chain_id,
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "inspecting")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="running",
            message="Inspecting dataset artifacts",
        )
        diagnosis = diagnose_dataset(dataset_path)
        diagnosis_payload = self._diagnosis_payload(diagnosis)
        self.repository.state_store.write_dataset_report(
            dataset_path,
            category="diagnosis",
            name=f"{run['run_id']}.json",
            payload=diagnosis_payload,
        )
        self._record_qc_step(dataset_path, run, {
            "id": "empty_dataset_check",
            "status": "failed" if diagnosis.damage_type == DamageType.EMPTY_SHELL else "passed",
            "message": diagnosis.damage_type.value,
            "details": diagnosis_payload,
        })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="passed",
            message="Inspection completed",
        )
        if diagnosis.damage_type == DamageType.EMPTY_SHELL:
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="empty_dataset_check",
                message="empty_dataset_check failed: no valid frames",
                diagnosis_payload=diagnosis_payload,
            )

        self._record_qc_step(dataset_path, run, {
            "id": "damage_diagnosis",
            "status": "passed",
            "message": diagnosis.damage_type.value,
            "details": diagnosis_payload,
        })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="diagnose",
            status="passed",
            message=diagnosis.damage_type.value,
            details=diagnosis_payload,
        )

        if diagnosis.damage_type == DamageType.HEALTHY:
            active_output = {"kind": "source", "dataset_id": dataset_id}
            self.repository.state_store.set_dataset_active_output(dataset_path, active_output)
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
                status="skipped",
                message="No manual review required",
            )
            self.repository.state_store.set_dataset_stage(dataset_path, "clean")
            self._record_qc_step(dataset_path, run, {
                "id": "repair_if_possible",
                "status": "skipped",
                "message": "Dataset is already clean",
            })
            self._finish_qc_run(dataset_path, run, status="completed", output=active_output)
            return {"dataset_id": dataset_id, "outcome": "clean", "diagnosis": diagnosis_payload}

        if not diagnosis.repairable:
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_if_possible",
                message=f"repair_if_possible failed: {diagnosis.damage_type.value} is not repairable",
                diagnosis_payload=diagnosis_payload,
            )

        self.repository.state_store.set_dataset_stage(dataset_path, "cleaning")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="running",
            message="Repairing dataset",
            details=diagnosis_payload,
        )
        output_dir = self._artifact_dataset_path(dataset_path, run["run_id"])
        output_dir.parent.mkdir(parents=True, exist_ok=True)
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
        self._record_qc_step(dataset_path, run, {
            "id": "repair_if_possible",
            "status": "passed" if result.outcome == "repaired" else "failed",
            "message": result.error or result.outcome,
            "details": result_payload,
        })
        if result.outcome != "repaired":
            if output_dir.exists():
                shutil.rmtree(output_dir)
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_if_possible",
                message=f"repair_if_possible failed: {result.error or result.outcome}",
                diagnosis_payload=diagnosis_payload,
                extra_details={"repair": result_payload},
            )

        verify_diagnosis = diagnose_dataset(output_dir)
        verify_payload = self._diagnosis_payload(verify_diagnosis)
        if verify_diagnosis.damage_type != DamageType.HEALTHY:
            self._record_qc_step(dataset_path, run, {
                "id": "repair_verify",
                "status": "failed",
                "message": verify_diagnosis.damage_type.value,
                "details": verify_payload,
            })
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_verify",
                message=f"repair_verify failed: {verify_diagnosis.damage_type.value}",
                diagnosis_payload=diagnosis_payload,
                extra_details={"repair": result_payload, "verify": verify_payload},
            )

        self._mark_cleaned_output(output_dir, {**result_payload, "verify": verify_payload})
        active_output = {
            "kind": "artifact",
            "run_id": run["run_id"],
            "relative_path": output_dir.relative_to(dataset_path).as_posix(),
            "path": str(output_dir),
        }
        self.repository.state_store.set_dataset_active_output(dataset_path, active_output)
        self._record_qc_step(dataset_path, run, {
            "id": "repair_verify",
            "status": "passed",
            "message": "Repair output verified",
            "details": verify_payload,
        })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="passed",
            message=f"Repair completed: {active_output['relative_path']}",
            details={**result_payload, "verify": verify_payload, "active_output": active_output},
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="review",
            status="skipped",
            message="Automatic repair verified",
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "clean")
        self._finish_qc_run(dataset_path, run, status="completed", output=active_output)
        return {
            "dataset_id": dataset_id,
            "active_output": active_output,
            "outcome": "clean",
            "diagnosis": diagnosis_payload,
            "repair": result_payload,
        }

    def _diagnosis_payload(self, diagnosis: Any) -> dict[str, Any]:
        return {
            "damage_type": diagnosis.damage_type.value,
            "repairable": diagnosis.repairable,
            "details": json_ready(diagnosis.details),
        }

    def _artifact_dataset_path(self, dataset_path: Path, run_id: str) -> Path:
        output_dir = (dataset_path / ".status" / "artifacts" / run_id / "dataset").resolve()
        output_dir.relative_to(dataset_path.resolve())
        return output_dir

    def _mark_cleaned_output(self, output_dir: Path, repair_payload: dict[str, Any]) -> None:
        state = self.repository.state_store.load_dataset_state(output_dir)
        state["lifecycle_stage"] = "clean"
        state["active_output"] = {"kind": "source"}
        for key in ("inspect", "diagnose", "clean", "review"):
            state["gates"][key]["status"] = "passed"
            state["gates"][key]["message"] = "Recovered dataset ready"
            state["gates"][key]["details"] = repair_payload
        self.repository.state_store.write_dataset_state(output_dir, state)

    def _start_qc_run(
        self,
        dataset_path: Path,
        *,
        dataset_id: str,
        lane: str,
        chain_id: str,
    ) -> dict[str, Any]:
        now = utc_now_iso()
        run = {
            "run_id": uuid4().hex,
            "dataset_id": dataset_id,
            "lane": lane,
            "chain_id": chain_id,
            "status": "running",
            "started_at": now,
            "updated_at": now,
            "steps": [],
        }
        self.repository.state_store.write_dataset_run(dataset_path, run)
        self.repository.state_store.append_dataset_event(dataset_path, {
            "type": "qc_run_started",
            "run_id": run["run_id"],
            "lane": lane,
            "chain_id": chain_id,
        })
        self.repository.state_store.set_dataset_qc_lane(
            dataset_path,
            lane=lane,
            payload={"status": "running", "chain_id": chain_id, "last_run_id": run["run_id"]},
        )
        return run

    def _record_qc_step(self, dataset_path: Path, run: dict[str, Any], step: dict[str, Any]) -> None:
        payload = {"updated_at": utc_now_iso(), **step}
        run.setdefault("steps", []).append(payload)
        run["updated_at"] = payload["updated_at"]
        self.repository.state_store.write_dataset_run(dataset_path, run)
        self.repository.state_store.append_dataset_event(dataset_path, {
            "type": "qc_step_recorded",
            "run_id": run["run_id"],
            "lane": run["lane"],
            "step": payload,
        })

    def _finish_qc_run(
        self,
        dataset_path: Path,
        run: dict[str, Any],
        *,
        status: str,
        output: dict[str, Any] | None = None,
        failure: dict[str, Any] | None = None,
    ) -> None:
        run["status"] = status
        run["updated_at"] = utc_now_iso()
        if output is not None:
            run["output"] = output
        if failure is not None:
            run["failure"] = failure
        self.repository.state_store.write_dataset_run(dataset_path, run)
        self.repository.state_store.append_dataset_event(dataset_path, {
            "type": "qc_run_finished",
            "run_id": run["run_id"],
            "lane": run["lane"],
            "status": status,
            "output": output or {},
            "failure": failure or {},
        })
        lane_payload: dict[str, Any] = {
            "status": status,
            "chain_id": run["chain_id"],
            "last_run_id": run["run_id"],
        }
        if output is not None:
            lane_payload["output"] = output
        if failure is not None:
            lane_payload["failure"] = failure
        self.repository.state_store.set_dataset_qc_lane(
            dataset_path,
            lane=run["lane"],
            payload=lane_payload,
        )

    def _fail_auto_clean(
        self,
        dataset_id: str,
        dataset_path: Path,
        run: dict[str, Any],
        *,
        step_id: str,
        message: str,
        diagnosis_payload: dict[str, Any],
        extra_details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        details = {"diagnosis": diagnosis_payload, **(extra_details or {})}
        if not any(step.get("id") == step_id and step.get("status") == "failed" for step in run.get("steps", [])):
            self._record_qc_step(dataset_path, run, {
                "id": step_id,
                "status": "failed",
                "message": message,
                "details": details,
            })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="failed",
            message=message,
            details=details,
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="review",
            status="needs_review",
            message="Manual review required",
            details={"auto_clean_run_id": run["run_id"], **details},
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "needs_review")
        failure = {"step_id": step_id, "message": message, "details": details}
        self._finish_qc_run(dataset_path, run, status="failed", failure=failure)
        return {
            "dataset_id": dataset_id,
            "outcome": "needs_review",
            "failure": failure,
            "diagnosis": diagnosis_payload,
        }

    def _find_dataset_run(self, run_id: str) -> tuple[str, Path]:
        for dataset in self.repository.list_datasets():
            dataset_path = self.repository.resolve_dataset_path(dataset.id)
            if self.repository.state_store.run_path(dataset_path, run_id).is_file():
                return dataset.id, dataset_path
        raise FileNotFoundError(f"Manual review session '{run_id}' not found")
