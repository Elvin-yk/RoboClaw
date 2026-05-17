from __future__ import annotations

import asyncio
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import uuid4

from roboclaw.data.cleaning import LeadingStaticTrimConfig, LeadingStaticTrimService
from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.infrastructure.state_store import utc_now_iso
from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.repairers import repair_dataset
from roboclaw.data.repair.types import IntegrityStatus, RepairStatus, RepairStrategy

from .jobs import DataJobCoordinator, DataJobHandle
from .serialization import json_ready


class DataCleanService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs
        self.leading_static_trim = LeadingStaticTrimService()

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
                    cancelled=lambda: handle.cancelled,
                )
                results.append(result)
                await handle.item(result)
                if result.get("status") == "cancelled":
                    break
                await handle.update(processed=index, message=f"Auto clean finished for {dataset_id}")
                if handle.cancelled:
                    break
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

    def get_qc_run(self, *, dataset_id: str, run_id: str) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        return json_ready(self.repository.state_store.load_dataset_run(dataset_path, run_id))

    def _diagnose_dataset(self, dataset_id: str) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        input_path = self.repository.dataset_materialized_path(dataset_id)
        self.repository.state_store.set_dataset_stage(dataset_path, "inspecting")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="running",
            message="Inspecting dataset artifacts",
        )
        diagnosis = diagnose_dataset(input_path)
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
            message=diagnosis.damage_kind.value,
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
        cancelled: Callable[[], bool],
    ) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        input_path = self.repository.dataset_materialized_path(dataset_id)
        run = self._start_qc_run(
            dataset_path,
            dataset_id=dataset_id,
            lane="auto_clean",
            chain_id=chain_id,
        )
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        self.repository.state_store.set_dataset_stage(dataset_path, "inspecting")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="running",
            message="Inspecting dataset artifacts",
        )
        diagnosis = diagnose_dataset(input_path)
        diagnosis_payload = self._diagnosis_payload(diagnosis)
        self.repository.state_store.write_dataset_report(
            dataset_path,
            category="diagnosis",
            name=f"{run['run_id']}.json",
            payload=diagnosis_payload,
        )
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        self._record_qc_step(dataset_path, run, {
            "id": "data_integrity_check",
            "status": "failed" if diagnosis.integrity_status == IntegrityStatus.EMPTY_SHELL else "passed",
            "message": diagnosis.integrity_status.value,
            "details": diagnosis_payload,
        })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="inspect",
            status="passed",
            message="Inspection completed",
        )

        if diagnosis.integrity_status == IntegrityStatus.EMPTY_SHELL:
            return self._fail_empty_shell(
                dataset_id,
                dataset_path,
                run,
                diagnosis_payload=diagnosis_payload,
            )

        self._record_qc_step(dataset_path, run, {
            "id": "damage_diagnosis",
            "status": "passed",
            "message": diagnosis.damage_kind.value,
            "details": diagnosis_payload,
        })
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="diagnose",
            status="passed",
            message=diagnosis.damage_kind.value,
            details=diagnosis_payload,
        )

        if diagnosis.integrity_status == IntegrityStatus.HEALTHY:
            active_output = self._current_active_output(dataset_path, dataset_id)
            self._record_qc_step(dataset_path, run, {
                "id": "repair_if_possible",
                "status": "skipped",
                "message": "Dataset is already clean",
            })
            return self._finish_with_leading_static_trim(
                dataset_id,
                dataset_path,
                run,
                input_path=input_path,
                base_active_output=active_output,
                diagnosis_payload=diagnosis_payload,
                clean_payload={"diagnosis": diagnosis_payload},
                trim_output_dir=self._artifact_dataset_path(dataset_path, run["run_id"]),
                vcodec=vcodec,
                force=force,
                cancelled=cancelled,
            )

        if not diagnosis.repairable:
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_if_possible",
                message=f"repair_if_possible failed: {diagnosis.damage_kind.value} is not repairable",
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
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        repair_status = "passed" if result.status == RepairStatus.REPAIRED else "failed"
        result_payload = {
            "damage_kind": result.damage_kind.value if result.damage_kind else None,
            "repair_strategy": (
                result.repair_strategy.value
                if result.repair_strategy
                else RepairStrategy.NONE.value
            ),
            "status": repair_status,
            "error": result.error,
        }
        self._record_qc_step(dataset_path, run, {
            "id": "repair_if_possible",
            "status": repair_status,
            "message": result.error or result_payload["repair_strategy"],
            "details": result_payload,
        })
        if result.status != RepairStatus.REPAIRED:
            if output_dir.exists():
                shutil.rmtree(output_dir)
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_if_possible",
                message=f"repair_if_possible failed: {result.error or repair_status}",
                diagnosis_payload=diagnosis_payload,
                extra_details={"repair": result_payload},
            )

        verify_diagnosis = diagnose_dataset(output_dir)
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        verify_payload = self._diagnosis_payload(verify_diagnosis)
        if verify_diagnosis.integrity_status != IntegrityStatus.HEALTHY:
            self._record_qc_step(dataset_path, run, {
                "id": "repair_verify",
                "status": "failed",
                "message": verify_diagnosis.integrity_status.value,
                "details": verify_payload,
            })
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="repair_verify",
                message=f"repair_verify failed: {verify_diagnosis.integrity_status.value}",
                diagnosis_payload=diagnosis_payload,
                extra_details={"repair": result_payload, "verify": verify_payload},
            )

        self._mark_cleaned_output(output_dir, {**result_payload, "verify": verify_payload})
        repair_active_output = {
            "kind": "artifact",
            "run_id": run["run_id"],
            "relative_path": output_dir.relative_to(dataset_path).as_posix(),
            "path": str(output_dir),
            "input_path": str(input_path),
            "created_at": utc_now_iso(),
            "reason": "repair_if_possible",
        }
        self._record_qc_step(dataset_path, run, {
            "id": "repair_verify",
            "status": "passed",
            "message": "Repair output verified",
            "details": verify_payload,
        })
        return self._finish_with_leading_static_trim(
            dataset_id,
            dataset_path,
            run,
            input_path=output_dir,
            base_active_output=repair_active_output,
            diagnosis_payload=diagnosis_payload,
            clean_payload={
                "diagnosis": diagnosis_payload,
                "repair": result_payload,
                "verify": verify_payload,
            },
            trim_output_dir=self._artifact_dataset_path(dataset_path, run["run_id"], name="trimmed-dataset"),
            vcodec=vcodec,
            force=force,
            cancelled=cancelled,
        )

    def _diagnosis_payload(self, diagnosis: Any) -> dict[str, Any]:
        return {
            "integrity_status": diagnosis.integrity_status.value,
            "damage_kind": diagnosis.damage_kind.value,
            "repair_strategy": diagnosis.repair_strategy.value,
            "repairable": diagnosis.repairable,
            "details": json_ready(diagnosis.details),
        }

    def _finish_with_leading_static_trim(
        self,
        dataset_id: str,
        dataset_path: Path,
        run: dict[str, Any],
        *,
        input_path: Path,
        base_active_output: dict[str, Any],
        diagnosis_payload: dict[str, Any],
        clean_payload: dict[str, Any],
        trim_output_dir: Path,
        vcodec: str,
        force: bool,
        cancelled: Callable[[], bool],
    ) -> dict[str, Any]:
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        self.repository.state_store.set_dataset_stage(dataset_path, "cleaning")
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="running",
            message="Trimming leading static frames",
            details=clean_payload,
        )
        try:
            trim_result = self.leading_static_trim.trim(
                input_path,
                output_dir=trim_output_dir,
                config=LeadingStaticTrimConfig(vcodec=vcodec),
                force=force,
            )
        except (FileExistsError, FileNotFoundError, ValueError) as exc:
            trim_payload = {
                "status": "failed",
                "input_path": str(input_path),
                "output_path": str(trim_output_dir),
                "error": str(exc),
            }
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="leading_static_trim",
                message=f"leading_static_trim failed: {exc}",
                diagnosis_payload=diagnosis_payload,
                extra_details={**clean_payload, "leading_static_trim": trim_payload},
            )

        trim_payload = trim_result.to_dict()
        cancelled_result = self._cancel_auto_clean_if_requested(dataset_id, dataset_path, run, cancelled)
        if cancelled_result is not None:
            return cancelled_result

        if trim_result.status == "failed":
            return self._fail_auto_clean(
                dataset_id,
                dataset_path,
                run,
                step_id="leading_static_trim",
                message=f"leading_static_trim failed: {trim_result.error}",
                diagnosis_payload=diagnosis_payload,
                extra_details={**clean_payload, "leading_static_trim": trim_payload},
            )

        trim_step_status = "passed" if trim_result.changed else "skipped"
        self._record_qc_step(dataset_path, run, {
            "id": "leading_static_trim",
            "status": trim_step_status,
            "message": self._leading_static_trim_message(trim_result),
            "details": trim_payload,
        })

        active_output = dict(base_active_output)
        if trim_result.changed:
            if trim_result.output_path is None:
                raise ValueError("Trim result changed without output_path")
            self._mark_cleaned_output(
                trim_result.output_path,
                {**clean_payload, "leading_static_trim": trim_payload},
                message="Trimmed dataset ready",
            )
            active_output = {
                "kind": "artifact",
                "run_id": run["run_id"],
                "relative_path": trim_result.output_path.relative_to(dataset_path).as_posix(),
                "path": str(trim_result.output_path),
                "input_path": str(input_path),
                "created_at": utc_now_iso(),
                "reason": "leading_static_trim",
            }

        self.repository.state_store.set_dataset_active_output(dataset_path, active_output)
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="passed",
            message=self._clean_gate_message(active_output, trim_result),
            details={**clean_payload, "leading_static_trim": trim_payload, "active_output": active_output},
        )
        self._mark_manual_review_pending_after_auto_clean(dataset_path, run)
        self._finish_qc_run(
            dataset_path,
            run,
            status="completed",
            output=active_output,
        )
        return {
            "dataset_id": dataset_id,
            "active_output": active_output,
            "status": "passed",
            "diagnosis": diagnosis_payload,
            "leading_static_trim": trim_payload,
        }

    def _cancel_auto_clean_if_requested(
        self,
        dataset_id: str,
        dataset_path: Path,
        run: dict[str, Any],
        cancelled: Callable[[], bool],
    ) -> dict[str, Any] | None:
        if not cancelled():
            return None
        return self._cancel_auto_clean_dataset(dataset_id, dataset_path, run)

    def _cancel_auto_clean_dataset(
        self,
        dataset_id: str,
        dataset_path: Path,
        run: dict[str, Any],
    ) -> dict[str, Any]:
        message = "Auto clean cancelled"
        failure = {"step_id": "auto_clean_cancelled", "message": message, "details": {}}
        artifact_root = dataset_path / ".status" / "artifacts" / run["run_id"]
        if artifact_root.exists():
            shutil.rmtree(artifact_root)
        run["status"] = "cancelled"
        run["updated_at"] = utc_now_iso()
        run["failure"] = failure
        self.repository.state_store.write_dataset_run(dataset_path, run)
        self.repository.state_store.append_dataset_event(dataset_path, {
            "type": "qc_run_cancelled",
            "run_id": run["run_id"],
            "lane": run["lane"],
            "failure": failure,
        })
        state = self.repository.state_store.load_dataset_state(dataset_path)
        state["lifecycle_stage"] = "raw"
        now = utc_now_iso()
        for gate_key, gate in state["gates"].items():
            if gate["status"] == "running" or gate_key == "clean":
                gate["status"] = "pending"
                gate["message"] = message if gate_key == "clean" else ""
                gate["details"] = {}
                gate["updated_at"] = now
        lanes = state.setdefault("qc", {}).setdefault("lanes", {})
        lanes["auto_clean"] = {
            "status": "pending",
            "chain_id": run["chain_id"],
            "last_run_id": run["run_id"],
            "failure": failure,
            "updated_at": now,
        }
        self.repository.state_store.write_dataset_state(dataset_path, state)
        return {
            "dataset_id": dataset_id,
            "status": "cancelled",
            "failure": failure,
        }

    def _leading_static_trim_message(self, result: Any) -> str:
        if result.status == "no_change":
            return "No leading static frames found"
        return (
            f"Trimmed {result.total_trimmed_frames} frames; "
            f"dropped {len(result.dropped_episode_indices)} episodes"
        )

    def _clean_gate_message(self, active_output: dict[str, Any], trim_result: Any) -> str:
        if trim_result.changed:
            return f"Leading static trim completed: {active_output['relative_path']}"
        if active_output.get("kind") == "artifact":
            return f"Dataset is clean: {active_output.get('relative_path', '')}"
        return "Dataset is clean"

    def _artifact_dataset_path(self, dataset_path: Path, run_id: str, *, name: str = "dataset") -> Path:
        output_dir = (dataset_path / ".status" / "artifacts" / run_id / name).resolve()
        output_dir.relative_to(dataset_path.resolve())
        return output_dir

    def _current_active_output(self, dataset_path: Path, dataset_id: str) -> dict[str, Any]:
        state = self.repository.state_store.load_dataset_state(dataset_path)
        active_output = state.get("active_output")
        if isinstance(active_output, dict) and active_output.get("kind") == "artifact":
            return dict(active_output)
        return {"kind": "source", "dataset_id": dataset_id}

    def _mark_manual_review_pending_after_auto_clean(
        self,
        dataset_path: Path,
        run: dict[str, Any],
    ) -> None:
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="review",
            status="pending",
            message="Manual review pending",
            details={"auto_clean_run_id": run["run_id"]},
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "needs_review")

    def _mark_cleaned_output(
        self,
        output_dir: Path,
        repair_payload: dict[str, Any],
        *,
        message: str = "Recovered dataset ready",
    ) -> None:
        state = self.repository.state_store.load_dataset_state(output_dir)
        state["lifecycle_stage"] = "clean"
        state["active_output"] = {"kind": "source"}
        for key in ("inspect", "diagnose", "clean", "review"):
            state["gates"][key]["status"] = "passed"
            state["gates"][key]["message"] = message
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
            payload={
                "status": "running",
                "chain_id": chain_id,
                "last_run_id": run["run_id"],
            },
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

    def _fail_empty_shell(
        self,
        dataset_id: str,
        dataset_path: Path,
        run: dict[str, Any],
        *,
        diagnosis_payload: dict[str, Any],
    ) -> dict[str, Any]:
        message = "data_integrity_check failed: empty_shell"
        details = {"diagnosis": diagnosis_payload}
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="diagnose",
            status="failed",
            message="empty_shell",
            details=diagnosis_payload,
        )
        self.repository.state_store.set_gate(
            dataset_path,
            object_type="dataset",
            key="clean",
            status="failed",
            message=message,
            details=details,
        )
        self.repository.state_store.set_dataset_stage(dataset_path, "excluded")
        failure = {"step_id": "data_integrity_check", "message": message, "details": details}
        self._finish_qc_run(dataset_path, run, status="failed", failure=failure)
        return {
            "dataset_id": dataset_id,
            "status": "failed",
            "failure": failure,
            "diagnosis": diagnosis_payload,
        }

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
            "status": "failed",
            "failure": failure,
            "diagnosis": diagnosis_payload,
        }
