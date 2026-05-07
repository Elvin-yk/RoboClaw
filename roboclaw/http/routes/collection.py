"""Local BFF for evo-data collection tasks."""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx
from fastapi import Body, FastAPI, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel

if TYPE_CHECKING:
    from roboclaw.embodied.service import EmbodiedService


class CollectionRunStartRequest(BaseModel):
    assignment_id: str


class CloudApiError(RuntimeError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class EvoDataCloudClient:
    def __init__(self, api_url: str) -> None:
        self.api_url = api_url.rstrip("/")

    def _url(self, path: str) -> str:
        return f"{self.api_url}/{path.lstrip('/')}"

    async def request(
        self,
        method: str,
        path: str,
        *,
        authorization: str | None = None,
        json_body: Any | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        headers: dict[str, str] = {}
        if authorization:
            headers["Authorization"] = authorization
        try:
            async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
                response = await client.request(
                    method,
                    self._url(path),
                    headers=headers,
                    json=json_body,
                    params=params,
                )
        except httpx.HTTPError as exc:
            raise CloudApiError(502, f"evo-data-dev unreachable: {exc}") from exc
        if response.status_code >= 400:
            raise CloudApiError(response.status_code, _response_detail(response))
        if response.status_code == 204:
            return None
        return response.json()

    async def proxy_raw(self, request: Request, path: str, authorization: str | None) -> Response:
        headers: dict[str, str] = {}
        if authorization:
            headers["Authorization"] = authorization
        content = await request.body()
        if content:
            headers["Content-Type"] = request.headers.get("content-type", "application/json")
        try:
            async with httpx.AsyncClient(timeout=15.0, trust_env=False) as client:
                response = await client.request(
                    request.method,
                    self._url(path),
                    headers=headers,
                    params=list(request.query_params.multi_items()),
                    content=content or None,
                )
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"evo-data-dev unreachable: {exc}") from exc
        return Response(
            content=response.content,
            status_code=response.status_code,
            media_type=response.headers.get("content-type"),
        )


@dataclass
class ActiveCollectionRun:
    run_id: str
    assignment_id: str
    dataset_name: str
    task_params: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "assignment_id": self.assignment_id,
            "dataset_name": self.dataset_name,
            "task_params": self.task_params,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ActiveCollectionRun":
        return cls(
            run_id=str(data["run_id"]),
            assignment_id=str(data["assignment_id"]),
            dataset_name=str(data["dataset_name"]),
            task_params=dict(data.get("task_params") or {}),
        )


class CollectionCoordinator:
    def __init__(
        self,
        *,
        service: EmbodiedService,
        cloud: EvoDataCloudClient,
        state_dir: Path,
        heartbeat_interval_s: int,
        finish_retry_interval_s: int,
    ) -> None:
        self.service = service
        self.cloud = cloud
        self.state_dir = state_dir
        self.heartbeat_interval_s = heartbeat_interval_s
        self.finish_retry_interval_s = finish_retry_interval_s
        self.active_path = state_dir / "active_collection_run.json"
        self.pending_path = state_dir / "pending_collection_finishes.json"
        self.active = self._load_active()
        self._active_authorization: str | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._retry_task: asyncio.Task | None = None

    def status(self) -> dict[str, Any]:
        return {
            "active_run": self.active.to_dict() if self.active else None,
            "pending_finish_count": len(self._load_pending()),
            "session": self.service.get_status(),
        }

    async def start(self, assignment_id: str, authorization: str | None) -> dict[str, Any]:
        self._require_auth(authorization)
        if self.active is not None:
            raise HTTPException(409, "本机已有进行中的云端采集")

        cloud_run = await self.cloud.request(
            "POST",
            "/collection/runs/start",
            authorization=authorization,
            json_body={
                "assignment_id": assignment_id,
                "client_info": self._client_info(include_hardware=True),
            },
        )
        task_params = dict(cloud_run.get("task_params") or {})
        active = ActiveCollectionRun(
            run_id=str(cloud_run["id"]),
            assignment_id=assignment_id,
            dataset_name=str(cloud_run["dataset_name"]),
            task_params=task_params,
        )
        try:
            dataset_name = await self.service.start_recording(
                task=str(task_params["task"]),
                num_episodes=int(task_params.get("num_episodes") or 10),
                fps=int(task_params.get("fps") or 30),
                episode_time_s=int(task_params.get("episode_time_s") or 300),
                reset_time_s=int(task_params.get("reset_time_s") or 10),
                dataset_name=active.dataset_name,
                use_cameras=bool(task_params.get("use_cameras", True)),
            )
        except (RuntimeError, KeyError, ValueError) as exc:
            await self._finish_or_queue(
                active,
                authorization,
                status="failed",
                error_message=str(exc),
                metadata={"local_start_failed": True},
            )
            raise HTTPException(400, str(exc)) from exc

        active.dataset_name = dataset_name
        self.active = active
        self._active_authorization = authorization
        self._save_active()
        self._ensure_heartbeat()
        return {
            "status": "recording",
            "run": cloud_run,
            "dataset_name": dataset_name,
            "task_params": task_params,
        }

    async def stop(self, authorization: str | None) -> dict[str, Any]:
        self._require_auth(authorization)
        if self.active is None:
            session = self.service.get_status()
            session_error = str(session.get("error") or "")
            if session.get("state") == "error" or session_error:
                await self.service.dismiss_error()
                return {
                    "status": "failed",
                    "run": None,
                    "local_stop_error": session_error or "session error cleared",
                    "pending_finish_count": len(self._load_pending()),
                }
            return {
                "status": "idle",
                "run": None,
                "local_stop_error": None,
                "pending_finish_count": len(self._load_pending()),
            }

        active = self.active
        session_before_stop = self.service.get_status()
        stop_error = ""
        try:
            await self.service.stop()
        except Exception as exc:
            stop_error = str(exc)
        session_after_stop = self.service.get_status()
        session_error = str(session_before_stop.get("error") or session_after_stop.get("error") or "")
        local_failed = (
            bool(stop_error)
            or session_before_stop.get("state") == "error"
            or session_after_stop.get("state") == "error"
            or bool(session_error)
        )
        finish_status = "failed" if local_failed else "finished"
        error_message = stop_error or session_error or None
        finish_payload = self._finish_payload(
            active,
            status=finish_status,
            error_message=error_message,
        )
        if local_failed:
            await self.service.dismiss_error()
        try:
            cloud_run = await self.cloud.request(
                "POST",
                f"/collection/runs/{active.run_id}/finish",
                authorization=authorization,
                json_body=finish_payload,
            )
        except CloudApiError as exc:
            self._queue_pending(active, finish_payload)
            self._clear_active()
            self._ensure_retry(authorization)
            return {
                "status": "pending_cloud_finish",
                "detail": exc.detail,
                "local_stop_error": stop_error or None,
                "pending_finish_count": len(self._load_pending()),
            }

        self._clear_active()
        return {
            "status": finish_status,
            "run": cloud_run,
            "local_stop_error": stop_error or None,
            "pending_finish_count": len(self._load_pending()),
        }

    async def retry_pending(self, authorization: str | None) -> dict[str, Any]:
        self._require_auth(authorization)
        return await self._retry_pending_once(authorization)

    async def heartbeat_once(self) -> dict[str, Any]:
        if self.active is None or self._active_authorization is None:
            return {"status": "idle"}
        payload = self._heartbeat_payload(self.active)
        run = await self.cloud.request(
            "POST",
            f"/collection/runs/{self.active.run_id}/heartbeat",
            authorization=self._active_authorization,
            json_body=payload,
        )
        return {"status": "heartbeat_sent", "run": run}

    def _ensure_heartbeat(self) -> None:
        if self._heartbeat_task is not None and not self._heartbeat_task.done():
            return
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _heartbeat_loop(self) -> None:
        while self.active is not None:
            await asyncio.sleep(max(self.heartbeat_interval_s, 1))
            if self.active is None:
                return
            try:
                await self.heartbeat_once()
            except CloudApiError:
                continue

    def _ensure_retry(self, authorization: str | None) -> None:
        if not authorization:
            return
        self._active_authorization = authorization
        if self._retry_task is not None and not self._retry_task.done():
            return
        self._retry_task = asyncio.create_task(self._retry_loop())

    async def _retry_loop(self) -> None:
        while self._load_pending() and self._active_authorization:
            await asyncio.sleep(max(self.finish_retry_interval_s, 1))
            await self._retry_pending_once(self._active_authorization)

    async def _retry_pending_once(self, authorization: str | None) -> dict[str, Any]:
        self._require_auth(authorization)
        pending = self._load_pending()
        remaining: list[dict[str, Any]] = []
        synced = 0
        for item in pending:
            try:
                await self.cloud.request(
                    "POST",
                    f"/collection/runs/{item['run_id']}/finish",
                    authorization=authorization,
                    json_body=item["payload"],
                )
                synced += 1
            except CloudApiError:
                remaining.append(item)
        self._save_pending(remaining)
        return {"status": "ok", "synced": synced, "pending_finish_count": len(remaining)}

    async def _finish_or_queue(
        self,
        active: ActiveCollectionRun,
        authorization: str | None,
        *,
        status: str,
        error_message: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        payload = self._finish_payload(
            active,
            status=status,
            error_message=error_message,
            metadata_override=metadata,
        )
        try:
            await self.cloud.request(
                "POST",
                f"/collection/runs/{active.run_id}/finish",
                authorization=authorization,
                json_body=payload,
            )
        except CloudApiError:
            self._queue_pending(active, payload)
            self._ensure_retry(authorization)

    def _heartbeat_payload(self, active: ActiveCollectionRun) -> dict[str, Any]:
        metrics = self._local_metrics(active)
        return {
            "saved_episodes": metrics["saved_episodes"],
            "total_frames": metrics["total_frames"],
            "fps": metrics["fps"],
            "duration_seconds": metrics["duration_seconds"],
            "client_info": self._client_info(include_hardware=False),
        }

    def _finish_payload(
        self,
        active: ActiveCollectionRun,
        *,
        status: str,
        error_message: str | None = None,
        metadata_override: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        metrics = self._local_metrics(active)
        return {
            "status": status,
            "saved_episodes": metrics["saved_episodes"],
            "total_frames": metrics["total_frames"],
            "fps": metrics["fps"],
            "duration_seconds": metrics["duration_seconds"],
            "metadata": metadata_override or metrics["metadata"],
            "client_info": self._client_info(include_hardware=True),
            "error_message": error_message,
        }

    def _local_metrics(self, active: ActiveCollectionRun) -> dict[str, Any]:
        status = self.service.get_status()
        info = self._dataset_info(active.dataset_name)
        fps = _positive_int(info.get("fps")) or _positive_int(status.get("fps")) or _positive_int(active.task_params.get("fps"))
        total_frames = _non_negative_int(info.get("total_frames"))
        if total_frames is None:
            total_frames = _non_negative_int(status.get("total_frames")) or 0
        saved_episodes = _non_negative_int(info.get("total_episodes"))
        if saved_episodes is None:
            saved_episodes = _non_negative_int(status.get("saved_episodes")) or 0
        duration = round(total_frames / fps) if fps and total_frames else _non_negative_int(status.get("elapsed_seconds")) or 0
        metadata = {
            "dataset_name": active.dataset_name,
            "dataset_root": str(self.service.datasets.root),
            "info_json": info or None,
        }
        return {
            "saved_episodes": saved_episodes,
            "total_frames": total_frames,
            "fps": fps,
            "duration_seconds": duration,
            "metadata": metadata,
        }

    def _dataset_info(self, dataset_name: str) -> dict[str, Any]:
        info_path = self.service.datasets.root / "local" / dataset_name / "meta" / "info.json"
        if not info_path.is_file():
            return {}
        with info_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}

    def _client_info(self, *, include_hardware: bool) -> dict[str, Any]:
        info: dict[str, Any] = {
            "client": "roboclaw",
            "hostname": socket.gethostname(),
            "session": self.service.get_status(),
        }
        if include_hardware:
            info["hardware"] = self.service.get_hardware_status()
        return info

    def _load_active(self) -> ActiveCollectionRun | None:
        if not self.active_path.is_file():
            return None
        with self.active_path.open("r", encoding="utf-8") as fh:
            return ActiveCollectionRun.from_dict(json.load(fh))

    def _save_active(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        if self.active is None:
            self.active_path.unlink(missing_ok=True)
            return
        _atomic_write_json(self.active_path, self.active.to_dict())

    def _clear_active(self) -> None:
        self.active = None
        self._active_authorization = None
        self._save_active()

    def _load_pending(self) -> list[dict[str, Any]]:
        if not self.pending_path.is_file():
            return []
        with self.pending_path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []

    def _save_pending(self, items: list[dict[str, Any]]) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(self.pending_path, items)

    def _queue_pending(self, active: ActiveCollectionRun, payload: dict[str, Any]) -> None:
        pending = self._load_pending()
        pending.append({
            "run_id": active.run_id,
            "assignment_id": active.assignment_id,
            "dataset_name": active.dataset_name,
            "payload": payload,
        })
        self._save_pending(pending)

    def _require_auth(self, authorization: str | None) -> None:
        if not authorization:
            raise HTTPException(401, "未登录")


def register_collection_routes(
    app: FastAPI,
    service: EmbodiedService,
    *,
    collection_config: Any | None = None,
    cloud_client: EvoDataCloudClient | None = None,
    auth_client: EvoDataCloudClient | None = None,
    state_dir: Path | None = None,
) -> None:
    api_url = getattr(collection_config, "api_url", "http://8.136.130.234/dev-api")
    auth_api_url = getattr(collection_config, "auth_api_url", "https://api.evomind-tech.com")
    heartbeat_interval_s = int(getattr(collection_config, "heartbeat_interval_s", 30))
    finish_retry_interval_s = int(getattr(collection_config, "finish_retry_interval_s", 60))
    cloud = cloud_client or EvoDataCloudClient(api_url)
    auth_cloud = auth_client or EvoDataCloudClient(auth_api_url)
    local_state_dir = state_dir or service.datasets.root.parent / "collection_state"
    coordinator = CollectionCoordinator(
        service=service,
        cloud=cloud,
        state_dir=local_state_dir,
        heartbeat_interval_s=heartbeat_interval_s,
        finish_retry_interval_s=finish_retry_interval_s,
    )
    app.state.collection_coordinator = coordinator
    app.state.evo_auth_api_url = auth_cloud.api_url

    @app.api_route("/api/evo/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
    async def evo_proxy(
        path: str,
        request: Request,
        authorization: str | None = Header(None),
    ) -> Response:
        return await auth_cloud.proxy_raw(request, f"/{path}", authorization)

    @app.get("/api/collection/status")
    async def collection_status() -> dict[str, Any]:
        return coordinator.status()

    @app.get("/api/collection/today")
    async def collection_today(authorization: str | None = Header(None)) -> Any:
        coordinator._require_auth(authorization)
        return await _cloud_or_http_exception(
            cloud.request("GET", "/collection/today", authorization=authorization)
        )

    @app.get("/api/collection/assignments")
    async def collection_assignments(
        target_date: str | None = Query(None),
        authorization: str | None = Header(None),
    ) -> Any:
        coordinator._require_auth(authorization)
        params = {"target_date": target_date} if target_date else None
        return await _cloud_or_http_exception(
            cloud.request(
                "GET",
                "/collection/my/assignments",
                authorization=authorization,
                params=params,
            )
        )

    @app.post("/api/collection/runs/start")
    async def collection_run_start(
        body: CollectionRunStartRequest,
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        try:
            return await coordinator.start(body.assignment_id, authorization)
        except CloudApiError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

    @app.post("/api/collection/runs/stop")
    async def collection_run_stop(
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        return await coordinator.stop(authorization)

    @app.post("/api/collection/runs/heartbeat")
    async def collection_run_heartbeat() -> dict[str, Any]:
        try:
            return await coordinator.heartbeat_once()
        except CloudApiError as exc:
            raise HTTPException(exc.status_code, exc.detail) from exc

    @app.post("/api/collection/pending/retry")
    async def collection_pending_retry(
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        return await coordinator.retry_pending(authorization)

    @app.get("/api/collection/publish/tasks")
    async def publish_tasks(
        include_inactive: bool = False,
        authorization: str | None = Header(None),
    ) -> Any:
        return await _cloud_or_http_exception(
            cloud.request(
                "GET",
                "/collection/admin/tasks",
                authorization=authorization,
                params={"include_inactive": include_inactive},
            )
        )

    @app.post("/api/collection/publish/tasks")
    async def publish_create_task(
        body: dict[str, Any] = Body(...),
        authorization: str | None = Header(None),
    ) -> Any:
        return await _cloud_or_http_exception(
            cloud.request("POST", "/collection/admin/tasks", authorization=authorization, json_body=body)
        )

    @app.patch("/api/collection/publish/tasks/{task_id}")
    async def publish_update_task(
        task_id: str,
        body: dict[str, Any] = Body(...),
        authorization: str | None = Header(None),
    ) -> Any:
        return await _cloud_or_http_exception(
            cloud.request(
                "PATCH",
                f"/collection/admin/tasks/{task_id}",
                authorization=authorization,
                json_body=body,
            )
        )

    @app.delete("/api/collection/publish/tasks/{task_id}")
    async def publish_delete_task(
        task_id: str,
        authorization: str | None = Header(None),
    ) -> Response:
        await _cloud_or_http_exception(
            cloud.request(
                "DELETE",
                f"/collection/admin/tasks/{task_id}",
                authorization=authorization,
            )
        )
        return Response(status_code=204)

    @app.post("/api/collection/publish/assignments")
    async def publish_upsert_assignment(
        body: dict[str, Any] = Body(...),
        authorization: str | None = Header(None),
    ) -> Any:
        return await _cloud_or_http_exception(
            cloud.request("POST", "/collection/admin/assignments", authorization=authorization, json_body=body)
        )

    @app.get("/api/collection/publish/progress")
    async def publish_progress(
        target_date: str | None = Query(None),
        authorization: str | None = Header(None),
    ) -> Any:
        params = {"target_date": target_date} if target_date else None
        return await _cloud_or_http_exception(
            cloud.request("GET", "/collection/admin/progress", authorization=authorization, params=params)
        )


async def _cloud_or_http_exception(awaitable: Any) -> Any:
    try:
        return await awaitable
    except CloudApiError as exc:
        raise HTTPException(exc.status_code, exc.detail) from exc


def _response_detail(response: httpx.Response) -> str:
    try:
        data = response.json()
    except json.JSONDecodeError:
        return f"HTTP {response.status_code}"
    detail = data.get("detail") if isinstance(data, dict) else None
    if isinstance(detail, str):
        return detail
    return f"HTTP {response.status_code}"


def _non_negative_int(value: Any) -> int | None:
    if value is None:
        return None
    return max(int(value), 0)


def _positive_int(value: Any) -> int | None:
    parsed = _non_negative_int(value)
    if parsed is None or parsed <= 0:
        return None
    return parsed


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    with tmp_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp_path.replace(path)
