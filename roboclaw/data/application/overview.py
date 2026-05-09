from __future__ import annotations

from typing import Any

from roboclaw.data.infrastructure.filesystem import DataRepository


class DataOverviewService:
    def __init__(self, repository: DataRepository) -> None:
        self.repository = repository

    def overview(self) -> dict[str, Any]:
        datasets = [item.to_dict() for item in self.repository.list_datasets()]
        packages = [item.to_dict() for item in self.repository.list_packages()]
        dataset_counts: dict[str, int] = {}
        package_counts: dict[str, int] = {}
        for dataset in datasets:
            stage = str(dataset.get("lifecycle_stage") or "raw")
            dataset_counts[stage] = dataset_counts.get(stage, 0) + 1
        for package in packages:
            stage = str(package.get("lifecycle_stage") or "assembled")
            package_counts[stage] = package_counts.get(stage, 0) + 1
        return {
            "datasets": datasets,
            "packages": packages,
            "summary": {
                "dataset_count": len(datasets),
                "package_count": len(packages),
                "dataset_stage_counts": dataset_counts,
                "package_stage_counts": package_counts,
            },
        }
