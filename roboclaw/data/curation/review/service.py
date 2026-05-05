"""Top-level human-review domain service.

Composes :class:`ReviewMarksStore`, the existing curation summary listing,
the explorer episode-page builder, and the dataset_pipeline extractor into
a single object that the FastAPI route layer can call.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from loguru import logger

from roboclaw.data.curation.episode_loader import load_episode_data
from roboclaw.data.curation.state import _now_iso, load_dataset_info
from roboclaw.data.explorer.local import (
    build_explorer_episode_page_from_artifacts,
    load_episodes_list_file,
)
from roboclaw.data.paths import datasets_root

from .marks_store import ReviewMarksStore
from .models import (
    CommitDeletionRequest,
    CommitDeletionResult,
    ReviewDatasetSummary,
    ReviewMark,
    ReviewState,
    ReviewSummary,
)


class OutputDatasetExistsError(Exception):
    """Raised when commit_deletion's target output path already exists."""


class ReviewService:
    def __init__(
        self,
        dataset_path_resolver: Callable[[str], Path],
        *,
        list_summaries: Callable[[], list[dict[str, Any]]] | None = None,
        datasets_root_provider: Callable[[], Path] | None = None,
    ) -> None:
        self._resolve = dataset_path_resolver
        self._list_summaries = list_summaries
        self._datasets_root = datasets_root_provider or datasets_root

    # -----------------------------------------------------------------
    # Listing
    # -----------------------------------------------------------------

    def list_candidate_datasets(
        self,
        *,
        critical_only: bool = True,
    ) -> list[ReviewDatasetSummary]:
        summaries: list[ReviewDatasetSummary] = []
        for raw in self._iter_raw_summaries():
            built = self._build_dataset_summary(raw)
            if built is None:
                continue
            if critical_only and not built.is_critical_phase:
                continue
            summaries.append(built)
        return summaries

    def _iter_raw_summaries(self) -> list[dict[str, Any]]:
        if self._list_summaries is not None:
            return list(self._list_summaries())
        from roboclaw.http.routes.curation import list_curation_dataset_summaries
        return list(list_curation_dataset_summaries())

    def _build_dataset_summary(
        self,
        raw: dict[str, Any],
    ) -> ReviewDatasetSummary | None:
        dataset_id = str(raw.get("id") or raw.get("name") or "")
        if not dataset_id:
            return None
        # Discovery is a best-effort scan over arbitrary on-disk datasets.
        # A single broken dataset must NOT poison the whole list — this is
        # the documented exception to the "no try/except swallow" rule
        # (see Stage 2 spec, section "list_candidate_datasets").
        try:
            return self._safe_build_dataset_summary(dataset_id, raw)
        except Exception:
            logger.debug(
                "review: skipping dataset {} during discovery", dataset_id, exc_info=True
            )
            return None

    def _safe_build_dataset_summary(
        self,
        dataset_id: str,
        raw: dict[str, Any],
    ) -> ReviewDatasetSummary | None:
        dataset_path = self._resolve(dataset_id)
        info = load_dataset_info(dataset_path)
        if not info:
            return None
        total_episodes = int(info.get("total_episodes", 0) or 0)
        fps = float(info.get("fps", 0) or 0)
        store = ReviewMarksStore(dataset_path, dataset_id)
        state = store.load()
        summary = self.summarize(state, total_episodes)
        label = str(raw.get("label") or raw.get("display_name") or dataset_id)
        return ReviewDatasetSummary(
            id=dataset_id,
            label=label,
            path=str(dataset_path),
            total_episodes=total_episodes,
            fps=fps,
            reviewed=summary.reviewed,
            abnormal=summary.abnormal,
            is_critical_phase=_detect_critical_phase(dataset_id, dataset_path, info),
        )

    # -----------------------------------------------------------------
    # State
    # -----------------------------------------------------------------

    def load_state(self, dataset_id: str) -> ReviewState:
        dataset_path = self._resolve(dataset_id)
        return ReviewMarksStore(dataset_path, dataset_id).load()

    def summarize(self, state: ReviewState, total_episodes: int) -> ReviewSummary:
        reviewed = len(state.marks)
        abnormal = sum(1 for mark in state.marks.values() if mark.abnormal)
        return ReviewSummary(
            total_episodes=total_episodes,
            reviewed=reviewed,
            abnormal=abnormal,
        )

    # -----------------------------------------------------------------
    # Episodes
    # -----------------------------------------------------------------

    def list_episodes(
        self,
        dataset_id: str,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        dataset_path = self._resolve(dataset_id)
        info = load_dataset_info(dataset_path)
        episodes_meta = load_episodes_list_file(dataset_path)
        page_payload = build_explorer_episode_page_from_artifacts(
            dataset_name=dataset_id,
            info=info,
            episodes_meta=episodes_meta,
            page=page,
            page_size=page_size,
        )
        state = ReviewMarksStore(dataset_path, dataset_id).load()
        page_payload["episodes"] = [
            _attach_mark(item, state.marks) for item in page_payload["episodes"]
        ]
        page_payload["summary"] = self.summarize(
            state, int(info.get("total_episodes", 0) or 0)
        ).to_dict()
        return page_payload

    def get_episode_detail(
        self,
        dataset_id: str,
        episode_index: int,
    ) -> dict[str, Any]:
        dataset_path = self._resolve(dataset_id)
        episode_payload = load_episode_data(
            dataset_path, episode_index, include_videos=True
        )
        state = ReviewMarksStore(dataset_path, dataset_id).load()
        mark = state.marks.get(episode_index)
        videos = _build_video_descriptors(
            dataset_id,
            dataset_path,
            episode_payload.get("video_files") or [],
        )
        return {
            "dataset_id": dataset_id,
            "episode_index": episode_index,
            "episode_meta": episode_payload.get("episode_meta") or {},
            "videos": videos,
            "mark": mark.to_dict() if mark is not None else None,
        }

    # -----------------------------------------------------------------
    # Marks
    # -----------------------------------------------------------------

    def set_mark(
        self,
        dataset_id: str,
        episode_index: int,
        abnormal: bool,
    ) -> ReviewState:
        dataset_path = self._resolve(dataset_id)
        return ReviewMarksStore(dataset_path, dataset_id).set_mark(
            episode_index, abnormal
        )

    def set_marks_bulk(
        self,
        dataset_id: str,
        marks: list[tuple[int, bool]],
    ) -> ReviewState:
        dataset_path = self._resolve(dataset_id)
        return ReviewMarksStore(dataset_path, dataset_id).set_marks(marks)

    # -----------------------------------------------------------------
    # Commit deletion
    # -----------------------------------------------------------------

    def commit_deletion(self, request: CommitDeletionRequest) -> CommitDeletionResult:
        dataset_path = self._resolve(request.dataset_id)
        episodes_meta = load_episodes_list_file(dataset_path)
        if not episodes_meta:
            raise ValueError(
                f"Dataset {request.dataset_id} has no meta/episodes.jsonl entries"
            )
        valid_indices = {int(entry.get("episode_index")) for entry in episodes_meta}
        store = ReviewMarksStore(dataset_path, request.dataset_id)
        state = store.load()
        stale_marks = sorted(set(state.marks) - valid_indices)
        if stale_marks:
            raise ValueError(
                f"marks reference episode indices not in dataset: {stale_marks}"
            )
        kept, deleted = _partition_episodes(episodes_meta, state.marks)
        if not deleted:
            raise ValueError("no abnormal marks to commit")
        if not kept:
            raise ValueError("would produce empty dataset")

        output_path = self._resolve_output_path(request.output_dataset_id, dataset_path)
        if output_path.exists():
            raise OutputDatasetExistsError(
                f"Output dataset already exists at {output_path}"
            )

        if request.dry_run:
            return CommitDeletionResult(
                source_dataset=request.dataset_id,
                output_dataset=request.output_dataset_id,
                output_path=None,
                kept_episode_indices=kept,
                deleted_episode_indices=deleted,
            )

        intervals = _build_full_episode_intervals(episodes_meta, kept)
        output_path = self._run_extraction(request, dataset_path, output_path, intervals)
        store.append_commit(
            {
                "output_dataset_id": request.output_dataset_id,
                "created_at": _now_iso(),
                "deleted_episode_indices": list(deleted),
            }
        )
        return CommitDeletionResult(
            source_dataset=request.dataset_id,
            output_dataset=request.output_dataset_id,
            output_path=str(output_path),
            kept_episode_indices=kept,
            deleted_episode_indices=deleted,
        )

    def _resolve_output_path(self, output_dataset_id: str, source_path: Path) -> Path:
        root = self._datasets_root().resolve()
        candidate = (root / output_dataset_id).resolve()
        candidate.relative_to(root)  # raises ValueError on path-traversal escape
        source_resolved = source_path.resolve()
        if candidate == source_resolved or _is_within(candidate, source_resolved):
            raise ValueError(
                f"output dataset path {candidate} would land inside source dataset {source_resolved}"
            )
        return candidate

    def _run_extraction(
        self,
        request: CommitDeletionRequest,
        source_path: Path,
        output_path: Path,
        intervals: list[Any],
    ) -> Path:
        from roboclaw.data.dataset_pipeline.critical_phase import (
            extract_event_windows_dataset,
        )
        return extract_event_windows_dataset(
            source_root=source_path,
            output_root=output_path,
            intervals=intervals,
            source_repo_id=request.source_repo_id,
            output_repo_id=request.output_repo_id,
            task=request.task,
            vcodec=request.vcodec,
        )


# ---------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _detect_critical_phase(
    dataset_id: str,
    dataset_path: Path,
    info: dict[str, Any],
) -> bool:
    if "critical_phase" in dataset_id:
        return True
    if info.get("critical_phase") is True:
        return True
    if info.get("stage") == "critical_phase":
        return True
    flag = dataset_path / ".workflow" / "critical_phase.json"
    return flag.exists()


