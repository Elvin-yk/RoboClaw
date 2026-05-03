"""CLI: extract per-event critical-phase windows from a LeRobot dataset.

For every left-gripper open event detected on ``action[--gripper-dim]`` of
each source episode, emit a window of ``--pre-event-seconds * fps`` frames
ending at and INCLUDING the event frame. All extracted segments are merged
into a single output dataset via the lerobot helper.

Example::

    python -m roboclaw.data.dataset_pipeline.trim_dataset_by_gripper \\
        --src /path/to/source_dataset \\
        --dst /path/to/output_dataset \\
        --gripper-dim 5 --open-threshold 10.0 \\
        --task "Insert the copper screw into the black sleeve" \\
        --exclude-episodes 90,124,142,176,218,236
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .critical_window_builder import ExtractionReport, OverlapPolicy
from .gripper_events import GripperEventConfig
from .multi_event_extractor import ExtractionRequest, load_dataset_fps, run


def _parse_int_set(raw: str) -> set[int]:
    raw = raw.strip()
    if not raw:
        return set()
    return {int(x) for x in raw.split(",") if x.strip()}


def _non_negative_float(raw: str) -> float:
    value = float(raw)
    if value < 0:
        raise argparse.ArgumentTypeError(f"must be >= 0 (got {value})")
    return value


def _positive_float(raw: str) -> float:
    value = float(raw)
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
    parser.add_argument("--min-event-separation-s", type=_non_negative_float, default=0.5)
    parser.add_argument("--pre-event-seconds", type=_positive_float, default=10.0)
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
        "Detector: open=%.3f reset=%.3f min_sep=%d frames (%.3fs * %.3ffps)",
        args.open_threshold,
        reset_threshold,
        min_separation_frames,
        args.min_event_separation_s,
        fps,
    )
    exclude = _parse_int_set(args.exclude_episodes)
    if exclude:
        log.info("Excluding %d episode(s): %s", len(exclude), sorted(exclude))
    return ExtractionRequest(
        src=args.src,
        dst=args.dst,
        task=args.task,
        gripper_dim=args.gripper_dim,
        event_config=GripperEventConfig(
            open_threshold=args.open_threshold,
            reset_threshold=reset_threshold,
            min_separation_frames=min_separation_frames,
        ),
        pre_event_seconds=args.pre_event_seconds,
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
    report, output_path = run(request)
    _log_report(log, report, output_path)
    if args.dry_run:
        log.info("--dry-run: not building output dataset.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
