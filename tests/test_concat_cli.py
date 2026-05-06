"""Tests for the concat CLI front-end."""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from roboclaw.data.dataset_pipeline.concat.cli import main as cli_main

from tests.test_lerobot_concat import _make_lerobot_source, _TASK, workspace  # noqa: F401


_FFMPEG_MISSING = shutil.which("ffmpeg") is None
_skip_no_ffmpeg = pytest.mark.skipif(_FFMPEG_MISSING, reason="ffmpeg required")


def test_returns_1_when_source_missing(tmp_path: Path) -> None:
    argv = [
        "--src", str(tmp_path / "missing"),
        "--dst", str(tmp_path / "dst"),
        "--task", _TASK,
    ]
    assert cli_main(argv) == 1


def test_returns_1_when_dst_exists(tmp_path: Path) -> None:
    src = tmp_path / "src"
    src.mkdir()
    dst = tmp_path / "dst"
    dst.mkdir()
    argv = [
        "--src", str(src),
        "--dst", str(dst),
        "--task", _TASK,
    ]
    assert cli_main(argv) == 1


@_skip_no_ffmpeg
def test_happy_path(workspace: Path) -> None:  # noqa: F811
    src1 = _make_lerobot_source(workspace, "src1")
    src2 = _make_lerobot_source(workspace, "src2")
    dst = workspace / "dst"
    argv = [
        "--src", str(src1),
        "--src", str(src2),
        "--dst", str(dst),
        "--task", _TASK,
    ]
    assert cli_main(argv) == 0
    info = json.loads((dst / "meta" / "info.json").read_text())
    assert info["total_episodes"] == 4
