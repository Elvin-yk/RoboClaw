"""CLI: concat already-trimmed LeRobot v3 datasets into a single dataset.

Example::

    python -m roboclaw.data.dataset_pipeline.concat.cli \\
        --src /path/to/dataset_a \\
        --src /path/to/dataset_b \\
        --dst /path/to/merged_dataset \\
        --task "Insert the copper screw into the black sleeve"
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .lerobot_concat import concat_lerobot_datasets


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    parser.add_argument(
        "--src",
        type=Path,
        action="append",
        required=True,
        help="Path to a source LeRobot v3 dataset. Repeat for each input dataset.",
    )
    parser.add_argument("--dst", type=Path, required=True)
    parser.add_argument(
        "--task",
        type=str,
        required=True,
        help="Expected single task description for all sources (asserted, not overridden).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log = logging.getLogger("concat")
    args = _build_arg_parser().parse_args(argv)

    sources: list[Path] = list(args.src)
    for src in sources:
        if not src.exists():
            log.error("Source dataset not found: %s", src)
            return 1
    if args.dst.exists():
        log.error("Destination already exists, refusing to overwrite: %s", args.dst)
        return 1

    out = concat_lerobot_datasets(sources, args.dst, task=args.task)
    log.info("Concat complete: %d source(s) -> %s", len(sources), out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