def _attach_mark(
    item: dict[str, Any],
    marks: dict[int, ReviewMark],
) -> dict[str, Any]:
    episode_index = int(item.get("episode_index", 0))
    mark = marks.get(episode_index)
    out = dict(item)
    out["mark"] = mark.to_dict() if mark is not None else None
    return out


def _build_video_descriptors(
    dataset_id: str,
    dataset_path: Path,
    video_files: list[Path],
) -> list[dict[str, Any]]:
    root = dataset_path.resolve()
    dataset_query = quote(dataset_id, safe="")
    descriptors: list[dict[str, Any]] = []
    for path in video_files:
        rel = Path(path).resolve().relative_to(root).as_posix()
        url_path = quote(rel)
        descriptors.append(
            {
                "name": Path(path).name,
                "relative_path": rel,
                "url": f"/api/curation/video/{url_path}?dataset={dataset_query}",
            }
        )
    return descriptors


def _partition_episodes(
    episodes_meta: list[dict[str, Any]],
    marks: dict[int, ReviewMark],
) -> tuple[list[int], list[int]]:
    kept: list[int] = []
    deleted: list[int] = []
    for entry in episodes_meta:
        idx = int(entry.get("episode_index"))
        mark = marks.get(idx)
        if mark is not None and mark.abnormal:
            deleted.append(idx)
        else:
            kept.append(idx)
    return sorted(kept), sorted(deleted)


def _build_full_episode_intervals(
    episodes_meta: list[dict[str, Any]],
    kept: list[int],
) -> list[Any]:
    from roboclaw.data.dataset_pipeline.critical_phase import CriticalInterval

    by_idx = {int(entry.get("episode_index")): entry for entry in episodes_meta}
    intervals: list[CriticalInterval] = []
    for ep_idx in kept:
        entry = by_idx[ep_idx]
        length = _episode_length(entry)
        intervals.append(
            CriticalInterval(
                source_episode_index=ep_idx,
                start_frame=0,
                end_frame_exclusive=length,
                event_frame=max(length - 1, 0),
            )
        )
    return intervals


def _episode_length(entry: dict[str, Any]) -> int:
    raw = entry.get("length")
    if raw is None:
        raise ValueError(f"episode meta missing 'length': {entry}")
    length = int(round(float(raw)))
    if length <= 0:
        raise ValueError(f"non-positive episode length in {entry}")
    return length
