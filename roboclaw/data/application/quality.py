from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from roboclaw.data.curation.quality_defaults import build_quality_defaults
from roboclaw.data.curation.quality_results import aggregate_quality_results, run_base_quality_validators
from roboclaw.data.infrastructure.filesystem import DataRepository

from .jobs import DataJobCoordinator, DataJobHandle


class DataQualityService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def defaults(self, package_id: str) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        return build_quality_defaults(path, package_id)

    def results(self, package_id: str) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        results_path = self._results_path(path)
        if not results_path.is_file():
            return {"package_id": package_id, "status": "missing", "results": None}
        return json.loads(results_path.read_text(encoding="utf-8"))

    def start_run(
        self,
        *,
        package_id: str,
        selected_validators: list[str],
        episode_indices: list[int] | None,
        threshold_overrides: dict[str, float] | None,
    ) -> dict[str, Any]:
        path = self.repository.resolve_package_path(package_id)
        indices = episode_indices if episode_indices is not None else self._episode_indices(path)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            self.repository.state_store.set_package_stage(path, "validating")
            self.repository.state_store.set_gate(
                path,
                object_type="package",
                key="validate",
                status="running",
                message="Running package quality validators",
            )
            per_episode: list[dict[str, Any]] = []
            passed = 0
            failed = 0
            for index, episode_index in enumerate(indices, start=1):
                if handle.cancelled:
                    break
                result = await asyncio.to_thread(
                    run_base_quality_validators,
                    path,
                    episode_index,
                    selected_validators=selected_validators,
                    threshold_overrides=threshold_overrides,
                )
                episode_result = {"episode_index": episode_index, **result}
                per_episode.append(episode_result)
                if result.get("passed"):
                    passed += 1
                else:
                    failed += 1
                await handle.item(episode_result)
                await handle.update(processed=index, message=f"Validated episode {episode_index}")
            aggregate = aggregate_quality_results(
                per_episode,
                selected_validators,
                passed,
                failed,
                len(indices),
                threshold_overrides,
            )
            payload = {"package_id": package_id, "status": "completed", "results": aggregate}
            self._write_results(path, payload)
            state = self.repository.state_store.load_package_state(path)
            state["quality_summary"] = {
                "overall_score": aggregate["overall_score"],
                "passed": aggregate["passed"],
                "failed": aggregate["failed"],
                "total": aggregate["total"],
            }
            self.repository.state_store.write_package_state(path, state)
            self.repository.state_store.set_gate(
                path,
                object_type="package",
                key="validate",
                status="passed" if failed == 0 else "needs_review",
                message="Quality validation completed",
                details=state["quality_summary"],
            )
            self.repository.state_store.set_package_stage(path, "validated")
            return payload

        job = self.jobs.start(
            kind="quality",
            target_type="package",
            target_id=package_id,
            total=len(indices),
            message="Queued package quality run",
            runner=runner,
        )
        return job.to_dict()

    def _episode_indices(self, package_path: Path) -> list[int]:
        episodes_path = package_path / "meta" / "episodes.jsonl"
        if episodes_path.is_file():
            rows = [json.loads(line) for line in episodes_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            return [int(row.get("episode_index", index) or index) for index, row in enumerate(rows)]
        info_path = package_path / "meta" / "info.json"
        if not info_path.is_file():
            return []
        info = json.loads(info_path.read_text(encoding="utf-8"))
        return list(range(int(info.get("total_episodes", 0) or 0)))

    def _results_path(self, package_path: Path) -> Path:
        return package_path / ".data" / "quality" / "latest.json"

    def _write_results(self, package_path: Path, payload: dict[str, Any]) -> None:
        path = self._results_path(package_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
