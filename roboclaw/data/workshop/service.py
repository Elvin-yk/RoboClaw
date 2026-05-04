from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

from roboclaw.data.curation.state import load_quality_results
from roboclaw.data.paths import datasets_root
from roboclaw.data.repair.diagnosis import diagnose_dataset
from roboclaw.data.repair.repairers import repair_dataset

from .diagnostics import (
    diagnosis_payload_from_result,
    inspect_structure,
    inspect_structure_summary,
)
from .storage import (
    list_assemblies,
    new_id,
    now_iso,
    read_assembly,
    read_workshop_state,
    write_assembly,
    write_workshop_state,
)
from .types import (
    DIRTY_REQUIRED_GATES,
    GATE_KEYS,
    DatasetAssembly,
    GateKey,
    GateStatus,
    ProcessingGate,
    UploadTask,
    WorkshopDataset,
    WorkshopStage,
)


class DataWorkshopService:
    def __init__(self, root_resolver: Callable[[], Path] | None = None) -> None:
        self._root_resolver = root_resolver or datasets_root

    @property
    def root(self) -> Path:
        return self._root_resolver().expanduser()

    def list_datasets(self) -> list[dict[str, Any]]:
        return [dataset.to_dict() for dataset in self._scan_datasets()]

    def get_dataset(self, dataset_id: str) -> dict[str, Any]:
        dataset_path = self.resolve_dataset_path(dataset_id)
        return self._build_dataset(dataset_id, dataset_path).to_dict()

    def diagnose(self, dataset_id: str) -> dict[str, Any]:
        dataset_path = self.resolve_dataset_path(dataset_id)
        state = self._load_state_with_gates(dataset_path)
        structure = inspect_structure(dataset_path)
        diagnosis = diagnosis_payload_from_result(diagnose_dataset(dataset_path))
        stage = self._stage_after_diagnosis(state.get("stage"), diagnosis, structure)
        gates = self._gates_from_state(state)
        self._apply_diagnosis_to_gates(gates, diagnosis, structure)
        saved = self._save_dataset_state(
            dataset_path,
            {
                **state,
                "stage": stage,
                "diagnosis": diagnosis,
                "structure": structure,
                "gates": self._serialize_gates(gates),
            },
        )
        return self._build_dataset(dataset_id, dataset_path, saved).to_dict()

    def repair(
        self,
        dataset_id: str,
        *,
        task: str,
        vcodec: str,
        force: bool,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        dataset_path = self.resolve_dataset_path(dataset_id)
        state = self._load_state_with_gates(dataset_path)
        diagnosis_result = diagnose_dataset(dataset_path)
        diagnosis = diagnosis_payload_from_result(diagnosis_result)
        if not diagnosis.get("repairable"):
            raise HTTPException(status_code=409, detail="Dataset is not repairable")

        repair_result = repair_dataset(
            diagnosis_result,
            task=task,
            vcodec=vcodec,
            dry_run=dry_run,
            force=force,
        )
        gates = self._gates_from_state(state)
        gate_status: GateStatus = "passed" if repair_result.outcome in {"repaired", "healthy"} else "failed"
        repaired_path = dataset_path.parent / f"{dataset_path.name}_repaired"
        details = {
            "outcome": repair_result.outcome,
            "error": repair_result.error,
            "repaired_path": str(repaired_path) if repaired_path.exists() else "",
        }
        self._set_gate(gates, "repair", gate_status, repair_result.outcome, details)
        structure = (
            inspect_structure(dataset_path)
            if gate_status == "passed"
            else state.get("structure") or inspect_structure(dataset_path)
        )
        saved = self._save_dataset_state(
            dataset_path,
            {
                **state,
                "diagnosis": diagnosis,
                "structure": structure,
                "gates": self._serialize_gates(gates),
            },
        )
        return self._build_dataset(dataset_id, dataset_path, saved).to_dict()

    def update_gate(
        self,
        dataset_id: str,
        gate_key: GateKey,
        *,
        status: GateStatus,
        message: str,
        details: dict[str, Any],
        groups: list[str],
        batch: str,
        notes: str,
    ) -> dict[str, Any]:
        dataset_path = self.resolve_dataset_path(dataset_id)
        state = self._load_state_with_gates(dataset_path)
        structure = state.get("structure") or inspect_structure(dataset_path)
        if status == "passed":
            self._raise_if_critical_structure(structure)

        gates = self._gates_from_state(state)
        self._set_gate(gates, gate_key, status, message, details)
        patch: dict[str, Any] = {
            **state,
            "structure": structure,
            "gates": self._serialize_gates(gates),
        }
        if gate_key == "organize":
            patch["groups"] = groups
            patch["batch"] = batch
            patch["notes"] = notes
        saved = self._save_dataset_state(dataset_path, patch)
        return self._build_dataset(dataset_id, dataset_path, saved).to_dict()

    def promote(self, dataset_id: str, target_stage: WorkshopStage = "clean") -> dict[str, Any]:
        if target_stage not in {"clean", "complete"}:
            raise HTTPException(status_code=400, detail="target_stage must be clean or complete")
        dataset_path = self.resolve_dataset_path(dataset_id)
        state = self._load_state_with_gates(dataset_path)
        structure = state.get("structure") or inspect_structure(dataset_path)
        self._raise_if_critical_structure(structure)
        gates = self._gates_from_state(state)
        missing = [key for key in DIRTY_REQUIRED_GATES if gates[key].status != "passed"]
        if missing:
            raise HTTPException(status_code=409, detail=f"Required gates are not passed: {missing}")
        saved = self._save_dataset_state(dataset_path, {**state, "stage": target_stage, "structure": structure})
        return self._build_dataset(dataset_id, dataset_path, saved).to_dict()

    def list_assemblies(self) -> list[dict[str, Any]]:
        return [assembly.to_dict() for assembly in list_assemblies()]

    def get_assembly(self, assembly_id: str) -> dict[str, Any]:
        return read_assembly(assembly_id).to_dict()

    def create_assembly(
        self,
        *,
        name: str,
        dataset_ids: list[str],
        groups: dict[str, list[str]],
    ) -> dict[str, Any]:
        clean_datasets = [self._require_clean_dataset(dataset_id) for dataset_id in dataset_ids]
        timestamp = now_iso()
        assembly = DatasetAssembly(
            id=new_id("assembly"),
            name=name.strip() or "完整数据包",
            status="draft",
            dataset_ids=dataset_ids,
            groups=groups,
            created_at=timestamp,
            updated_at=timestamp,
            quality_summary=self._assembly_quality_summary(clean_datasets),
        )
        write_assembly(assembly)
        for dataset_id, dataset_path in clean_datasets:
            self._attach_assembly(dataset_path, assembly.id)
        return assembly.to_dict()

    def create_upload_placeholder(self, assembly_id: str, target: str) -> dict[str, Any]:
        assembly = read_assembly(assembly_id)
        timestamp = now_iso()
        assembly.upload_task = UploadTask(
            id=new_id("upload"),
            status="queued",
            target=target.strip() or "aliyun-oss",
            created_at=timestamp,
            updated_at=timestamp,
            message="上传接口已预留，OSS 执行器尚未接入。",
        )
        assembly.status = "upload_queued"
        assembly.updated_at = timestamp
        write_assembly(assembly)
        return assembly.to_dict()

    def resolve_dataset_path(self, dataset_id: str) -> Path:
        _reject_unsafe_dataset_id(dataset_id)
        candidates = [self.root / dataset_id]
        if "/" not in dataset_id:
            candidates.append(self.root / "local" / dataset_id)
        for candidate in candidates:
            if candidate.exists() and candidate.is_dir():
                return candidate
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_id}' not found")

    def _scan_datasets(self) -> list[WorkshopDataset]:
        refs = [(dataset_id, path) for dataset_id, path in self._iter_dataset_entries()]
        return [
            self._build_dataset(dataset_id, path, refresh_structure=False)
            for dataset_id, path in sorted(refs)
        ]

    def _iter_dataset_entries(self) -> list[tuple[str, Path]]:
        root = self.root
        if not root.is_dir():
            return []
        entries: list[tuple[str, Path]] = []
        local_dir = root / "local"
        if local_dir.is_dir():
            for entry in sorted(local_dir.iterdir()):
                if entry.is_dir():
                    entries.append((f"local/{entry.name}", entry))
        for entry in sorted(root.iterdir()):
            if entry.name == "local" or not entry.is_dir():
                continue
            if _looks_like_dataset_dir(entry):
                entries.append((entry.name, entry))
                continue
            entries.extend(_nested_dataset_entries(root, entry))
        return entries

    def _build_dataset(
        self,
        dataset_id: str,
        dataset_path: Path,
        state: dict[str, Any] | None = None,
        *,
        refresh_structure: bool = True,
    ) -> WorkshopDataset:
        state = state if state is not None else self._load_state_with_gates(dataset_path)
        structure = state.get("structure")
        if not structure:
            structure = (
                inspect_structure(dataset_path)
                if refresh_structure
                else inspect_structure_summary(dataset_path)
            )
        stats = _stats_from_structure(structure)
        stage = _coerce_stage(state.get("stage")) or self._derive_stage(structure)
        return WorkshopDataset(
            id=dataset_id,
            name=dataset_path.name,
            label=dataset_path.name,
            path=str(dataset_path),
            real_path=str(dataset_path.resolve()),
            is_symlink=dataset_path.is_symlink(),
            stage=stage,
            stats=stats,
            gates=self._gates_from_state(state),
            diagnosis=state.get("diagnosis"),
            structure=structure,
            groups=[str(item) for item in state.get("groups") or []],
            batch=str(state.get("batch") or ""),
            notes=str(state.get("notes") or ""),
            assembly_ids=[str(item) for item in state.get("assembly_ids") or []],
            updated_at=str(state.get("updated_at") or ""),
        )

    def _derive_stage(self, structure: dict[str, Any]) -> WorkshopStage:
        checks = [issue["check"] for issue in structure.get("issues") or []]
        return "excluded" if "empty_shell" in checks else "dirty"

    def _stage_after_diagnosis(
        self,
        current: Any,
        diagnosis: dict[str, Any],
        structure: dict[str, Any],
    ) -> WorkshopStage:
        if diagnosis.get("damage_type") == "empty_shell":
            return "excluded"
        if "empty_shell" in [issue["check"] for issue in structure.get("issues") or []]:
            return "excluded"
        return _coerce_stage(current) or "dirty"

    def _load_state_with_gates(self, dataset_path: Path) -> dict[str, Any]:
        state = read_workshop_state(dataset_path)
        state["gates"] = self._serialize_gates(self._gates_from_state(state))
        return state

    def _gates_from_state(self, state: dict[str, Any]) -> dict[GateKey, ProcessingGate]:
        raw_gates = state.get("gates") if isinstance(state.get("gates"), dict) else {}
        return {
            key: ProcessingGate.from_dict(key, raw_gates.get(key))
            for key in GATE_KEYS
        }

    def _serialize_gates(self, gates: dict[GateKey, ProcessingGate]) -> dict[str, Any]:
        return {key: gate.to_dict() for key, gate in gates.items()}

    def _apply_diagnosis_to_gates(
        self,
        gates: dict[GateKey, ProcessingGate],
        diagnosis: dict[str, Any],
        structure: dict[str, Any],
    ) -> None:
        has_critical = _has_critical_structure(structure)
        repairable = bool(diagnosis.get("repairable"))
        damage_type = str(diagnosis.get("damage_type") or "")
        diagnosis_status: GateStatus = "failed" if has_critical and not repairable else "passed"
        self._set_gate(gates, "repair_diagnosis", diagnosis_status, damage_type, diagnosis)
        if damage_type == "empty_shell":
            self._set_gate(gates, "auto_prune", "passed", "空壳数据已进入排除候选。", {})
            self._set_gate(gates, "repair", "skipped", "空壳数据没有可修复内容。", {})
            return
        repair_status: GateStatus = "manual_required" if repairable else "skipped"
        self._set_gate(gates, "auto_prune", "skipped", "未命中自动剔除规则。", {})
        self._set_gate(gates, "repair", repair_status, "等待修复" if repairable else "无需修复", {})

    def _set_gate(
        self,
        gates: dict[GateKey, ProcessingGate],
        key: GateKey,
        status: GateStatus,
        message: str,
        details: dict[str, Any],
    ) -> None:
        gate = gates[key]
        timestamp = now_iso()
        gate.status = status
        gate.message = message
        gate.details = details
        gate.updated_at = timestamp
        gate.history.append({
            "status": status,
            "message": message,
            "details": details,
            "updated_at": timestamp,
        })

    def _save_dataset_state(self, dataset_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
        return write_workshop_state(dataset_path, payload)

    def _raise_if_critical_structure(self, structure: dict[str, Any]) -> None:
        critical = [issue for issue in structure.get("issues") or [] if issue.get("level") == "critical"]
        if critical:
            raise HTTPException(status_code=409, detail=f"Critical structure issues block this action: {critical}")

    def _require_clean_dataset(self, dataset_id: str) -> tuple[str, Path]:
        dataset_path = self.resolve_dataset_path(dataset_id)
        dataset = self._build_dataset(dataset_id, dataset_path)
        if dataset.stage != "clean":
            raise HTTPException(status_code=409, detail=f"Dataset '{dataset_id}' is not clean")
        return dataset_id, dataset_path

    def _attach_assembly(self, dataset_path: Path, assembly_id: str) -> None:
        state = self._load_state_with_gates(dataset_path)
        assembly_ids = [str(item) for item in state.get("assembly_ids") or []]
        if assembly_id not in assembly_ids:
            assembly_ids.append(assembly_id)
        gates = self._gates_from_state(state)
        self._set_gate(gates, "assembly", "passed", "已加入完整数据包。", {"assembly_id": assembly_id})
        write_workshop_state(
            dataset_path,
            {
                **state,
                "stage": "complete",
                "assembly_ids": assembly_ids,
                "gates": self._serialize_gates(gates),
            },
        )

    def _assembly_quality_summary(self, datasets: list[tuple[str, Path]]) -> dict[str, Any]:
        total = len(datasets)
        with_quality = 0
        passed = 0
        failed = 0
        for _dataset_id, dataset_path in datasets:
            quality = load_quality_results(dataset_path) or {}
            if quality:
                with_quality += 1
            passed += int(quality.get("passed") or 0)
            failed += int(quality.get("failed") or 0)
        return {
            "dataset_count": total,
            "with_quality_results": with_quality,
            "passed_episodes": passed,
            "failed_episodes": failed,
        }


def _reject_unsafe_dataset_id(dataset_id: str) -> None:
    path = Path(dataset_id)
    if path.is_absolute() or ".." in path.parts or not dataset_id.strip():
        raise HTTPException(status_code=400, detail=f"Invalid dataset id: {dataset_id!r}")


def _looks_like_dataset_dir(path: Path) -> bool:
    return path.is_dir() and (path / "meta" / "info.json").exists()


def _nested_dataset_entries(root: Path, entry: Path) -> list[tuple[str, Path]]:
    results: list[tuple[str, Path]] = []
    for child in sorted(entry.iterdir()):
        if child.is_dir() and _looks_like_dataset_dir(child):
            results.append((child.relative_to(root).as_posix(), child))
    return results


def _stats_from_structure(structure: dict[str, Any]) -> dict[str, Any]:
    counts = structure.get("counts") or {}
    return {
        "total_episodes": int(counts.get("info_total_episodes") or 0),
        "total_frames": int(counts.get("info_total_frames") or 0),
        "parquet_rows": int(counts.get("parquet_rows") or 0),
        "video_files": int(counts.get("video_files") or 0),
        "episode_metadata_count": int(counts.get("episode_metadata_count") or 0),
    }


def _coerce_stage(value: Any) -> WorkshopStage | None:
    return value if value in {"dirty", "clean", "complete", "excluded"} else None


def _has_critical_structure(structure: dict[str, Any]) -> bool:
    return any(issue.get("level") == "critical" for issue in structure.get("issues") or [])
