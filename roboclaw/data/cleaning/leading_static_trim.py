from __future__ import annotations

import json
import shutil
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from roboclaw.data.curation.bridge import read_parquet_rows, write_parquet_rows
from roboclaw.data.curation.paths import (
    PACKAGE_DATA_PATH,
    PACKAGE_VIDEO_PATH,
    video_path_from_indices,
)
from roboclaw.data.curation.serializers import video_feature_keys
from roboclaw.data.curation.stats import compute_feature_stats


@dataclass(frozen=True)
class LeadingStaticTrimConfig:
    signal: str = "action_delta"
    pre_roll_seconds: float = 0.5
    sustain_seconds: float = 0.2
    min_kept_seconds: float = 1.0
    min_trim_seconds: float = 0.1
    threshold_floor: float = 0.002
    threshold_quantile_scale: float = 0.05
    vcodec: str = "libx264"
    pix_fmt: str = "yuv420p"


@dataclass(frozen=True)
class EpisodeTrimDecision:
    source_episode_index: int
    output_episode_index: int | None
    source_length: int
    output_length: int
    detected_start_frame: int | None
    keep_from_frame: int
    trimmed_frames: int
    dropped_reason: str | None


@dataclass(frozen=True)
class LeadingStaticTrimResult:
    status: str
    input_path: Path
    output_path: Path | None
    changed: bool
    total_source_episodes: int
    total_output_episodes: int
    total_source_frames: int
    total_output_frames: int
    total_trimmed_frames: int
    dropped_episode_indices: list[int]
    threshold: float | None
    decisions: list[EpisodeTrimDecision]
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["input_path"] = str(self.input_path)
        payload["output_path"] = str(self.output_path) if self.output_path else None
        return payload


@dataclass(frozen=True)
class _EpisodeRows:
    episode_index: int
    rows: list[dict[str, Any]]
    meta: dict[str, Any]


@dataclass(frozen=True)
class _VideoSegmentPlan:
    video_key: str
    source_path: Path
    target_path: Path
    source_start_frame: int
    source_end_frame: int
    target_start_frame: int
    target_end_frame: int
    output_episode_index: int


@dataclass(frozen=True)
class _VideoWriter:
    container: Any
    stream: Any


