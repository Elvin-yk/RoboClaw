"""Compound (gripper-open) AND (EE-close) rising-edge detector.

A screw insertion attempt only counts when BOTH:
  * the left gripper is open (mask from :class:`GripperOpenMaskDetector`); and
  * the two end-effectors are close to one another (precomputed by the
    pipeline from an :class:`EpisodeEEDistanceProvider`).

We AND the two boolean traces and feed the result through the generic
:class:`RisingEdgeDetector`, so debounce/hysteresis live in exactly one place.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    RisingEdgeConfig,
    RisingEdgeDetector,
)

from .gripper import GripperOpenMaskConfig, GripperOpenMaskDetector


@dataclass(frozen=True)
class GripperEEEventConfig:
    gripper: GripperOpenMaskConfig
    ee_close_threshold_m: float
    edge: RisingEdgeConfig


class GripperEEEventDetector:
    def __init__(self, config: GripperEEEventConfig) -> None:
        if config.ee_close_threshold_m <= 0:
            raise ValueError(
                f"ee_close_threshold_m must be > 0 (got {config.ee_close_threshold_m})"
            )
        self._cfg = config
        self._gripper = GripperOpenMaskDetector(config.gripper)
        self._edge = RisingEdgeDetector(config.edge)

    def detect(
        self,
        episode_index: int,
        gripper_trace: np.ndarray,
        ee_trace: np.ndarray,
        episode_length: int,
    ) -> list[CriticalEvent]:
        gripper_mask = self._gripper.open_mask(gripper_trace)
        if ee_trace.shape != (episode_length,):
            raise ValueError(
                f"ee_trace shape {ee_trace.shape} does not match "
                f"episode_length ({episode_length},)"
            )
        composite = np.logical_and(gripper_mask, ee_trace < self._cfg.ee_close_threshold_m)
        return self._edge.detect(episode_index, composite, episode_length)
