"""Dataset session handles for cache-backed remote and local datasets."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4

from huggingface_hub import snapshot_download

from roboclaw.data.local_discovery import is_dataset_dir, iter_dataset_dirs
from roboclaw.embodied.embodiment.manifest.helpers import get_manifest_path, get_roboclaw_home

SessionKind = Literal["remote", "local_directory", "local_path", "local_collection"]
SESSION_PREFIX = "session"


def _session_root() -> Path:
    return get_roboclaw_home() / "cache" / "dataset-sessions"


def _datasets_root() -> Path:
    manifest_path = get_manifest_path()
    if manifest_path.exists():
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        root = data.get("datasets", {}).get("root", "")
        if root:
            return Path(root).expanduser()
    return get_roboclaw_home() / "workspace" / "embodied" / "datasets"


def _session_dir(kind: SessionKind, session_id: str) -> Path:
    return _session_root() / kind / session_id


def _dataset_dir(kind: SessionKind, session_id: str) -> Path:
    return _session_dir(kind, session_id) / "dataset"


def _meta_path(kind: SessionKind, session_id: str) -> Path:
    return _session_dir(kind, session_id) / "session.json"


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _ensure_child_path(root: Path, target: Path) -> Path:
    resolved_root = root.resolve()
    resolved_target = target.resolve()
    resolved_target.relative_to(resolved_root)
    return resolved_target


def _path_is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def make_session_handle(kind: SessionKind, session_id: str) -> str:
    return f"{SESSION_PREFIX}:{kind}:{session_id}"


def parse_session_handle(handle: str) -> tuple[SessionKind, str] | None:
    parts = handle.split(":", 2)
    if len(parts) != 3 or parts[0] != SESSION_PREFIX:
        return None
    kind = parts[1]
    if kind not in {"remote", "local_directory", "local_path", "local_collection"}:
        return None
    session_id = parts[2]
    if not _is_safe_session_id(session_id):
        return None
    return kind, session_id


def is_session_handle(handle: str) -> bool:
    return parse_session_handle(handle) is not None


def is_local_collection_handle(handle: str) -> bool:
    parsed = parse_session_handle(handle)
    return parsed is not None and parsed[0] == "local_collection"


def _is_safe_session_id(session_id: str) -> bool:
    return bool(session_id) and session_id not in {".", ".."} and not any(
        char in session_id
        for char in ("/", "\\", ":")
    )


def resolve_session_dataset_path(handle: str) -> Path:
    parsed = parse_session_handle(handle)
    if parsed is None:
        raise ValueError(f"Invalid dataset session handle '{handle}'")
    kind, session_id = parsed
    if kind == "local_path":
        return _resolve_local_path_session_dataset(kind, session_id)
    if kind == "local_collection":
        return _resolve_local_collection_session_root(kind, session_id)
    dataset_dir = _dataset_dir(kind, session_id)
    if not dataset_dir.is_dir():
        raise FileNotFoundError(f"Dataset session '{handle}' not found")
    return dataset_dir.resolve()


def read_session_metadata(handle: str) -> dict[str, Any]:
    parsed = parse_session_handle(handle)
    if parsed is None:
        raise ValueError(f"Invalid dataset session handle '{handle}'")
    kind, session_id = parsed
    path = _meta_path(kind, session_id)
    if not path.is_file():
        raise FileNotFoundError(f"Dataset session metadata for '{handle}' not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_session_metadata(kind: SessionKind, session_id: str, payload: dict[str, Any]) -> None:
    path = _meta_path(kind, session_id)
    _ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_dataset_summary_from_dir(
    *,
    dataset_dir: Path,
    handle: str,
    display_name: str,
    source_kind: str,
    source_dataset: str,
) -> dict[str, Any]:
    info_path = dataset_dir / "meta" / "info.json"
    if not info_path.is_file():
        raise FileNotFoundError(f"Dataset session '{handle}' is missing meta/info.json")
    info = json.loads(info_path.read_text(encoding="utf-8"))

    episode_lengths: list[int] = []
    episodes_path = dataset_dir / "meta" / "episodes.jsonl"
    if episodes_path.is_file():
        for line in episodes_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            episode_lengths.append(int(entry.get("length", 0) or 0))

    return {
        "name": handle,
        "display_name": display_name,
        "source_kind": source_kind,
        "local_path": str(dataset_dir.resolve()),
        "total_episodes": int(info.get("total_episodes", 0) or 0),
        "total_frames": int(info.get("total_frames", 0) or 0),
        "fps": int(info.get("fps", 0) or 0),
        "robot_type": str(info.get("robot_type", "")),
        "episode_lengths": episode_lengths,
        "features": list((info.get("features") or {}).keys()),
        "source_dataset": source_dataset,
    }


def _resolve_local_path_session_dataset(kind: SessionKind, session_id: str) -> Path:
    metadata = json.loads(_meta_path(kind, session_id).read_text(encoding="utf-8"))
    dataset_dir = Path(str(metadata.get("dataset_dir") or "")).expanduser().resolve()
    if not is_dataset_dir(dataset_dir):
        handle = make_session_handle(kind, session_id)
        raise FileNotFoundError(f"Dataset session '{handle}' is missing meta/info.json")
    return dataset_dir


def _resolve_local_collection_session_root(kind: SessionKind, session_id: str) -> Path:
    metadata = json.loads(_meta_path(kind, session_id).read_text(encoding="utf-8"))
    root = Path(str(metadata.get("dataset_dir") or "")).expanduser().resolve()
    if not root.is_dir():
        handle = make_session_handle(kind, session_id)
        raise FileNotFoundError(f"Dataset collection session '{handle}' root not found")
    if not _local_collection_dataset_items_from_metadata(metadata):
        handle = make_session_handle(kind, session_id)
        raise FileNotFoundError(f"Dataset collection session '{handle}' has no readable datasets")
    return root


def register_remote_dataset_session(
    dataset_id: str,
    *,
    include_videos: bool = False,
    force: bool = False,
) -> dict[str, Any]:
    session_id = hashlib.sha1(dataset_id.encode("utf-8")).hexdigest()[:16]
    handle = make_session_handle("remote", session_id)
    session_dir = _session_dir("remote", session_id)
    dataset_dir = _dataset_dir("remote", session_id)
    remove_on_failure = force or not session_dir.exists()
    if force and session_dir.exists():
        shutil.rmtree(session_dir)

    succeeded = False
    try:
        _ensure_dir(dataset_dir)

        snapshot_download(
            repo_id=dataset_id,
            repo_type="dataset",
            local_dir=str(dataset_dir),
            allow_patterns=["meta/**", "README*", *(["videos/**"] if include_videos else [])],
        )

        info_path = dataset_dir / "meta" / "info.json"
        if info_path.is_file():
            info = json.loads(info_path.read_text(encoding="utf-8"))
            if info.get("source_dataset") != dataset_id:
                info["source_dataset"] = dataset_id
                info_path.write_text(json.dumps(info, indent=2), encoding="utf-8")

        metadata = {
            "handle": handle,
            "kind": "remote",
            "session_id": session_id,
            "display_name": dataset_id,
            "source_dataset": dataset_id,
            "dataset_dir": str(dataset_dir.resolve()),
        }
        _write_session_metadata("remote", session_id, metadata)
        summary = _build_dataset_summary_from_dir(
            dataset_dir=dataset_dir,
            handle=handle,
            display_name=dataset_id,
            source_kind="remote_session",
            source_dataset=dataset_id,
        )
        succeeded = True
        return {
            "dataset_id": dataset_id,
            "dataset_name": handle,
            "display_name": dataset_id,
            "local_path": str(dataset_dir.resolve()),
            "summary": summary,
        }
    finally:
        if not succeeded and remove_on_failure and session_dir.exists():
            shutil.rmtree(session_dir)


def create_uploaded_directory_session(
    *,
    files: list[tuple[str, bytes | Path]],
    display_name: str | None = None,
) -> dict[str, Any]:
    session_id = uuid4().hex[:12]
    handle = make_session_handle("local_directory", session_id)
    dataset_dir = _dataset_dir("local_directory", session_id)
    _ensure_dir(dataset_dir)
    dataset_root = dataset_dir.resolve()

    for relative_path, raw in files:
        try:
            target = _ensure_child_path(dataset_root, dataset_root / relative_path)
        except ValueError as exc:
            raise ValueError(f"Invalid uploaded file path '{relative_path}'") from exc
        _ensure_dir(target.parent)
        if isinstance(raw, Path):
            shutil.copyfile(raw, target)
        else:
            target.write_bytes(bytes(raw))

    session_display_name = display_name or dataset_dir.name
    metadata = {
        "handle": handle,
        "kind": "local_directory",
        "session_id": session_id,
        "display_name": session_display_name,
        "source_dataset": session_display_name,
        "dataset_dir": str(dataset_dir.resolve()),
    }
    _write_session_metadata("local_directory", session_id, metadata)
    summary = _build_dataset_summary_from_dir(
        dataset_dir=dataset_dir,
        handle=handle,
        display_name=session_display_name,
        source_kind="local_directory_session",
        source_dataset=session_display_name,
    )
    return {
        "dataset_name": handle,
        "display_name": session_display_name,
        "local_path": str(dataset_dir.resolve()),
        "summary": summary,
    }


def create_local_path_session(
    *,
    path: str | Path,
    display_name: str | None = None,
) -> dict[str, Any]:
    root = Path(path).expanduser().resolve()
    dataset_dirs = [root] if is_dataset_dir(root) else list(iter_dataset_dirs(root))
    if not dataset_dirs:
        raise FileNotFoundError(f"Dataset path '{root}' does not contain any meta/info.json")

    sessions = [
        _create_single_local_path_session(
            dataset_dir=dataset_dir,
            display_name=_local_path_session_display_name(
                root=root,
                dataset_dir=dataset_dir,
                requested_display_name=display_name,
                use_requested_display_name=len(dataset_dirs) == 1,
            ),
            label=_local_path_session_label(root, dataset_dir),
        )
        for dataset_dir in dataset_dirs
    ]
    if len(sessions) > 1:
        collection = _create_local_collection_session(
            root=root,
            display_name=display_name or root.name,
            sessions=sessions,
        )
        return {
            "dataset_name": collection["dataset_name"],
            "display_name": collection["display_name"],
            "local_path": collection["local_path"],
            "summary": collection["summary"],
            "dataset_count": len(sessions),
            "datasets": [
                {
                    "id": collection["dataset_name"],
                    "label": collection["label"],
                    "path": collection["local_path"],
                    "source": "local",
                    "source_kind": "local_path_collection",
                    "summary": collection["summary"],
                    "dataset_count": len(sessions),
                    "is_collection": True,
                },
                *[
                    {
                        "id": item["dataset_name"],
                        "label": item["label"],
                        "path": item["local_path"],
                        "source": "local",
                        "source_kind": "local_path_session",
                        "summary": item["summary"],
                    }
                    for item in sessions
                ],
            ],
        }

    primary = sessions[0]
    return {
        "dataset_name": primary["dataset_name"],
        "display_name": primary["display_name"],
        "local_path": primary["local_path"],
        "summary": primary["summary"],
        "dataset_count": 1,
        "datasets": [
            {
                "id": item["dataset_name"],
                "label": item["label"],
                "path": item["local_path"],
                "source": "local",
                "source_kind": "local_path_session",
                "summary": item["summary"],
            }
            for item in sessions
        ],
    }


def _create_local_collection_session(
    *,
    root: Path,
    display_name: str,
    sessions: list[dict[str, Any]],
) -> dict[str, Any]:
    session_id = hashlib.sha1(f"collection:{root}".encode("utf-8")).hexdigest()[:16]
    handle = make_session_handle("local_collection", session_id)
    metadata = {
        "handle": handle,
        "kind": "local_collection",
        "session_id": session_id,
        "display_name": display_name,
        "source_dataset": str(root),
        "dataset_dir": str(root),
        "datasets": [
            {
                "id": item["dataset_name"],
                "label": item["label"],
                "path": item["local_path"],
                "source": "local",
                "source_kind": "local_path_session",
            }
            for item in sessions
        ],
    }
    _write_session_metadata("local_collection", session_id, metadata)
    summary = _build_collection_summary_from_metadata(metadata)
    return {
        "dataset_name": handle,
        "display_name": display_name,
        "label": f"{display_name} (all datasets)",
        "local_path": str(root),
        "summary": summary,
    }


def _create_single_local_path_session(
    *,
    dataset_dir: Path,
    display_name: str,
    label: str,
) -> dict[str, Any]:
    session_id = hashlib.sha1(str(dataset_dir).encode("utf-8")).hexdigest()[:16]
    handle = make_session_handle("local_path", session_id)
    metadata = {
        "handle": handle,
        "kind": "local_path",
        "session_id": session_id,
        "display_name": display_name,
        "source_dataset": str(dataset_dir),
        "dataset_dir": str(dataset_dir),
    }
    _write_session_metadata("local_path", session_id, metadata)
    summary = _build_dataset_summary_from_dir(
        dataset_dir=dataset_dir,
        handle=handle,
        display_name=display_name,
        source_kind="local_path_session",
        source_dataset=str(dataset_dir),
    )
    return {
        "dataset_name": handle,
        "display_name": display_name,
        "label": label,
        "local_path": str(dataset_dir),
        "summary": summary,
    }


def _local_path_session_label(root: Path, dataset_dir: Path) -> str:
    if root == dataset_dir:
        return dataset_dir.name
    return dataset_dir.relative_to(root).as_posix()


def _local_path_session_display_name(
    *,
    root: Path,
    dataset_dir: Path,
    requested_display_name: str | None,
    use_requested_display_name: bool,
) -> str:
    if use_requested_display_name and requested_display_name:
        return requested_display_name
    return _local_path_session_label(root, dataset_dir)


def list_session_dataset_summaries(
    *,
    include_remote: bool = True,
    include_local_directory: bool = True,
    include_local_path: bool = True,
    include_local_collection: bool = False,
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    kinds: list[SessionKind] = []
    if include_remote:
        kinds.append("remote")
    if include_local_directory:
        kinds.append("local_directory")
    if include_local_collection:
        kinds.append("local_collection")
    if include_local_path:
        kinds.append("local_path")

    for kind in kinds:
        kind_root = _session_root() / kind
        if not kind_root.is_dir():
            continue
        for session_dir in sorted(kind_root.iterdir()):
            if not session_dir.is_dir():
                continue
            session_id = session_dir.name
            handle = make_session_handle(kind, session_id)
            if not _session_metadata_exists(kind, session_id):
                continue
            metadata = read_session_metadata(handle)
            if kind == "local_collection":
                summary = _build_collection_summary_from_metadata(metadata)
                if int(summary.get("dataset_count", 0) or 0) > 0:
                    results.append(summary)
                continue
            dataset_dir = _dataset_dir_from_session(kind, session_id, metadata)
            if not is_dataset_dir(dataset_dir):
                continue
            summary = _build_dataset_summary_from_dir(
                dataset_dir=dataset_dir,
                handle=handle,
                display_name=str(metadata.get("display_name") or handle),
                source_kind=_source_kind_for_session(kind),
                source_dataset=str(metadata.get("source_dataset") or metadata.get("display_name") or handle),
            )
            results.append(summary)
    return results


def _dataset_dir_from_session(kind: SessionKind, session_id: str, metadata: dict[str, Any]) -> Path:
    if kind == "local_path":
        return Path(str(metadata.get("dataset_dir") or "")).expanduser().resolve()
    return _dataset_dir(kind, session_id)


def _source_kind_for_session(kind: str) -> str:
    if kind == "remote":
        return "remote_session"
    if kind == "local_path":
        return "local_path_session"
    if kind == "local_collection":
        return "local_path_collection"
    return "local_directory_session"


def _session_metadata_exists(kind: SessionKind, session_id: str) -> bool:
    return _meta_path(kind, session_id).is_file()


def list_curation_dataset_summaries() -> list[dict[str, Any]]:
    workspace_root = _datasets_root()
    workspace_items = [
        {
            **item,
            "display_name": item["name"],
            "source_kind": "workspace",
        }
        for item in _workspace_list_datasets(workspace_root)
    ]
    return workspace_items + list_session_dataset_summaries(
        include_remote=True,
        include_local_directory=True,
        include_local_path=True,
    )


def list_local_dataset_options() -> list[dict[str, Any]]:
    workspace_root = _datasets_root()
    workspace_items = [
        {
            "id": item["name"],
            "label": item["name"],
            "path": item["path"],
            "source": "local",
            "source_kind": "workspace",
        }
        for item in _workspace_list_datasets(workspace_root)
    ]

    session_items = [
        {
            "id": item["name"],
            "label": str(item.get("display_name") or item["name"]),
            "path": str(item.get("local_path") or ""),
            "source": "local",
            "source_kind": item.get("source_kind", "local_directory_session"),
            **({
                "dataset_count": int(item.get("dataset_count", 0) or 0),
                "is_collection": True,
            } if item.get("source_kind") == "local_path_collection" else {}),
        }
        for item in list_session_dataset_summaries(
            include_remote=False,
            include_local_directory=True,
            include_local_path=True,
            include_local_collection=True,
        )
    ]
    return workspace_items + session_items


def _workspace_list_datasets(root: Path) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []

    datasets: list[dict[str, Any]] = []
    for dataset_dir in iter_dataset_dirs(root):
        datasets.append(_read_workspace_dataset_info(root, dataset_dir))
    return datasets


def _read_workspace_dataset_info(root: Path, dataset_dir: Path) -> dict[str, Any]:
    info_path = dataset_dir / "meta" / "info.json"
    raw = json.loads(info_path.read_text(encoding="utf-8"))
    total_episodes = raw.get("total_episodes", 0)
    total_frames = raw.get("total_frames", 0)
    fps = raw.get("fps", 0)

    episodes_path = dataset_dir / "meta" / "episodes.jsonl"
    episode_lengths: list[int] = []
    if episodes_path.exists():
        for line in episodes_path.read_text(encoding="utf-8").strip().splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            episode_lengths.append(int(entry.get("length", 0) or 0))

    return {
        "name": dataset_dir.relative_to(root).as_posix(),
        "path": str(dataset_dir.resolve()),
        "total_episodes": total_episodes,
        "total_frames": total_frames,
        "fps": fps,
        "episode_lengths": episode_lengths,
        "features": list(raw.get("features", {}).keys()),
        "robot_type": raw.get("robot_type", ""),
        "source_dataset": raw.get("repo_id") or raw.get("dataset_id") or dataset_dir.relative_to(root).as_posix(),
    }


def resolve_dataset_handle_or_workspace(name: str) -> Path:
    if is_session_handle(name):
        return resolve_session_dataset_path(name)

    root = _datasets_root().resolve()
    candidate = (root / name).resolve()
    if _path_is_relative_to(candidate, root) and is_dataset_dir(candidate):
        return candidate

    raise FileNotFoundError(f"Dataset '{name}' not found")


def get_dataset_summary(name: str) -> dict[str, Any]:
    if is_session_handle(name):
        metadata = read_session_metadata(name)
        if is_local_collection_handle(name):
            return _build_collection_summary_from_metadata(metadata)
        dataset_dir = resolve_session_dataset_path(name)
        return _build_dataset_summary_from_dir(
            dataset_dir=dataset_dir,
            handle=name,
            display_name=str(metadata.get("display_name") or name),
            source_kind=_source_kind_for_session(str(metadata.get("kind") or "local_directory")),
            source_dataset=str(metadata.get("source_dataset") or metadata.get("display_name") or name),
        )

    from roboclaw.data.datasets import list_datasets

    root = _datasets_root().resolve()
    for item in list_datasets(root):
        dataset_name = str(item.get("name") or item.get("id") or "")
        if dataset_name == name:
            return {
                **item,
                "name": dataset_name,
                "display_name": item.get("display_name") or item.get("label") or dataset_name,
                "source_kind": "workspace",
            }
    raise FileNotFoundError(f"Dataset '{name}' not found")


def list_local_collection_dataset_items(handle: str) -> list[dict[str, Any]]:
    if not is_local_collection_handle(handle):
        raise ValueError(f"Dataset session '{handle}' is not a local collection")
    metadata = read_session_metadata(handle)
    return _local_collection_dataset_items_from_metadata(metadata)


def _local_collection_dataset_items_from_metadata(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    root = Path(str(metadata.get("dataset_dir") or "")).expanduser().resolve()
    results: list[dict[str, Any]] = []
    for raw in metadata.get("datasets") or []:
        if not isinstance(raw, dict):
            continue
        dataset_path = Path(str(raw.get("path") or "")).expanduser().resolve()
        if not is_dataset_dir(dataset_path):
            continue
        if not _path_is_relative_to(dataset_path, root):
            continue
        dataset_id = str(raw.get("id") or "")
        if not is_session_handle(dataset_id):
            continue
        label = str(raw.get("label") or dataset_path.relative_to(root).as_posix())
        results.append({
            "id": dataset_id,
            "label": label,
            "path": str(dataset_path),
            "source": "local",
            "source_kind": "local_path_session",
        })
    return results


def _build_collection_summary_from_metadata(metadata: dict[str, Any]) -> dict[str, Any]:
    handle = str(metadata.get("handle") or "")
    display_name = str(metadata.get("display_name") or handle)
    root = Path(str(metadata.get("dataset_dir") or "")).expanduser().resolve()
    child_summaries: list[dict[str, Any]] = []
    for item in _local_collection_dataset_items_from_metadata(metadata):
        try:
            child_summaries.append(get_dataset_summary(str(item["id"])))
        except FileNotFoundError:
            continue

    fps_values = {
        int(summary.get("fps", 0) or 0)
        for summary in child_summaries
        if int(summary.get("fps", 0) or 0) > 0
    }
    robot_types = {
        str(summary.get("robot_type") or "")
        for summary in child_summaries
        if str(summary.get("robot_type") or "")
    }
    features: list[str] = []
    seen_features: set[str] = set()
    episode_lengths: list[int] = []
    for summary in child_summaries:
        for feature in summary.get("features") or []:
            name = str(feature)
            if name not in seen_features:
                seen_features.add(name)
                features.append(name)
        episode_lengths.extend(int(value) for value in summary.get("episode_lengths") or [])

    return {
        "name": handle,
        "display_name": display_name,
        "source_kind": "local_path_collection",
        "local_path": str(root),
        "total_episodes": sum(int(summary.get("total_episodes", 0) or 0) for summary in child_summaries),
        "total_frames": sum(int(summary.get("total_frames", 0) or 0) for summary in child_summaries),
        "fps": fps_values.pop() if len(fps_values) == 1 else 0,
        "robot_type": robot_types.pop() if len(robot_types) == 1 else ("mixed" if robot_types else ""),
        "episode_lengths": episode_lengths,
        "features": features,
        "source_dataset": str(metadata.get("source_dataset") or root),
        "dataset_count": len(child_summaries),
    }
