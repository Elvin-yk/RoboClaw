from __future__ import annotations

import asyncio
import json
from pathlib import Path, PurePosixPath
from typing import Any, TypeVar
from urllib.parse import quote

import httpx
import pyarrow.parquet as pq
from fastapi import HTTPException
from fastapi.responses import FileResponse
from huggingface_hub.errors import HfHubHTTPError, HFValidationError, RepositoryNotFoundError

from roboclaw.data.application.episode_robot_trajectory import (
    TrajectorySignal,
    build_episode_robot_trajectory,
)
from roboclaw.data.curation.features import (
    build_joint_trajectory_payload,
    extract_action_names,
    extract_state_names,
    resolve_timestamp,
)
from roboclaw.data.curation.serializers import video_clip_bounds, video_key_from_relative_path
from roboclaw.data.curation.validators import load_episode_data
from roboclaw.data.explorer.local import (
    build_explorer_episode_page_from_artifacts,
    build_explorer_overview_from_artifacts,
    build_explorer_summary_from_info,
    load_episodes_list_file,
    load_json_file,
    scan_dataset_siblings,
)
from roboclaw.data.explorer.remote import (
    build_remote_dataset_info,
    build_remote_episode_page,
    build_remote_explorer_details,
    build_remote_explorer_summary,
    load_remote_episode_detail,
    search_remote_datasets,
)
from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.embodied.embodiment.arm.assets import (
    get_robot_asset_bundle,
    validate_robot_asset_path,
)
from roboclaw.embodied.embodiment.arm.visualization import (
    RobotVisualizationSpec,
    get_robot_visualization_spec,
)

T = TypeVar("T")


