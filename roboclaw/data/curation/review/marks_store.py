"""Read/write the ``.workflow/review_marks.json`` sidecar.

Reuses the atomic ``_read_json`` / ``_write_json`` helpers from
``roboclaw.data.curation.state`` so we never reimplement tmp+rename writes.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from roboclaw.data.curation.state import _now_iso, _read_json, _workflow_dir, _write_json

from .models import ReviewMark, ReviewState

_SCHEMA_VERSION = 1


class ReviewMarksStore:
    SIDECAR_RELPATH = Path(".workflow") / "review_marks.json"

    def __init__(self, dataset_path: Path, dataset_id: str) -> None:
        self._dataset_path = dataset_path
        self._dataset_id = dataset_id

    @property
    def sidecar_path(self) -> Path:
        return _workflow_dir(self._dataset_path) / "review_marks.json"

    def load(self) -> ReviewState:
        data = _read_json(self.sidecar_path)
        if data is None:
            return ReviewState(
                dataset_id=self._dataset_id,
                version=_SCHEMA_VERSION,
                updated_at=_now_iso(),
                marks={},
                commits=[],
            )
        return _state_from_payload(data, fallback_dataset_id=self._dataset_id)

    def save(self, state: ReviewState) -> ReviewState:
        bumped = ReviewState(
            dataset_id=state.dataset_id,
            version=state.version,
            updated_at=_now_iso(),
            marks=dict(state.marks),
            commits=list(state.commits),
        )
        _write_json(self.sidecar_path, bumped.to_dict())
        return bumped

    def set_mark(self, episode_index: int, abnormal: bool) -> ReviewState:
        return self.set_marks([(episode_index, abnormal)])

    def set_marks(self, marks: list[tuple[int, bool]]) -> ReviewState:
        state = self.load()
        merged = dict(state.marks)
        now = _now_iso()
        for episode_index, abnormal in marks:
            merged[episode_index] = ReviewMark(
                episode_index=episode_index,
                abnormal=abnormal,
                updated_at=now,
            )
        return self.save(
            ReviewState(
                dataset_id=state.dataset_id,
                version=state.version,
                updated_at=state.updated_at,
                marks=merged,
                commits=list(state.commits),
            )
        )

    def append_commit(self, commit_record: dict[str, Any]) -> ReviewState:
        state = self.load()
        commits = list(state.commits)
        commits.append(dict(commit_record))
        return self.save(
            ReviewState(
                dataset_id=state.dataset_id,
                version=state.version,
                updated_at=state.updated_at,
                marks=dict(state.marks),
                commits=commits,
            )
        )


def _state_from_payload(
    payload: dict[str, Any],
    *,
    fallback_dataset_id: str,
) -> ReviewState:
    marks_payload = payload.get("marks") or {}
    marks: dict[int, ReviewMark] = {}
    for raw_key, value in marks_payload.items():
        if not isinstance(value, dict):
            continue
        idx = int(raw_key)
        marks[idx] = ReviewMark(
            episode_index=int(value.get("episode_index", idx)),
            abnormal=bool(value.get("abnormal", False)),
            updated_at=str(value.get("updated_at") or _now_iso()),
        )
    commits = payload.get("commits")
    if not isinstance(commits, list):
        commits = []
    return ReviewState(
        dataset_id=str(payload.get("dataset_id") or fallback_dataset_id),
        version=int(payload.get("version") or _SCHEMA_VERSION),
        updated_at=str(payload.get("updated_at") or _now_iso()),
        marks=marks,
        commits=list(commits),
    )
