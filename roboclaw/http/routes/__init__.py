"""Dashboard route registration — one file per API area."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable

from fastapi import FastAPI

if TYPE_CHECKING:
    from roboclaw.embodied.service import EmbodiedService


def register_all_routes(
    app: FastAPI,
    web_channel: Any,
    service: EmbodiedService,
    get_config: Callable[[], tuple[str, int]],
    collection_config: Any | None = None,
) -> None:
    """Register every dashboard API group on *app*."""
    from roboclaw.http.routes.session import register_session_routes
    from roboclaw.http.routes.hardware import register_hardware_routes
    from roboclaw.http.routes.setup import register_setup_routes
    from roboclaw.http.routes.devices import register_device_routes
    from roboclaw.http.routes.calibrate import register_calibrate_routes
    from roboclaw.http.routes.datasets import register_dataset_routes
    from roboclaw.http.routes.policies import register_policy_routes
    from roboclaw.http.routes.recovery import register_recovery_routes
    from roboclaw.http.routes.network import register_network_routes
    from roboclaw.http.routes.replay import register_replay_routes
    from roboclaw.http.routes.train import register_train_routes
    from roboclaw.http.routes.infer import register_infer_routes
    from roboclaw.http.routes.hub import register_hub_routes
    from roboclaw.http.routes.chat_uploads import register_chat_upload_routes
    from roboclaw.http.routes.collection import register_collection_routes

    register_chat_upload_routes(app)
    register_collection_routes(app, service, collection_config=collection_config)
    register_session_routes(app, service)
    register_hardware_routes(app, service)
    register_setup_routes(app, service)
    register_device_routes(app, service)
    register_calibrate_routes(app, service)
    register_dataset_routes(app, service)
    register_policy_routes(app, service)
    register_recovery_routes(app)
    register_network_routes(app, get_config)
    register_replay_routes(app, service)
    register_train_routes(app, service, collection_config=collection_config)
    register_infer_routes(app, service)
    register_hub_routes(app, service)

    from roboclaw.http.routes.curation import register_curation_routes
    from roboclaw.http.routes.data_workshop import register_data_workshop_routes
    from roboclaw.http.routes.dataset_repair import register_dataset_repair_routes
    from roboclaw.http.routes.explorer import register_explorer_routes
    from roboclaw.data.repair.service import DatasetRepairCoordinator

    register_data_workshop_routes(app)
    register_curation_routes(app)
    register_dataset_repair_routes(
        app,
        DatasetRepairCoordinator(
            service.datasets.root / "local",
            cleaned_root=service.datasets.root / "cleaned",
            log_sink=service.board.log,
        ),
    )
    register_explorer_routes(app)