class DataInspectService:
    def __init__(self, repository: DataRepository) -> None:
        self.repository = repository

    async def suggestions(self, *, query: str, source: str, limit: int) -> list[dict[str, Any]]:
        if self._normalize_source(source) == "remote":
            if not query.strip():
                return []
            return await self._remote_call(query, search_remote_datasets, query, max(1, min(limit, 12)))
        needle = query.strip().lower()
        items = [
            {"id": dataset.id, "label": dataset.label, "path": str(dataset.path), "source": "local"}
            for dataset in self.repository.list_datasets()
        ]
        if needle:
            items = [item for item in items if needle in item["id"].lower() or needle in item["path"].lower()]
        return items[: max(1, min(limit, 50))]

    async def summary(self, *, dataset: str | None, source: str, path: str | None) -> dict[str, Any]:
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            return await self._remote_call(dataset_name, build_remote_explorer_summary, dataset_name)
        return await asyncio.to_thread(self._local_summary, dataset_path, dataset_name)

    async def details(self, *, dataset: str | None, source: str, path: str | None) -> dict[str, Any]:
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            return await self._remote_call(dataset_name, build_remote_explorer_details, dataset_name)
        return await asyncio.to_thread(self._local_details, dataset_path, dataset_name)

    async def dataset_info(self, *, dataset: str | None, source: str, path: str | None) -> dict[str, Any]:
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            return await self._remote_call(dataset_name, build_remote_dataset_info, dataset_name)
        details = self._local_summary(dataset_path, dataset_name)
        info = load_json_file(dataset_path / "meta" / "info.json")
        episodes_meta = load_episodes_list_file(dataset_path)
        return {
            "name": details["dataset"],
            "total_episodes": details["summary"]["total_episodes"],
            "total_frames": details["summary"]["total_frames"],
            "fps": details["summary"]["fps"],
            "episode_lengths": [int(entry.get("length", 0) or 0) for entry in episodes_meta],
            "features": list((info.get("features") or {}).keys()) if isinstance(info, dict) else [],
            "robot_type": details["summary"]["robot_type"],
            "source_dataset": details["dataset"],
        }

    async def episodes(
        self,
        *,
        dataset: str | None,
        source: str,
        path: str | None,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        safe_page_size = max(1, min(page_size, 200))
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            return await self._remote_call(dataset_name, build_remote_episode_page, dataset_name, page, safe_page_size)
        return await asyncio.to_thread(self._local_episode_page, dataset_path, dataset_name, page, safe_page_size)

    async def episode(
        self,
        *,
        dataset: str | None,
        source: str,
        path: str | None,
        episode_index: int,
        preview: bool,
    ) -> dict[str, Any]:
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            return await self._remote_call(
                dataset_name,
                load_remote_episode_detail,
                dataset_name,
                episode_index,
                preview_only=preview,
            )
        return await asyncio.to_thread(
            self._local_episode_payload,
            dataset_path,
            dataset_name,
            episode_index,
            preview=preview,
            source=resolved_source,
        )

    async def robot_model(self, *, model: str) -> dict[str, Any]:
        spec = self._robot_visualization_spec(model)
        return self._robot_model_manifest(spec)

    async def episode_robot_trajectory(
        self,
        *,
        dataset: str | None,
        source: str,
        path: str | None,
        episode_index: int,
        signal: str,
        model: str,
    ) -> dict[str, Any]:
        spec = self._robot_visualization_spec(model)
        trajectory_signal = self._normalize_trajectory_signal(signal)
        resolved_source, dataset_name, dataset_path = self._resolve_context(dataset=dataset, source=source, path=path)
        if resolved_source == "remote":
            raise HTTPException(status_code=400, detail="Robot trajectory visualization requires a local dataset")
        try:
            return await asyncio.to_thread(
                build_episode_robot_trajectory,
                dataset_path,
                dataset_name,
                episode_index,
                source=resolved_source,
                signal=trajectory_signal,
                spec=spec,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    def robot_asset_file(self, *, asset_id: str, relative_path: str) -> FileResponse:
        try:
            asset_path = validate_robot_asset_path(relative_path)
            bundle = get_robot_asset_bundle(asset_id)
            asset_file = bundle.resolve_file(asset_path)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Path traversal not allowed") from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail="Robot asset file not found") from exc
        return FileResponse(
            str(asset_file.local_path),
            media_type=asset_file.content_type,
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )

    def video(self, *, relative_path: str, dataset: str | None, source: str, dataset_path: str | None) -> FileResponse:
        resolved_source = self._normalize_source(source)
        if resolved_source == "path":
            root = self._resolve_external_path(dataset_path or "")
        else:
            if not dataset:
                raise HTTPException(status_code=400, detail="Local video requests require dataset")
            root = self.repository.dataset_materialized_path(dataset)
        video_path = self._resolve_child_path(root, relative_path)
        if not video_path.is_file():
            raise HTTPException(status_code=404, detail=f"Video file '{relative_path}' not found")
        return FileResponse(str(video_path), media_type="video/mp4", filename=video_path.name)

    async def _remote_call(self, dataset_name: str, func: Any, *args: Any, **kwargs: Any) -> T:
        try:
            return await asyncio.to_thread(func, *args, **kwargs)
        except RepositoryNotFoundError as exc:
            raise HTTPException(status_code=404, detail=f"Remote dataset '{dataset_name}' was not found") from exc
        except HFValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except (HfHubHTTPError, httpx.HTTPError) as exc:
            raise HTTPException(status_code=502, detail=f"Failed to load remote dataset '{dataset_name}'") from exc

    def _robot_model_manifest(self, spec: RobotVisualizationSpec) -> dict[str, Any]:
        try:
            bundle = get_robot_asset_bundle(spec.asset_id)
        except (ValueError, FileNotFoundError) as exc:
            raise HTTPException(status_code=404, detail=f"Robot asset bundle '{spec.asset_id}' not found") from exc
        base_url = f"/api/data/inspect/robot-assets/{spec.asset_id}/"
        return {
            **spec.to_manifest_fields(),
            **bundle.to_manifest(base_url, spec.urdf_path),
        }

    def _robot_visualization_spec(self, model: str) -> RobotVisualizationSpec:
        try:
            return get_robot_visualization_spec(model)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Robot model '{model}' is not configured") from exc

    def _normalize_trajectory_signal(self, signal: str) -> TrajectorySignal:
        normalized = signal.strip().lower()
        if normalized in {"action", "state"}:
            return normalized  # type: ignore[return-value]
        raise HTTPException(status_code=400, detail=f"Unsupported robot trajectory signal '{signal}'")

    def _resolve_context(self, *, dataset: str | None, source: str, path: str | None) -> tuple[str, str, Path]:
        resolved_source = self._normalize_source(source)
        if resolved_source == "remote":
            if not dataset or not dataset.strip():
                raise HTTPException(status_code=400, detail="Remote inspect requests require dataset")
            return resolved_source, dataset.strip(), Path()
        if resolved_source == "local":
            if not dataset or not dataset.strip():
                raise HTTPException(status_code=400, detail="Local inspect requests require dataset")
            dataset_path = self.repository.dataset_materialized_path(dataset.strip())
            return resolved_source, dataset.strip(), dataset_path
        dataset_path = self._resolve_external_path(path or "")
        dataset_name = dataset.strip() if dataset and dataset.strip() else dataset_path.name
        return resolved_source, dataset_name, dataset_path

    def _resolve_external_path(self, raw_path: str) -> Path:
        if not raw_path.strip():
            raise HTTPException(status_code=400, detail="Path inspect requests require path")
        path = Path(raw_path).expanduser().resolve()
        if not path.is_dir() or not (path / "meta" / "info.json").is_file():
            raise HTTPException(status_code=404, detail=f"Dataset path '{raw_path}' not found")
        return path

    def _normalize_source(self, source: str) -> str:
        value = source.strip().lower()
        if value in {"remote", "local", "path"}:
            return value
        raise HTTPException(status_code=400, detail=f"Unsupported inspect source '{source}'")

    def _local_details(self, dataset_path: Path, dataset_name: str) -> dict[str, Any]:
        info = load_json_file(dataset_path / "meta" / "info.json")
        stats = load_json_file(dataset_path / "meta" / "stats.json")
        siblings = scan_dataset_siblings(dataset_path)
        episodes_meta = load_episodes_list_file(dataset_path)
        return build_explorer_overview_from_artifacts(
            dataset_name=dataset_name,
            info=info,
            stats=stats,
            siblings=siblings,
            episodes_meta=episodes_meta,
            dataset_path=dataset_path,
        )

    def _local_summary(self, dataset_path: Path, dataset_name: str) -> dict[str, Any]:
        info = load_json_file(dataset_path / "meta" / "info.json")
        episodes_meta = load_episodes_list_file(dataset_path)
        return build_explorer_summary_from_info(dataset_name, info, episodes_meta, dataset_path)

    def _local_episode_page(self, dataset_path: Path, dataset_name: str, page: int, page_size: int) -> dict[str, Any]:
        info = load_json_file(dataset_path / "meta" / "info.json")
        episodes_meta = load_episodes_list_file(dataset_path)
        return build_explorer_episode_page_from_artifacts(
            dataset_name=dataset_name,
            info=info,
            episodes_meta=episodes_meta,
            page=page,
            page_size=page_size,
            dataset_path=dataset_path,
        )

    def _local_episode_payload(
        self,
        dataset_path: Path,
        dataset_name: str,
        episode_index: int,
        *,
        preview: bool,
        source: str,
    ) -> dict[str, Any]:
        data = load_episode_data(dataset_path, episode_index)
        info = data.get("info", {})
        rows = data.get("rows", [])
        action_names = extract_action_names(info)
        state_names = extract_state_names(info)
        timestamps = [t for row in rows if (t := resolve_timestamp(row)) is not None]
        start_ts = timestamps[0] if timestamps else None
        end_ts = timestamps[-1] if timestamps else None
        duration_s = max(end_ts - start_ts, 0.0) if start_ts is not None and end_ts is not None else 0.0
        videos = self._episode_videos(
            dataset_path,
            dataset_name,
            data.get("video_files", []),
            source,
            info,
            data.get("episode_meta", {}),
            duration_s,
        )
        task_description = self._episode_task_description(dataset_path, data.get("episode_meta", {}), rows)
        return {
            "episode_index": episode_index,
            "task_description": task_description,
            "summary": {
                "row_count": len(rows),
                "fps": info.get("fps", 0),
                "duration_s": round(duration_s, 2),
                "video_count": len(videos),
            },
            "sample_rows": [] if preview else self._serialize_sample_rows(rows[:5]),
            "joint_trajectory": self._empty_joint_payload()
            if preview
            else build_joint_trajectory_payload(rows, action_names, state_names),
            "videos": videos,
        }

    def _episode_task_description(
        self,
        dataset_path: Path,
        episode_meta: dict[str, Any],
        rows: list[dict[str, Any]],
    ) -> str:
        direct_text = self._task_text(episode_meta)
        if direct_text:
            return direct_text

        for row in rows:
            direct_text = self._task_text(row)
            if direct_text:
                return direct_text

        task_index = self._task_index(episode_meta)
        if task_index is None:
            for row in rows:
                task_index = self._task_index(row)
                if task_index is not None:
                    break
        if task_index is None:
            return ""

        return self._task_lookup(dataset_path).get(task_index, "")

    def _task_lookup(self, dataset_path: Path) -> dict[int, str]:
        tasks_parquet = dataset_path / "meta" / "tasks.parquet"
        if tasks_parquet.is_file():
            rows = pq.read_table(tasks_parquet).to_pylist()
            return self._task_lookup_from_rows(rows)

        tasks_jsonl = dataset_path / "meta" / "tasks.jsonl"
        if not tasks_jsonl.is_file():
            return {}
        rows = [
            json.loads(line)
            for line in tasks_jsonl.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        return self._task_lookup_from_rows(rows)

    def _task_lookup_from_rows(self, rows: list[dict[str, Any]]) -> dict[int, str]:
        lookup: dict[int, str] = {}
        for row in rows:
            task_index = self._task_index(row)
            task_text = self._task_text(row)
            if task_index is not None and task_text:
                lookup[task_index] = task_text
        return lookup

    def _task_text(self, payload: dict[str, Any]) -> str:
        for key in (
            "task_description",
            "task",
            "task_label",
            "description",
            "task_desc",
            "instruction",
            "language_instruction",
            "language_instruction_2",
            "language_instruction_3",
        ):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        tasks = payload.get("tasks")
        if isinstance(tasks, list):
            for item in tasks:
                if isinstance(item, str) and item.strip():
                    return item.strip()
                if isinstance(item, dict):
                    text = self._task_text(item)
                    if text:
                        return text
        if isinstance(tasks, dict):
            return self._task_text(tasks)
        return ""

    def _task_index(self, payload: dict[str, Any]) -> int | None:
        value = payload.get("task_index")
        if isinstance(value, bool):
            return None
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            if text.lstrip("-").isdigit():
                return int(text)
        return None

    def _episode_videos(
        self,
        dataset_path: Path,
        dataset_name: str,
        video_files: list[Path],
        source: str,
        info: dict[str, Any],
        episode_meta: dict[str, Any],
        duration_s: float,
    ) -> list[dict[str, Any]]:
        videos: list[dict[str, Any]] = []
        for video_path in video_files:
            relative = video_path.relative_to(dataset_path).as_posix()
            if source == "path":
                url = (
                    f"/api/data/inspect/video/{quote(relative, safe='/')}"
                    f"?source=path&dataset_path={quote(dataset_path.as_posix(), safe='')}"
                )
            else:
                url = (
                    f"/api/data/inspect/video/{quote(relative, safe='/')}"
                    f"?source=local&dataset={quote(dataset_name, safe='')}"
                )
            video_key = video_key_from_relative_path(relative, info)
            clip_start, clip_end = video_clip_bounds(episode_meta, video_key, duration_s)
            videos.append({
                "path": relative,
                "url": url,
                "stream": video_key or Path(relative).stem,
                "from_timestamp": clip_start,
                "to_timestamp": clip_end,
            })
        return videos

    def _serialize_sample_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for row in rows:
            serialized: dict[str, Any] = {}
            for key, value in row.items():
                if isinstance(value, list) and len(value) > 6:
                    serialized[key] = value[:4] + ["..."]
                elif hasattr(value, "tolist"):
                    lst = value.tolist()
                    serialized[key] = lst[:4] + ["..."] if len(lst) > 6 else lst
                else:
                    serialized[key] = value
            result.append(serialized)
        return result

    def _empty_joint_payload(self) -> dict[str, Any]:
        return {
            "x_axis_key": "time",
            "x_values": [],
            "time_values": [],
            "frame_values": [],
            "joint_trajectories": [],
            "sampled_points": 0,
            "total_points": 0,
        }

    def _resolve_child_path(self, root: Path, relative_path: str) -> Path:
        path = PurePosixPath(relative_path.replace("\\", "/"))
        if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
            raise HTTPException(status_code=403, detail="Path traversal not allowed")
        root_path = root.resolve()
        resolved = (root_path / path.as_posix()).resolve()
        try:
            resolved.relative_to(root_path)
        except ValueError as exc:
            raise HTTPException(status_code=403, detail="Path traversal not allowed") from exc
        return resolved
