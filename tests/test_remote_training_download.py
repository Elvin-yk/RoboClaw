from __future__ import annotations

import asyncio
import io
import json
import tarfile

import pytest

from roboclaw.http.routes.train import (
    RemoteTrainStartRequest,
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
