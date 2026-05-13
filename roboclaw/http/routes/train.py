"""Training routes — policy training lifecycle."""

from __future__ import annotations

import asyncio
import io
import json
import tarfile
import time
from typing import Any
from urllib.parse import quote

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from roboclaw.config.schema import EvoDataConfig
from roboclaw.embodied.service import EmbodiedService
from roboclaw.http.remote_training_transfer import RemoteTrainingConnection


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
    datasetName: str | None = None
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
    limit: int | None = None
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


def extract_loss_text(tar_bytes: bytes) -> str:
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:*") as tar:
        member = next((item for item in tar.getmembers() if item.isfile() and item.name.endswith("loss.txt")), None)
        if member is None:
            raise ValueError("loss.txt not found in loss archive")
        file_obj = tar.extractfile(member)
        if file_obj is None:
            raise ValueError("loss.txt cannot be read")
        return file_obj.read().decode("utf-8", errors="replace")


def build_loss_curve(username: str, task_name: str, loss_text: str, limit: int) -> dict[str, Any]:
    values: list[float] = []
    for line in loss_text.splitlines():
        try:
            values.append(float(line.strip()))
        except ValueError:
            continue

    bounded_limit = min(1000, max(1, limit))
    recent_values = values[-bounded_limit:]
    offset = len(values) - len(recent_values)
    best_loss = min(values) if values else None
    best_index = values.index(best_loss) + 1 if best_loss is not None else None
    return {
        "message": "loss refresh success",
        "job_id": f"{username}/{task_name}",
        "log_path": "loss.txt",
        "exists": True,
        "points": [
            {"step": str(offset + index + 1), "ep": 0, "epoch": 0, "loss": loss}
            for index, loss in enumerate(recent_values)
        ],
        "last_epoch": len(values) or None,
        "last_loss": values[-1] if values else None,
        "best_ep": best_index,
        "best_loss": best_loss,
        "updated_at": time.time(),
        "total": len(values),
        "offset": offset,
    }


def register_train_routes(
    app: FastAPI,
    service: EmbodiedService,
    collection_config: EvoDataConfig | None = None,
) -> None:
    evo_data_config = collection_config or EvoDataConfig()
    remote_training_connection = RemoteTrainingConnection(
        evo_data_config.remote_training_host,
        evo_data_config.remote_training_port,
    )
    remote_download_progress = RemoteDownloadProgress()
    app.router.add_event_handler("shutdown", remote_training_connection.close)

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
    async def remote_train_start(body: RemoteTrainStartRequest) -> Any:
        if body.action == "结果下载":
            return await remote_training_download(
                body.username,
                body.taskName,
                downloadAll=body.downloadAll if body.downloadAll is not None else True,
                downloadList=body.downloadList or "",
            )
        if body.action == "下载损失":
            return await remote_training_loss(body.username, body.taskName, body.limit or 1000)
        return await remote_training_connection.request(serialize_remote_request(body))

    @app.get("/api/train/remote/download", response_model=None)
    async def remote_training_download(
        username: str,
        taskName: str,
        downloadId: str = "",
        downloadAll: bool = True,
        downloadList: str = "",
        expectedSize: int = 0,
    ) -> Any:
        body = RemoteTrainStartRequest(
            username=username,
            taskName=taskName,
            action="结果下载",
            downloadAll=downloadAll,
            downloadList=downloadList,
        )
        total_bytes = max(0, expectedSize)
        if downloadId:
            await remote_download_progress.start(downloadId, total_bytes)
        filename_task = body.taskName.strip() or "remote-training-result"
        filename_scope = "all" if downloadAll else "selected"
        download = await remote_training_connection.download(
            serialize_remote_request(body),
            f"{filename_task}-{filename_scope}-result.tar",
            lambda downloaded: remote_download_progress.update_now(downloadId, downloaded) if downloadId else None,
        )
        if isinstance(download, dict):
            if downloadId:
                await remote_download_progress.fail(downloadId, str(download.get("message") or "download failed"))
            return download

        message = str(download.response.get("message") or "")

        async def tracked_chunks() -> Any:
            try:
                async for chunk in download.chunks:
                    yield chunk
                if downloadId:
                    await remote_download_progress.finish(downloadId)
            except Exception as exc:
                if downloadId:
                    await remote_download_progress.fail(downloadId, str(exc))
                raise

        return StreamingResponse(
            tracked_chunks(),
            media_type=download.media_type,
            headers={
                "Content-Disposition": f"attachment; filename*=UTF-8''{quote(download.filename)}",
                "X-Remote-Training-Message": quote(message, safe=""),
                "X-Remote-Training-Size": str(total_bytes),
            },
        )

    @app.get("/api/train/remote/download/progress")
    async def remote_training_download_progress(downloadId: str) -> dict[str, Any]:
        return await remote_download_progress.snapshot(downloadId)

    @app.get("/api/train/remote/loss")
    async def remote_training_loss(username: str, taskName: str, limit: int = 1000) -> dict[str, Any]:
        body = RemoteTrainStartRequest(username=username, taskName=taskName, action="下载损失")
        download = await remote_training_connection.download(
            serialize_remote_request(body),
            f"{taskName or 'remote-training'}-loss.tar",
        )
        if isinstance(download, dict):
            return download

        tar_bytes = bytearray()
        async for chunk in download.chunks:
            tar_bytes.extend(chunk)
        try:
            return build_loss_curve(username, taskName, extract_loss_text(bytes(tar_bytes)), limit)
        except (tarfile.TarError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc

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
