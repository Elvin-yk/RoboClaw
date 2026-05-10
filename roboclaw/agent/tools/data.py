"""Data bounded-context tool for the in-app RoboClaw AI."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

from roboclaw.agent.tools.base import Tool
from roboclaw.bus.events import OutboundMessage
from roboclaw.data.application import DataService

SendCallback = Callable[[OutboundMessage], Awaitable[None]]


class DataTool(Tool):
    """Let RoboClaw AI inspect and trigger data lifecycle operations."""

    def __init__(self, send_callback: SendCallback | None = None, data_service: DataService | None = None):
        self._send_callback = send_callback
        self._data = data_service or DataService()
        self._channel = ""
        self._chat_id = ""
        self._context_by_session: dict[str, dict[str, Any]] = {}

    @property
    def name(self) -> str:
        return "data"

    @property
    def description(self) -> str:
        return (
            "Control RoboClaw's data bounded context: list datasets/packages, inspect local or remote "
            "datasets, run dataset diagnosis/cleaning, materialize DatasetPackage directories, run package data "
            "evaluation, manage semantic annotations, upload packages, and read DataJob status."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "get_current_page_data",
                        "list_datasets",
                        "list_packages",
                        "get_overview",
                        "import_dataset",
                        "get_inspect_summary",
                        "get_inspect_details",
                        "get_inspect_episodes",
                        "run_diagnosis",
                        "run_clean",
                        "delete_dataset",
                        "create_package",
                        "delete_package",
                        "upload_package",
                        "get_evaluation_defaults",
                        "get_evaluation_results",
                        "run_evaluation",
                        "get_annotation_workspace",
                        "save_annotations",
                        "run_prototype",
                        "run_propagation",
                        "job_status",
                        "cancel_job",
                    ],
                },
                "dataset": {"type": "string"},
                "dataset_ids": {"type": "array", "items": {"type": "string"}},
                "package_id": {"type": "string"},
                "source": {"type": "string", "enum": ["remote", "local", "path"]},
                "path": {"type": "string"},
                "page": {"type": "integer", "minimum": 1},
                "page_size": {"type": "integer", "minimum": 1, "maximum": 200},
                "include_videos": {"type": "boolean"},
                "force": {"type": "boolean"},
                "repo_id": {"type": "string"},
                "token": {"type": "string"},
                "private": {"type": "boolean"},
                "selected_validators": {"type": "array", "items": {"type": "string"}},
                "threshold_overrides": {"type": "object", "additionalProperties": {"type": "number"}},
                "episode_indices": {"type": "array", "items": {"type": "integer"}},
                "episode_index": {"type": "integer", "minimum": 0},
                "task_context": {"type": "object"},
                "annotations": {"type": "array", "items": {"type": "object"}},
                "cluster_count": {"type": "integer", "minimum": 1},
                "candidate_limit": {"type": "integer", "minimum": 1},
                "quality_filter_mode": {"type": "string", "enum": ["passed", "failed", "all", "raw"]},
                "source_episode_index": {"type": "integer", "minimum": 0},
                "job_id": {"type": "string"},
            },
            "required": ["action"],
            "additionalProperties": False,
        }

    async def execute(
        self,
        action: str,
        dataset: str = "",
        dataset_ids: list[str] | None = None,
        package_id: str = "",
        source: str = "local",
        path: str = "",
        page: int = 1,
        page_size: int = 50,
        include_videos: bool = True,
        force: bool = False,
        repo_id: str = "",
        token: str = "",
        private: bool = False,
        selected_validators: list[str] | None = None,
        threshold_overrides: dict[str, float] | None = None,
        episode_indices: list[int] | None = None,
        episode_index: int = 0,
        task_context: dict[str, Any] | None = None,
        annotations: list[dict[str, Any]] | None = None,
        cluster_count: int | None = None,
        candidate_limit: int = 200,
        quality_filter_mode: str = "passed",
        source_episode_index: int | None = None,
        job_id: str = "",
    ) -> str:
        context = self._current_context()
        dataset = dataset.strip() or self._default_dataset(context)
        package_id = package_id.strip() or self._default_package(context)

        if action == "get_current_page_data":
            return _json(await self._current_page_data(context, dataset, package_id, source, path, page, page_size))
        if action == "list_datasets":
            return _json({"datasets": self._data.library.list_datasets()})
        if action == "list_packages":
            return _json({"packages": self._data.packages.list_packages()})
        if action == "get_overview":
            return _json(self._data.overview.overview())
        if action == "import_dataset":
            if not dataset:
                return _json({"error": "dataset is required"})
            job = self._data.library.start_import(dataset_id=dataset, include_videos=include_videos, force=force)
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action.startswith("get_inspect_"):
            return await self._inspect_action(action, dataset, source, path, page, page_size)
        if action == "run_diagnosis":
            ids = dataset_ids or ([dataset] if dataset else [])
            job = self._data.clean.start_diagnosis_run(dataset_ids=ids)
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "run_clean":
            ids = dataset_ids or ([dataset] if dataset else [])
            job = self._data.clean.start_auto_clean_run(dataset_ids=ids, chain_id="default", force=True)
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "delete_dataset":
            if not dataset:
                return _json({"error": "dataset is required"})
            payload = self._data.library.delete_dataset(dataset)
            event_sent = await self._send_app_event({"type": "data.library_changed", "dataset_id": dataset})
            return _json({**payload, "event_sent": event_sent})
        if action == "create_package":
            if not package_id:
                return _json({"error": "package_id is required"})
            payload = self._data.packages.create_package(
                package_id=package_id,
                dataset_ids=dataset_ids or [],
                groups={},
                force=force,
            )
            event_sent = await self._send_app_event({"type": "data.library_changed", "package_id": package_id})
            return _json({**payload, "event_sent": event_sent})
        if action == "delete_package":
            resolved_package = self._require_package(package_id)
            payload = self._data.packages.delete_package(resolved_package)
            event_sent = await self._send_app_event({"type": "data.library_changed", "package_id": resolved_package})
            return _json({**payload, "event_sent": event_sent})
        if action == "upload_package":
            resolved_package = self._require_package(package_id)
            if not repo_id.strip():
                return _json({"error": "repo_id is required"})
            job = self._data.packages.start_upload(
                package_id=resolved_package,
                repo_id=repo_id,
                token=token,
                private=private,
            )
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "get_evaluation_defaults":
            return _json(self._data.evaluation.defaults(self._require_package(package_id)))
        if action == "get_evaluation_results":
            return _json(self._data.evaluation.results(self._require_package(package_id)))
        if action == "run_evaluation":
            resolved_package = self._require_package(package_id)
            defaults = self._data.evaluation.defaults(resolved_package)
            validators = selected_validators or [str(item) for item in defaults.get("selected_validators", ["metadata"])]
            job = self._data.evaluation.start_run(
                package_id=resolved_package,
                selected_validators=validators,
                episode_indices=episode_indices,
                threshold_overrides=threshold_overrides,
            )
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "get_annotation_workspace":
            return _json(self._data.annotation.workspace(package_id=self._require_package(package_id), episode_index=episode_index))
        if action == "save_annotations":
            return _json(self._data.annotation.save_annotations(
                package_id=self._require_package(package_id),
                episode_index=episode_index,
                task_context=task_context or {},
                annotations=annotations or [],
            ))
        if action == "run_prototype":
            job = self._data.annotation.start_prototype_run(
                package_id=self._require_package(package_id),
                cluster_count=cluster_count,
                candidate_limit=candidate_limit,
                episode_indices=episode_indices,
                quality_filter_mode=quality_filter_mode,
            )
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "run_propagation":
            if source_episode_index is None:
                return _json({"error": "source_episode_index is required"})
            job = self._data.annotation.start_propagation_run(
                package_id=self._require_package(package_id),
                source_episode_index=source_episode_index,
            )
            event_sent = await self._send_app_event({"type": "data.job_started", "job_id": job["job_id"]})
            return _json({**job, "event_sent": event_sent})
        if action == "job_status":
            if not job_id:
                return _json({"error": "job_id is required"})
            return _json(self._data.jobs.snapshot(job_id).to_dict())
        if action == "cancel_job":
            if not job_id:
                return _json({"error": "job_id is required"})
            return _json(self._data.jobs.cancel(job_id).to_dict())
        return _json({"error": f"Unknown data action: {action}"})

    def set_context(
        self,
        channel: str,
        chat_id: str,
        message_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._channel = channel
        self._chat_id = chat_id
        app_context = _extract_app_context(metadata or {})
        if app_context:
            self._context_by_session[self._session_key(channel, chat_id)] = app_context

    def _current_context(self) -> dict[str, Any]:
        return deepcopy(self._context_by_session.get(self._session_key(self._channel, self._chat_id), {}))

    def _default_dataset(self, context: dict[str, Any]) -> str:
        data = context.get("data")
        if isinstance(data, dict):
            selected = data.get("selected_dataset_ids")
            if isinstance(selected, list) and selected:
                return str(selected[0])
        inspect = context.get("inspect")
        if isinstance(inspect, dict):
            return str(inspect.get("dataset") or "")
        return str(context.get("dataset") or "")

    def _default_package(self, context: dict[str, Any]) -> str:
        data = context.get("data")
        if isinstance(data, dict):
            packages = data.get("packages")
            if isinstance(packages, list) and packages:
                first = packages[0]
                if isinstance(first, dict):
                    return str(first.get("id") or "")
        return str(context.get("package_id") or "")

    async def _current_page_data(
        self,
        context: dict[str, Any],
        dataset: str,
        package_id: str,
        source: str,
        path: str,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        route = _normalize_route(str(context.get("route") or context.get("pathname") or ""))
        if route.startswith("/data/analysis"):
            payload: dict[str, Any] = {"page": "data_analysis", "context": context}
            if dataset or path:
                params = self._inspect_params(dataset, source, path)
                payload["summary"] = await self._data.inspect.summary(**params)
                payload["episodes"] = await self._data.inspect.episodes(**params, page=page, page_size=page_size)
            if package_id:
                payload["defaults"] = self._data.evaluation.defaults(package_id)
                payload["results"] = self._data.evaluation.results(package_id)
            return payload
        if route.startswith("/data/qc"):
            return {
                "page": "data_qc",
                "context": context,
                "datasets": self._data.library.list_datasets(),
            }
        if route.startswith("/data/manage") or route == "/data":
            return {
                "page": "data_manage",
                "context": context,
                "datasets": self._data.library.list_datasets(),
                "packages": self._data.packages.list_packages(),
            }
        if route.startswith("/data/annotation") and package_id:
            return {
                "page": "data_annotation",
                "context": context,
                "workspace": self._data.annotation.workspace(package_id=package_id, episode_index=0),
            }
        return {"page": route or "data", "context": context, "overview": self._data.overview.overview()}

    async def _inspect_action(
        self,
        action: str,
        dataset: str,
        source: str,
        path: str,
        page: int,
        page_size: int,
    ) -> str:
        params = self._inspect_params(dataset, source, path)
        if action == "get_inspect_summary":
            return _json(await self._data.inspect.summary(**params))
        if action == "get_inspect_details":
            return _json(await self._data.inspect.details(**params))
        return _json(await self._data.inspect.episodes(**params, page=page, page_size=page_size))

    def _inspect_params(self, dataset: str, source: str, path: str) -> dict[str, Any]:
        return {"dataset": dataset or None, "source": source, "path": path or None}

    def _require_package(self, package_id: str) -> str:
        if not package_id:
            raise ValueError("package_id is required")
        return package_id

    async def _send_app_event(self, app_event: dict[str, Any]) -> bool:
        if not self._send_callback or self._channel != "web" or not self._chat_id:
            return False
        context = deepcopy(self._context_by_session.get(self._session_key(self._channel, self._chat_id), {}))
        if context:
            app_event.setdefault("context", context)
        await self._send_callback(
            OutboundMessage(
                channel=self._channel,
                chat_id=self._chat_id,
                content="",
                metadata={"app_event": app_event},
            )
        )
        return True

    @staticmethod
    def _session_key(channel: str, chat_id: str) -> str:
        return f"{channel}:{chat_id}"


def _extract_app_context(metadata: dict[str, Any]) -> dict[str, Any]:
    raw = metadata.get("app_context") or metadata.get("appContext") or metadata.get("app")
    if not isinstance(raw, dict):
        return {}
    context = deepcopy(raw)
    route = str(context.get("route") or context.get("pathname") or "").strip()
    if route:
        context["route"] = _normalize_route(route)
    return context


def _normalize_route(value: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    if "://" in clean:
        from urllib.parse import urlparse

        parsed = urlparse(clean)
        clean = parsed.path or "/"
    if "?" in clean:
        clean = clean.split("?", 1)[0]
    if "#" in clean:
        clean = clean.split("#", 1)[0]
    if clean.startswith("/"):
        return clean.rstrip("/") or "/"
    return clean


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)
