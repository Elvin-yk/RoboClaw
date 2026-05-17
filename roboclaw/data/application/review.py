from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from uuid import uuid4

from roboclaw.data.curation.bridge import read_parquet_rows, write_parquet_rows
from roboclaw.data.curation.paths import PACKAGE_DATA_PATH, PACKAGE_VIDEO_PATH
from roboclaw.data.curation.serializers import video_feature_keys
from roboclaw.data.domain.models import (
    MANUAL_REVIEW_DECISION_FAILED,
    MANUAL_REVIEW_DECISION_PASSED,
    MANUAL_REVIEW_STATUS_FAILED,
    MANUAL_REVIEW_STATUS_NEEDS_FIX,
    MANUAL_REVIEW_STATUS_PASSED,
    MANUAL_REVIEW_STATUS_PENDING,
)
from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.infrastructure.state_store import utc_now_iso

from .jobs import DataJobCoordinator, DataJobHandle

REVIEW_STATUSES = {
    MANUAL_REVIEW_STATUS_PENDING,
    MANUAL_REVIEW_STATUS_PASSED,
    MANUAL_REVIEW_STATUS_NEEDS_FIX,
    MANUAL_REVIEW_STATUS_FAILED,
}
REVIEW_DECISIONS = {MANUAL_REVIEW_DECISION_PASSED, MANUAL_REVIEW_DECISION_FAILED}
REVIEW_BATCH_APPLICABLE_STATUSES = {MANUAL_REVIEW_STATUS_PASSED, MANUAL_REVIEW_STATUS_NEEDS_FIX}


@dataclass(frozen=True)
class ReviewBatchContext:
    dataset_path: Path
    source_path: Path
    info: dict[str, Any]
    episodes: list[dict[str, Any]]
    state: dict[str, Any]
    review: dict[str, Any]


