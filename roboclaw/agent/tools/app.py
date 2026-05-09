"""App-awareness tool for the in-app RoboClaw AI."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any

from roboclaw.agent.tools.base import Tool
from roboclaw.bus.events import OutboundMessage

SendCallback = Callable[[OutboundMessage], Awaitable[None]]


def _action(
    action_id: str,
    label: str,
    tool: str,
    action: str,
    requires: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": action_id,
        "label": label,
        "tool": tool,
        "action": action,
        "requires": requires or [],
    }


APP_PAGES: list[dict[str, Any]] = [
    {
        "id": "control",
        "route": "/control",
        "name": "控制中心",
        "description": "Live robot control for teleoperation, recording, replay, inference, and hardware readiness.",
        "state_sources": ["/api/hardware/status", "/api/session/status"],
        "actions": [
            _action("hardware.get_status", "读取硬件状态", "app", "describe_page"),
            _action("hardware.check_connections", "检查设备连接状态", "doctor", "check"),
            _action("dashboard.restart", "重启 Dashboard", "app", "describe_page"),
            _action("teleop.teleoperate", "启动遥操作", "teleop", "teleoperate"),
            _action("record.record", "采集数据集", "record", "record"),
            _action("replay.replay", "回放数据集 episode", "replay", "replay"),
            _action("infer.run_policy", "运行策略推理", "infer", "run_policy"),
        ],
    },
    {
        "id": "training",
        "route": "/training",
        "name": "训练中心",
        "description": "Policy training dashboard with dataset/policy discovery, job start/stop, status, and loss curves.",
        "state_sources": ["/api/train/current", "/api/train/datasets", "/api/train/policies"],
        "actions": [
            _action("train.list_datasets", "列出可训练数据集", "train", "list_datasets"),
            _action("train.list_policies", "列出策略/模型", "train", "list_policies"),
            _action("train.train", "启动训练", "train", "train"),
            _action("train.job_status", "查看训练任务状态", "train", "job_status"),
        ],
    },
    {
        "id": "data_overview",
        "route": "/data",
        "name": "数据总览",
        "description": "Dataset and DatasetPackage lifecycle counts, gates, recent objects, and evaluation summary.",
        "state_sources": ["/api/data/overview"],
        "actions": [
            _action("data.get_current_page_data", "读取当前数据总览页面数据", "data", "get_current_page_data"),
            _action("data.get_overview", "读取数据总览完整状态", "data", "get_overview"),
        ],
    },
    {
        "id": "data_qc",
        "route": "/data/qc",
        "name": "数据质检",
        "description": "Dataset raw-to-clean lifecycle operations with inspect, diagnose, clean, and review gates.",
        "state_sources": ["/api/data/library/datasets", "/api/data/jobs/{job_id}"],
        "actions": [
            _action("data.get_current_page_data", "读取当前数据质检页面数据", "data", "get_current_page_data"),
            _action("data.run_diagnosis", "运行 Dataset 诊断", "data", "run_diagnosis", ["dataset_ids"]),
            _action("data.run_clean", "运行 Dataset 质检", "data", "run_clean", ["dataset_ids"]),
            _action("data.job_status", "读取 DataJob 状态", "data", "job_status", ["job_id"]),
            _action("data.cancel_job", "取消 DataJob", "data", "cancel_job", ["job_id"]),
        ],
    },
    {
        "id": "data_analysis",
        "route": "/data/analysis",
        "name": "数据分析",
        "description": "Direct local/path/remote inspect, episode visualization, and package-level data evaluation.",
        "state_sources": [
            "/api/data/inspect/summary",
            "/api/data/inspect/details",
            "/api/data/inspect/episodes",
            "/api/data/evaluation/defaults",
            "/api/data/evaluation/results",
            "/api/data/jobs/{job_id}",
        ],
        "actions": [
            _action("data.get_current_page_data", "读取当前数据分析页面数据", "data", "get_current_page_data"),
            _action("data.get_inspect_summary", "读取数据摘要", "data", "get_inspect_summary", ["dataset"]),
            _action("data.get_inspect_details", "读取数据结构详情", "data", "get_inspect_details", ["dataset"]),
            _action("data.get_inspect_episodes", "读取 episode 列表页", "data", "get_inspect_episodes", ["dataset"]),
            _action("data.get_evaluation_defaults", "读取 Package 默认评估参数", "data", "get_evaluation_defaults", ["package_id"]),
            _action("data.get_evaluation_results", "读取 Package 评估结果", "data", "get_evaluation_results", ["package_id"]),
            _action("data.run_evaluation", "运行 Package 数据评估", "data", "run_evaluation", ["package_id"]),
        ],
    },
    {
        "id": "data_annotation",
        "route": "/data/annotation",
        "name": "数据标注",
        "description": "Package-level semantic annotation workspace, prototype discovery, and propagation.",
        "state_sources": [
            "/api/data/annotation/workspace",
            "/api/data/jobs/{job_id}",
        ],
        "actions": [
            _action("data.get_current_page_data", "读取当前数据标注页面数据", "data", "get_current_page_data"),
            _action("data.get_annotation_workspace", "读取标注工作台 episode 数据", "data", "get_annotation_workspace", ["package_id", "episode_index"]),
            _action("data.save_annotations", "保存语义标注", "data", "save_annotations", ["package_id", "episode_index"]),
            _action("data.run_prototype", "发现原型片段", "data", "run_prototype", ["package_id"]),
            _action("data.run_propagation", "语义传播标注", "data", "run_propagation", ["package_id", "source_episode_index"]),
        ],
    },
    {
        "id": "data_manage",
        "route": "/data/manage",
        "name": "数据管理",
        "description": "Dataset import/delete, DatasetPackage materialization/delete, and real HuggingFace package upload.",
        "state_sources": ["/api/data/library/datasets", "/api/data/packages", "/api/data/jobs/{job_id}"],
        "actions": [
            _action("data.get_current_page_data", "读取当前数据管理页面数据", "data", "get_current_page_data"),
            _action("data.import_dataset", "导入远程 Dataset", "data", "import_dataset", ["dataset"]),
            _action("data.list_datasets", "列出 Dataset", "data", "list_datasets"),
            _action("data.list_packages", "列出 DatasetPackage", "data", "list_packages"),
            _action("data.create_package", "创建 DatasetPackage", "data", "create_package", ["package_id", "dataset_ids"]),
            _action("data.upload_package", "上传 DatasetPackage 到 HF", "data", "upload_package", ["package_id", "repo_id"]),
        ],
    },
    {
        "id": "settings",
        "route": "/settings",
        "name": "设置总览",
        "description": "Settings overview for hardware, provider, and HuggingFace integration.",
        "state_sources": ["/api/devices", "/api/system/provider-status"],
        "actions": [
            _action("app.list_pages", "查看设置相关页面", "app", "list_pages"),
        ],
    },
    {
        "id": "settings_hardware",
        "route": "/settings/hardware",
        "name": "硬件设置",
        "description": "Device catalog, hardware setup wizard, calibration, and manifest management.",
        "state_sources": ["/api/setup/session", "/api/devices", "/api/hardware/status"],
        "actions": [
            _action("setup.identify", "识别并配置硬件", "setup", "identify"),
            _action("setup.preview_cameras", "预览摄像头", "setup", "preview_cameras"),
            _action("setup.modify", "修改设备绑定", "setup", "modify"),
            _action("calibration.calibrate", "校准机械臂", "calibration", "calibrate"),
            _action("doctor.check", "检查硬件环境", "doctor", "check"),
        ],
    },
    {
        "id": "settings_provider",
        "route": "/settings/provider",
        "name": "AI Provider 设置",
        "description": "LLM provider configuration and connection testing.",
        "state_sources": ["/api/system/provider-status", "/api/system/provider-config"],
        "actions": [
            _action("app.describe_page", "解释 Provider 设置页", "app", "describe_page"),
        ],
    },
    {
        "id": "settings_hub",
        "route": "/settings/hub",
        "name": "HuggingFace 设置",
        "description": "Hub authentication and dataset/policy transfer settings.",
        "state_sources": [
            "/api/hub/datasets/push",
            "/api/hub/datasets/pull",
            "/api/hub/policies/push",
            "/api/hub/policies/pull",
        ],
        "actions": [
            _action("hub.pull_dataset", "拉取 Hub 数据集", "hub", "pull_dataset"),
            _action("hub.push_dataset", "推送数据集到 Hub", "hub", "push_dataset"),
            _action("hub.pull_policy", "拉取 Hub 策略", "hub", "pull_policy"),
            _action("hub.push_policy", "推送策略到 Hub", "hub", "push_policy"),
        ],
    },
    {
        "id": "logs",
        "route": "/logs",
        "name": "日志",
        "description": "Runtime logs and diagnostics view.",
        "state_sources": ["/api/session/logs"],
        "actions": [
            _action("doctor.check", "检查运行环境", "doctor", "check"),
        ],
    },
]


class AppTool(Tool):
    """Let RoboClaw AI understand the web app surface and current page context."""

    def __init__(self, send_callback: SendCallback | None = None):
        self._send_callback = send_callback
        self._channel = ""
        self._chat_id = ""
        self._context_by_session: dict[str, dict[str, Any]] = {}

    @property
    def name(self) -> str:
        return "app"

    @property
    def description(self) -> str:
        return (
            "Discover RoboClaw web app pages, inspect the user's current page context, "
            "list page-level capabilities, and request navigation in the Web UI."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "list_pages",
                        "get_current_context",
                        "describe_page",
                        "list_page_actions",
                        "resolve_route",
                        "navigate",
                    ],
                    "description": "App-awareness operation to perform.",
                },
                "page": {
                    "type": "string",
                    "description": "Page id or route. Defaults to the current page when available.",
                },
                "route": {
                    "type": "string",
                    "description": "Route to resolve or navigate to, such as /data/analysis.",
                },
            },
            "required": ["action"],
            "additionalProperties": False,
        }

    def set_context(
        self,
        channel: str,
        chat_id: str,
        message_id: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self._channel = channel
        self._chat_id = chat_id
        app_context = _extract_app_context(metadata or {})
        if app_context:
            self._context_by_session[self._session_key(channel, chat_id)] = app_context

    async def execute(self, action: str, page: str = "", route: str = "") -> str:
        if action == "list_pages":
            return _json({"pages": [_page_summary(item) for item in APP_PAGES]})

        if action == "get_current_context":
            context = self._current_context()
            resolved = _resolve_page(page or route or str(context.get("route") or ""))
            return _json({
                "context": context,
                "page": _page_payload(resolved) if resolved else None,
                "context_available": bool(context),
            })

        if action == "describe_page":
            resolved = self._resolve_requested_page(page, route)
            if not resolved:
                return _json({"error": "page or route is required"})
            return _json({"page": _page_payload(resolved)})

        if action == "list_page_actions":
            resolved = self._resolve_requested_page(page, route)
            if not resolved:
                return _json({"error": "page or route is required"})
            return _json({
                "page": _page_summary(resolved),
                "actions": deepcopy(resolved.get("actions", [])),
            })

        if action == "resolve_route":
            resolved = self._resolve_requested_page(page, route)
            if not resolved:
                return _json({"error": "No matching page found"})
            return _json({"page": _page_payload(resolved)})

        if action == "navigate":
            resolved = self._resolve_requested_page(page, route)
            target_route = str((resolved or {}).get("route") or route)
            if not _is_safe_route(target_route):
                return _json({"error": f"Unsafe or unknown route: {target_route}"})
            event_sent = await self._send_navigation_event(target_route, resolved)
            return _json({
                "status": "navigation_requested" if event_sent else "navigation_resolved",
                "route": target_route,
                "page": _page_summary(resolved) if resolved else None,
                "event_sent": event_sent,
            })

        return _json({"error": f"Unknown app action: {action}"})

    def _current_context(self) -> dict[str, Any]:
        return deepcopy(self._context_by_session.get(self._session_key(self._channel, self._chat_id), {}))

    def _resolve_requested_page(self, page: str, route: str) -> dict[str, Any] | None:
        if page or route:
            return _resolve_page(page or route)
        context = self._current_context()
        return _resolve_page(str(context.get("route") or context.get("pathname") or ""))

    async def _send_navigation_event(
        self,
        route: str,
        page: dict[str, Any] | None,
    ) -> bool:
        if not self._send_callback or self._channel != "web" or not self._chat_id:
            return False
        await self._send_callback(
            OutboundMessage(
                channel=self._channel,
                chat_id=self._chat_id,
                content="",
                metadata={
                    "app_event": {
                        "type": "app.navigate",
                        "route": route,
                        "page": _page_summary(page) if page else None,
                    }
                },
            )
        )
        return True

    @staticmethod
    def _session_key(channel: str, chat_id: str) -> str:
        return f"{channel}:{chat_id}"


def _extract_app_context(metadata: dict[str, Any]) -> dict[str, Any]:
    raw = metadata.get("app_context") or metadata.get("appContext") or metadata.get("app")
    if not isinstance(raw, dict):
        return {}
    context = deepcopy(raw)
    route = str(context.get("route") or context.get("pathname") or "").strip()
    if route:
        context["route"] = _normalize_route(route)
    return context


def _resolve_page(value: str) -> dict[str, Any] | None:
    needle = _normalize_route(value)
    if not needle:
        return None
    for page in sorted(APP_PAGES, key=lambda item: len(item["route"]), reverse=True):
        page_id = str(page["id"])
        page_route = str(page["route"])
        if needle == page_id or needle == page_route:
            return page
        if needle.startswith(page_route.rstrip("/") + "/"):
            return page
    return None


def _normalize_route(value: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    if "://" in clean:
        from urllib.parse import urlparse

        parsed = urlparse(clean)
        clean = parsed.path or "/"
    if "?" in clean:
        clean = clean.split("?", 1)[0]
    if "#" in clean:
        clean = clean.split("#", 1)[0]
    if not clean.startswith("/"):
        return clean
    return clean.rstrip("/") or "/"


def _is_safe_route(route: str) -> bool:
    return bool(route) and route.startswith("/") and not route.startswith("//")


def _page_summary(page: dict[str, Any] | None) -> dict[str, Any]:
    if not page:
        return {}
    return {
        "id": page["id"],
        "route": page["route"],
        "name": page["name"],
        "description": page["description"],
    }


def _page_payload(page: dict[str, Any]) -> dict[str, Any]:
    payload = _page_summary(page)
    payload["state_sources"] = list(page.get("state_sources", []))
    payload["actions"] = deepcopy(page.get("actions", []))
    return payload


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)
