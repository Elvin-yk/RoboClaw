from __future__ import annotations

from pathlib import Path
from typing import Callable

from roboclaw.data.infrastructure.filesystem import DataRepository
from roboclaw.data.infrastructure.state_store import DataStateStore

from .annotation import DataAnnotationService
from .clean import DataCleanService
from .inspect import DataInspectService
from .jobs import DataJobCoordinator
from .library import DataLibraryService
from .overview import DataOverviewService
from .packages import DatasetPackageService
from .evaluation import DataEvaluationService


class DataService:
    def __init__(self, root_resolver: Callable[[], Path] | None = None) -> None:
        self.state_store = DataStateStore()
        self.repository = DataRepository(root_resolver=root_resolver, state_store=self.state_store)
        self.jobs = DataJobCoordinator()
        self.library = DataLibraryService(self.repository, self.jobs)
        self.inspect = DataInspectService(self.repository)
        self.clean = DataCleanService(self.repository, self.jobs)
        self.packages = DatasetPackageService(self.repository, self.jobs)
        self.evaluation = DataEvaluationService(self.repository, self.jobs)
        self.annotation = DataAnnotationService(self.repository, self.jobs)
        self.overview = DataOverviewService(self.repository)
