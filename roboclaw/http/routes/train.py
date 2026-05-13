"""Training routes — policy training lifecycle."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from roboclaw.config.schema import EvoDataConfig
from roboclaw.embodied.service import EmbodiedService
from roboclaw.http.routes.collection import EvoDataCloudClient


class TrainStartRequest(BaseModel):
    dataset_name: str
    policy_type: str = "act"
    steps: int = 100_000
    device: str = "cuda"


class TrainStopRequest(BaseModel):
    job_id: str


class RemoteTrainStartRequest(BaseModel):
    username: str
    taskName: str = ""
    datasetPath: str | None = None
    steps: int | None = None
    saveFreq: int | None = None
    gpuCount: int | None = None
    gpuType: str | None = None
    batchSize: int | None = None
    policyType: str | None = None
    emptyDocker: bool | None = None
    sleepT: int | None = None
    logFreq: int | None = None
    downloadAll: bool | None = None
    downloadList: str | None = None
    account_id: str | None = None
    action: str


class RemoteDownloadProgress:
    def __init__(self) -> None:
        self._items: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def start(self, download_id: str, total_bytes: int) -> None:
        async with self._lock:
            self._items[download_id] = {
                "downloadId": download_id,
                "downloadedBytes": 0,
                "totalBytes": total_bytes,
                "status": "downloading",
                "updatedAt": time.time(),
            }

    def update_now(self, download_id: str, downloaded_bytes: int) -> None:
        item = self._items.get(download_id)
        if item is None:
            return
        item["downloadedBytes"] = downloaded_bytes
        item["updatedAt"] = time.time()

    async def finish(self, download_id: str) -> None:
        async with self._lock:
            item = self._items.get(download_id)
            if item is None:
                return
            item["downloadedBytes"] = item.get("totalBytes") or item.get("downloadedBytes", 0)
            item["status"] = "completed"
            item["updatedAt"] = time.time()

    async def fail(self, download_id: str, message: str) -> None:
        async with self._lock:
            item = self._items.setdefault(download_id, {"downloadId": download_id, "downloadedBytes": 0, "totalBytes": 0})
            item["status"] = "failed"
            item["message"] = message
            item["updatedAt"] = time.time()

    async def snapshot(self, download_id: str) -> dict[str, Any]:
        async with self._lock:
            item = self._items.get(download_id)
            if item is None:
                return {"downloadId": download_id, "downloadedBytes": 0, "totalBytes": 0, "status": "unknown"}
            return dict(item)


def serialize_remote_request(body: RemoteTrainStartRequest) -> bytes:
    return (json.dumps(body.model_dump(exclude_none=True), ensure_ascii=False) + "\n").encode("utf-8")


def register_train_routes(
    app: FastAPI,
    service: EmbodiedService,
    collection_config: EvoDataConfig | None = None,
) -> None:
    evo_data_config = collection_config or EvoDataConfig()
    cloud = EvoDataCloudClient(evo_data_config.api_url)

    @app.post("/api/train/start")
    async def train_start(body: TrainStartRequest) -> dict[str, Any]:
        result = await service.train.train(
            manifest=service.manifest,
            kwargs={
                "dataset_name": body.dataset_name,
                "policy_type": body.policy_type,
                "steps": body.steps,
                "device": body.device,
            },
            tty_handoff=None,
        )
        job_id = result.rsplit("Job ID:", 1)[-1].strip() if "Job ID:" in result else ""
        return {"message": result, "job_id": job_id}

    @app.post("/api/train/stop")
    async def train_stop(body: TrainStopRequest) -> dict[str, Any]:
        result = await service.train.stop_job(
            manifest=service.manifest,
            kwargs={"job_id": body.job_id},
            tty_handoff=None,
        )
        return {"message": result}

    @app.post("/api/train/remote/start", response_model=None)
    async def remote_train_start(
        body: RemoteTrainStartRequest,
        authorization: str | None = Header(None),
    ) -> Any:
        if not authorization:
            raise HTTPException(401, "未登录")
        return await cloud.request(
            "POST",
            "/train/remote/start",
            authorization=authorization,
            json_body=body.model_dump(exclude_none=True),
        )

    @app.get("/api/train/remote/download", response_model=None)
    async def remote_training_download(
        username: str,
        taskName: str,
        downloadId: str = "",
        downloadAll: bool = True,
        downloadList: str = "",
        expectedSize: int = 0,
        authorization: str | None = Header(None),
    ) -> Any:
        if not authorization:
            raise HTTPException(401, "未登录")
        return await _proxy_remote_download(
            cloud.api_url,
            authorization,
            {
                "username": username,
                "taskName": taskName,
                "downloadId": downloadId,
                "downloadAll": str(downloadAll),
                "downloadList": downloadList,
                "expectedSize": str(expectedSize),
            },
        )

    @app.get("/api/train/remote/download/progress")
    async def remote_training_download_progress(
        downloadId: str,
        authorization: str | None = Header(None),
    ) -> dict[str, Any]:
        if not authorization:
            raise HTTPException(401, "未登录")
        return await cloud.request(
            "GET",
            "/train/remote/download/progress",
            authorization=authorization,
            params={"downloadId": downloadId},
        )

    @app.get("/api/train/current")
    async def train_current() -> dict[str, Any]:
        return await service.train.current_job(
            manifest=service.manifest,
            kwargs={},
            tty_handoff=None,
        )

    @app.get("/api/train/status/{job_id}")
    async def train_status(job_id: str) -> dict[str, Any]:
        result = await service.train.job_status(
            manifest=service.manifest,
            kwargs={"job_id": job_id},
            tty_handoff=None,
        )
        return {"message": result}

    @app.get("/api/train/curve/{job_id}")
    async def train_curve(job_id: str) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(service.train.curve_data, job_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/train/datasets")
    async def train_datasets() -> dict[str, Any]:
        result = service.train.list_datasets(service.manifest)
        return {"message": result}

    @app.get("/api/train/policies")
    async def train_policies() -> dict[str, Any]:
        result = service.train.list_policies(service.manifest)
        return {"message": result}


async def _proxy_remote_download(
    api_url: str,
    authorization: str,
    params: dict[str, str],
) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=None, trust_env=False)
    request = client.build_request(
        "GET",
        f"{api_url.rstrip('/')}/train/remote/download",
        headers={"Authorization": authorization},
        params=params,
    )
    response = await client.send(request, stream=True)
    if response.status_code >= 400:
        content = await response.aread()
        await response.aclose()
        await client.aclose()
        raise HTTPException(response.status_code, content.decode("utf-8", errors="ignore") or "download failed")

    async def chunks() -> Any:
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    headers: dict[str, str] = {}
    for name in ("content-disposition", "x-remote-training-message", "x-remote-training-size"):
        if name in response.headers:
            headers[name] = response.headers[name]
    return StreamingResponse(
        chunks(),
        status_code=response.status_code,
        media_type=response.headers.get("content-type"),
        headers=headers,
    )
