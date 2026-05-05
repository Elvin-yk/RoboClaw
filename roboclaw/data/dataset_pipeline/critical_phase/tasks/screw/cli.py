"""CLI: extract per-event critical-phase windows from a screw-task LeRobot dataset.

For every (gripper-open AND EE-close) rising edge detected in each source
episode, emit a window of ``--pre-event-seconds * fps`` frames ending at and
INCLUDING the event frame. All extracted segments are merged into a single
output dataset via the lerobot helper.

NB: real inter-EE distance computation lands via ``shuyuan/traj-viz``. Until
that branch supplies an :class:`EpisodeEEDistanceProvider`, this CLI cannot
run end-to-end and ``main()`` raises :class:`NotImplementedError` immediately.
``--help`` and argument parsing still work so the surface is testable.

Example::

    python -m roboclaw.data.dataset_pipeline.critical_phase.tasks.screw.cli \\
        --src /path/to/source_dataset \\
        --dst /path/to/output_dataset \\
        --gripper-dim 5 --open-threshold 10.0 --ee-close-threshold-m 0.08 \\
        --task "Insert the copper screw into the black sleeve" \\
        --exclude-episodes 90,124,142,176,218,236
"""
from __future__ import annotations

import argparse
import logging
import math
import sys
from pathlib import Path

from roboclaw.data.dataset_pipeline.critical_phase import OverlapPolicy


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


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    return _build_arg_parser().parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("trim")
    _parse_args(argv)
    log.error(
        "EE distance provider not yet wired; lands via shuyuan/traj-viz. "
        "This CLI cannot run end-to-end yet."
    )
    raise NotImplementedError(
        "EpisodeEEDistanceProvider not yet implemented (lands via shuyuan/traj-viz)"
    )


if __name__ == "__main__":
    sys.exit(main())
