from __future__ import annotations

import asyncio
import io
import json
import tarfile

import pytest

from roboclaw.http.routes.train import (
    RemoteDownloadResult,
    RemoteTrainStartRequest,
    RemoteTrainingConnection,
)


def _make_tar(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w|") as tar:
        for name, content in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


@pytest.mark.asyncio
async def test_download_reads_tar_json_response_and_reuses_connection() -> None:
    actions: list[str] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request = json.loads((await reader.readline()).decode("utf-8"))
            actions.append(request["action"])
            writer.write(_make_tar({"checkpoint.txt": b"weights"}))
            writer.write(json.dumps({"message": "download ok", "tasks": []}).encode("utf-8") + b"\n")
            await writer.drain()

            request = json.loads((await reader.readline()).decode("utf-8"))
            actions.append(request["action"])
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
            RemoteTrainStartRequest(username="alice", taskName="job1", action="结果下载")
        )
        assert isinstance(download, RemoteDownloadResult)
        assert download.response == {"message": "download ok", "tasks": []}

        with tarfile.open(download.file_path, "r:") as tar:
            member = tar.extractfile("checkpoint.txt")
            assert member is not None
            assert member.read() == b"weights"

        response = await connection.request(RemoteTrainStartRequest(username="alice", action="任务同步"))
        assert response == {"message": "sync success", "tasks": []}
        assert actions == ["结果下载", "任务同步"]
    finally:
        await connection.close()
        if "download" in locals() and isinstance(download, RemoteDownloadResult):
            download.file_path.unlink(missing_ok=True)
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
            connection.download(RemoteTrainStartRequest(username="alice", taskName="job1", action="结果下载")),
            timeout=0.5,
        )
        assert response == {"message": "job is running", "tasks": []}
    finally:
        await connection.close()
        server.close()
        await server.wait_closed()
