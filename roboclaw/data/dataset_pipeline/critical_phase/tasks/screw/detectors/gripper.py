"""Per-frame "is the left gripper open" boolean mask with hysteresis.

The detector consumes a 1-D action trace (typically ``action[:, gripper_dim]``
of a single episode) and emits a boolean mask of the same length. Output
toggles via two thresholds:

  * ``open_threshold``: while currently closed, the gripper "opens" the
    first frame ``trace[i] >= open_threshold`` (equality counts).
  * ``reset_threshold``: while currently open, the gripper "closes" the
    first frame ``trace[i] < reset_threshold`` (strict, equality keeps open).

``reset_threshold <= open_threshold`` is required to model a real hysteresis
band. Equal thresholds collapse to a flat-comparator (no hysteresis).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class GripperOpenMaskConfig:
    open_threshold: float
    reset_threshold: float


class GripperOpenMaskDetector:
    def __init__(self, config: GripperOpenMaskConfig) -> None:
        if config.reset_threshold > config.open_threshold:
            raise ValueError(
                f"reset_threshold ({config.reset_threshold}) must be <= "
                f"open_threshold ({config.open_threshold})"
            )
        self.config = config

    def open_mask(self, trace: np.ndarray) -> np.ndarray:
        if trace.ndim != 1:
            raise ValueError(f"trace must be 1-D (got shape {trace.shape})")
        mask = np.zeros(trace.shape, dtype=np.bool_)
        is_open = False
        open_t = self.config.open_threshold
        reset_t = self.config.reset_threshold
        for i in range(trace.shape[0]):
            value = float(trace[i])
            if not is_open and value >= open_t:
                is_open = True
            elif is_open and value < reset_t:
                is_open = False
            mask[i] = is_open
        return mask