class LeadingStaticTrimService:
    def trim(
        self,
        input_dir: Path,
        *,
        output_dir: Path,
        config: LeadingStaticTrimConfig | None = None,
        force: bool,
    ) -> LeadingStaticTrimResult:
        cfg = config or LeadingStaticTrimConfig()
        info = self._read_json(input_dir / "meta" / "info.json")
        fps = int(info.get("fps", 30) or 30)
        episodes = self._load_episodes(input_dir, info)
        episode_rows = self._load_episode_rows(input_dir, episodes)
        threshold, movement_by_episode = self._movement_scores(episode_rows, cfg)
        decisions = self._decisions(
            episode_rows,
            movement_by_episode=movement_by_episode,
            threshold=threshold,
            fps=fps,
            config=cfg,
        )
        kept_decisions = [decision for decision in decisions if decision.output_episode_index is not None]
        if not kept_decisions:
            return LeadingStaticTrimResult(
                status="failed",
                input_path=input_dir,
                output_path=None,
                changed=False,
                total_source_episodes=len(episode_rows),
                total_output_episodes=0,
                total_source_frames=sum(len(item.rows) for item in episode_rows),
                total_output_frames=0,
                total_trimmed_frames=sum(decision.trimmed_frames for decision in decisions),
                dropped_episode_indices=[decision.source_episode_index for decision in decisions],
                threshold=threshold,
                decisions=decisions,
                error="leading_static_trim removed every episode",
            )

        changed = any(decision.trimmed_frames > 0 or decision.dropped_reason for decision in decisions)
        if not changed:
            return LeadingStaticTrimResult(
                status="no_change",
                input_path=input_dir,
                output_path=None,
                changed=False,
                total_source_episodes=len(episode_rows),
                total_output_episodes=len(episode_rows),
                total_source_frames=sum(len(item.rows) for item in episode_rows),
                total_output_frames=sum(len(item.rows) for item in episode_rows),
                total_trimmed_frames=0,
                dropped_episode_indices=[],
                threshold=threshold,
                decisions=decisions,
            )

        self._prepare_output_dir(output_dir, force=force)
        self._materialize_static_assets(input_dir, output_dir)
        output_rows, output_episodes = self._write_data_and_metadata(
            input_dir=input_dir,
            output_dir=output_dir,
            info=info,
            episode_rows=episode_rows,
            decisions=decisions,
            fps=fps,
            config=cfg,
        )
        self._write_info(output_dir, info, output_episodes, output_rows)
        self._copy_tasks(input_dir, output_dir)
        self._write_stats(output_dir, info, output_rows)
        return LeadingStaticTrimResult(
            status="trimmed",
            input_path=input_dir,
            output_path=output_dir,
            changed=True,
            total_source_episodes=len(episode_rows),
            total_output_episodes=len(output_episodes),
            total_source_frames=sum(len(item.rows) for item in episode_rows),
            total_output_frames=len(output_rows),
            total_trimmed_frames=sum(decision.trimmed_frames for decision in decisions),
            dropped_episode_indices=[
                decision.source_episode_index for decision in decisions if decision.dropped_reason
            ],
            threshold=threshold,
            decisions=decisions,
        )

    def _read_json(self, path: Path) -> dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8"))

    def _load_episodes(self, dataset_dir: Path, info: dict[str, Any]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        episodes_root = dataset_dir / "meta" / "episodes"
        if episodes_root.is_dir():
            for parquet_path in sorted(episodes_root.rglob("*.parquet")):
                rows.extend(read_parquet_rows(parquet_path))
        if not rows:
            total_episodes = int(info.get("total_episodes", 0) or 0)
            rows = [{"episode_index": index} for index in range(total_episodes)]
        return sorted(rows, key=lambda row: int(row.get("episode_index", 0) or 0))

    def _load_episode_rows(
        self,
        dataset_dir: Path,
        episodes: list[dict[str, Any]],
    ) -> list[_EpisodeRows]:
        rows_by_episode: dict[int, list[dict[str, Any]]] = {
            int(episode.get("episode_index", index) or 0): []
            for index, episode in enumerate(episodes)
        }
        for parquet_path in sorted((dataset_dir / "data").rglob("*.parquet")):
            for row in read_parquet_rows(parquet_path):
                episode_index = int(row.get("episode_index", 0) or 0)
                rows_by_episode.setdefault(episode_index, []).append(row)
        result: list[_EpisodeRows] = []
        for index, episode in enumerate(episodes):
            episode_index = int(episode.get("episode_index", index) or index)
            rows = rows_by_episode.get(episode_index, [])
            result.append(
                _EpisodeRows(
                    episode_index=episode_index,
                    rows=sorted(rows, key=self._row_sort_key),
                    meta=episode,
                )
            )
        return result

    def _row_sort_key(self, row: dict[str, Any]) -> tuple[int, int]:
        frame_index = int(row.get("frame_index", row.get("index", 0)) or 0)
        index = int(row.get("index", frame_index) or frame_index)
        return frame_index, index

    def _movement_scores(
        self,
        episode_rows: list[_EpisodeRows],
        config: LeadingStaticTrimConfig,
    ) -> tuple[float, dict[int, np.ndarray]]:
        action_matrices: dict[int, np.ndarray] = {}
        matrices: list[np.ndarray] = []
        for episode in episode_rows:
            vectors: list[np.ndarray] = []
            for row in episode.rows:
                if "action" not in row:
                    raise ValueError("leading_static_trim requires an action column")
                vectors.append(self._as_float_vector(row["action"]))
            if vectors:
                matrix = np.vstack(vectors)
                action_matrices[episode.episode_index] = matrix
                matrices.append(matrix)
            else:
                action_matrices[episode.episode_index] = np.empty((0, 0), dtype=float)
        if not matrices:
            raise ValueError("leading_static_trim requires at least one action row")
        action_matrix = np.vstack(matrices)
        q01 = np.quantile(action_matrix, 0.01, axis=0)
        q99 = np.quantile(action_matrix, 0.99, axis=0)
        ranges = q99 - q01
        active_dims = ranges > 0
        movement_by_episode: dict[int, np.ndarray] = {}
        all_movement: list[float] = []
        for episode in episode_rows:
            scores = np.zeros(len(episode.rows), dtype=float)
            if len(episode.rows) >= 2 and np.any(active_dims):
                ep_actions = action_matrices[episode.episode_index]
                normalized = ep_actions[:, active_dims] / ranges[active_dims]
                deltas = np.diff(normalized, axis=0)
                scores[1:] = np.linalg.norm(deltas, axis=1)
                all_movement.extend(scores[1:].tolist())
            movement_by_episode[episode.episode_index] = scores
        p95 = float(np.quantile(np.asarray(all_movement, dtype=float), 0.95)) if all_movement else 0.0
        threshold = max(config.threshold_floor, config.threshold_quantile_scale * p95)
        return threshold, movement_by_episode

    def _as_float_vector(self, value: Any) -> np.ndarray:
        array = np.asarray(value, dtype=float)
        return array.reshape(-1)

    def _decisions(
        self,
        episode_rows: list[_EpisodeRows],
        *,
        movement_by_episode: dict[int, np.ndarray],
        threshold: float,
        fps: int,
        config: LeadingStaticTrimConfig,
    ) -> list[EpisodeTrimDecision]:
        sustain_frames = max(1, int(round(config.sustain_seconds * fps)))
        pre_roll_frames = max(0, int(round(config.pre_roll_seconds * fps)))
        min_trim_frames = max(1, int(round(config.min_trim_seconds * fps)))
        min_kept_frames = max(1, int(round(config.min_kept_seconds * fps)))
        decisions: list[EpisodeTrimDecision] = []
        output_episode_index = 0
        for episode in episode_rows:
            source_length = len(episode.rows)
            detected_start = self._detect_start(
                movement_by_episode[episode.episode_index],
                threshold=threshold,
                sustain_frames=sustain_frames,
            )
            if detected_start is None:
                decisions.append(
                    EpisodeTrimDecision(
                        source_episode_index=episode.episode_index,
                        output_episode_index=None,
                        source_length=source_length,
                        output_length=0,
                        detected_start_frame=None,
                        keep_from_frame=source_length,
                        trimmed_frames=source_length,
                        dropped_reason="no_motion_detected",
                    )
                )
                continue

            keep_from = max(0, detected_start - pre_roll_frames)
            if keep_from < min_trim_frames:
                keep_from = 0
            output_length = source_length - keep_from
            if keep_from > 0 and output_length < min_kept_frames:
                decisions.append(
                    EpisodeTrimDecision(
                        source_episode_index=episode.episode_index,
                        output_episode_index=None,
                        source_length=source_length,
                        output_length=0,
                        detected_start_frame=detected_start,
                        keep_from_frame=keep_from,
                        trimmed_frames=source_length,
                        dropped_reason="too_short_after_trim",
                    )
                )
                continue
            decisions.append(
                EpisodeTrimDecision(
                    source_episode_index=episode.episode_index,
                    output_episode_index=output_episode_index,
                    source_length=source_length,
                    output_length=output_length,
                    detected_start_frame=detected_start,
                    keep_from_frame=keep_from,
                    trimmed_frames=keep_from,
                    dropped_reason=None,
                )
            )
            output_episode_index += 1
        return decisions

    def _detect_start(
        self,
        movement: np.ndarray,
        *,
        threshold: float,
        sustain_frames: int,
    ) -> int | None:
        if len(movement) < 2:
            return None
        active = movement > threshold
        for frame_index in range(1, len(active)):
            end = frame_index + sustain_frames
            if end <= len(active):
                if bool(np.all(active[frame_index:end])):
                    return frame_index
                continue
            if len(active) - 1 < sustain_frames and bool(np.all(active[frame_index:])):
                return frame_index
            break
        return None

    def _prepare_output_dir(self, output_dir: Path, *, force: bool) -> None:
        if output_dir.exists() and force:
            shutil.rmtree(output_dir)
        if output_dir.exists():
            raise FileExistsError(f"{output_dir} already exists")
        output_dir.mkdir(parents=True)

    def _materialize_static_assets(self, input_dir: Path, output_dir: Path) -> None:
        for entry in sorted(input_dir.iterdir()):
            if entry.name in {".status", ".data", ".workflow", "data", "videos", "meta"}:
                continue
            if entry.is_dir() and entry.name.startswith("tmp"):
                continue
            target = output_dir / entry.name
            if entry.is_dir():
                self._symlink_tree(entry, target)
            else:
                target.symlink_to(entry.resolve())

    def _symlink_tree(self, source_dir: Path, target_dir: Path) -> None:
        target_dir.mkdir(parents=True, exist_ok=True)
        for entry in sorted(source_dir.iterdir()):
            target = target_dir / entry.name
            if entry.is_dir():
                self._symlink_tree(entry, target)
            else:
                target.symlink_to(entry.resolve())

    def _write_data_and_metadata(
        self,
        *,
        input_dir: Path,
        output_dir: Path,
        info: dict[str, Any],
        episode_rows: list[_EpisodeRows],
        decisions: list[EpisodeTrimDecision],
        fps: int,
        config: LeadingStaticTrimConfig,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        episode_by_index = {episode.episode_index: episode for episode in episode_rows}
        output_rows: list[dict[str, Any]] = []
        output_episodes: list[dict[str, Any]] = []
        video_segments: list[_VideoSegmentPlan] = []
        target_next_frame: dict[Path, int] = {}
        global_index = 0
        for decision in decisions:
            if decision.output_episode_index is None:
                continue
            source_episode = episode_by_index[decision.source_episode_index]
            kept_rows = source_episode.rows[decision.keep_from_frame:]
            episode_rows_out: list[dict[str, Any]] = []
            for frame_index, row in enumerate(kept_rows):
                next_row = dict(row)
                next_row["episode_index"] = decision.output_episode_index
                next_row["frame_index"] = frame_index
                next_row["timestamp"] = frame_index / fps
                next_row["index"] = global_index
                output_rows.append(next_row)
                episode_rows_out.append(next_row)
                global_index += 1
            output_episode = self._episode_metadata(
                source_episode,
                decision=decision,
                episode_rows=episode_rows_out,
                fps=fps,
            )
            if video_feature_keys(info):
                video_meta, episode_video_segments = self._plan_episode_videos(
                    input_dir=input_dir,
                    output_dir=output_dir,
                    info=info,
                    source_episode=source_episode.meta,
                    decision=decision,
                    fps=fps,
                    target_next_frame=target_next_frame,
                )
                output_episode.update(video_meta)
                video_segments.extend(episode_video_segments)
            output_episodes.append(output_episode)
        self._rewrite_videos_by_source(video_segments, fps=fps, config=config)
        write_parquet_rows(output_dir / PACKAGE_DATA_PATH.format(chunk_index=0, file_index=0), output_rows)
        self._write_episode_metadata(output_dir, output_episodes)
        return output_rows, output_episodes

    def _episode_metadata(
        self,
        source_episode: _EpisodeRows,
        *,
        decision: EpisodeTrimDecision,
        episode_rows: list[dict[str, Any]],
        fps: int,
    ) -> dict[str, Any]:
        if decision.output_episode_index is None:
            raise ValueError("dropped episode has no output metadata")
        first_index = int(episode_rows[0]["index"])
        last_index = int(episode_rows[-1]["index"]) + 1
        task_indices = {
            int(row.get("task_index", 0) or 0)
            for row in episode_rows
        }
        tasks = source_episode.meta.get("tasks")
        if not isinstance(tasks, list) or not tasks:
            tasks = [str(index) for index in sorted(task_indices)]
        return {
            "episode_index": decision.output_episode_index,
            "source_episode_index": source_episode.episode_index,
            "tasks": tasks,
            "length": len(episode_rows),
            "data/chunk_index": 0,
            "data/file_index": 0,
            "dataset_from_index": first_index,
            "dataset_to_index": last_index,
            "trim/source_keep_from_frame": decision.keep_from_frame,
            "trim/source_detected_start_frame": decision.detected_start_frame,
            "trim/source_trimmed_frames": decision.trimmed_frames,
            "trim/source_duration_seconds": decision.source_length / fps,
        }

    def _plan_episode_videos(
        self,
        *,
        input_dir: Path,
        output_dir: Path,
        info: dict[str, Any],
        source_episode: dict[str, Any],
        decision: EpisodeTrimDecision,
        fps: int,
        target_next_frame: dict[Path, int],
    ) -> tuple[dict[str, Any], list[_VideoSegmentPlan]]:
        if decision.output_episode_index is None:
            return {}, []
        video_meta: dict[str, Any] = {}
        segments: list[_VideoSegmentPlan] = []
        for video_key in video_feature_keys(info):
            source_path, chunk_index, file_index = self._source_video_reference(
                input_dir,
                info,
                source_episode,
                video_key,
            )
            target_path = output_dir / source_path.relative_to(input_dir)
            target_path.parent.mkdir(parents=True, exist_ok=True)
            source_from_ts = float(source_episode.get(f"videos/{video_key}/from_timestamp", 0.0) or 0.0)
            source_start_frame = round((source_from_ts * fps) + decision.keep_from_frame)
            source_end_frame = source_start_frame + decision.output_length
            target_start_frame = target_next_frame.get(target_path, 0)
            target_end_frame = target_start_frame + decision.output_length
            target_next_frame[target_path] = target_end_frame
            segments.append(
                _VideoSegmentPlan(
                    video_key=video_key,
                    source_path=source_path,
                    target_path=target_path,
                    source_start_frame=source_start_frame,
                    source_end_frame=source_end_frame,
                    target_start_frame=target_start_frame,
                    target_end_frame=target_end_frame,
                    output_episode_index=decision.output_episode_index,
                )
            )
            prefix = f"videos/{video_key}/"
            video_meta[f"{prefix}chunk_index"] = chunk_index
            video_meta[f"{prefix}file_index"] = file_index
            video_meta[f"{prefix}from_timestamp"] = target_start_frame / fps
            video_meta[f"{prefix}to_timestamp"] = target_end_frame / fps
        return video_meta, segments

    def _source_video_path(
        self,
        dataset_dir: Path,
        info: dict[str, Any],
        source_episode: dict[str, Any],
        video_key: str,
    ) -> Path:
        prefix = f"videos/{video_key}/"
        chunk_index = int(source_episode.get(f"{prefix}chunk_index", 0) or 0)
        file_index = int(source_episode.get(f"{prefix}file_index", 0) or 0)
        return video_path_from_indices(dataset_dir, info, video_key, chunk_index, file_index)

    def _source_video_reference(
        self,
        dataset_dir: Path,
        info: dict[str, Any],
        source_episode: dict[str, Any],
        video_key: str,
    ) -> tuple[Path, int, int]:
        prefix = f"videos/{video_key}/"
        chunk_index = int(source_episode.get(f"{prefix}chunk_index", 0) or 0)
        file_index = int(source_episode.get(f"{prefix}file_index", 0) or 0)
        return (
            self._source_video_path(dataset_dir, info, source_episode, video_key),
            chunk_index,
            file_index,
        )

    def _rewrite_videos_by_source(
        self,
        segments: list[_VideoSegmentPlan],
        *,
        fps: int,
        config: LeadingStaticTrimConfig,
    ) -> None:
        groups: dict[Path, list[_VideoSegmentPlan]] = {}
        for segment in segments:
            groups.setdefault(segment.source_path, []).append(segment)
        for source_path, source_segments in groups.items():
            ordered_segments = sorted(
                source_segments,
                key=lambda segment: (segment.source_start_frame, segment.source_end_frame),
            )
            self._assert_non_overlapping_segments(source_path, ordered_segments)
            self._rewrite_video_source(
                source_path,
                ordered_segments,
                fps=fps,
                config=config,
            )

    def _assert_non_overlapping_segments(
        self,
        source_path: Path,
        segments: list[_VideoSegmentPlan],
    ) -> None:
        previous_end = -1
        for segment in segments:
            if segment.source_start_frame < previous_end:
                raise ValueError(f"Overlapping trim segments for {source_path}")
            if segment.source_end_frame <= segment.source_start_frame:
                raise ValueError(
                    f"Invalid video frame range {segment.source_start_frame}:{segment.source_end_frame} "
                    f"for {source_path}"
                )
            previous_end = segment.source_end_frame

    def _rewrite_video_source(
        self,
        source_path: Path,
        segments: list[_VideoSegmentPlan],
        *,
        fps: int,
        config: LeadingStaticTrimConfig,
    ) -> None:
        import av

        if not segments:
            return
        in_container = av.open(str(source_path))
        if not in_container.streams.video:
            raise ValueError(f"No video stream found in {source_path}")
        v_in = in_container.streams.video[0]
        writers: dict[Path, _VideoWriter] = {}
        written_by_segment = [0 for _segment in segments]
        max_end_frame = max(segment.source_end_frame for segment in segments)
        source_index = 0
        segment_index = 0
        for packet in in_container.demux(v_in):
            for frame in packet.decode():
                if source_index >= max_end_frame:
                    break
                while (
                    segment_index < len(segments)
                    and source_index >= segments[segment_index].source_end_frame
                ):
                    self._assert_segment_written(segments[segment_index], written_by_segment[segment_index])
                    segment_index += 1
                if segment_index < len(segments):
                    segment = segments[segment_index]
                    if source_index >= segment.source_start_frame:
                        writer = self._video_writer(
                            writers,
                            segment.target_path,
                            input_stream=v_in,
                            fps=fps,
                            config=config,
                        )
                        target_frame_index = segment.target_start_frame + (
                            source_index - segment.source_start_frame
                        )
                        self._encode_video_frame(
                            writer,
                            frame,
                            target_frame_index=target_frame_index,
                            fps=fps,
                        )
                        written_by_segment[segment_index] += 1
                source_index += 1
            if source_index >= max_end_frame:
                break
        while segment_index < len(segments):
            self._assert_segment_written(segments[segment_index], written_by_segment[segment_index])
            segment_index += 1
        for writer in writers.values():
            self._flush_video_writer(writer)
        for writer in writers.values():
            writer.container.close()
        in_container.close()

    def _video_writer(
        self,
        writers: dict[Path, _VideoWriter],
        target_path: Path,
        *,
        input_stream: Any,
        fps: int,
        config: LeadingStaticTrimConfig,
    ) -> _VideoWriter:
        import av

        existing = writers.get(target_path)
        if existing is not None:
            return existing
        target_path.parent.mkdir(parents=True, exist_ok=True)
        container = av.open(str(target_path), mode="w")
        fps_fraction = Fraction(fps).limit_denominator(1000)
        stream = container.add_stream(config.vcodec, rate=fps_fraction)
        stream.width = input_stream.codec_context.width
        stream.height = input_stream.codec_context.height
        stream.pix_fmt = config.pix_fmt
        stream.time_base = Fraction(1, fps)
        container.start_encoding()
        writer = _VideoWriter(container=container, stream=stream)
        writers[target_path] = writer
        return writer

    def _encode_video_frame(
        self,
        writer: _VideoWriter,
        frame: Any,
        *,
        target_frame_index: int,
        fps: int,
    ) -> None:
        next_frame = frame.reformat(
            width=writer.stream.width,
            height=writer.stream.height,
            format=writer.stream.pix_fmt,
        )
        next_frame.pts = target_frame_index
        next_frame.time_base = Fraction(1, fps)
        for output_packet in writer.stream.encode(next_frame):
            writer.container.mux(output_packet)

    def _flush_video_writer(self, writer: _VideoWriter) -> None:
        for output_packet in writer.stream.encode():
            writer.container.mux(output_packet)

    def _assert_segment_written(self, segment: _VideoSegmentPlan, written_frames: int) -> None:
        expected_frames = segment.source_end_frame - segment.source_start_frame
        if written_frames != expected_frames:
            raise ValueError(
                f"Video {segment.source_path} yielded {written_frames} frames for requested range "
                f"{segment.source_start_frame}:{segment.source_end_frame}"
            )

    def _write_episode_metadata(self, output_dir: Path, episodes: list[dict[str, Any]]) -> None:
        episodes_path = output_dir / "meta" / "episodes" / "chunk-000" / "file-000.parquet"
        episodes_path.parent.mkdir(parents=True, exist_ok=True)
        pq.write_table(pa.Table.from_pylist(episodes), episodes_path)

    def _write_info(
        self,
        output_dir: Path,
        source_info: dict[str, Any],
        output_episodes: list[dict[str, Any]],
        output_rows: list[dict[str, Any]],
    ) -> None:
        info = dict(source_info)
        info["data_path"] = PACKAGE_DATA_PATH
        if video_feature_keys(info):
            info["video_path"] = str(source_info.get("video_path") or PACKAGE_VIDEO_PATH)
        info["total_episodes"] = len(output_episodes)
        info["total_frames"] = len(output_rows)
        info["splits"] = {"train": f"0:{len(output_episodes)}"} if output_episodes else {}
        info["episode_lengths"] = [int(episode["length"]) for episode in output_episodes]
        if video_feature_keys(info):
            info["total_videos"] = self._total_referenced_videos(info, output_episodes)
        meta_dir = output_dir / "meta"
        meta_dir.mkdir(parents=True, exist_ok=True)
        (meta_dir / "info.json").write_text(
            json.dumps(info, indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    def _total_referenced_videos(
        self,
        info: dict[str, Any],
        output_episodes: list[dict[str, Any]],
    ) -> int:
        referenced: set[tuple[str, int, int]] = set()
        for video_key in video_feature_keys(info):
            prefix = f"videos/{video_key}/"
            for episode in output_episodes:
                referenced.add((
                    video_key,
                    int(episode.get(f"{prefix}chunk_index", 0) or 0),
                    int(episode.get(f"{prefix}file_index", 0) or 0),
                ))
        return len(referenced)

    def _copy_tasks(self, input_dir: Path, output_dir: Path) -> None:
        (output_dir / "meta").mkdir(parents=True, exist_ok=True)
        for filename in ("tasks.parquet", "tasks.jsonl"):
            source = input_dir / "meta" / filename
            if source.is_file():
                target = output_dir / "meta" / filename
                if target.exists() or target.is_symlink():
                    target.unlink()
                shutil.copy2(source, target)

    def _write_stats(self, output_dir: Path, info: dict[str, Any], rows: list[dict[str, Any]]) -> None:
        stats_path = output_dir / "meta" / "stats.json"
        stats_path.write_text(
            json.dumps(compute_feature_stats(info, rows), indent=4, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
