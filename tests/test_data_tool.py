from __future__ import annotations

import asyncio
import json
from pathlib import Path

from roboclaw.agent.tools.data import DataTool
from roboclaw.data.application import DataService


def _create_dataset(root: Path, dataset_id: str) -> None:
    meta = root / dataset_id / "meta"
    meta.mkdir(parents=True)
    (meta / "info.json").write_text(
        json.dumps({
            "total_episodes": 1,
            "total_frames": 10,
            "fps": 30,
            "robot_type": "so100",
            "features": {"action": {"dtype": "float32"}},
        }),
        encoding="utf-8",
    )
    (meta / "episodes.jsonl").write_text(json.dumps({"episode_index": 0, "length": 10}) + "\n", encoding="utf-8")


def test_data_tool_is_named_data_and_lists_datasets(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    tool = DataTool(data_service=DataService(root_resolver=lambda: tmp_path))

    result = json.loads(asyncio.run(tool.execute(action="list_datasets")))

    assert tool.name == "data"
    assert result["datasets"][0]["id"] == "local/demo"


def test_data_tool_current_page_data_uses_data_context(tmp_path: Path) -> None:
    _create_dataset(tmp_path, "local/demo")
    tool = DataTool(data_service=DataService(root_resolver=lambda: tmp_path))
    tool.set_context(
        "web",
        "chat",
        metadata={
            "app_context": {
                "route": "/data",
                "data": {"selected_dataset_ids": ["local/demo"], "packages": []},
            }
        },
    )

    result = json.loads(asyncio.run(tool.execute(action="get_current_page_data")))

    assert result["page"] == "data_overview"
    assert result["overview"]["summary"]["dataset_count"] == 1
