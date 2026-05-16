from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from roboclaw.data.application import DataService
from roboclaw.data.application.jobs import format_sse

from .schemas import (
    AnnotationSaveRequest,
    EvaluationRunRequest,
    GateUpdateRequest,
    ImportRequest,
    PackageCreateRequest,
    PackageUploadRequest,
    PropagationRunRequest,
    PrototypeRunRequest,
    QcRunRequest,
    ReviewBatchRunRequest,
    ReviewDraftRequest,
    ReviewEpisodeDecisionRequest,
)


def register_data_routes(app: FastAPI, service: DataService) -> None:
    @app.get("/api/data/library/datasets")
    async def data_library_datasets() -> list[dict[str, Any]]:
        return service.library.list_datasets()

    @app.get("/api/data/library/datasets/{dataset_id:path}")
    async def data_library_dataset(dataset_id: str) -> dict[str, Any]:
        try:
            return service.library.get_dataset(dataset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/data/library/datasets/{dataset_id:path}")
    async def data_library_delete(dataset_id: str) -> dict[str, str]:
        try:
            return service.library.delete_dataset(dataset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data/library/imports")
    async def data_library_import(body: ImportRequest) -> dict[str, Any]:
        try:
            return service.library.start_import(
                dataset_id=body.dataset_id,
                include_videos=body.include_videos,
                force=body.force,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/data/inspect/suggestions")
    async def data_inspect_suggestions(q: str = "", source: str = "remote", limit: int = 8) -> list[dict[str, Any]]:
        return await service.inspect.suggestions(query=q, source=source, limit=limit)

    @app.get("/api/data/inspect/summary")
    async def data_inspect_summary(
        dataset: str | None = None,
        source: str = "remote",
        path: str | None = None,
    ) -> dict[str, Any]:
        return await service.inspect.summary(dataset=dataset, source=source, path=path)

    @app.get("/api/data/inspect/details")
    async def data_inspect_details(
        dataset: str | None = None,
        source: str = "remote",
        path: str | None = None,
    ) -> dict[str, Any]:
        return await service.inspect.details(dataset=dataset, source=source, path=path)

    @app.get("/api/data/inspect/episodes")
    async def data_inspect_episodes(
        dataset: str | None = None,
        source: str = "remote",
        path: str | None = None,
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        return await service.inspect.episodes(
            dataset=dataset,
            source=source,
            path=path,
            page=page,
            page_size=page_size,
        )

    @app.get("/api/data/inspect/episode")
    async def data_inspect_episode(
        dataset: str | None = None,
        source: str = "remote",
        path: str | None = None,
        episode_index: int = 0,
        preview: bool = False,
    ) -> dict[str, Any]:
        return await service.inspect.episode(
            dataset=dataset,
            source=source,
            path=path,
            episode_index=episode_index,
            preview=preview,
        )

    @app.get("/api/data/inspect/robot-model/{model}")
    async def data_inspect_robot_model(model: str) -> dict[str, Any]:
        return await service.inspect.robot_model(model=model)

    @app.get("/api/data/inspect/robot-assets/{asset_id}/{path:path}")
    async def data_inspect_robot_asset(asset_id: str, path: str):
        return service.inspect.robot_asset_file(
            asset_id=asset_id,
            relative_path=path,
        )

    @app.get("/api/data/inspect/episode-robot-trajectory")
    async def data_inspect_episode_robot_trajectory(
        dataset: str | None = None,
        source: str = "local",
        path: str | None = None,
        episode_index: int = 0,
        signal: str = "action",
        model: str = "so101",
    ) -> dict[str, Any]:
        return await service.inspect.episode_robot_trajectory(
            dataset=dataset,
            source=source,
            path=path,
            episode_index=episode_index,
            signal=signal,
            model=model,
        )

    @app.get("/api/data/inspect/video/{path:path}")
    async def data_inspect_video(
        path: str,
        dataset: str | None = None,
        source: str = "local",
        dataset_path: str | None = None,
    ):
        return service.inspect.video(
            relative_path=path,
            dataset=dataset,
            source=source,
            dataset_path=dataset_path,
        )

    @app.post("/api/data/qc/diagnosis-runs")
    async def data_diagnosis_run(body: QcRunRequest) -> dict[str, Any]:
        try:
            return service.clean.start_diagnosis_run(dataset_ids=body.dataset_ids)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/api/data/qc/auto-clean-runs")
    async def data_auto_clean_run(body: QcRunRequest) -> dict[str, Any]:
        try:
            return service.clean.start_auto_clean_run(
                dataset_ids=body.dataset_ids,
                chain_id=body.chain_id,
                task=body.task,
                vcodec=body.vcodec,
                force=body.force,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/data/qc/run-details")
    async def data_qc_run(dataset_id: str, run_id: str) -> dict[str, Any]:
        try:
            return service.clean.get_qc_run(dataset_id=dataset_id, run_id=run_id)
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(
                status_code=404 if isinstance(exc, FileNotFoundError) else 400,
                detail=str(exc),
            ) from exc

    @app.get("/api/data/review/workspace")
    async def data_review_workspace(dataset_id: str) -> dict[str, Any]:
        try:
            return service.review.workspace(dataset_id=dataset_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.patch("/api/data/review/datasets/{dataset_id:path}/episodes/{episode_index}")
    async def data_review_episode(
        dataset_id: str,
        episode_index: int,
        body: ReviewEpisodeDecisionRequest,
    ) -> dict[str, Any]:
        try:
            return service.review.save_episode_decision(
                dataset_id=dataset_id,
                episode_index=episode_index,
                decision=body.decision,
                reason=body.reason,
                note=body.note,
                reviewer_id=body.reviewer_id,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/api/data/review/datasets/{dataset_id:path}/draft")
    async def data_review_draft(dataset_id: str, body: ReviewDraftRequest) -> dict[str, Any]:
        try:
            return service.review.save_draft(
                dataset_id=dataset_id,
                draft_edits=body.draft_edits,
                reviewer_id=body.reviewer_id,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/data/review/batch-runs")
    async def data_review_batch_run(body: ReviewBatchRunRequest) -> dict[str, Any]:
        try:
            return service.review.start_batch_run(
                dataset_ids=body.dataset_ids,
                reviewer_id=body.reviewer_id,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.patch("/api/data/lifecycle/datasets/{dataset_id:path}/gates/{gate_key}")
    async def data_dataset_gate(dataset_id: str, gate_key: str, body: GateUpdateRequest) -> dict[str, Any]:
        try:
            return service.clean.update_dataset_gate(
                dataset_id=dataset_id,
                gate_key=gate_key,
                status=body.status,
                message=body.message,
                details=body.details,
            )
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, FileNotFoundError) else 400, detail=str(exc)) from exc

    @app.post("/api/data/packages")
    async def data_package_create(body: PackageCreateRequest) -> dict[str, Any]:
        try:
            return service.packages.create_package(
                package_id=body.package_id,
                dataset_ids=body.dataset_ids,
                groups=body.groups,
                force=body.force,
            )
        except FileExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/data/packages")
    async def data_packages() -> list[dict[str, Any]]:
        return service.packages.list_packages()

    @app.get("/api/data/packages/{package_id}")
    async def data_package(package_id: str) -> dict[str, Any]:
        try:
            return service.packages.get_package(package_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.delete("/api/data/packages/{package_id}")
    async def data_package_delete(package_id: str) -> dict[str, str]:
        try:
            return service.packages.delete_package(package_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data/packages/{package_id}/market-listing-applications")
    async def data_package_market_listing_application(package_id: str) -> dict[str, Any]:
        try:
            return service.packages.apply_market_listing(package_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data/packages/{package_id}/uploads")
    async def data_package_upload(package_id: str, body: PackageUploadRequest) -> dict[str, Any]:
        try:
            return service.packages.start_upload(
                package_id=package_id,
                repo_id=body.repo_id,
                token=body.token,
                private=body.private,
            )
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=404 if isinstance(exc, FileNotFoundError) else 400, detail=str(exc)) from exc

    @app.post("/api/data/evaluation/runs")
    async def data_evaluation_run(body: EvaluationRunRequest) -> dict[str, Any]:
        try:
            return service.evaluation.start_run(
                package_id=body.package_id,
                selected_validators=body.selected_validators,
                episode_indices=body.episode_indices,
                threshold_overrides=body.threshold_overrides,
            )
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/data/evaluation/defaults")
    async def data_evaluation_defaults(package_id: str) -> dict[str, Any]:
        try:
            return service.evaluation.defaults(package_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/data/evaluation/results")
    async def data_evaluation_results(package_id: str) -> dict[str, Any]:
        try:
            return service.evaluation.results(package_id)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/data/annotation/workspace")
    async def data_annotation_workspace(package_id: str, episode_index: int = 0) -> dict[str, Any]:
        try:
            return service.annotation.workspace(package_id=package_id, episode_index=episode_index)
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data/annotation/annotations")
    async def data_annotation_save(body: AnnotationSaveRequest) -> dict[str, Any]:
        try:
            return service.annotation.save_annotations(
                package_id=body.package_id,
                episode_index=body.episode_index,
                task_context=body.task_context,
                annotations=body.annotations,
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/data/annotation/prototype-runs")
    async def data_annotation_prototypes(body: PrototypeRunRequest) -> dict[str, Any]:
        try:
            return service.annotation.start_prototype_run(
                package_id=body.package_id,
                cluster_count=body.cluster_count,
                candidate_limit=body.candidate_limit,
                episode_indices=body.episode_indices,
                quality_filter_mode=body.quality_filter_mode,
            )
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.post("/api/data/annotation/propagation-runs")
    async def data_annotation_propagation(body: PropagationRunRequest) -> dict[str, Any]:
        try:
            return service.annotation.start_propagation_run(
                package_id=body.package_id,
                source_episode_index=body.source_episode_index,
            )
        except (FileNotFoundError, ValueError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @app.get("/api/data/overview")
    async def data_overview() -> dict[str, Any]:
        return service.overview.overview()

    @app.get("/api/data/jobs/{job_id}")
    async def data_job(job_id: str) -> dict[str, Any]:
        try:
            return service.jobs.snapshot(job_id).to_dict()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Data job '{job_id}' not found") from exc

    @app.get("/api/data/jobs/{job_id}/events")
    async def data_job_events(job_id: str) -> StreamingResponse:
        async def generate():
            try:
                async for event in service.jobs.events(job_id):
                    yield format_sse(event)
            except KeyError:
                yield "event: error\ndata: {\"detail\":\"job not found\"}\n\n"

        return StreamingResponse(generate(), media_type="text/event-stream")

    @app.post("/api/data/jobs/{job_id}/cancel")
    async def data_job_cancel(job_id: str) -> dict[str, Any]:
        try:
            return service.jobs.cancel(job_id).to_dict()
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=f"Data job '{job_id}' not found") from exc
