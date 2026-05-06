"""CLI: extract per-event critical-phase windows from a screw-task LeRobot dataset.

For every (gripper-open AND EE-close) rising edge detected in each source
episode, emit a window covering ``--pre-event-seconds`` before the event
frame (inclusive of the event) plus ``--post-event-seconds`` after it. All
extracted segments are merged into a single output dataset via the lerobot
helper.

Inter-EE distance is computed by :class:`EpisodeEEDistanceProvider`, which
runs forward kinematics on the bimanual SO101 action vector. ``placo`` is a
required runtime dependency (provided by lerobot's ``kinematics`` extra).

Example::

    python -m roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.cli \\
        --src /path/to/source_dataset \\
        --dst /path/to/output_dataset \\
        --gripper-dim 5 --open-threshold 10.0 --ee-close-threshold-m 0.08 \\
        --pre-event-seconds 2.0 --post-event-seconds 0.5 \\
        --task "Insert the copper screw into the black sleeve" \\
        --exclude-episodes 90,124,142,176,218,236
"""
from __future__ import annotations

import argparse
import logging
import math
import sys
from pathlib import Path

from roboclaw.data.dataset_pipeline.critical_phase import (
    ExtractionReport,
    OverlapPolicy,
    RisingEdgeConfig,
    load_dataset_fps,
)
from roboclaw.data.trajectory_viz import EpisodeEEDistanceProvider

from .detectors import GripperEEEventConfig, GripperOpenMaskConfig
from .pipeline import ExtractionRequest, run


def _parse_int_set(raw: str) -> set[int]:
    raw = raw.strip()
    if not raw:
        return set()
    return {int(x) for x in raw.split(",") if x.strip()}


def _non_negative_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"must be finite (got {value})")
    if value < 0:
        raise argparse.ArgumentTypeError(f"must be >= 0 (got {value})")
    return value


def _positive_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value):
        raise argparse.ArgumentTypeError(f"must be finite (got {value})")
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be > 0 (got {value})")
    return value


def _positive_int(raw: str) -> int:
    value = int(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError(f"must be > 0 (got {value})")
    return value


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument("--src", type=Path, required=True)
    parser.add_argument("--dst", type=Path, required=True)
    parser.add_argument("--task", type=str, required=True)
    parser.add_argument("--gripper-dim", type=int, required=True)
    parser.add_argument("--open-threshold", type=float, required=True)
    parser.add_argument("--reset-threshold", type=float, default=None)
    parser.add_argument(
        "--ee-close-threshold-m",
        type=_positive_float,
        required=True,
        help="Inter-EE distance (meters) below which the gripper-open event counts.",
    )
    parser.add_argument("--min-event-separation-s", type=_non_negative_float, default=0.5)
    parser.add_argument("--pre-event-seconds", type=_positive_float, default=10.0)
    parser.add_argument(
        "--post-event-seconds",
        type=_non_negative_float,
        default=0.0,
        help="Seconds to keep AFTER the event frame (window covers pre + event + post). "
        "Default 0 reproduces pre-only behavior.",
    )
    parser.add_argument(
        "--overlap-policy",
        choices=[p.value for p in OverlapPolicy],
        default=OverlapPolicy.KEEP.value,
    )
    parser.add_argument("--min-events-per-episode", type=_positive_int, default=5)
    parser.add_argument("--exclude-episodes", type=str, default="")
    parser.add_argument("--source-repo-id", type=str, default="local/trim_src")
    parser.add_argument("--output-repo-id", type=str, default="local/trim_out")
    parser.add_argument("--vcodec", type=str, default="h264")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def _build_request(args: argparse.Namespace, log: logging.Logger) -> ExtractionRequest:
    fps = load_dataset_fps(args.src)
    log.info("Source fps: %.3f", fps)
    reset_threshold = (
        args.reset_threshold if args.reset_threshold is not None else args.open_threshold
    )
    min_separation_frames = int(round(args.min_event_separation_s * fps))
    log.info(
        "Detector: open=%.3f reset=%.3f ee_close=%.4fm min_sep=%d frames (%.3fs * %.3ffps)",
        args.open_threshold,
        reset_threshold,
        args.ee_close_threshold_m,
        min_separation_frames,
        args.min_event_separation_s,
        fps,
    )
    exclude = _parse_int_set(args.exclude_episodes)
    if exclude:
        log.info("Excluding %d episode(s): %s", len(exclude), sorted(exclude))
    event_config = GripperEEEventConfig(
        gripper=GripperOpenMaskConfig(
            open_threshold=args.open_threshold,
            reset_threshold=reset_threshold,
        ),
        ee_close_threshold_m=args.ee_close_threshold_m,
        edge=RisingEdgeConfig(min_separation_frames=min_separation_frames),
    )
    return ExtractionRequest(
        src=args.src,
        dst=args.dst,
        task=args.task,
        gripper_dim=args.gripper_dim,
        event_config=event_config,
        pre_event_seconds=args.pre_event_seconds,
        post_event_seconds=args.post_event_seconds,
        overlap_policy=OverlapPolicy(args.overlap_policy),
        min_events_per_episode=args.min_events_per_episode,
        exclude_episodes=exclude,
        source_repo_id=args.source_repo_id,
        output_repo_id=args.output_repo_id,
        vcodec=args.vcodec,
        dry_run=args.dry_run,
    )


def _log_report(log: logging.Logger, report: ExtractionReport, output_path: Path | None) -> None:
    log.info(
        "Source episodes: %d  output segments: %d  output frames: %d",
        report.source_episode_count,
        report.output_segment_count,
        report.total_output_frames,
    )
    if report.episodes_with_no_events:
        log.warning(
            "Episodes with no detected events (%d): %s",
            len(report.episodes_with_no_events),
            report.episodes_with_no_events,
        )
    if report.episodes_with_fewer_than_min_events:
        log.warning(
            "Episodes with fewer than min events (kept anyway): %s",
            report.episodes_with_fewer_than_min_events,
        )
    if report.clamped_windows:
        log.warning(
            "Clamped %d window(s) at episode start (event too early for full window).",
            report.clamped_windows,
        )
    if report.tail_clamped_windows:
        log.warning(
            "Clamped %d window(s) at episode end (event too late for full post window).",
            report.tail_clamped_windows,
        )
    if report.skipped_overlaps:
        log.warning(
            "Skipped %d overlapping window(s) per overlap-policy.",
            report.skipped_overlaps,
        )
    if output_path is not None:
        log.info("Done. Output dataset at %s", output_path)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("trim")
    args = _build_arg_parser().parse_args(argv)
    if not args.src.exists():
        log.error("Source dataset not found: %s", args.src)
        return 1
    if args.dst.exists():
        log.error("Destination already exists, refusing to overwrite: %s", args.dst)
        return 1
    request = _build_request(args, log)
    report, output_path = run(request, EpisodeEEDistanceProvider())
    _log_report(log, report, output_path)
    if args.dry_run:
        log.info("--dry-run: not building output dataset.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
