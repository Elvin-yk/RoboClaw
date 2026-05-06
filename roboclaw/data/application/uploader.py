from __future__ import annotations

from pathlib import Path
from typing import Protocol


class DatasetPackageUploader(Protocol):
    def upload(self, package_id: str, package_path: Path) -> str:
        ...
