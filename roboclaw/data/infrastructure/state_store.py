from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from roboclaw.data.domain.models import (
    DATASET_GATE_KEYS,
    PACKAGE_GATE_KEYS,
    DatasetPackageStage,
    DatasetStage,
    Gate,
)

STATE_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class DataStateStore:
    def status_dir(self, root: Path) -> Path:
        return root / ".status"

    def state_path(self, root: Path) -> Path:
        return self.status_dir(root) / "current.json"

    def events_path(self, root: Path) -> Path:
        return self.status_dir(root) / "events.jsonl"

    def runs_dir(self, root: Path) -> Path:
        return self.status_dir(root) / "runs"

    def run_path(self, root: Path, run_id: str) -> Path:
        return self.runs_dir(root) / f"{run_id}.json"

    def reports_dir(self, root: Path) -> Path:
        return self.status_dir(root) / "reports"

    def load_dataset_state(self, root: Path) -> dict[str, Any]:
        payload = self._read(root)
        return self._normalize_dataset_state(payload)

    def load_package_state(self, root: Path) -> dict[str, Any]:
        payload = self._read(root)
        return self._normalize_package_state(payload)

    def write_dataset_state(self, root: Path, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize_dataset_state(payload)
        normalized["updated_at"] = utc_now_iso()
        self._write(root, normalized)
        return normalized

    def write_package_state(self, root: Path, payload: dict[str, Any]) -> dict[str, Any]:
        normalized = self._normalize_package_state(payload)
        normalized["updated_at"] = utc_now_iso()
        self._write(root, normalized)
        return normalized

    def set_dataset_stage(self, root: Path, stage: DatasetStage) -> dict[str, Any]:
        state = self.load_dataset_state(root)
        state["lifecycle_stage"] = stage
        return self.write_dataset_state(root, state)

    def set_package_stage(self, root: Path, stage: DatasetPackageStage) -> dict[str, Any]:
        state = self.load_package_state(root)
        state["lifecycle_stage"] = stage
        return self.write_package_state(root, state)

    def set_gate(
        self,
        root: Path,
        *,
        object_type: str,
        key: str,
        status: str,
        message: str = "",
        details: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        state = self.load_package_state(root) if object_type == "package" else self.load_dataset_state(root)
        gates = state.setdefault("gates", {})
        if key not in gates:
            raise ValueError(f"Unknown gate '{key}'")
        gates[key] = {
            **gates[key],
            "status": status,
            "message": message,
            "details": details or {},
            "updated_at": utc_now_iso(),
        }
        if object_type == "dataset":
            self.append_dataset_event(root, {
                "type": "gate_updated",
                "gate": key,
                "status": status,
                "message": message,
                "details": details or {},
            })
        if object_type == "package":
            return self.write_package_state(root, state)
        return self.write_dataset_state(root, state)

    def write_dataset_run(self, root: Path, run: dict[str, Any]) -> dict[str, Any]:
        payload = dict(run)
        payload.setdefault("updated_at", utc_now_iso())
        path = self.run_path(root, str(payload["run_id"]))
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(path)
        return payload

    def load_dataset_run(self, root: Path, run_id: str) -> dict[str, Any]:
        path = self.run_path(root, run_id)
        if not path.is_file():
            raise FileNotFoundError(f"QC run '{run_id}' not found")
        return json.loads(path.read_text(encoding="utf-8"))

    def append_dataset_event(self, root: Path, event: dict[str, Any]) -> dict[str, Any]:
        payload = {
            "id": uuid4().hex,
            "at": utc_now_iso(),
            **event,
        }
        path = self.events_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, default=str) + "\n")
        return payload

    def write_dataset_report(
        self,
        root: Path,
        *,
        category: str,
        name: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        report_path = self.reports_dir(root) / category / name
        report_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = report_path.with_name(f".{report_path.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(report_path)
        state = self.load_dataset_state(root)
        qc = state.setdefault("qc", self._default_qc())
        reports = qc.setdefault("reports", {})
        reports[category] = {
            "relative_path": report_path.relative_to(self.status_dir(root)).as_posix(),
            "updated_at": utc_now_iso(),
        }
        return self.write_dataset_state(root, state)

    def set_dataset_qc_lane(
        self,
        root: Path,
        *,
        lane: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        state = self.load_dataset_state(root)
        qc = state.setdefault("qc", self._default_qc())
        lanes = qc.setdefault("lanes", {})
        lanes[lane] = {
            **dict(lanes.get(lane) or {}),
            **payload,
            "updated_at": utc_now_iso(),
        }
        return self.write_dataset_state(root, state)

    def set_dataset_active_output(self, root: Path, active_output: dict[str, Any]) -> dict[str, Any]:
        state = self.load_dataset_state(root)
        state["active_output"] = dict(active_output)
        return self.write_dataset_state(root, state)

    def _read(self, root: Path) -> dict[str, Any]:
        path = self.state_path(root)
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _write(self, root: Path, payload: dict[str, Any]) -> None:
        path = self.state_path(root)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
        tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
        tmp.replace(path)

    def _normalize_dataset_state(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        payload = dict(payload or {})
        payload["version"] = STATE_VERSION
        payload["object_type"] = "dataset"
        payload.setdefault("lifecycle_stage", "raw")
        payload["gates"] = self._normalize_gates(payload.get("gates"), DATASET_GATE_KEYS)
        payload["qc"] = self._normalize_qc(payload.get("qc"))
        payload["active_output"] = self._normalize_active_output(payload.get("active_output"))
        payload.setdefault("updated_at", utc_now_iso())
        return payload

    def _normalize_package_state(self, payload: dict[str, Any] | None) -> dict[str, Any]:
        payload = dict(payload or {})
        payload["version"] = STATE_VERSION
        payload["object_type"] = "package"
        payload.setdefault("lifecycle_stage", "assembled")
        payload.setdefault("dataset_ids", [])
        payload.setdefault("groups", {})
        payload.setdefault("evaluation_summary", {})
        payload["gates"] = self._normalize_gates(payload.get("gates"), PACKAGE_GATE_KEYS)
        payload.setdefault("updated_at", utc_now_iso())
        return payload

    def _normalize_gates(self, raw: Any, keys: tuple[str, ...]) -> dict[str, dict[str, Any]]:
        raw_gates = raw if isinstance(raw, dict) else {}
        return {
            key: Gate(
                key=key,
                status=str(raw_gates.get(key, {}).get("status") or "pending"),
                required=bool(raw_gates.get(key, {}).get("required", True)),
                message=str(raw_gates.get(key, {}).get("message") or ""),
                updated_at=str(raw_gates.get(key, {}).get("updated_at") or ""),
                details=dict(raw_gates.get(key, {}).get("details") or {}),
            ).to_dict()
            for key in keys
        }

    def _normalize_qc(self, raw: Any) -> dict[str, Any]:
        payload = dict(raw) if isinstance(raw, dict) else {}
        lanes = payload.get("lanes")
        reports = payload.get("reports")
        payload["lanes"] = lanes if isinstance(lanes, dict) else {}
        payload["reports"] = reports if isinstance(reports, dict) else {}
        return payload

    def _default_qc(self) -> dict[str, Any]:
        return {"lanes": {}, "reports": {}}

    def _normalize_active_output(self, raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return dict(raw)
        return {"kind": "source"}
