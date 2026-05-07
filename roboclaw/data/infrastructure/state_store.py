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
    def state_path(self, root: Path) -> Path:
        return root / ".data" / "state.json"

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
        if object_type == "package":
            return self.write_package_state(root, state)
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
