from __future__ import annotations

from typing import Any

import numpy as np


def compute_feature_stats(info: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    for key, feature in dict(info.get("features") or {}).items():
        if not isinstance(feature, dict) or feature.get("dtype") in {"image", "video", "string"}:
            continue
        values = [row[key] for row in rows if key in row and row[key] is not None]
        if not values:
            continue
        array = np.asarray(values, dtype=float)
        if array.ndim == 1:
            array = array.reshape(-1, 1)
        stats[key] = {
            "min": np.min(array, axis=0).tolist(),
            "max": np.max(array, axis=0).tolist(),
            "mean": np.mean(array, axis=0).tolist(),
            "std": np.std(array, axis=0).tolist(),
            "count": [int(array.shape[0])],
            "q01": np.quantile(array, 0.01, axis=0).tolist(),
            "q10": np.quantile(array, 0.10, axis=0).tolist(),
            "q50": np.quantile(array, 0.50, axis=0).tolist(),
            "q90": np.quantile(array, 0.90, axis=0).tolist(),
            "q99": np.quantile(array, 0.99, axis=0).tolist(),
        }
    return stats
