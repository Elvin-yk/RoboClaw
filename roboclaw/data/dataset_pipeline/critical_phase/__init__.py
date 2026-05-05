"""Critical-phase dataset extraction.

Top-level building blocks here are task-agnostic. Per-task event detectors
live under ``tasks/<task_name>/``; e.g. screw insertion uses compound
(gripper-open AND EE-close) events under ``tasks/screw/``.
"""
from .edge import RisingEdgeConfig, RisingEdgeDetector
from .event import CriticalEvent
from .extractor import (
    extract_event_windows_dataset,
    load_dataset_fps,
    resolve_single_data_parquet,
)
from .interval import (
    CriticalInterval,
    CriticalWindowBuilder,
    ExtractionReport,
    OverlapPolicy,
    WindowSpec,
)

__all__ = [
    "CriticalEvent",
    "CriticalInterval",
    "CriticalWindowBuilder",
    "ExtractionReport",
    "OverlapPolicy",
    "RisingEdgeConfig",
    "RisingEdgeDetector",
    "WindowSpec",
    "extract_event_windows_dataset",
    "load_dataset_fps",
    "resolve_single_data_parquet",
]
