"""Lightweight discovery for local LeRobot dataset containers."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

DEFAULT_MAX_DISCOVERY_DEPTH = 5
SKIPPED_CONTAINER_NAMES = frozenset({
    "__pycache__",
    "_filelists",
    "_lists",
})


@dataclass(frozen=True)
class LocalDatasetEntry:
    id: str
    path: Path


def is_dataset_dir(path: Path) -> bool:
    return (path / "meta" / "info.json").is_file()


def is_pollution_file(path: Path) -> bool:
    return path.name.startswith(".") or path.name.startswith("._")


def iter_data_files(
    root: Path,
    pattern: str,
) -> Iterator[Path]:
    if not root.exists():
        return
    for path in sorted(root.rglob(pattern)):
        if path.is_file() and not is_pollution_file(path):
            yield path


def iter_dataset_entries(
    root: Path,
    *,
    max_depth: int = DEFAULT_MAX_DISCOVERY_DEPTH,
) -> Iterator[LocalDatasetEntry]:
    for dataset_dir in iter_dataset_dirs(root, max_depth=max_depth):
        yield LocalDatasetEntry(
            id=dataset_dir.relative_to(root).as_posix(),
            path=dataset_dir,
        )


def iter_dataset_dirs(
    root: Path,
    *,
    max_depth: int = DEFAULT_MAX_DISCOVERY_DEPTH,
) -> Iterator[Path]:
    root = root.expanduser()
    if not root.is_dir():
        return
    yield from _walk_dataset_dirs(root, depth=0, max_depth=max_depth)


def _walk_dataset_dirs(root: Path, *, depth: int, max_depth: int) -> Iterator[Path]:
    if is_dataset_dir(root):
        yield root
        return
    if depth >= max_depth:
        return
    for child in sorted(root.iterdir()):
        if not child.is_dir() or _should_skip_container(child.name):
            continue
        yield from _walk_dataset_dirs(child, depth=depth + 1, max_depth=max_depth)


def _should_skip_container(name: str) -> bool:
    return name.startswith(".") or name.startswith("._") or name in SKIPPED_CONTAINER_NAMES