class DataReviewService:
    def __init__(self, repository: DataRepository, jobs: DataJobCoordinator) -> None:
        self.repository = repository
        self.jobs = jobs

    def workspace(self, *, dataset_id: str) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        materialized_path = self.repository.dataset_materialized_path(dataset_id)
        info = self._read_json(materialized_path / "meta" / "info.json")
        episodes = self._normalize_episode_meta(info, self._read_episode_meta(materialized_path, info))
        episode_indices = [int(entry["episode_index"]) for entry in episodes]
        return {
            "dataset": self.repository.read_dataset(dataset_id).to_dict(),
            "review": self._review_state(dataset_path, episode_indices),
            "episode_indices": episode_indices,
            "total_episodes": len(episode_indices),
        }

    def save_episode_decision(
        self,
        *,
        dataset_id: str,
        episode_index: int,
        decision: str,
        reason: str,
        note: str,
        reviewer_id: str,
    ) -> dict[str, Any]:
        normalized_decision = decision.strip().lower()
        if normalized_decision not in REVIEW_DECISIONS:
            raise ValueError("decision must be 'passed' or 'failed'")
        normalized_reason = reason.strip()
        if normalized_decision == MANUAL_REVIEW_DECISION_FAILED and not normalized_reason:
            raise ValueError("reason is required when decision is failed")

        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        state = self.repository.state_store.load_dataset_state(dataset_path)
        if self._clean_status(state) != "passed":
            raise ValueError(f"Dataset '{dataset_id}' has not passed auto clean")
        materialized_path = self.repository.dataset_materialized_path(dataset_id)
        info = self._read_json(materialized_path / "meta" / "info.json")
        episodes = self._normalize_episode_meta(info, self._read_episode_meta(materialized_path, info))
        episode_indices = [int(entry["episode_index"]) for entry in episodes]
        if episode_index not in episode_indices:
            raise ValueError(f"Episode {episode_index} is not part of dataset '{dataset_id}'")

        review = self._review_state_from_payload(state, episode_indices)
        review["episodes"][str(episode_index)] = {
            "decision": normalized_decision,
            "reason": normalized_reason if normalized_decision == MANUAL_REVIEW_DECISION_FAILED else "",
            "note": note.strip(),
            "reviewer_id": reviewer_id.strip(),
            "reviewed_at": utc_now_iso(),
        }
        self._update_review_progress(review, episode_indices)
        review["updated_at"] = utc_now_iso()
        self._write_review_state(dataset_path, state, review, event_type="review_episode_decision")
        return self.workspace(dataset_id=dataset_id)

    def save_draft(
        self,
        *,
        dataset_id: str,
        draft_edits: dict[str, Any],
        reviewer_id: str,
    ) -> dict[str, Any]:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        materialized_path = self.repository.dataset_materialized_path(dataset_id)
        info = self._read_json(materialized_path / "meta" / "info.json")
        episodes = self._normalize_episode_meta(info, self._read_episode_meta(materialized_path, info))
        episode_indices = [int(entry["episode_index"]) for entry in episodes]
        state = self.repository.state_store.load_dataset_state(dataset_path)
        review = self._review_state_from_payload(state, episode_indices)
        next_draft = dict(review.get("draft_edits") or {})
        if "task_description" in draft_edits:
            next_draft["task_description"] = str(draft_edits.get("task_description") or "").strip()
        review["draft_edits"] = next_draft
        review["draft_reviewer_id"] = reviewer_id.strip()
        self._update_review_progress(review, episode_indices)
        review["updated_at"] = utc_now_iso()
        self._write_review_state(dataset_path, state, review, event_type="review_draft_saved")
        return self.workspace(dataset_id=dataset_id)

    def start_batch_run(self, *, dataset_ids: list[str], reviewer_id: str) -> dict[str, Any]:
        ids = [item.strip() for item in dataset_ids if item.strip()]
        if not ids:
            raise ValueError("dataset_ids must not be empty")
        for dataset_id in ids:
            self._require_ready_for_batch(dataset_id)

        async def runner(handle: DataJobHandle) -> dict[str, Any]:
            results: list[dict[str, Any]] = []
            for index, dataset_id in enumerate(ids, start=1):
                await handle.update(processed=index - 1, message=f"Applying review batch for {dataset_id}")
                result = self._apply_review_batch(dataset_id=dataset_id, reviewer_id=reviewer_id.strip())
                results.append(result)
                await handle.item(result)
            await handle.update(processed=len(ids), message="Review batch applied")
            return {"datasets": results}

        job = self.jobs.start(
            kind="review_batch",
            target_type="global",
            target_id="review_batch",
            total=len(ids),
            message="Queued review batch",
            runner=runner,
        )
        return job.to_dict()

    def _require_ready_for_batch(self, dataset_id: str) -> None:
        self._review_batch_context(dataset_id)

    def _review_batch_context(self, dataset_id: str) -> ReviewBatchContext:
        dataset_path = self.repository.resolve_dataset_path(dataset_id)
        source_path = self.repository.dataset_materialized_path(dataset_id)
        info = self._read_json(source_path / "meta" / "info.json")
        episodes = self._normalize_episode_meta(info, self._read_episode_meta(source_path, info))
        episode_indices = [int(entry["episode_index"]) for entry in episodes]
        state = self.repository.state_store.load_dataset_state(dataset_path)
        review = self._review_state_from_payload(state, episode_indices)
        self._assert_review_batch_applicable(dataset_id, state, review)
        return ReviewBatchContext(
            dataset_path=dataset_path,
            source_path=source_path,
            info=info,
            episodes=episodes,
            state=state,
            review=review,
        )

    def _assert_review_batch_applicable(
        self,
        dataset_id: str,
        state: dict[str, Any],
        review: dict[str, Any],
    ) -> None:
        if review["status"] not in REVIEW_BATCH_APPLICABLE_STATUSES:
            raise ValueError(f"Dataset '{dataset_id}' is not ready for review batch")
        if review.get("batch_result"):
            raise ValueError(f"Dataset '{dataset_id}' review batch has already been applied")
        if self._clean_status(state) != "passed":
            raise ValueError(f"Dataset '{dataset_id}' has not passed auto clean")

    def _apply_review_batch(self, *, dataset_id: str, reviewer_id: str) -> dict[str, Any]:
        context = self._review_batch_context(dataset_id)
        failed_indices = {
            int(index)
            for index, payload in context.review["episodes"].items()
            if dict(payload).get("decision") == MANUAL_REVIEW_DECISION_FAILED
        }
        kept_episodes = [entry for entry in context.episodes if int(entry["episode_index"]) not in failed_indices]
        if not kept_episodes:
            raise ValueError(f"Dataset '{dataset_id}' has no episodes to keep")
        artifact_dir = self._write_review_artifact(
            context,
            kept_episodes=kept_episodes,
        )
        relative_path = artifact_dir.relative_to(context.dataset_path).as_posix()
        applied_at = utc_now_iso()
        state = context.state
        review = context.review
        review["status"] = MANUAL_REVIEW_STATUS_PASSED
        review["applied_at"] = applied_at
        review["applied_by"] = reviewer_id
        review["artifact_relative_path"] = relative_path
        review["updated_at"] = applied_at
        review["batch_result"] = {
            "kept_episode_indices": [int(entry["episode_index"]) for entry in kept_episodes],
            "removed_episode_indices": sorted(failed_indices),
            "artifact_relative_path": relative_path,
        }
        qc = state.setdefault("qc", {"lanes": {}, "reports": {}})
        qc["review"] = review
        state["lifecycle_stage"] = "clean"
        state["active_output"] = {
            "kind": "artifact",
            "relative_path": relative_path,
            "created_at": applied_at,
            "reason": "review_batch",
        }
        gates = state.setdefault("gates", {})
        if "review" in gates:
            gates["review"] = {
                **gates["review"],
                "status": "passed",
                "message": "review_batch_applied",
                "details": review["batch_result"],
                "updated_at": applied_at,
            }
        self.repository.state_store.write_dataset_state(context.dataset_path, state)
        self.repository.state_store.append_dataset_event(context.dataset_path, {
            "type": "review_batch_applied",
            "review_status": review["status"],
            "artifact_relative_path": relative_path,
            "removed_episode_indices": sorted(failed_indices),
        })
        return {
            "dataset_id": dataset_id,
            "active_output": state["active_output"],
            **review["batch_result"],
        }

    def _write_review_artifact(
        self,
        context: ReviewBatchContext,
        *,
        kept_episodes: list[dict[str, Any]],
    ) -> Path:
        artifact_root = context.dataset_path / ".status" / "artifacts"
        artifact_root.mkdir(parents=True, exist_ok=True)
        artifact_dir = artifact_root / f"review-{uuid4().hex[:10]}"
        with TemporaryDirectory(prefix=f".{artifact_dir.name}-", dir=artifact_root) as temporary_root:
            temporary_artifact_dir = Path(temporary_root) / artifact_dir.name
            self._materialize_review_artifact(
                output_path=temporary_artifact_dir,
                source_path=context.source_path,
                info=context.info,
                episodes=kept_episodes,
                draft_edits=dict(context.review.get("draft_edits") or {}),
            )
            temporary_artifact_dir.replace(artifact_dir)
        return artifact_dir

    def _materialize_review_artifact(
        self,
        *,
        output_path: Path,
        source_path: Path,
        info: dict[str, Any],
        episodes: list[dict[str, Any]],
        draft_edits: dict[str, Any],
    ) -> None:
        shutil.copytree(
            source_path,
            output_path,
            ignore=shutil.ignore_patterns(".status", ".data", ".workflow", "data", "videos", "meta"),
        )
        (output_path / "meta").mkdir(parents=True, exist_ok=True)
        output_chunks_size = int(info.get("chunks_size", 1000) or 1000)
        episode_index_map = {
            int(entry["episode_index"]): index
            for index, entry in enumerate(episodes)
        }
        data_file_by_episode, frame_counts = self._materialize_parquet_data(
            output_path=output_path,
            source_path=source_path,
            info=info,
            episode_index_map=episode_index_map,
            episodes=episodes,
            output_chunks_size=output_chunks_size,
        )
        output_info = dict(info)
        output_info["data_path"] = PACKAGE_DATA_PATH
        if video_feature_keys(info):
            output_info["video_path"] = PACKAGE_VIDEO_PATH
        output_info["chunks_size"] = output_chunks_size
        output_info["total_episodes"] = len(episodes)
        output_info["total_videos"] = 0
        output_info["episode_lengths"] = []
        output_info["splits"] = {"train": f"0:{len(episodes)}"}
        task_description = str(draft_edits.get("task_description") or "").strip()
        if task_description:
            output_info["task_description"] = task_description
            self._write_task_description(output_path, task_description)
        else:
            self._copy_task_files(source_path, output_path)

        total_frames = 0
        copied_video_count = 0
        output_episodes: list[dict[str, Any]] = []
        for next_index, entry in enumerate(episodes):
            source_episode_index = int(entry["episode_index"])
            length = frame_counts.get(source_episode_index, int(entry.get("length", 0) or 0))
            package_entry = {
                **entry,
                **self._data_pointer(data_file_by_episode.get(source_episode_index)),
                "episode_index": next_index,
                "source_episode_index": source_episode_index,
                "dataset_from_index": total_frames,
                "dataset_to_index": total_frames + length,
                "length": length,
            }
            video_pointers = self._copy_episode_videos(
                output_path=output_path,
                source_path=source_path,
                info=info,
                source_episode=entry,
                output_episode_index=next_index,
                output_chunks_size=output_chunks_size,
            )
            copied_video_count += len(video_pointers)
            package_entry.update(video_pointers)
            output_episodes.append(package_entry)
            total_frames += length
            output_info["episode_lengths"].append(length)
        output_info["total_frames"] = total_frames
        output_info["total_videos"] = copied_video_count
        (output_path / "meta" / "info.json").write_text(
            json.dumps(output_info, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self._write_jsonl(output_path / "meta" / "episodes.jsonl", output_episodes)
        (output_path / "meta" / "review_batch.json").write_text(
            json.dumps({
                "created_at": utc_now_iso(),
                "source_path": str(source_path),
                "source_episode_indices": [int(entry["episode_index"]) for entry in episodes],
                "draft_edits": draft_edits,
            }, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def _materialize_parquet_data(
        self,
        *,
        output_path: Path,
        source_path: Path,
        info: dict[str, Any],
        episode_index_map: dict[int, int],
        episodes: list[dict[str, Any]],
        output_chunks_size: int,
    ) -> tuple[dict[int, tuple[int, int]], dict[int, int]]:
        data_file_by_episode: dict[int, tuple[int, int]] = {}
        frame_counts: dict[int, int] = {}
        frame_index = 0
        parquet_file_index = 0
        for source_file in sorted((source_path / "data").rglob("*.parquet")):
            rows = read_parquet_rows(source_file)
            if not rows:
                continue
            source_episode = self._infer_source_episode_for_parquet(source_path, info, episodes, source_file)
            remapped_rows: list[dict[str, Any]] = []
            for row in rows:
                row_episode = self._coerce_episode_index(row.get("episode_index"), source_episode)
                if row_episode not in episode_index_map:
                    continue
                mapped_episode = episode_index_map[row_episode]
                next_row = dict(row)
                next_row["episode_index"] = mapped_episode
                if "index" in next_row:
                    next_row["index"] = frame_index
                if "task_index" in next_row:
                    next_row["task_index"] = int(next_row.get("task_index", 0) or 0)
                frame_index += 1
                frame_counts[row_episode] = frame_counts.get(row_episode, 0) + 1
                remapped_rows.append(next_row)
            if not remapped_rows:
                continue
            chunk_index = parquet_file_index // output_chunks_size
            file_index = parquet_file_index % output_chunks_size
            for row in remapped_rows:
                data_file_by_episode[int(row["episode_index"])] = (chunk_index, file_index)
            output_file = output_path / PACKAGE_DATA_PATH.format(chunk_index=chunk_index, file_index=file_index)
            write_parquet_rows(output_file, remapped_rows)
            parquet_file_index += 1
        return {
            source_episode: pointer
            for source_episode, mapped_episode in episode_index_map.items()
            if (pointer := data_file_by_episode.get(mapped_episode)) is not None
        }, frame_counts

    def _copy_episode_videos(
        self,
        *,
        output_path: Path,
        source_path: Path,
        info: dict[str, Any],
        source_episode: dict[str, Any],
        output_episode_index: int,
        output_chunks_size: int,
    ) -> dict[str, Any]:
        pointers: dict[str, Any] = {}
        source_episode_index = int(source_episode.get("episode_index", output_episode_index) or 0)
        chunk_index = output_episode_index // output_chunks_size
        file_index = output_episode_index % output_chunks_size
        for video_key in video_feature_keys(info):
            source_video_path = self._source_video_path(source_path, info, source_episode, video_key, source_episode_index)
            if not source_video_path.is_file():
                continue
            target_path = output_path / PACKAGE_VIDEO_PATH.format(
                video_key=video_key,
                chunk_index=chunk_index,
                file_index=file_index,
            )
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_video_path, target_path)
            prefix = f"videos/{video_key}/"
            pointers[f"{prefix}chunk_index"] = chunk_index
            pointers[f"{prefix}file_index"] = file_index
            for suffix in ("from_timestamp", "to_timestamp"):
                value = source_episode.get(f"{prefix}{suffix}", source_episode.get(f"video_{suffix}"))
                if value is not None:
                    pointers[f"{prefix}{suffix}"] = value
        return pointers

    def _review_state(self, dataset_path: Path, episode_indices: list[int]) -> dict[str, Any]:
        state = self.repository.state_store.load_dataset_state(dataset_path)
        return self._review_state_from_payload(state, episode_indices)

    def _review_state_from_payload(self, state: dict[str, Any], episode_indices: list[int]) -> dict[str, Any]:
        qc = state.setdefault("qc", {"lanes": {}, "reports": {}})
        raw_review = qc.get("review") if isinstance(qc.get("review"), dict) else {}
        review = dict(raw_review)
        episodes = review.get("episodes")
        normalized_episodes: dict[str, dict[str, Any]] = {}
        for index, payload in dict(episodes or {}).items():
            decision = self._normalize_episode_decision(payload)
            if decision:
                normalized_episodes[str(index)] = decision
        review["episodes"] = normalized_episodes
        review["draft_edits"] = dict(review.get("draft_edits") or {})
        self._update_review_progress(review, episode_indices)
        review.setdefault("updated_at", "")
        return review

    def _normalize_episode_decision(self, payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict):
            return {}
        decision = str(payload.get("decision") or "").strip().lower()
        if decision not in REVIEW_DECISIONS:
            return {}
        return {
            "decision": decision,
            "reason": str(payload.get("reason") or "").strip(),
            "note": str(payload.get("note") or "").strip(),
            "reviewer_id": str(payload.get("reviewer_id") or "").strip(),
            "reviewed_at": str(payload.get("reviewed_at") or ""),
        }

    def _update_review_progress(self, review: dict[str, Any], episode_indices: list[int]) -> None:
        review["status"] = self._review_progress(review, episode_indices)

    def _review_progress(self, review: dict[str, Any], episode_indices: list[int]) -> str:
        if review.get("batch_result") or str(review.get("status") or "") == "applied":
            return MANUAL_REVIEW_STATUS_PASSED
        decisions = dict(review.get("episodes") or {})
        if not episode_indices or not all(str(index) in decisions for index in episode_indices):
            status = str(review.get("status") or MANUAL_REVIEW_STATUS_PENDING)
            normalized_status = status if status in REVIEW_STATUSES else MANUAL_REVIEW_STATUS_PENDING
            return normalized_status

        passed_count = 0
        failed_count = 0
        for index in episode_indices:
            decision = dict(decisions.get(str(index)) or {}).get("decision")
            if decision == MANUAL_REVIEW_DECISION_PASSED:
                passed_count += 1
            if decision == MANUAL_REVIEW_DECISION_FAILED:
                failed_count += 1

        has_draft_edits = any(str(value).strip() for value in dict(review.get("draft_edits") or {}).values())
        if failed_count == len(episode_indices):
            return MANUAL_REVIEW_STATUS_FAILED
        if passed_count == len(episode_indices) and not has_draft_edits:
            return MANUAL_REVIEW_STATUS_PASSED
        if passed_count > 0 and (failed_count > 0 or has_draft_edits):
            return MANUAL_REVIEW_STATUS_NEEDS_FIX
        return MANUAL_REVIEW_STATUS_PENDING

    def _clean_status(self, state: dict[str, Any]) -> str:
        gates = state.get("gates") if isinstance(state.get("gates"), dict) else {}
        clean = gates.get("clean") if isinstance(gates.get("clean"), dict) else {}
        return str(clean.get("status") or "pending")

    def _write_review_state(
        self,
        dataset_path: Path,
        state: dict[str, Any],
        review: dict[str, Any],
        *,
        event_type: str,
    ) -> None:
        qc = state.setdefault("qc", {"lanes": {}, "reports": {}})
        qc["review"] = review
        self.repository.state_store.write_dataset_state(dataset_path, state)
        self.repository.state_store.append_dataset_event(dataset_path, {
            "type": event_type,
            "review_status": review["status"],
        })

    def _read_json(self, path: Path) -> dict[str, Any]:
        if not path.is_file():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))

    def _read_jsonl(self, path: Path) -> list[dict[str, Any]]:
        if not path.is_file():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _read_episode_meta(self, dataset_path: Path, info: dict[str, Any]) -> list[dict[str, Any]]:
        jsonl_rows = self._read_jsonl(dataset_path / "meta" / "episodes.jsonl")
        if jsonl_rows:
            return jsonl_rows
        return [
            {"episode_index": index, "length": 0}
            for index in range(int(info.get("total_episodes", 0) or 0))
        ]

    def _normalize_episode_meta(self, info: dict[str, Any], episodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if episodes:
            return [
                {
                    **entry,
                    "episode_index": int(entry.get("episode_index", index) or index),
                    "length": int(entry.get("length", 0) or 0),
                }
                for index, entry in enumerate(sorted(episodes, key=lambda item: int(item.get("episode_index", 0) or 0)))
            ]
        return [
            {"episode_index": index, "length": 0}
            for index in range(int(info.get("total_episodes", 0) or 0))
        ]

    def _infer_source_episode_for_parquet(
        self,
        dataset_path: Path,
        info: dict[str, Any],
        episodes: list[dict[str, Any]],
        source_file: Path,
    ) -> int | None:
        relative = source_file.relative_to(dataset_path).as_posix()
        source_chunks_size = int(info.get("chunks_size", 1000) or 1000)
        for episode in episodes:
            episode_index = int(episode.get("episode_index", 0) or 0)
            chunk_index = int(
                episode.get("data/chunk_index", episode.get("data_chunk_index", episode_index // source_chunks_size))
                or 0
            )
            file_index = int(
                episode.get("data/file_index", episode.get("data_file_index", episode_index % source_chunks_size))
                or 0
            )
            rendered = self._render_path_template(
                info.get("data_path") or PACKAGE_DATA_PATH,
                chunk_index=chunk_index,
                file_index=file_index,
                episode_index=episode_index,
                chunks_size=source_chunks_size,
            )
            if rendered == relative:
                return episode_index
        return None

    def _source_video_path(
        self,
        dataset_path: Path,
        info: dict[str, Any],
        episode: dict[str, Any],
        video_key: str,
        episode_index: int,
    ) -> Path:
        source_chunks_size = int(info.get("chunks_size", 1000) or 1000)
        prefix = f"videos/{video_key}/"
        chunk_index = int(
            episode.get(f"{prefix}chunk_index", episode.get("video_chunk_index", episode_index // source_chunks_size))
            or 0
        )
        file_index = int(
            episode.get(f"{prefix}file_index", episode.get("video_file_index", episode_index % source_chunks_size))
            or 0
        )
        rendered = self._render_path_template(
            info.get("video_path") or PACKAGE_VIDEO_PATH,
            video_key=video_key,
            chunk_index=chunk_index,
            file_index=file_index,
            episode_index=episode_index,
            chunks_size=source_chunks_size,
        )
        return dataset_path / (rendered or PACKAGE_VIDEO_PATH.format(
            video_key=video_key,
            chunk_index=chunk_index,
            file_index=file_index,
        ))

    def _render_path_template(
        self,
        template: str,
        *,
        chunk_index: int,
        file_index: int,
        episode_index: int,
        chunks_size: int,
        video_key: str | None = None,
    ) -> str | None:
        values = {
            "chunk_index": chunk_index,
            "file_index": file_index,
            "episode_index": episode_index,
            "episode_chunk": episode_index // max(chunks_size, 1),
            "episode_file": episode_index % max(chunks_size, 1),
            "video_key": video_key or "",
        }
        try:
            return template.format(**values)
        except KeyError:
            return None

    def _coerce_episode_index(self, value: Any, fallback: int | None) -> int:
        if value is None:
            if fallback is None:
                raise ValueError("Parquet row has no episode_index and source episode cannot be inferred")
            return fallback
        return int(value)

    def _data_pointer(self, pointer: tuple[int, int] | None) -> dict[str, int]:
        if pointer is None:
            return {}
        chunk_index, file_index = pointer
        return {"data/chunk_index": chunk_index, "data/file_index": file_index}

    def _copy_task_files(self, source_path: Path, output_path: Path) -> None:
        for filename in ("tasks.parquet", "tasks.jsonl"):
            source_file = source_path / "meta" / filename
            if source_file.is_file():
                shutil.copy2(source_file, output_path / "meta" / filename)

    def _write_task_description(self, output_path: Path, task_description: str) -> None:
        import pyarrow as pa
        import pyarrow.parquet as pq

        task_payload = [{"task_index": 0, "task": task_description, "task_description": task_description}]
        pq.write_table(pa.Table.from_pylist(task_payload), output_path / "meta" / "tasks.parquet")
        self._write_jsonl(output_path / "meta" / "tasks.jsonl", task_payload)

    def _write_jsonl(self, path: Path, rows: list[dict[str, Any]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + ("\n" if rows else ""),
            encoding="utf-8",
        )
