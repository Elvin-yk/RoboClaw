"""Compound (gripper-open) AND (EE-close) rising-edge detector.

A screw insertion attempt only counts when BOTH:
  * the left gripper is open (mask from :class:`GripperOpenMaskDetector`); and
  * the two end-effectors are close to one another (distance trace from an
    :class:`EpisodeEEDistanceProvider`).

We AND the two boolean traces and feed the result through the generic
:class:`RisingEdgeDetector`, so debounce/hysteresis live in exactly one place.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pyarrow as pa

from roboclaw.data.dataset_pipeline.critical_phase import (
    CriticalEvent,
    RisingEdgeConfig,
    RisingEdgeDetector,
)

from ..ee_distance import EpisodeEEDistanceProvider
from .gripper import GripperOpenMaskConfig, GripperOpenMaskDetector


@dataclass(frozen=True)
class GripperEEEventConfig:
    gripper: GripperOpenMaskConfig
    ee_close_threshold_m: float
    edge: RisingEdgeConfig


class GripperEEEventDetector:
    def __init__(
        self,
        config: GripperEEEventConfig,
        ee_provider: EpisodeEEDistanceProvider,
    ) -> None:
        if config.ee_close_threshold_m <= 0:
            raise ValueError(
                f"ee_close_threshold_m must be > 0 (got {config.ee_close_threshold_m})"
            )
        self._cfg = config
        self._gripper = GripperOpenMaskDetector(config.gripper)
        self._edge = RisingEdgeDetector(config.edge)
        self._ee = ee_provider

    def detect(
        self,
        parquet: pa.Table,
        episode_index: int,
        gripper_trace: np.ndarray,
        episode_length: int,
    ) -> list[CriticalEvent]:
        gripper_mask = self._gripper.open_mask(gripper_trace)
        ee_trace = self._ee.distance_trace(parquet, episode_index, episode_length)
        if ee_trace.shape != (episode_length,):
            raise ValueError(
                f"ee_trace shape {ee_trace.shape} does not match "
                f"episode_length ({episode_length},)"
            )
        if gripper_mask.shape != (episode_length,):
            raise ValueError(
                f"gripper_mask shape {gripper_mask.shape} does not match "
                f"episode_length ({episode_length},)"
            )
        composite = np.logical_and(
            gripper_mask, ee_trace < self._cfg.ee_close_threshold_m
        )
        return self._edge.detect(episode_index, composite, episode_length)
