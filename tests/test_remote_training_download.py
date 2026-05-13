from __future__ import annotations

import asyncio
import io
import json
import tarfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from roboclaw.http.routes.collection_cloud import CloudApiError
from roboclaw.http.routes.train import (
    RemoteTrainStartRequest,
    register_train_routes,
    serialize_remote_request,
)
from roboclaw.http.remote_training_transfer import RemoteDownloadStream, RemoteTrainingConnection


def _make_tar(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w|") as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_download_streams_tar_and_keeps_regular_requests_available() -> None:
    actions: list[str] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = json.loads((await reader.readline()).decode("utf-8"))
            actions.append(request["action"])
            if request["action"] == "结果下载":
                writer.write(_make_tar({"checkpoint.txt": b"weights"}))
                writer.write(json.dumps({"message": "download ok", "tasks": []}).encode("utf-8") + b"\n")
            else:
                writer.write(json.dumps({"message": "sync success", "tasks": []}).encode("utf-8") + b"\n")
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    host, port = server.sockets[0].getsockname()[:2]
    connection = RemoteTrainingConnection(host, port)
    try:
        download = await connection.download(
            serialize_remote_request(RemoteTrainStartRequest(username="alice", taskName="job1", action="结果下载")),
            "job1-result.tar",
        )
        assert isinstance(download, RemoteDownloadStream)
        assert download.response == {"message": "download started"}

        tar_bytes = b""
        async for chunk in download.chunks:
            tar_bytes += chunk

        with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as tar:
            member = tar.extractfile("checkpoint.txt")
            assert member is not None
            assert member.read() == b"weights"

        response = await connection.request(
            serialize_remote_request(RemoteTrainStartRequest(username="alice", action="任务同步"))
        )
        assert response == {"message": "sync success", "tasks": []}
        assert actions == ["结果下载", "任务同步"]
    finally:
        await connection.close()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_download_returns_json_error_without_waiting_for_socket_close() -> None:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.readline()
        writer.write(json.dumps({"message": "job is running", "tasks": []}).encode("utf-8") + b"\n")
        await writer.drain()
        await asyncio.sleep(1)
        writer.close()
        await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    host, port = server.sockets[0].getsockname()[:2]
    connection = RemoteTrainingConnection(host, port)
    try:
        response = await asyncio.wait_for(
            connection.download(
                serialize_remote_request(RemoteTrainStartRequest(username="alice", taskName="job1", action="结果下载")),
                "job1-result.tar",
            ),
            timeout=0.5,
        )
        assert response == {"message": "job is running", "tasks": []}
    finally:
        await connection.close()
        server.close()
        await server.wait_closed()


def test_remote_train_start_returns_cloud_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeCloud:
        async def request(self, method: str, path: str, **kwargs: object) -> object:
            assert method == "POST"
            assert path == "/train/remote/start"
            assert kwargs["authorization"] == "Bearer token"
            raise CloudApiError(402, "训练积分不足")

    fake_cloud = FakeCloud()
    monkeypatch.setattr("roboclaw.http.routes.train.EvoDataCloudClient", lambda api_url: fake_cloud)
    app = FastAPI()
    register_train_routes(
        app,
        object(),  # type: ignore[arg-type]
        collection_config=type("Config", (), {"api_url": "http://fake"})(),
    )
    client = TestClient(app, raise_server_exceptions=False)

    response = client.post(
        "/api/train/remote/start",
        headers={"Authorization": "Bearer token"},
        json={"username": "alice", "taskName": "job1", "action": "开始训练"},
    )

    assert response.status_code == 402
    assert response.json()["detail"] == "训练积分不足"


def test_remote_download_progress_returns_cloud_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeCloud:
        async def request(self, method: str, path: str, **kwargs: object) -> object:
            assert method == "GET"
            assert path == "/train/remote/download/progress"
            assert kwargs["authorization"] == "Bearer token"
            assert kwargs["params"] == {"downloadId": "download-1"}
            raise CloudApiError(401, "登录已过期")

    fake_cloud = FakeCloud()
    monkeypatch.setattr("roboclaw.http.routes.train.EvoDataCloudClient", lambda api_url: fake_cloud)
    app = FastAPI()
    register_train_routes(
        app,
        object(),  # type: ignore[arg-type]
        collection_config=type("Config", (), {"api_url": "http://fake"})(),
    )
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get(
        "/api/train/remote/download/progress?downloadId=download-1",
        headers={"Authorization": "Bearer token"},
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "登录已过期"
