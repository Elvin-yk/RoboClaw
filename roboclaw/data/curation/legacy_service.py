from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from loguru import logger

from .quality_results import aggregate_quality_results, run_base_quality_validators
from .reference_tube import TRAJECTORY_DTW_VALIDATOR
from .serializers import coerce_int
from .service_state import (
    configure_quality_stage,
    quality_run_is_current,
    update_prototype_running_summary,
)
from .state import (
    is_stage_pause_requested,
    load_annotations,
    load_propagation_results,
    load_prototype_results,
    load_quality_results,
    load_workflow_state,
    save_prototype_results,
    save_quality_results,
    save_workflow_state,
)
from .exports import save_working_quality_parquet
from .trajectory_quality import append_trajectory_dtw_results
from .pipeline_helpers import collect_passed_episodes


def episode_range(info: dict[str, Any]) -> list[int]:
    total = info.get("total_episodes", 0)
    return list(range(total))


class _LegacyCurationService:
    """Bound pipeline executor for a single dataset."""

    def __init__(self, dataset_path: Path, dataset_name: str | None = None):
        self.dataset_path = dataset_path
        self.dataset_name = dataset_name or dataset_path.name

    # ------------------------------------------------------------------
    # Stage 1: Quality validation
    # ------------------------------------------------------------------

    def run_quality_batch(
        self,
        selected_validators: list[str],
        episode_indices: list[int] | None = None,
        threshold_overrides: dict[str, float] | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
        resume_existing: bool = False,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Run quality validation across episodes.

        Updates workflow state to running/completed and persists results.
        """
        configure_quality_stage(
            self.dataset_path,
            status="running",
            selected_validators=selected_validators,
            active_run_id=run_id,
        )
        logger.info("Quality batch started for {}", self.dataset_path.name)

        from . import service as curation_service

        info = curation_service._load_info(self.dataset_path)
        indices = list(episode_indices) if episode_indices is not None else curation_service._episode_range(info)
        include_trajectory_dtw = TRAJECTORY_DTW_VALIDATOR in selected_validators
        base_validators = [
            name for name in selected_validators
            if name != TRAJECTORY_DTW_VALIDATOR
        ]
        per_episode: list[dict[str, Any]] = []
        passed_count = 0
        failed_count = 0
        total = len(indices)

        initial_completed = 0

        if resume_existing:
            existing = load_quality_results(self.dataset_path) or {}
            existing_episodes = existing.get("episodes", [])
            if isinstance(existing_episodes, list):
                per_episode = list(existing_episodes)
            initial_completed = len(per_episode)
            passed_count = sum(1 for episode in per_episode if episode.get("passed"))
            failed_count = max(len(per_episode) - passed_count, 0)
            existing_total = existing.get("total")
            try:
                total = int(existing_total)
            except (TypeError, ValueError):
                total = len(per_episode) + len(indices)

        remaining_indices = set(indices)
        if per_episode:
            completed_indices = {
                index
                for episode in per_episode
                if (index := coerce_int(episode.get("episode_index"))) is not None
            }
            cleanup = curation_service._cleanup_existing_remote_quality_assets(
                self.dataset_path,
                info,
                completed_indices,
                remaining_indices,
            )
            if cleanup["removed_count"]:
                logger.info(
                    "Removed {} remote quality cache files from completed episodes",
                    cleanup["removed_count"],
                )

        def current_or_saved_results() -> dict[str, Any]:
            return load_quality_results(self.dataset_path) or aggregate_quality_results(
                per_episode,
                selected_validators,
                passed_count,
                failed_count,
                total,
                threshold_overrides,
            )

        def finalize_quality_run(stage_status: str) -> dict[str, Any]:
            if not quality_run_is_current(self.dataset_path, run_id):
                return current_or_saved_results()
            aggregated = aggregate_quality_results(
                per_episode,
                selected_validators,
                passed_count,
                failed_count,
                total,
                threshold_overrides,
            )
            save_quality_results(self.dataset_path, aggregated)

            parquet_path = None
            try:
                parquet_info = save_working_quality_parquet(self.dataset_name, self.dataset_path)
                parquet_path = parquet_info["path"]
            except Exception:
                logger.exception(
                    "Failed to write working quality parquet for {}",
                    self.dataset_path.name,
                )

            summary = {
                "total": total,
                "completed": len(per_episode),
                "remaining": max(total - len(per_episode), 0),
                "passed": passed_count,
                "failed": failed_count,
                "overall_score": aggregated["overall_score"],
                "progress_percent": round((len(per_episode) / max(total, 1)) * 100, 1),
                "quality_parquet_path": parquet_path,
            }
            finished = curation_service._finish_quality_stage(
                self.dataset_path,
                status=stage_status,
                summary=summary,
                run_id=run_id,
            )
            if not finished:
                return load_quality_results(self.dataset_path) or aggregated
            if stage_status == "paused":
                logger.info(
                    "Quality batch paused after {}/{} episodes",
                    len(per_episode),
                    total,
                )
            else:
                logger.info(
                    "Quality batch completed: {}/{} passed (mean score {:.1f})",
                    passed_count,
                    total,
                    aggregated["overall_score"],
                )
            return aggregated

        for position, ep_idx in enumerate(indices):
            if not quality_run_is_current(self.dataset_path, run_id):
                return current_or_saved_results()
            if is_stage_pause_requested(self.dataset_path, "quality_validation"):
                return finalize_quality_run("paused")
            logger.info("Validating episode {}/{}", initial_completed + position + 1, total)
            result = run_base_quality_validators(
                self.dataset_path,
                ep_idx,
                selected_validators=base_validators,
                threshold_overrides=threshold_overrides,
                runner=curation_service.run_quality_validators,
            )
            if not quality_run_is_current(self.dataset_path, run_id):
                return current_or_saved_results()
            entry = {
                "episode_index": ep_idx,
                "passed": result["passed"],
                "score": result["score"],
                "validators": result["validators"],
                "issues": result["issues"],
            }
            per_episode.append(entry)
            if result["passed"]:
                passed_count += 1
            else:
                failed_count += 1
            remaining_indices.discard(ep_idx)

            save_quality_results(
                self.dataset_path,
                aggregate_quality_results(
                    per_episode,
                    selected_validators,
                    passed_count,
                    failed_count,
                    total,
                    threshold_overrides,
                ),
            )

            if is_stage_pause_requested(self.dataset_path, "quality_validation"):
                return finalize_quality_run("paused")

            cleanup = curation_service._cleanup_completed_remote_episode_assets(
                self.dataset_path,
                info,
                ep_idx,
                remaining_indices,
            )
            if cleanup["removed_count"]:
                logger.info(
                    "Removed {} remote quality cache files after episode {}",
                    cleanup["removed_count"],
                    ep_idx,
                )

            if progress_callback is not None:
                progress_callback({
                    "phase": "quality_validation",
                    "episode_index": ep_idx,
                    "completed": initial_completed + position + 1,
                    "total": total,
                    "progress_percent": round(
                        ((initial_completed + position + 1) / max(total, 1)) * 100,
                        1,
                    ),
                })

        if include_trajectory_dtw:
            if not quality_run_is_current(self.dataset_path, run_id):
                return current_or_saved_results()
            append_trajectory_dtw_results(
                self.dataset_path,
                per_episode,
                threshold_overrides=threshold_overrides,
                progress_callback=progress_callback,
            )
            if not quality_run_is_current(self.dataset_path, run_id):
                return current_or_saved_results()
            passed_count = sum(1 for episode in per_episode if episode.get("passed"))
            failed_count = max(len(per_episode) - passed_count, 0)

        completed = finalize_quality_run("completed")
        cleanup = curation_service._cleanup_remote_quality_cache(self.dataset_path)
        if cleanup["removed_count"]:
            logger.info(
                "Removed {} remote quality cache directories after completion",
                cleanup["removed_count"],
            )
        return completed

    # ------------------------------------------------------------------
    # Stage 2: Prototype discovery
    # ------------------------------------------------------------------

    def run_prototype_discovery(
        self,
        cluster_count: int | None = None,
        candidate_limit: int | None = None,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
        episode_indices: list[int] | None = None,
        quality_filter_mode: str = "passed",
    ) -> dict[str, Any]:
        """Run DTW + k-medoids prototype discovery on the selected episode subset."""
        from . import service as curation_service

        curation_service._set_stage_status(self.dataset_path, "prototype_discovery", "running")
        logger.info("Prototype discovery started for {}", self.dataset_path.name)

        if episode_indices is not None:
            selected_episodes = list(episode_indices)
        elif quality_filter_mode == "raw":
            selected_episodes = curation_service._episode_range(curation_service._load_info(self.dataset_path))
        else:
            selected_episodes = collect_passed_episodes(self.dataset_path)
        if not selected_episodes:
            return curation_service._finish_prototype_empty(self.dataset_path)

        candidates = (
            selected_episodes
            if candidate_limit is None
            else selected_episodes[:candidate_limit]
        )
        curation_service._set_prototype_stage_context(
            self.dataset_path,
            quality_filter_mode=quality_filter_mode,
            selected_episode_indices=candidates,
            summary={
                "candidate_count": len(candidates),
                "entry_count": 0,
                "cluster_count": 0,
                "group_count": 0,
                "quality_filter_mode": quality_filter_mode,
                "phase": "building_canonical",
                "progress_percent": 0,
            },
        )
        entries = curation_service._build_canonical_entries(self.dataset_path, candidates, progress_callback)
        if not entries:
            return curation_service._finish_prototype_empty(self.dataset_path)

        update_prototype_running_summary(
            self.dataset_path,
            {
                "candidate_count": len(candidates),
                "entry_count": len(entries),
                "phase": "building_dtw_graph",
                "progress_percent": 0,
            },
        )
        prototypes = curation_service.discover_grouped_prototypes(
            entries,
            cluster_count=cluster_count,
            progress_callback=progress_callback,
        )
        clustering = prototypes["clustering"]
        refined = prototypes["refinement"]

        results = {
            "clustering": clustering,
            "refinement": refined,
            "candidate_count": len(candidates),
            "entry_count": len(entries),
            "cluster_count": refined.get("cluster_count", clustering.get("cluster_count", 0)),
            "group_count": prototypes["group_count"],
            "quality_filter_mode": quality_filter_mode,
            "selected_episode_indices": candidates,
        }
        save_prototype_results(self.dataset_path, results)
        curation_service._update_stage_summary(
            self.dataset_path,
            "prototype_discovery",
            {
                "candidate_count": len(candidates),
                "entry_count": len(entries),
                "cluster_count": results["cluster_count"],
                "group_count": results["group_count"],
                "quality_filter_mode": quality_filter_mode,
                "selection_mode": clustering.get("selection_mode"),
                "distance_pair_count": clustering.get("distance_pair_count", 0),
                "distance_backend": clustering.get("distance_backend", "cpu"),
            },
        )
        logger.info(
            "Prototype discovery completed: {} entries, {} clusters",
            len(entries), results["cluster_count"],
        )
        return results

    # ------------------------------------------------------------------
    # Stage 3: Semantic propagation
    # ------------------------------------------------------------------

    def run_semantic_propagation(
        self,
        source_episode_index: int,
        progress_callback: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        """Propagate annotations from source episode to cluster members."""
        from . import service as curation_service

        curation_service._set_stage_status(self.dataset_path, "annotation", "running")
        logger.info(
            "Semantic propagation started from episode {} for {}",
            source_episode_index, self.dataset_path.name,
        )

        source_annotations = load_annotations(self.dataset_path, source_episode_index)
        if source_annotations is None:
            return curation_service._finish_propagation_empty(self.dataset_path, source_episode_index)

        spans = source_annotations.get("annotations", [])
        if not spans:
            return curation_service._finish_propagation_empty(self.dataset_path, source_episode_index)

        source_duration = curation_service._load_episode_duration(self.dataset_path, source_episode_index)
        source_entry = build_propagation_entry(self.dataset_path, source_episode_index)
        prototype_results = load_prototype_results(self.dataset_path)
        targets = propagation_history.collect_propagation_targets(
            prototype_results, source_episode_index,
        )

        propagated: list[dict[str, Any]] = []
        persisted_annotation_targets: set[int] = {source_episode_index}
        total = len(targets)
        for position, target in enumerate(targets):
            result, persisted = curation_service._propagate_single_target(
                self.dataset_path,
                target,
                spans,
                source_duration,
                source_entry,
                source_annotations,
                source_episode_index,
            )
            propagated.append(result)
            if persisted:
                persisted_annotation_targets.add(target["episode_index"])
            if progress_callback is not None:
                progress_callback({
                    "phase": "semantic_propagation",
                    "completed": position + 1,
                    "total": total,
                    "progress_percent": round(((position + 1) / max(total, 1)) * 100, 1),
                })

        previous_results = load_propagation_results(self.dataset_path)
        state = load_workflow_state(self.dataset_path)
        annotation_stage = state["stages"]["annotation"]
        propagated_source_episodes = propagation_history.collect_propagated_source_episodes(
            annotation_stage,
            previous_results,
            source_episode_index,
        )
        results = {
            "source_episode_index": source_episode_index,
            "source_episode_indices": propagated_source_episodes,
            "target_count": len(propagated),
            "propagated": propagated,
        }
        curation_service.save_propagation_results(self.dataset_path, results)
        existing_targets = {
            int(value)
            for value in annotation_stage.get("annotated_episodes", [])
            if isinstance(value, int) or str(value).isdigit()
        }
        annotation_stage["annotated_episodes"] = sorted(existing_targets | persisted_annotation_targets)
        annotation_stage["propagated_source_episodes"] = propagated_source_episodes
        save_workflow_state(self.dataset_path, state)
        curation_service._update_stage_summary(
            self.dataset_path,
            "annotation",
            {
                "source_episode_index": source_episode_index,
                "propagated_source_episodes": propagated_source_episodes,
                "target_count": len(propagated),
                "annotated_count": len(annotation_stage["annotated_episodes"]),
                "completed": len(propagated),
                "total": len(propagated),
                "phase": "semantic_propagation",
                "progress_percent": 100,
            },
        )
        logger.info(
            "Semantic propagation completed: {} targets from episode {}",
            len(propagated), source_episode_index,
        )
        return results


# ---------------------------------------------------------------------------
