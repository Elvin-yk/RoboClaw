"""Per-task critical-event detectors and end-to-end pipelines.

Each subpackage owns one task's notion of "critical event". Add a new task
by creating ``tasks/<task_name>/`` with at minimum an event detector and a
pipeline that wires that detector into the generic extractor.
"""
