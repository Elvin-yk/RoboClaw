from __future__ import annotations

import hashlib
from dataclasses import dataclass
from functools import cache
from pathlib import Path, PurePosixPath

ROBOT_ASSET_ROOT = Path(__file__).resolve().parents[2] / "assets" / "robots"


@dataclass(frozen=True)
class RobotAssetFile:
    path: str
    size: int
    sha256: str
    content_type: str
    local_path: Path

    def to_manifest(self) -> dict[str, str | int]:
        return {
            "path": self.path,
            "size": self.size,
            "sha256": self.sha256,
            "content_type": self.content_type,
        }


@dataclass(frozen=True)
class RobotAssetBundle:
    asset_id: str
    root: Path

    @property
    def files(self) -> tuple[RobotAssetFile, ...]:
        return _robot_asset_files(self.asset_id)

    def resolve_file(self, relative_path: str) -> RobotAssetFile:
        normalized = validate_robot_asset_path(relative_path)
        for asset_file in self.files:
            if asset_file.path == normalized:
                return asset_file
        raise FileNotFoundError(normalized)

    def to_manifest(self, base_url: str, urdf_path: str) -> dict[str, object]:
        normalized_base_url = base_url.rstrip("/") + "/"
        normalized_urdf_path = validate_robot_asset_path(urdf_path)
        self.resolve_file(normalized_urdf_path)
        return {
            "asset_id": self.asset_id,
            "asset_base_url": normalized_base_url,
            "urdf_path": normalized_urdf_path,
            "urdf_url": f"{normalized_base_url}{normalized_urdf_path}",
            "files": [asset_file.to_manifest() for asset_file in self.files],
        }


def get_robot_asset_bundle(asset_id: str) -> RobotAssetBundle:
    normalized_asset_id = validate_robot_asset_segment(asset_id)
    root = ROBOT_ASSET_ROOT / normalized_asset_id
    if not root.is_dir():
        raise FileNotFoundError(root)
    return RobotAssetBundle(
        asset_id=normalized_asset_id,
        root=root,
    )


def validate_robot_asset_segment(value: str) -> str:
    normalized = value.strip()
    path = PurePosixPath(normalized.replace("\\", "/"))
    if not normalized or path.is_absolute() or len(path.parts) != 1 or path.parts[0] in {".", ".."}:
        raise ValueError(value)
    return normalized


def validate_robot_asset_path(value: str) -> str:
    normalized = PurePosixPath(value.replace("\\", "/"))
    if normalized.is_absolute() or any(part in {"", ".", ".."} for part in normalized.parts):
        raise ValueError(value)
    return normalized.as_posix()


@cache
def _robot_asset_files(asset_id: str) -> tuple[RobotAssetFile, ...]:
    root = ROBOT_ASSET_ROOT / asset_id
    files: list[RobotAssetFile] = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative_path = path.relative_to(root).as_posix()
        files.append(
            RobotAssetFile(
                path=relative_path,
                size=path.stat().st_size,
                sha256=_sha256(path),
                content_type=_content_type(path),
                local_path=path,
            )
        )
    return tuple(files)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _content_type(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".urdf":
        return "application/xml"
    if suffix == ".stl":
        return "model/stl"
    return "application/octet-stream"
