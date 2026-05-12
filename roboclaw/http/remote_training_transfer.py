"""Streaming bridge for EVO_Train result downloads."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Callable

TAR_BLOCK_SIZE = 512
TAR_RECORD_SIZE = TAR_BLOCK_SIZE * 20


@dataclass
class RemoteDownloadStream:
    filename: str
    media_type: str
    chunks: Any
    response: dict[str, Any]


class RemoteTrainingConnection:
    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._lock = asyncio.Lock()
        self._download_lock = asyncio.Lock()
        self._buffer = b""
        self._decoder = json.JSONDecoder()

    async def request(self, payload: bytes) -> dict[str, Any]:
        async with self._lock:
            try:
                await self._connect()
                writer = self._writer
                if writer is None:
                    raise ConnectionError("remote training connection is not available")
                writer.write(payload)
                await writer.drain()
                return await self._read_response()
            except (ConnectionError, OSError):
                await self.close()
                raise

    async def download(
        self,
        payload: bytes,
        filename: str,
        progress_callback: Callable[[int], None] | None = None,
    ) -> RemoteDownloadStream | dict[str, Any]:
        await self._download_lock.acquire()
        try:
            reader, writer = await asyncio.open_connection(self.host, self.port)
            writer.write(payload)
            await writer.drain()
            return await self._prepare_download_stream(filename, reader, writer, progress_callback)
        except Exception:
            self._download_lock.release()
            raise

    async def close(self) -> None:
        writer = self._writer
        self._reader = None
        self._writer = None
        self._buffer = b""
        if writer is not None:
            writer.close()
            await writer.wait_closed()

    async def _connect(self) -> None:
        if self._writer is not None and not self._writer.is_closing():
            return
        self._reader, self._writer = await asyncio.open_connection(self.host, self.port)
        self._buffer = b""

    async def _read_response(self) -> dict[str, Any]:
        reader = self._reader
        if reader is None:
            raise ConnectionError("remote training connection is not available")

        while True:
            parsed = self._try_parse_buffer()
            if parsed is not None:
                return parsed

            chunk = await reader.read(64 * 1024)
            if not chunk:
                raise ConnectionError("remote training connection closed before response")
            self._buffer += chunk

    async def _prepare_download_stream(
        self,
        filename: str,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        progress_callback: Callable[[int], None] | None,
    ) -> RemoteDownloadStream | dict[str, Any]:
        buffer = b""
        while True:
            parsed, buffer = self._try_parse_bytes(buffer)
            if parsed is not None:
                await self._close_download_writer(writer)
                self._download_lock.release()
                return parsed
            if buffer and not buffer.lstrip().startswith(b"{"):
                return RemoteDownloadStream(
                    filename=filename,
                    media_type="application/x-tar",
                    chunks=self._iter_download_tar(reader, writer, buffer, progress_callback),
                    response={"message": "download started"},
                )
            chunk = await reader.read(64 * 1024)
            if not chunk:
                await self._close_download_writer(writer)
                self._download_lock.release()
                raise ConnectionError("remote training connection closed before response")
            buffer += chunk

    async def _iter_download_tar(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        buffer: bytes,
        progress_callback: Callable[[int], None] | None,
    ) -> Any:
        tar_finished = False
        payload_remaining = 0
        padding_remaining = 0
        zero_headers = 0
        tar_bytes = 0
        zero_block = b"\0" * TAR_BLOCK_SIZE

        try:
            while not tar_finished:
                while buffer:
                    if padding_remaining:
                        chunk, buffer = self._take_bytes(buffer, padding_remaining)
                        padding_remaining -= len(chunk)
                        tar_bytes += len(chunk)
                        if chunk:
                            if progress_callback is not None:
                                progress_callback(tar_bytes)
                            yield chunk
                        if padding_remaining == 0:
                            tar_finished = True
                            break
                        continue

                    if payload_remaining:
                        chunk, buffer = self._take_bytes(buffer, payload_remaining)
                        payload_remaining -= len(chunk)
                        tar_bytes += len(chunk)
                        if chunk:
                            if progress_callback is not None:
                                progress_callback(tar_bytes)
                            yield chunk
                        if not chunk:
                            break
                        continue

                    if len(buffer) < TAR_BLOCK_SIZE:
                        break

                    header = buffer[:TAR_BLOCK_SIZE]
                    buffer = buffer[TAR_BLOCK_SIZE:]
                    tar_bytes += TAR_BLOCK_SIZE
                    if progress_callback is not None:
                        progress_callback(tar_bytes)
                    yield header

                    if header == zero_block:
                        zero_headers += 1
                        if zero_headers == 2:
                            padding_remaining = (TAR_RECORD_SIZE - (tar_bytes % TAR_RECORD_SIZE)) % TAR_RECORD_SIZE
                            if padding_remaining == 0:
                                tar_finished = True
                                break
                        continue

                    zero_headers = 0
                    payload_remaining = self._tar_payload_block_size(header)

                if tar_finished:
                    break

                chunk = await reader.read(64 * 1024)
                if not chunk:
                    raise ConnectionError("remote training connection closed before download completed")
                buffer += chunk

            while self._try_parse_bytes(buffer)[0] is None:
                chunk = await reader.read(64 * 1024)
                if not chunk:
                    break
                buffer += chunk
        finally:
            await self._close_download_writer(writer)
            self._download_lock.release()

    def _take_bytes(self, buffer: bytes, byte_count: int) -> tuple[bytes, bytes]:
        consumed = min(len(buffer), byte_count)
        return buffer[:consumed], buffer[consumed:]

    def _tar_payload_block_size(self, header: bytes) -> int:
        raw_size = header[124:136].split(b"\0", 1)[0].strip() or b"0"
        try:
            size = int(raw_size, 8)
        except ValueError:
            raise ConnectionError("remote training download is not a valid tar stream") from None
        return ((size + TAR_BLOCK_SIZE - 1) // TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE

    def _try_parse_buffer(self) -> dict[str, Any] | None:
        parsed, self._buffer = self._try_parse_bytes(self._buffer)
        return parsed

    def _try_parse_bytes(self, buffer: bytes) -> tuple[dict[str, Any] | None, bytes]:
        if not buffer.strip():
            return None, buffer
        try:
            text = buffer.decode("utf-8")
        except UnicodeDecodeError:
            return None, buffer

        stripped = text.lstrip()
        try:
            data, end = self._decoder.raw_decode(stripped)
        except json.JSONDecodeError:
            return None, buffer

        consumed_text = len(text) - len(stripped) + end
        consumed_bytes = len(text[:consumed_text].encode("utf-8"))
        return data, buffer[consumed_bytes:].lstrip()

    async def _close_download_writer(self, writer: asyncio.StreamWriter) -> None:
        writer.close()
        await writer.wait_closed()
