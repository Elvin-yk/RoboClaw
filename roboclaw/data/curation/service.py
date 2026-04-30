"""Curation service orchestration facade."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from uuid import uuid4

from loguru import logger

from . import propagation_history
from .alignment_overview import build_alignment_overview
from .exports import (
    dataset_quality_parquet_path,
    dataset_text_annotations_parquet_path,
    save_working_quality_parquet,
    workflow_quality_parquet_path,
)
from .legacy_service import _LegacyCurationService
from .pipeline_helpers import (
    build_canonical_entries as _build_canonical_entries,
    collect_passed_episodes as _collect_passed_episodes,
    finish_propagation_empty as _finish_propagation_empty,
    finish_prototype_empty as _finish_prototype_empty,
    load_episode_duration as _load_episode_duration,
    propagate_single_target as _propagate_single_target,
)
from .quality_defaults import build_quality_defaults
from .quality_cache import (
    cleanup_completed_remote_episode_assets as _cleanup_completed_remote_episode_assets,
    cleanup_existing_remote_quality_assets as _cleanup_existing_remote_quality_assets,
    cleanup_remote_quality_cache as _cleanup_remote_quality_cache,
)
from .prototypes import discover_grouped_prototypes
from .serializers import (
    build_workspace_payload,
    coerce_int,
    serialize_propagation_results,
    serialize_prototype_results,
    serialize_quality_results,
)
from .service_state import (
    configure_quality_stage as _configure_quality_stage,
    finish_quality_stage as _finish_quality_stage,
    mark_quality_stage_paused,
    mark_quality_stage_paused as _mark_quality_stage_paused,
    quality_run_is_current as _quality_run_is_current,
    set_prototype_stage_context,
    set_prototype_stage_context as _set_prototype_stage_context,
    set_stage_status,
    set_stage_status as _set_stage_status,
    update_annotation_running_summary,
    update_annotation_running_summary as _update_annotation_running_summary,
    update_prototype_running_summary,
    update_prototype_running_summary as _update_prototype_running_summary,
    update_quality_running_summary,
    update_quality_running_summary as _update_quality_running_summary,
    update_stage_summary as _update_stage_summary,
)
from .state import (
    load_annotations,
    load_dataset_info,
    load_propagation_results,
    load_prototype_results,
    load_quality_results,
    load_workflow_state,
    save_annotations,
    save_propagation_results,
    save_workflow_state,
)
from .validators import load_episode_data, run_quality_validators


_load_info = load_dataset_info


def _episode_range(info: dict[str, Any]) -> list[int]:
    total = info.get("total_episodes", 0)
    return list(range(total))


class CurationService:
    """Orchestrates the 3-stage curation pipeline for a single dataset.

    A single instance is created at application startup.  Dataset-specific
    parameters are passed to each method rather than stored on ``__init__``.
    """

    def __init__(self) -> None:
        self._active_tasks: dict[tuple[str, str], asyncio.Task[Any]] = {}

    # ------------------------------------------------------------------
    # Legacy constructor shim — accepts (dataset_path, dataset_name) so
    # existing call-sites (e.g. ``CurationService(dp, dn)``) keep working
    # until they are migrated.
    # ------------------------------------------------------------------

    @classmethod
    def _legacy(cls, dataset_path: Path, dataset_name: str | None = None) -> _LegacyCurationService:
        return _LegacyCurationService(dataset_path, dataset_name)

    # ------------------------------------------------------------------
    # Task management
    # ------------------------------------------------------------------

    def _task_key(self, dataset_path: Path, stage_key: str) -> tuple[str, str]:
        return (str(dataset_path.resolve()), stage_key)

    def _active_stage_task(
        self,
        dataset_path: Path,
        stage_key: str,
    ) -> asyncio.Task[Any] | None:
        return self._active_tasks.get(self._task_key(dataset_path, stage_key))

    def _stage_task_is_running(self, dataset_path: Path, stage_key: str) -> bool:
        task = self._active_stage_task(dataset_path, stage_key)
        return task is not None and not task.done()

    async def _run_in_background(
        self,
        coro: Any,
        dataset_path: Path,
        stage_key: str,
    ) -> None:
        """Wrapper that logs errors and updates state on failure."""
        task_key = self._task_key(dataset_path, stage_key)
        current_task = asyncio.current_task()
        try:
            await coro
        except asyncio.CancelledError:
            if self._active_tasks.get(task_key) is current_task:
                state = load_workflow_state(dataset_path)
                stage = state["stages"][stage_key]
                if stage.get("status") != "paused" and not stage.get("pause_requested"):
                    stage["status"] = "error"
                    save_workflow_state(dataset_path, state)
            raise
        except Exception:
            logger.exception("Background workflow task failed")
            if self._active_tasks.get(task_key) is current_task:
                state = load_workflow_state(dataset_path)
                state["stages"][stage_key]["status"] = "error"
                save_workflow_state(dataset_path, state)
        finally:
            if self._active_tasks.get(task_key) is current_task:
                self._active_tasks.pop(task_key, None)

    def _register_workflow_task(
        self,
        dataset_path: Path,
        stage_key: str,
        coro: Any,
    ) -> None:
        """Schedule *coro* as the active background task for a stage."""
        task_key = self._task_key(dataset_path, stage_key)
        existing = self._active_stage_task(dataset_path, stage_key)
        if existing is not None and not existing.done():
            existing.cancel()
        task = asyncio.create_task(
            self._run_in_background(coro, dataset_path, stage_key),
        )
        self._active_tasks[task_key] = task

    def reconcile_stale_state(
        self,
        dataset_path: Path,
        state: dict[str, Any],
    ) -> dict[str, Any]:
        """Mark ``running`` stages whose task has vanished as ``error``."""
        resolved_dataset = str(dataset_path.resolve())
        changed = False
        for stage_key, stage in state.get("stages", {}).items():
            if stage.get("status") != "running":
                continue
            active_task = self._active_tasks.get((resolved_dataset, stage_key))
            if active_task is not None and not active_task.done():
                continue
            stage["status"] = "error"
            if stage_key == "quality_validation":
                stage["active_run_id"] = None
                stage["pause_requested"] = False
            summary = stage.get("summary")
            if not isinstance(summary, dict):
                summary = {}
            summary["warning"] = "Previous run was interrupted before completion."
            stage["summary"] = summary
            changed = True
        if changed:
            save_workflow_state(dataset_path, state)
        return state

    # ------------------------------------------------------------------
    # High-level orchestration (called from thin route layer)
    # ------------------------------------------------------------------

    async def start_quality_run(
        self,
        dataset_path: Path,
        dataset_name: str,
        selected_validators: list[str],
        episode_indices: list[int] | None,
        threshold_overrides: dict[str, float] | None,
    ) -> dict[str, str]:
        svc = _LegacyCurationService(dataset_path, dataset_name)
        run_id = uuid4().hex

        async def _task() -> None:
            await asyncio.to_thread(
                svc.run_quality_batch,
                selected_validators,
                episode_indices,
                threshold_overrides,
                None,
                False,
                run_id,
            )

        self._register_workflow_task(dataset_path, "quality_validation", _task())
        logger.info("Quality run queued for dataset '{}'", dataset_name)
        return {"status": "started"}

    def pause_quality_run(
        self,
        dataset_path: Path,
        dataset_name: str,
    ) -> dict[str, Any]:
        state = load_workflow_state(dataset_path)
        quality_stage = state["stages"]["quality_validation"]
        if quality_stage.get("status") != "running":
            raise ValueError("Quality validation is not running")

        active_task = self._active_stage_task(dataset_path, "quality_validation")
        pause_requested = (
            active_task is not None
            and not active_task.done()
            and quality_stage.get("active_run_id") is None
        )
        mark_quality_stage_paused(dataset_path, pause_requested=pause_requested)
        if active_task is not None and not active_task.done():
            active_task.cancel()
        logger.info("Quality pause applied for dataset '{}'", dataset_name)
        return {"status": "paused", "pause_requested": pause_requested}

    async def start_quality_resume(
        self,
        dataset_path: Path,
        dataset_name: str,
        selected_validators: list[str],
        episode_indices: list[int] | None,
        threshold_overrides: dict[str, float] | None,
    ) -> dict[str, str]:
        state = load_workflow_state(dataset_path)
        quality_stage = state["stages"]["quality_validation"]
        if quality_stage.get("status") != "paused":
            raise ValueError("Quality validation is not paused")

        existing = load_quality_results(dataset_path)
        if not existing:
            raise ValueError("No paused quality results to resume")

        completed = {
            int(episode.get("episode_index"))
            for episode in existing.get("episodes", [])
            if episode.get("episode_index") is not None
        }
        total = int(existing.get("total", 0) or 0)
        if episode_indices:
            remaining = [index for index in episode_indices if index not in completed]
        else:
            remaining = [index for index in range(total) if index not in completed]

        svc = _LegacyCurationService(dataset_path, dataset_name)
        resolved_validators = existing.get("selected_validators") or selected_validators
        resolved_overrides = existing.get("threshold_overrides") or threshold_overrides
        run_id = uuid4().hex
        last_progress_phase: str | None = None
        last_progress_bucket = -1

        def _progress(payload: dict[str, Any]) -> None:
            nonlocal last_progress_phase, last_progress_bucket
            phase = str(payload.get("phase", "quality_validation"))
            progress_percent = float(payload.get("progress_percent", 0.0) or 0.0)
            progress_bucket = int(progress_percent)
            is_complete = payload.get("completed") == payload.get("total")
            if (
                phase == last_progress_phase
                and progress_bucket == last_progress_bucket
                and not is_complete
            ):
                return
            last_progress_phase = phase
            last_progress_bucket = progress_bucket
            summary = {
                "phase": phase,
                "progress_percent": progress_percent,
            }
            if "total" in payload:
                summary["total"] = payload["total"]
            if "completed" in payload:
                summary["completed"] = payload["completed"]
            if "episode_index" in payload:
                summary["episode_index"] = payload["episode_index"]
            update_quality_running_summary(dataset_path, summary)

        async def _task() -> None:
            await asyncio.to_thread(
                svc.run_quality_batch,
                resolved_validators,
                remaining,
                resolved_overrides,
                _progress,
                True,
                run_id,
            )

        self._register_workflow_task(dataset_path, "quality_validation", _task())
        logger.info(
            "Quality resume queued for dataset '{}' with {} remaining episodes",
            dataset_name,
            len(remaining),
        )
        return {"status": "started"}

    async def start_prototype_run(
        self,
        dataset_path: Path,
        dataset_name: str,
        cluster_count: int | None,
        candidate_limit: int | None,
        episode_indices: list[int] | None = None,
        quality_filter_mode: str = "passed",
    ) -> dict[str, str]:
        svc = _LegacyCurationService(dataset_path, dataset_name)
        selected_episode_indices = list(episode_indices or [])
        set_prototype_stage_context(
            dataset_path,
            quality_filter_mode=quality_filter_mode,
            selected_episode_indices=selected_episode_indices,
            summary={
                "candidate_count": len(selected_episode_indices),
                "entry_count": 0,
                "cluster_count": 0,
                "group_count": 0,
                "quality_filter_mode": quality_filter_mode,
                "phase": "queued",
                "progress_percent": 0,
            },
        )

        last_progress_phase: str | None = None
        last_progress_bucket = -1

        def _progress(payload: dict[str, Any]) -> None:
            nonlocal last_progress_phase, last_progress_bucket
            phase = str(payload.get("phase", "running"))
            progress_percent = float(payload.get("progress_percent", 0) or 0)
            progress_bucket = int(progress_percent)
            is_complete = (
                payload.get("completed") == payload.get("total")
                or payload.get("pairs_completed") == payload.get("pairs_total")
            )
            if (
                phase == last_progress_phase
                and progress_bucket == last_progress_bucket
                and not is_complete
            ):
                return
            last_progress_phase = phase
            last_progress_bucket = progress_bucket
            summary_update = {
                "quality_filter_mode": quality_filter_mode,
                "phase": phase,
                "progress_percent": progress_percent,
            }
            if "total" in payload:
                summary_update["candidate_count"] = payload["total"]
            if "completed" in payload:
                summary_update["entry_count"] = payload["completed"]
            if "pairs_total" in payload:
                summary_update["distance_pair_count"] = payload["pairs_total"]
            if "pairs_completed" in payload:
                summary_update["distance_pairs_completed"] = payload["pairs_completed"]
            update_prototype_running_summary(dataset_path, summary_update)

        async def _task() -> None:
            await asyncio.to_thread(
                svc.run_prototype_discovery,
                cluster_count,
                candidate_limit,
                _progress,
                selected_episode_indices or None,
                quality_filter_mode,
            )

        self._register_workflow_task(dataset_path, "prototype_discovery", _task())
        logger.info("Prototype run queued for dataset '{}'", dataset_name)
        return {"status": "started"}

    async def start_propagation_run(
        self,
        dataset_path: Path,
        dataset_name: str,
        source_episode_index: int,
    ) -> dict[str, str]:
        if self._stage_task_is_running(dataset_path, "annotation"):
            logger.info(
                "Propagation run already active for dataset '{}'; ignoring duplicate request",
                dataset_name,
            )
            return {"status": "already_running"}

        set_stage_status(dataset_path, "annotation", "running")
        update_annotation_running_summary(
            dataset_path,
            {
                "source_episode_index": source_episode_index,
                "phase": "queued",
                "completed": 0,
                "total": 0,
                "progress_percent": 0,
            },
        )
        svc = _LegacyCurationService(dataset_path, dataset_name)
        last_progress_bucket = -1

        def _progress(payload: dict[str, Any]) -> None:
            nonlocal last_progress_bucket
            progress_percent = float(payload.get("progress_percent", 0) or 0)
            progress_bucket = int(progress_percent)
            is_complete = payload.get("completed") == payload.get("total")
            if progress_bucket == last_progress_bucket and not is_complete:
                return
            last_progress_bucket = progress_bucket
            summary_update = {
                "source_episode_index": source_episode_index,
                "phase": str(payload.get("phase", "semantic_propagation")),
                "progress_percent": progress_percent,
            }
            if "completed" in payload:
                summary_update["completed"] = payload["completed"]
            if "total" in payload:
                summary_update["total"] = payload["total"]
                summary_update["target_count"] = payload["total"]
            update_annotation_running_summary(dataset_path, summary_update)

        async def _task() -> None:
            def _run(_source_episode_index: int) -> dict[str, Any]:
                return svc.run_semantic_propagation(
                    source_episode_index,
                    _progress,
                )

            await asyncio.to_thread(
                _run,
                source_episode_index,
            )

        self._register_workflow_task(dataset_path, "annotation", _task())
        logger.info(
            "Propagation run queued for dataset '{}' from episode {}",
            dataset_name,
            source_episode_index,
        )
        return {"status": "started"}

    # ------------------------------------------------------------------
    # Query methods
    # ------------------------------------------------------------------

    def get_quality_results(self, dataset_path: Path) -> dict[str, Any]:
        payload = serialize_quality_results(load_quality_results(dataset_path))
        payload["working_parquet_path"] = str(workflow_quality_parquet_path(dataset_path))
        payload["published_parquet_path"] = str(dataset_quality_parquet_path(dataset_path))
        return payload

    def get_quality_defaults(self, dataset_path: Path, dataset_name: str | None = None) -> dict[str, Any]:
        return build_quality_defaults(dataset_path, dataset_name)

    def get_prototype_results(self, dataset_path: Path) -> dict[str, Any]:
        return serialize_prototype_results(load_prototype_results(dataset_path))

    def get_propagation_results(self, dataset_path: Path) -> dict[str, Any]:
        payload = serialize_propagation_results(load_propagation_results(dataset_path))
        payload["published_parquet_path"] = str(dataset_text_annotations_parquet_path(dataset_path))
        return payload

    def get_workflow_state(self, dataset_path: Path) -> dict[str, Any]:
        state = load_workflow_state(dataset_path)
        propagation_results = load_propagation_results(dataset_path)
        changed = propagation_history.reconcile_propagated_source_episodes(
            dataset_path,
            state,
            propagation_results,
        )
        state = self.reconcile_stale_state(dataset_path, state)
        if changed:
            save_workflow_state(dataset_path, state)
        return state

    def delete_quality_results(
        self,
        dataset: str,
        dataset_path: Path,
    ) -> dict[str, Any]:
        state = load_workflow_state(dataset_path)
        quality_stage = state["stages"]["quality_validation"]
        if quality_stage.get("status") == "running":
            raise ValueError("Quality validation is still running")

        removed_paths: list[str] = []
        for path in (
            dataset_path / ".workflow" / "quality" / "latest.json",
            workflow_quality_parquet_path(dataset_path),
            dataset_quality_parquet_path(dataset_path),
        ):
            if not path.exists():
                continue
            path.unlink()
            removed_paths.append(str(path))

        quality_stage["status"] = "idle"
        quality_stage["selected_validators"] = []
        quality_stage["latest_run"] = None
        quality_stage["active_run_id"] = None
        quality_stage["pause_requested"] = False
        quality_stage["summary"] = None
        save_workflow_state(dataset_path, state)
        logger.info("Deleted quality results for dataset '{}'", dataset)
        return {"status": "deleted", "removed_paths": removed_paths}

    def save_episode_annotations(
        self,
        dataset_path: Path,
        episode_index: int,
        data: dict[str, Any],
    ) -> dict[str, Any]:
        save_annotations(dataset_path, episode_index, data)
        self._update_annotation_stage(dataset_path, episode_index)
        saved = load_annotations(dataset_path, episode_index)
        if saved is None:
            raise RuntimeError("Annotation save did not persist")
        return saved

    def get_workspace_payload(
        self,
        dataset: str,
        dataset_path: Path,
        episode_index: int,
    ) -> dict[str, Any]:
        return build_workspace_payload(dataset, dataset_path, episode_index)

    def get_alignment_overview(self, dataset_path: Path) -> dict[str, Any]:
        return build_alignment_overview(dataset_path)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _update_annotation_stage(dataset_path: Path, episode_index: int) -> None:
        state = load_workflow_state(dataset_path)
        annotation_stage = state["stages"]["annotation"]
        annotated_episodes = {
            coerced
            for value in annotation_stage.get("annotated_episodes", [])
            if (coerced := coerce_int(value)) is not None
        }
        annotated_episodes.add(episode_index)
        annotation_stage["annotated_episodes"] = sorted(annotated_episodes)
        annotation_stage["summary"] = {
            "annotated_count": len(annotation_stage["annotated_episodes"]),
            "last_saved_episode_index": episode_index,
        }
        save_workflow_state(dataset_path, state)



# ---------------------------------------------------------------------------
# _LegacyCurationService — holds dataset_path/name for pipeline methods.
# Used internally by CurationService orchestration methods and by existing
