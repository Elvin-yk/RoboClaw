from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from roboclaw.embodied.embodiment.manifest.helpers import get_roboclaw_home

from .types import DatasetAssembly

STATE_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def workflow_state_path(dataset_path: Path) -> Path:
    return dataset_path / ".workflow" / "workshop.json"


def assemblies_root() -> Path:
    return get_roboclaw_home() / "workspace" / "embodied" / "data-assemblies"


def assembly_path(assembly_id: str) -> Path:
    return assemblies_root() / assembly_id / "assembly.json"


def read_workshop_state(dataset_path: Path) -> dict[str, Any]:
    path = workflow_state_path(dataset_path)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def write_workshop_state(dataset_path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    payload = dict(payload)
    payload["version"] = STATE_VERSION
    payload["updated_at"] = now_iso()
    _write_json(workflow_state_path(dataset_path), payload)
    return payload


def list_assemblies() -> list[DatasetAssembly]:
    root = assemblies_root()
    if not root.is_dir():
        return []
    assemblies: list[DatasetAssembly] = []
    for path in sorted(root.glob("*/assembly.json")):
        assemblies.append(DatasetAssembly.from_dict(json.loads(path.read_text(encoding="utf-8"))))
    return assemblies


def read_assembly(assembly_id: str) -> DatasetAssembly:
    path = assembly_path(assembly_id)
    if not path.is_file():
        raise FileNotFoundError(f"Dataset assembly '{assembly_id}' not found")
    return DatasetAssembly.from_dict(json.loads(path.read_text(encoding="utf-8")))


def write_assembly(assembly: DatasetAssembly) -> DatasetAssembly:
    _write_json(assembly_path(assembly.id), assembly.to_dict())
    return assembly


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:12]}"


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    tmp_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    tmp_path.replace(path)
