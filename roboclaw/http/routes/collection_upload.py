"""OSS upload support for collection runs."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from roboclaw.http.routes.collection_cloud import CloudApiError

PutObject = Callable[[str, Path], Awaitable[None]]

_INVALID_PATH_SEGMENTS = {
    "__pycache__",
    ".cache",
    ".git",
    ".DS_Store",
    ".huggingface",
    ".ipynb_checkpoints",
    ".gitattributes",
    ".gitignore",
    "node_modules",
}


class CollectionUploadError(RuntimeError):
    """Raised when a collection dataset cannot be synced to OSS."""


@dataclass
class FileSignature:
    size: int
    mtime_ns: int

    def to_dict(self) -> dict[str, int]:
        return {"size": self.size, "mtime_ns": self.mtime_ns}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "FileSignature":
        return cls(size=int(data["size"]), mtime_ns=int(data["mtime_ns"]))


@dataclass
class CollectionUploadState:
    run_id: str
    dataset_name: str
    upload_id: str = ""
    upload_dir: str = ""
    completed: bool = False
    uploaded_files: dict[str, FileSignature] = field(default_factory=dict)
    last_error: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "dataset_name": self.dataset_name,
            "upload_id": self.upload_id,
            "upload_dir": self.upload_dir,
            "completed": self.completed,
            "uploaded_files": {
                path: signature.to_dict()
                for path, signature in sorted(self.uploaded_files.items())
            },
            "last_error": self.last_error,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CollectionUploadState":
        return cls(
            run_id=str(data["run_id"]),
            dataset_name=str(data["dataset_name"]),
            upload_id=str(data.get("upload_id") or ""),
            upload_dir=str(data.get("upload_dir") or ""),
            completed=bool(data.get("completed", False)),
            uploaded_files={
                path: FileSignature.from_dict(signature)
                for path, signature in (data.get("uploaded_files") or {}).items()
            },
            last_error=str(data.get("last_error") or ""),
        )


class CollectionUploadManager:
    """Sync local collection datasets to EvoData OSS upload sessions."""

    def __init__(
        self,
        *,
        cloud: Any,
        state_dir: Path,
        put_object: PutObject | None = None,
        batch_size: int = 100,
    ) -> None:
        self.cloud = cloud
        self.state_dir = state_dir
        self.put_object = put_object or _put_file
        self.batch_size = max(batch_size, 1)

    def status(self, run_id: str) -> dict[str, Any] | None:
        state = self._load_state(run_id)
        if state is None:
            return None
        return self._status_payload(state)

    async def sync(
        self,
        *,
        run_id: str,
        dataset_name: str,
        dataset_dir: Path,
        authorization: str,
        complete: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not dataset_dir.is_dir():
            return {
                "enabled": True,
                "status": "missing_dataset",
                "dataset_name": dataset_name,
            }

        state = self._load_state(run_id) or CollectionUploadState(
            run_id=run_id,
            dataset_name=dataset_name,
        )
        files = self._collect_files(dataset_dir)
        try:
            if not state.upload_id or not state.upload_dir:
                await self._create_upload_session(state, authorization)
                await self._report_run_upload(state, files, authorization, status="pending")

            pending = [
                (relative_path, path, signature)
                for relative_path, path, signature in files
                if state.uploaded_files.get(relative_path) != signature
            ]
            for batch in _chunks(pending, self.batch_size):
                last_uploaded_path = await self._upload_batch(state, batch, authorization)
                await self._report_run_upload(
                    state,
                    files,
                    authorization,
                    status="uploading",
                    last_uploaded_path=last_uploaded_path,
                )

            if complete and not state.completed:
                await self._report_run_upload(state, files, authorization, status="uploaded")
                await self._complete_upload(state, authorization, metadata=metadata)
                await self._report_run_upload(state, files, authorization, status="validating")
            elif not complete:
                await self._report_run_upload(state, files, authorization, status="uploading")

            state.last_error = ""
            self._save_state(state)
            payload = self._status_payload(state)
            payload["uploaded_file_count"] = len(state.uploaded_files)
            payload["pending_file_count"] = 0
            return payload
        except (CloudApiError, CollectionUploadError, httpx.HTTPError, OSError, KeyError) as exc:
            state.last_error = str(exc)
            self._save_state(state)
            try:
                await self._report_run_upload(
                    state,
                    files,
                    authorization,
                    status="failed",
                    error_message=str(exc),
                )
            except (CloudApiError, CollectionUploadError, httpx.HTTPError, OSError, KeyError) as report_exc:
                message = f"{exc}; upload status report failed: {report_exc}"
                raise CollectionUploadError(message) from exc
            raise CollectionUploadError(str(exc)) from exc

    async def _create_upload_session(
        self,
        state: CollectionUploadState,
        authorization: str,
    ) -> None:
        credentials = await self.cloud.request(
            "POST",
            f"/collection/runs/{state.run_id}/upload/session",
            authorization=authorization,
        )
        state.upload_id = str(credentials["upload_id"])
        state.upload_dir = str(credentials["upload_dir"])

    async def _upload_batch(
        self,
        state: CollectionUploadState,
        batch: list[tuple[str, Path, FileSignature]],
        authorization: str,
    ) -> str | None:
        relative_paths = [item[0] for item in batch]
        response = await self.cloud.request(
            "POST",
            "/sts/presign",
            authorization=authorization,
            json_body={
                "upload_dir": state.upload_dir,
                "relative_paths": relative_paths,
            },
        )
        urls = response.get("urls") or {}
        last_uploaded_path = None
        for relative_path, path, signature in batch:
            url = urls.get(relative_path)
            if not url:
                raise CollectionUploadError(f"Missing OSS upload URL for {relative_path}")
            await self.put_object(str(url), path)
            state.uploaded_files[relative_path] = signature
            last_uploaded_path = relative_path
            self._save_state(state)
        return last_uploaded_path

    async def _complete_upload(
        self,
        state: CollectionUploadState,
        authorization: str,
        *,
        metadata: dict[str, Any] | None,
    ) -> None:
        body = {
            "upload_id": state.upload_id,
            "dataset_name": state.dataset_name,
            "oss_path": state.upload_dir,
            "description": (metadata or {}).get("description"),
            "tags": (metadata or {}).get("tags"),
            "is_public": bool((metadata or {}).get("is_public", False)),
        }
        try:
            await self.cloud.request(
                "POST",
                "/datasets/upload/complete",
                authorization=authorization,
                json_body=body,
            )
        except CloudApiError as exc:
            if await self._upload_status_exists(state.upload_id, authorization):
                state.completed = True
                return
            raise exc
        state.completed = True

    async def _upload_status_exists(self, upload_id: str, authorization: str) -> bool:
        try:
            await self.cloud.request(
                "GET",
                f"/datasets/upload/{upload_id}/status",
                authorization=authorization,
            )
        except CloudApiError:
            return False
        return True

    async def _report_run_upload(
        self,
        state: CollectionUploadState,
        files: list[tuple[str, Path, FileSignature]],
        authorization: str,
        *,
        status: str,
        last_uploaded_path: str | None = None,
        error_message: str | None = None,
    ) -> dict[str, Any]:
        body = {
            "upload_id": state.upload_id or None,
            "oss_path": state.upload_dir or None,
            "status": status,
            "last_uploaded_path": last_uploaded_path,
            "error_message": error_message,
            **self._progress_counts(state, files),
        }
        return await self.cloud.request(
            "PUT",
            f"/collection/runs/{state.run_id}/upload",
            authorization=authorization,
            json_body=body,
        )

    def _progress_counts(
        self,
        state: CollectionUploadState,
        files: list[tuple[str, Path, FileSignature]],
    ) -> dict[str, int]:
        uploaded_files = 0
        uploaded_bytes = 0
        total_bytes = 0
        for relative_path, _path, signature in files:
            total_bytes += signature.size
            if state.uploaded_files.get(relative_path) == signature:
                uploaded_files += 1
                uploaded_bytes += signature.size
        return {
            "total_files": len(files),
            "uploaded_files": uploaded_files,
            "total_bytes": total_bytes,
            "uploaded_bytes": uploaded_bytes,
        }

    def _collect_files(self, dataset_dir: Path) -> list[tuple[str, Path, FileSignature]]:
        files: list[tuple[str, Path, FileSignature]] = []
        for path in sorted(dataset_dir.rglob("*")):
            if not path.is_file():
                continue
            relative_path = path.relative_to(dataset_dir).as_posix()
            if _is_invalid_relative_path(relative_path):
                continue
            stat = path.stat()
            files.append((relative_path, path, FileSignature(stat.st_size, stat.st_mtime_ns)))
        return files

    def _state_path(self, run_id: str) -> Path:
        return self.state_dir / f"{run_id}.json"

    def _load_state(self, run_id: str) -> CollectionUploadState | None:
        path = self._state_path(run_id)
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as fh:
            return CollectionUploadState.from_dict(json.load(fh))

    def _save_state(self, state: CollectionUploadState) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        path = self._state_path(state.run_id)
        tmp_path = path.with_suffix(f"{path.suffix}.tmp")
        with tmp_path.open("w", encoding="utf-8") as fh:
            json.dump(state.to_dict(), fh, ensure_ascii=False, indent=2)
        tmp_path.replace(path)

    def _status_payload(self, state: CollectionUploadState) -> dict[str, Any]:
        return {
            "enabled": True,
            "status": "completed" if state.completed else "syncing",
            "dataset_name": state.dataset_name,
            "upload_id": state.upload_id,
            "oss_path": state.upload_dir,
            "last_error": state.last_error,
        }


def _is_invalid_relative_path(relative_path: str) -> bool:
    parts = relative_path.split("/")
    if any(part in _INVALID_PATH_SEGMENTS for part in parts):
        return True
    if any(part.startswith(".") for part in parts):
        return True
    return relative_path.endswith((".tmp", ".part"))


def _chunks[T](items: list[T], size: int) -> list[list[T]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


async def _put_file(url: str, path: Path) -> None:
    async with httpx.AsyncClient(timeout=None, trust_env=False) as client:
        response = await client.put(
            url,
            headers={"Content-Type": "application/octet-stream"},
            content=_read_file_chunks(path),
        )
    if response.status_code >= 300:
        raise CollectionUploadError(f"OSS PUT failed for {path.name}: HTTP {response.status_code}")


async def _read_file_chunks(path: Path, chunk_size: int = 1024 * 1024):
    with path.open("rb") as fh:
        while True:
            chunk = await asyncio.to_thread(fh.read, chunk_size)
            if not chunk:
                return
            yield chunk
