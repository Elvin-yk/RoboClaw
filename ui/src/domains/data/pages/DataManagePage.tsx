import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { DataDateRangeFilter, isDateInFilter, type DateFilterValue } from '@/domains/data/components/DataDateRangeFilter'
import { asRecord } from '@/domains/data/lib/analysisPayload'
import {
  dataGateLabelKey,
  dataGateMessageLabelKey,
  dataGateStatusLabelKey,
  sortDataGateKeys,
} from '@/domains/data/model/gates'
import {
  buildDatasetQualityView,
  datasetTaskDescription,
  qualityStatusLabelKey,
  qcReviewStatus,
  type QualityStatus,
} from '@/domains/data/model/datasetQuality'
import { isTerminalDataJobPhase, type DataGate, type DataJob, type DataQcRun, type Dataset, type DatasetPackage } from '@/domains/data/model/types'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import { useAuthStore } from '@/shared/lib/authStore'

type DrawerTarget =
  | { type: 'dataset'; id: string }
  | { type: 'package'; id: string }
  | null

type DeleteTarget =
  | { type: 'dataset'; id: string }
  | { type: 'package'; id: string }
  | null

const DEFAULT_PAGE_SIZE = 10
const PAGE_SIZE_OPTIONS = [10, 20, 50]
const DEFAULT_DATE_FILTER: DateFilterValue = { preset: 'all', from: '', to: '' }
const MANAGE_SECTION_STORAGE_KEY = 'roboclaw:data-manage:sections'

type ManageSectionKey = 'raw' | 'clean' | 'packages'
type QualityLane = 'auto_clean' | 'manual_review'
type ManageQualityStatus = 'pending' | 'running' | 'passed' | 'failed'
type QualityStepStatusClass = ManageQualityStatus | 'skipped'
type QualityRunStepView = DataQcRun['steps'][number]

type SectionOpenState = Record<ManageSectionKey, boolean>
type QualityStatusFilter = ManageQualityStatus | 'all'
type LaneStatusCounts = Record<ManageQualityStatus, number>

interface DatasetSectionStatusSummary {
  autoClean: LaneStatusCounts
  manualReview: LaneStatusCounts
}

interface TaskFilterOption {
  value: string
  count: number
}

const PACKAGE_STAGE_LABELS: Record<DatasetPackage['lifecycle_stage'], TranslationKey> = {
  assembling: 'dataPackageStageAssembling',
  assembled: 'dataPackageStageAssembled',
  validating: 'dataPackageStageValidating',
  validated: 'dataPackageStageValidated',
  annotating: 'dataPackageStageAnnotating',
  annotated: 'dataPackageStageAnnotated',
  upload_queued: 'dataPackageStageUploadQueued',
  uploaded: 'dataPackageStageUploaded',
  failed: 'dataPackageStageFailed',
}

const JOB_PHASE_LABELS: Record<DataJob['phase'], TranslationKey> = {
  queued: 'dataJobPhaseQueued',
  running: 'dataJobPhaseRunning',
  completed: 'dataJobPhaseCompleted',
  failed: 'dataJobPhaseFailed',
  cancelling: 'dataJobPhaseCancelling',
  cancelled: 'dataJobPhaseCancelled',
}

const QUALITY_STEP_LABELS: Record<string, TranslationKey> = {
  empty_dataset_check: 'dataManageQualityStepEmptyDatasetCheck',
  damage_diagnosis: 'dataManageQualityStepDamageDiagnosis',
  repair_if_possible: 'dataManageQualityStepRepair',
  repair_verify: 'dataManageQualityStepVerify',
  manual_review_decision: 'dataManageQualityStepManualReview',
}
const MANAGE_QUALITY_STATUSES: ManageQualityStatus[] = ['pending', 'running', 'passed', 'failed']
const DASHBOARD_QUALITY_STATUSES: ManageQualityStatus[] = ['pending', 'running', 'passed', 'failed']
const MANUAL_REVIEW_STATUSES: ManageQualityStatus[] = ['pending', 'passed', 'failed']

export default function DataManagePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const {
    datasets,
    packages,
    selectedDatasetIds,
    error,
    load,
    toggleDataset,
    setDatasetSelection,
    clearSelection,
    deleteDataset,
    deletePackage,
  } = useDataLibraryStore()
  const { jobs, attach } = useDataJobStore()
  const [packageId, setPackageId] = useState('')
  const [groupName, setGroupName] = useState('default')
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null)
  const [rawPage, setRawPage] = useState(1)
  const [cleanPage, setCleanPage] = useState(1)
  const [packagePage, setPackagePage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [sectionOpen, setSectionOpen] = useState<SectionOpenState>(() => readSectionOpenState())
  const [filterOpen, setFilterOpen] = useState<SectionOpenState>({ raw: true, clean: true, packages: true })
  const [rawDateFilter, setRawDateFilter] = useState<DateFilterValue>(DEFAULT_DATE_FILTER)
  const [cleanDateFilter, setCleanDateFilter] = useState<DateFilterValue>(DEFAULT_DATE_FILTER)
  const [packageDateFilter, setPackageDateFilter] = useState<DateFilterValue>(DEFAULT_DATE_FILTER)
  const [rawTaskFilter, setRawTaskFilter] = useState<string[]>([])
  const [cleanTaskFilter, setCleanTaskFilter] = useState<string[]>([])
  const [packageTaskFilter, setPackageTaskFilter] = useState<string[]>([])
  const [rawAutoCleanFilter, setRawAutoCleanFilter] = useState<QualityStatusFilter>('all')
  const [rawManualReviewFilter, setRawManualReviewFilter] = useState<QualityStatusFilter>('all')
  const [cleanAutoCleanFilter, setCleanAutoCleanFilter] = useState<QualityStatusFilter>('all')
  const [cleanManualReviewFilter, setCleanManualReviewFilter] = useState<QualityStatusFilter>('all')
  const [uploadRepoId, setUploadRepoId] = useState('')
  const [uploadToken, setUploadToken] = useState('')
  const [uploadPrivate, setUploadPrivate] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState(560)
  const [reloadedJobSignatures, setReloadedJobSignatures] = useState<string[]>([])
  const [autoCleanDialogJobId, setAutoCleanDialogJobId] = useState<string | null>(null)
  const loadedDrawerDatasetFromQuery = useRef('')
  const drawerDatasetFromQuery = searchParams.get('dataset') || ''

  useEffect(() => {
    void load()
  }, [load])

  const rawDatasetPool = useMemo(
    () => datasets.filter((dataset) => !isPackableDataset(dataset)),
    [datasets],
  )
  const cleanDatasetPool = useMemo(
    () => datasets.filter(isPackableDataset),
    [datasets],
  )
  const datasetsById = useMemo(
    () => new Map(datasets.map((dataset) => [dataset.id, dataset])),
    [datasets],
  )
  const packageSourceDatasets = useMemo(
    () => packages.flatMap((packageItem) => (
      packageItem.dataset_ids.map((datasetId) => datasetsById.get(datasetId)).filter(isDataset)
    )),
    [datasetsById, packages],
  )
  const rawTaskOptions = useMemo(() => taskOptionsFromDatasets(rawDatasetPool), [rawDatasetPool])
  const cleanTaskOptions = useMemo(() => taskOptionsFromDatasets(cleanDatasetPool), [cleanDatasetPool])
  const packageTaskOptions = useMemo(() => taskOptionsFromDatasets(packageSourceDatasets), [packageSourceDatasets])
  const rawDatasets = useMemo(
    () => rawDatasetPool.filter((dataset) => (
      matchesDatasetFilters(dataset, rawDateFilter, rawTaskFilter, rawAutoCleanFilter, rawManualReviewFilter)
    )),
    [rawAutoCleanFilter, rawDateFilter, rawDatasetPool, rawManualReviewFilter, rawTaskFilter],
  )
  const cleanDatasets = useMemo(
    () => cleanDatasetPool.filter((dataset) => (
      matchesDatasetFilters(dataset, cleanDateFilter, cleanTaskFilter, cleanAutoCleanFilter, cleanManualReviewFilter)
    )),
    [cleanAutoCleanFilter, cleanDatasetPool, cleanDateFilter, cleanManualReviewFilter, cleanTaskFilter],
  )
  const visiblePackages = useMemo(
    () => packages.filter((packageItem) => matchesPackageFilters(packageItem, datasetsById, packageDateFilter, packageTaskFilter)),
    [datasetsById, packageDateFilter, packages, packageTaskFilter],
  )
  const selectedDatasetIdSet = useMemo(() => new Set(selectedDatasetIds), [selectedDatasetIds])
  const rawStatusSummary = useMemo(() => datasetSectionStatusSummary(rawDatasetPool), [rawDatasetPool])
  const rawFilteredIds = useMemo(() => rawDatasets.map((dataset) => dataset.id), [rawDatasets])
  const selectedRawIds = rawFilteredIds.filter((id) => selectedDatasetIdSet.has(id))
  const selectedRawDatasets = useMemo(
    () => rawDatasetPool.filter((dataset) => selectedDatasetIdSet.has(dataset.id)),
    [rawDatasetPool, selectedDatasetIdSet],
  )
  const selectedRawBatchIds = selectedRawDatasets.map((dataset) => dataset.id)
  const selectedManualReviewDatasets = selectedRawDatasets.filter(isAutoCleanPassedDataset)
  const canStartManualReviewBatch = selectedRawDatasets.length > 0
    && selectedManualReviewDatasets.length === selectedRawDatasets.length
  const allFilteredRawSelected = rawFilteredIds.length > 0 && rawFilteredIds.every((id) => selectedDatasetIdSet.has(id))
  const selectedReviewDatasets = selectedDatasetIds.map((id) => datasetsById.get(id)).filter(isDataset)
  const selectedReviewBatchIds = selectedReviewDatasets.map((dataset) => dataset.id)
  const canApplyReviewBatch = selectedReviewDatasets.length > 0
    && selectedReviewDatasets.every(isReviewBatchReady)
  const autoCleanDisabledReason = selectedRawBatchIds.length ? '' : t('dataManageBatchDisabledNoDataset')
  const manualReviewDisabledReason = manualReviewBatchDisabledReason(selectedRawDatasets, t)
  const reviewBatchDisabledReason = applyReviewBatchDisabledReason(selectedReviewDatasets, t)
  const selectedCleanIds = selectedDatasetIds.filter((id) => (
    cleanDatasets.some((dataset) => dataset.id === id)
  ))
  const rawPageItems = paginate(rawDatasets, rawPage, pageSize)
  const cleanPageItems = paginate(cleanDatasets, cleanPage, pageSize)
  const packagePageItems = paginate(visiblePackages, packagePage, pageSize)
  const drawerDataset = drawerTarget?.type === 'dataset'
    ? datasets.find((dataset) => dataset.id === drawerTarget.id) || null
    : null
  const drawerPackage = drawerTarget?.type === 'package'
    ? packages.find((item) => item.id === drawerTarget.id) || null
    : null
  const deleteDatasetTarget = deleteTarget?.type === 'dataset'
    ? datasets.find((dataset) => dataset.id === deleteTarget.id) || null
    : null
  const deletePackageTarget = deleteTarget?.type === 'package'
    ? packages.find((item) => item.id === deleteTarget.id) || null
    : null
  const autoCleanDialogJob = autoCleanDialogJobId ? jobs[autoCleanDialogJobId] ?? null : null
  const terminalJobSignatures = Object.values(jobs)
    .filter((job) => job.kind === 'auto_clean' && isTerminalDataJobPhase(job.phase))
    .map((job) => `${job.job_id}:${job.phase}:${job.updated_at}`)
    .sort()
  const terminalJobSignature = terminalJobSignatures[terminalJobSignatures.length - 1] ?? ''

  useEffect(() => {
    setRawPage((current) => clampPage(current, pageCount(rawDatasets.length, pageSize)))
    setCleanPage((current) => clampPage(current, pageCount(cleanDatasets.length, pageSize)))
    setPackagePage((current) => clampPage(current, pageCount(visiblePackages.length, pageSize)))
  }, [cleanDatasets.length, pageSize, rawDatasets.length, visiblePackages.length])

  useEffect(() => {
    window.localStorage.setItem(MANAGE_SECTION_STORAGE_KEY, JSON.stringify(sectionOpen))
  }, [sectionOpen])

  useEffect(() => {
    if (!terminalJobSignature || reloadedJobSignatures.includes(terminalJobSignature)) return
    setReloadedJobSignatures((current) => [...current, terminalJobSignature])
    void load()
  }, [load, reloadedJobSignatures, terminalJobSignature])

  useEffect(() => {
    if (!drawerDatasetFromQuery || loadedDrawerDatasetFromQuery.current === drawerDatasetFromQuery) return
    if (!datasets.some((dataset) => dataset.id === drawerDatasetFromQuery)) return
    loadedDrawerDatasetFromQuery.current = drawerDatasetFromQuery
    setDrawerTarget({ type: 'dataset', id: drawerDatasetFromQuery })
  }, [datasets, drawerDatasetFromQuery])

  async function createPackage() {
    const nextPackageId = packageId.trim()
    if (!nextPackageId || selectedCleanIds.length === 0) return
    const groupKey = groupName.trim() || 'default'
    await dataApi.createPackage({
      package_id: nextPackageId,
      dataset_ids: selectedCleanIds,
      groups: { [groupKey]: selectedCleanIds },
      force: false,
    })
    setPackageId('')
    clearSelection()
    await load()
  }

  async function uploadPackage(packageItem: DatasetPackage) {
    const repoId = uploadRepoId.trim()
    if (!repoId) return
    const job = await dataApi.uploadPackage(packageItem.id, {
      repo_id: repoId,
      token: uploadToken.trim(),
      private: uploadPrivate,
    })
    attach(job)
  }

  async function startSelectedAutoClean() {
    if (!selectedRawBatchIds.length) return
    const job = await dataApi.startAutoCleanRun({ dataset_ids: selectedRawBatchIds, chain_id: 'default', force: true })
    attach(job)
    setAutoCleanDialogJobId(job.job_id)
  }

  function openSelectedReviewQueue() {
    if (!canStartManualReviewBatch || !selectedManualReviewDatasets.length) return
    const params = new URLSearchParams()
    params.set('dataset', selectedManualReviewDatasets[0].id)
    selectedManualReviewDatasets.forEach((dataset) => params.append('datasets', dataset.id))
    navigate(`/data/qc?${params.toString()}`)
  }

  async function startSelectedReviewBatch() {
    if (!canApplyReviewBatch) return
    const job = await dataApi.startReviewBatchRun({
      dataset_ids: selectedReviewBatchIds,
      reviewer_id: currentReviewerId(user),
    })
    attach(job)
  }

  function toggleRawFilteredSelection() {
    setDatasetSelection(rawFilteredIds, !allFilteredRawSelected)
  }

  async function removeDataset(dataset: Dataset) {
    await deleteDataset(dataset.id)
    setDeleteTarget(null)
    setDrawerTarget(null)
  }

  async function removePackage(packageItem: DatasetPackage) {
    await deletePackage(packageItem.id)
    setDeleteTarget(null)
    setDrawerTarget(null)
  }

  function openDatasetAnalysis(dataset: Dataset) {
    setDrawerTarget(null)
    const encodedDataset = encodeURIComponent(dataset.id)
    navigate(`/data/analysis?dataset=${encodedDataset}&returnTo=data-manage&manageDataset=${encodedDataset}`)
  }

  function openDatasetReview(dataset: Dataset) {
    setDrawerTarget(null)
    const encodedDataset = encodeURIComponent(dataset.id)
    navigate(`/data/qc?dataset=${encodedDataset}&datasets=${encodedDataset}`)
  }

  function openPackageGate(packageItem: DatasetPackage, gateKey: string) {
    setDrawerTarget(null)
    navigate(packageGateRoute(packageItem.id, gateKey))
  }

  function changePageSize(value: number) {
    setPageSize(value)
    setRawPage(1)
    setCleanPage(1)
    setPackagePage(1)
  }

  function toggleSection(section: ManageSectionKey) {
    setSectionOpen((current) => ({ ...current, [section]: !current[section] }))
  }

  function toggleFilters(section: ManageSectionKey) {
    setFilterOpen((current) => ({ ...current, [section]: !current[section] }))
  }

  function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    const resize = (moveEvent: PointerEvent) => {
      const maxWidth = Math.max(420, Math.min(960, window.innerWidth - 48))
      const nextWidth = Math.min(Math.max(420, window.innerWidth - moveEvent.clientX), maxWidth)
      setDrawerWidth(nextWidth)
    }
    const stopResize = () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      window.removeEventListener('pointermove', resize)
      window.removeEventListener('pointerup', stopResize)
    }
    window.addEventListener('pointermove', resize)
    window.addEventListener('pointerup', stopResize)
  }

  const drawerStyle = {
    '--data-manage-drawer-width': `${drawerWidth}px`,
  } as CSSProperties & Record<'--data-manage-drawer-width', string>

  return (
    <section className="data-manage-page data-manage-page--current">
      {error && <div className="data-manage-error">{error}</div>}

      <main className="data-manage-grid">
        <DataManageDashboard
          title={t('dataManageRawColumn')}
          count={rawDatasetPool.length}
          summary={rawStatusSummary}
        />

        <ManageSection
          sectionKey="raw"
          title={t('dataManageRawColumn')}
          count={rawDatasetPool.length}
          visibleCount={rawDatasets.length}
          showCount={false}
          open={sectionOpen.raw}
          onToggle={toggleSection}
          actions={(
            <div className="data-manage-section__action-group">
              <ActionButtonWithReason
                className={cn('data-manage-batch-clean-button', selectedRawBatchIds.length > 0 && 'is-armed')}
                disabled={selectedRawBatchIds.length === 0}
                disabledReason={autoCleanDisabledReason}
                onClick={() => void startSelectedAutoClean()}
              >
                {t('dataManageBatchAutoClean')}
              </ActionButtonWithReason>
              <ActionButtonWithReason
                className={cn('data-manage-manual-review-button', canStartManualReviewBatch && 'is-armed')}
                disabled={!canStartManualReviewBatch}
                disabledReason={manualReviewDisabledReason}
                onClick={openSelectedReviewQueue}
              >
                {t('dataManageStartManualReviewBatch')}
              </ActionButtonWithReason>
              <ActionButtonWithReason
                className={cn('data-manage-review-batch-button', canApplyReviewBatch && 'is-armed')}
                disabled={!canApplyReviewBatch}
                disabledReason={reviewBatchDisabledReason}
                onClick={() => void startSelectedReviewBatch()}
              >
                {t('dataManageApplyReviewBatch')}
              </ActionButtonWithReason>
            </div>
          )}
          filtersOpen={filterOpen.raw}
          onToggleFilters={toggleFilters}
          filters={(
            <SectionFilters>
              <FilterField label={t('dataManageTaskFilterLabel')}>
                <TaskMultiSelectFilter
                  options={rawTaskOptions}
                  value={rawTaskFilter}
                  onChange={(value) => {
                    setRawTaskFilter(value)
                    setRawPage(1)
                  }}
                />
              </FilterField>
              <FilterField label={t('dataDateRange')} wide>
                <DataDateRangeFilter
                  value={rawDateFilter}
                  onChange={(value) => {
                    setRawDateFilter(value)
                    setRawPage(1)
                  }}
                />
              </FilterField>
              <div className="data-manage-status-filter-group">
                <FilterField label={t('dataManageAutoCleanStatus')}>
                  <QualityStatusFacetFilter
                    label={t('dataManageAutoCleanStatus')}
                    value={rawAutoCleanFilter}
                    onChange={(value) => {
                      setRawAutoCleanFilter(value)
                      setRawPage(1)
                    }}
                  />
                </FilterField>
                <FilterField label={t('dataManageManualReviewStatus')}>
                  <QualityStatusFacetFilter
                    label={t('dataManageManualReviewStatus')}
                    statuses={MANUAL_REVIEW_STATUSES}
                    value={rawManualReviewFilter}
                    onChange={(value) => {
                      setRawManualReviewFilter(value)
                      setRawPage(1)
                    }}
                  />
                </FilterField>
              </div>
            </SectionFilters>
          )}
          pager={(
            <Pager
              page={rawPage}
              pageSize={pageSize}
              total={rawDatasets.length}
              onPageChange={setRawPage}
              onPageSizeChange={changePageSize}
              leading={(
                <div className="data-manage-pager-actions">
                  <span>{t('dataManageSelectedFilterStatus', { selected: selectedRawIds.length, total: rawDatasets.length })}</span>
                  <button
                    type="button"
                    className="data-manage-ghost-button"
                    onClick={toggleRawFilteredSelection}
                    disabled={rawFilteredIds.length === 0}
                  >
                    {allFilteredRawSelected ? t('dataManageClearFilteredSelection') : t('dataManageSelectAllFiltered')}
                  </button>
                </div>
              )}
            />
          )}
        >
          {rawPageItems.map((dataset) => (
            <DatasetRow
              key={dataset.id}
              dataset={dataset}
              active={drawerTarget?.type === 'dataset' && drawerTarget.id === dataset.id}
              selected={selectedDatasetIdSet.has(dataset.id)}
              selectable
              onSelect={() => setDrawerTarget({ type: 'dataset', id: dataset.id })}
              onToggle={() => toggleDataset(dataset.id)}
            />
          ))}
          {!rawDatasets.length && <div className="data-manage-empty">{t('dataManageEmptyRaw')}</div>}
        </ManageSection>

        <ManageSection
          sectionKey="clean"
          title={t('dataManageCleanColumn')}
          count={cleanDatasetPool.length}
          visibleCount={cleanDatasets.length}
          open={sectionOpen.clean}
          onToggle={toggleSection}
          filtersOpen={filterOpen.clean}
          onToggleFilters={toggleFilters}
          filters={(
            <SectionFilters>
              <FilterField label={t('dataManageTaskFilterLabel')}>
                <TaskMultiSelectFilter
                  options={cleanTaskOptions}
                  value={cleanTaskFilter}
                  onChange={(value) => {
                    setCleanTaskFilter(value)
                    setCleanPage(1)
                  }}
                />
              </FilterField>
              <FilterField label={t('dataDateRange')} wide>
                <DataDateRangeFilter
                  value={cleanDateFilter}
                  onChange={(value) => {
                    setCleanDateFilter(value)
                    setCleanPage(1)
                  }}
                />
              </FilterField>
              <div className="data-manage-status-filter-group">
                <FilterField label={t('dataManageAutoCleanStatus')}>
                  <QualityStatusFacetFilter
                    label={t('dataManageAutoCleanStatus')}
                    value={cleanAutoCleanFilter}
                    onChange={(value) => {
                      setCleanAutoCleanFilter(value)
                      setCleanPage(1)
                    }}
                  />
                </FilterField>
                <FilterField label={t('dataManageManualReviewStatus')}>
                  <QualityStatusFacetFilter
                    label={t('dataManageManualReviewStatus')}
                    statuses={MANUAL_REVIEW_STATUSES}
                    value={cleanManualReviewFilter}
                    onChange={(value) => {
                      setCleanManualReviewFilter(value)
                      setCleanPage(1)
                    }}
                  />
                </FilterField>
              </div>
            </SectionFilters>
          )}
          pager={(
            <Pager
              page={cleanPage}
              pageSize={pageSize}
              total={cleanDatasets.length}
              onPageChange={setCleanPage}
              onPageSizeChange={changePageSize}
            />
          )}
        >
          <div className="data-manage-package-form">
            <input value={packageId} onChange={(event) => setPackageId(event.target.value)} placeholder={t('dataManagePackageIdPlaceholder')} />
            <input value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder={t('dataManageGroupPlaceholder')} />
            <button
              type="button"
              onClick={() => void createPackage()}
              disabled={!packageId.trim() || selectedCleanIds.length === 0}
            >
              {t('dataManageCreatePackage')}
            </button>
          </div>
          {cleanPageItems.map((dataset) => (
            <DatasetRow
              key={dataset.id}
              dataset={dataset}
              active={drawerTarget?.type === 'dataset' && drawerTarget.id === dataset.id}
              selected={selectedDatasetIdSet.has(dataset.id)}
              selectable
              onSelect={() => setDrawerTarget({ type: 'dataset', id: dataset.id })}
              onToggle={() => toggleDataset(dataset.id)}
            />
          ))}
          {!cleanDatasets.length && <div className="data-manage-empty">{t('dataManageEmptyClean')}</div>}
        </ManageSection>

        <ManageSection
          sectionKey="packages"
          title={t('dataManagePackageColumn')}
          count={packages.length}
          visibleCount={visiblePackages.length}
          open={sectionOpen.packages}
          onToggle={toggleSection}
          filtersOpen={filterOpen.packages}
          onToggleFilters={toggleFilters}
          filters={(
            <SectionFilters>
              <FilterField label={t('dataManageTaskFilterLabel')}>
                <TaskMultiSelectFilter
                  options={packageTaskOptions}
                  value={packageTaskFilter}
                  onChange={(value) => {
                    setPackageTaskFilter(value)
                    setPackagePage(1)
                  }}
                />
              </FilterField>
              <FilterField label={t('dataDateRange')} wide>
                <DataDateRangeFilter
                  value={packageDateFilter}
                  onChange={(value) => {
                    setPackageDateFilter(value)
                    setPackagePage(1)
                  }}
                />
              </FilterField>
            </SectionFilters>
          )}
          pager={(
            <Pager
              page={packagePage}
              pageSize={pageSize}
              total={visiblePackages.length}
              onPageChange={setPackagePage}
              onPageSizeChange={changePageSize}
            />
          )}
        >
          {packagePageItems.map((packageItem) => (
            <PackageRow
              key={packageItem.id}
              packageItem={packageItem}
              active={drawerTarget?.type === 'package' && drawerTarget.id === packageItem.id}
              onSelect={() => {
                setDrawerTarget({ type: 'package', id: packageItem.id })
                setUploadRepoId(uploadRepoId || packageItem.id)
              }}
            />
          ))}
          {!visiblePackages.length && <div className="data-manage-empty">{t('dataManageEmptyPackages')}</div>}
        </ManageSection>
      </main>

      {autoCleanDialogJob && (
        <AutoCleanJobDialog
          job={autoCleanDialogJob}
          onClose={() => setAutoCleanDialogJobId(null)}
        />
      )}

      {drawerDataset && (
        <DrawerLayer onClose={() => setDrawerTarget(null)}>
          <DatasetDrawer
            dataset={drawerDataset}
            onClose={() => setDrawerTarget(null)}
            onDelete={() => setDeleteTarget({ type: 'dataset', id: drawerDataset.id })}
            onAnalyze={() => openDatasetAnalysis(drawerDataset)}
            onReview={() => openDatasetReview(drawerDataset)}
            onResizeStart={startDrawerResize}
            style={drawerStyle}
          />
        </DrawerLayer>
      )}

      {drawerPackage && (
        <DrawerLayer onClose={() => setDrawerTarget(null)}>
          <PackageDrawer
            packageItem={drawerPackage}
            repoId={uploadRepoId}
            token={uploadToken}
            privateRepo={uploadPrivate}
            onRepoIdChange={setUploadRepoId}
            onTokenChange={setUploadToken}
            onPrivateChange={setUploadPrivate}
            onClose={() => setDrawerTarget(null)}
            onUpload={() => void uploadPackage(drawerPackage)}
            onDelete={() => setDeleteTarget({ type: 'package', id: drawerPackage.id })}
            onOpenGate={(gateKey) => openPackageGate(drawerPackage, gateKey)}
            onResizeStart={startDrawerResize}
            style={drawerStyle}
          />
        </DrawerLayer>
      )}

      {deleteDatasetTarget && (
        <DeleteConfirmDialog
          message={t('dataManageDeleteDatasetConfirm', { id: deleteDatasetTarget.id })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void removeDataset(deleteDatasetTarget)}
        />
      )}

      {deletePackageTarget && (
        <DeleteConfirmDialog
          message={t('dataManageDeletePackageConfirm', { id: deletePackageTarget.id })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void removePackage(deletePackageTarget)}
        />
      )}
    </section>
  )
}

function DataManageDashboard({
  title,
  count,
  summary,
}: {
  title: string
  count: number
  summary: DatasetSectionStatusSummary
}) {
  const { t } = useI18n()
  return (
    <section className="data-panel data-manage-dashboard">
      <div className="data-manage-dashboard__main">
        <span>{title}</span>
        <strong className="data-metric">{count}</strong>
      </div>
      <div className="data-manage-dashboard__lanes">
        <DataManageDashboardLane title={t('dataManageAutoCleanStatus')} counts={summary.autoClean} statuses={DASHBOARD_QUALITY_STATUSES} />
        <DataManageDashboardLane title={t('dataManageManualReviewStatus')} counts={summary.manualReview} statuses={MANUAL_REVIEW_STATUSES} />
      </div>
    </section>
  )
}

function DataManageDashboardLane({
  title,
  counts,
  statuses,
}: {
  title: string
  counts: LaneStatusCounts
  statuses: ManageQualityStatus[]
}) {
  return (
    <div className="data-manage-dashboard-lane">
      <span>{title}</span>
      <StatusCountPills counts={counts} statuses={statuses} />
    </div>
  )
}

function ManageSection({
  sectionKey,
  title,
  count,
  visibleCount,
  showCount = true,
  open,
  onToggle,
  actions,
  filtersOpen,
  onToggleFilters,
  filters,
  pager,
  children,
}: {
  sectionKey: ManageSectionKey
  title: string
  count: number
  visibleCount?: number
  showCount?: boolean
  open: boolean
  onToggle: (section: ManageSectionKey) => void
  actions?: ReactNode
  filtersOpen: boolean
  onToggleFilters: (section: ManageSectionKey) => void
  filters: ReactNode
  pager: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  const bodyId = `data-manage-section-${sectionKey}`
  const filterId = `${bodyId}-filters`
  return (
    <section className={cn('data-manage-section', !open && 'is-collapsed')}>
      <div className="data-manage-section__header">
        <div className="data-manage-section__title-area">
          <button
            type="button"
            className="data-manage-section__toggle"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => onToggle(sectionKey)}
          >
            <span className="data-manage-section__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
            <h2>{title}</h2>
            {showCount && <span className="data-manage-section__count">{t('dataManageTotalCount', { count })}</span>}
            {showCount && visibleCount !== undefined && visibleCount !== count && (
              <span className="data-manage-section__filtered-count">{t('dataManageFilteredCount', { count: visibleCount })}</span>
            )}
          </button>
          {open && (
            <button
              type="button"
              className="data-manage-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls={filterId}
              onClick={() => onToggleFilters(sectionKey)}
            >
              <span>{t('dataManageFilterConditions')}</span>
              <i aria-hidden="true">{filtersOpen ? '▾' : '▸'}</i>
            </button>
          )}
        </div>
        {actions && <div className="data-manage-section__actions">{actions}</div>}
      </div>
      {open && (
        <div id={bodyId} className="data-manage-section__content">
          {filtersOpen && <div id={filterId} className="data-manage-section__filters">{filters}</div>}
          <div className="data-manage-column__body">{children}</div>
          {pager}
        </div>
      )}
    </section>
  )
}

function StatusCountPills({
  counts,
  statuses = MANAGE_QUALITY_STATUSES,
}: {
  counts: LaneStatusCounts
  statuses?: ManageQualityStatus[]
}) {
  const { t } = useI18n()
  return (
    <div className="data-manage-status-count-pills">
      {statuses.map((status) => (
        <em key={status} className={cn('data-manage-status-count', `is-${status}`)}>
          <i aria-hidden="true" />
          <span>{manageQualityStatusLabel(status, t)}</span>
          <strong>{counts[status]}</strong>
        </em>
      ))}
    </div>
  )
}

function ActionButtonWithReason({
  className,
  disabled,
  disabledReason,
  onClick,
  children,
}: {
  className: string
  disabled: boolean
  disabledReason: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <div
      className="data-manage-action-with-reason data-tooltip-host"
      data-tooltip={disabled ? disabledReason : undefined}
    >
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={disabled}
      >
        {children}
      </button>
    </div>
  )
}

function SectionFilters({ children }: { children: ReactNode }) {
  return <div className="data-manage-filter-panel">{children}</div>
}

function FilterField({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <div className={cn('data-manage-filter-field', wide && 'data-manage-filter-field--wide')}>
      <span className="data-manage-filter-field__label">{label}</span>
      <div className="data-manage-filter-field__control">{children}</div>
    </div>
  )
}

function TaskMultiSelectFilter({
  options,
  value,
  onChange,
}: {
  options: TaskFilterOption[]
  value: string[]
  onChange: (value: string[]) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = new Set(value)
  const normalizedQuery = query.trim().toLowerCase()
  const visibleOptions = normalizedQuery
    ? options.filter((option) => option.value.toLowerCase().includes(normalizedQuery))
    : options
  const label = value.length ? t('dataManageTaskFilterSelected', { count: value.length }) : t('dataManageTaskFilterAll')

  function toggleOption(option: string) {
    if (selected.has(option)) {
      onChange(value.filter((item) => item !== option))
      return
    }
    onChange([...value, option])
  }

  return (
    <div className="data-manage-task-filter">
      <button
        type="button"
        className="data-manage-neutral-button data-manage-task-filter__button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        <span>{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="data-manage-task-filter__popover">
          {options.length > 10 && (
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('dataManageTaskFilterSearch')}
            />
          )}
          <div className="data-manage-task-filter__list">
            {visibleOptions.map((option) => (
              <label key={option.value} className="data-manage-task-filter__option">
                <input
                  type="checkbox"
                  checked={selected.has(option.value)}
                  onChange={() => toggleOption(option.value)}
                />
                <span>{option.value}</span>
                <small>{option.count}</small>
              </label>
            ))}
            {!visibleOptions.length && <div className="data-manage-task-filter__empty">{t('dataManageTaskFilterEmpty')}</div>}
          </div>
          <div className="data-manage-task-filter__actions">
            <button type="button" className="data-manage-ghost-button" onClick={() => onChange([])} disabled={!value.length}>
              {t('clearSelection')}
            </button>
            <button type="button" className="data-manage-neutral-button" onClick={() => setOpen(false)}>
              {t('dataManageTaskFilterDone')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function QualityStatusFacetFilter({
  label,
  statuses = MANAGE_QUALITY_STATUSES,
  value,
  onChange,
}: {
  label: string
  statuses?: ManageQualityStatus[]
  value: QualityStatusFilter
  onChange: (value: QualityStatusFilter) => void
}) {
  const { t } = useI18n()
  return (
    <div className="data-manage-status-filter" role="group" aria-label={label}>
      {statuses.map((status) => (
        <button
          key={status}
          type="button"
          className={cn('data-manage-status-filter__option', `is-${status}`, value === status && 'is-active')}
          onClick={() => onChange(value === status ? 'all' : status)}
        >
          <i aria-hidden="true" />
          {manageQualityStatusLabel(status, t)}
        </button>
      ))}
    </div>
  )
}

function DatasetRow({
  dataset,
  active,
  selected,
  selectable,
  onSelect,
  onToggle,
}: {
  dataset: Dataset
  active: boolean
  selected: boolean
  selectable: boolean
  onSelect: () => void
  onToggle?: () => void
}) {
  const { t } = useI18n()
  const quality = buildDatasetQualityView(dataset)
  const autoCleanStatus = datasetAutoCleanDisplayStatus(dataset, quality)
  const manualReviewStatus = datasetManualReviewDisplayStatus(dataset, quality)
  return (
    <article className={cn('data-manage-card data-manage-dataset-row', active && 'is-active')}>
      {selectable && onToggle && (
        <label className="data-manage-row-checkbox" title={selected ? t('dataManageUnselectDataset') : t('dataManageSelectDataset')} onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
          />
        </label>
      )}
      <button type="button" className="data-manage-card__main" onClick={onSelect}>
        <div className="data-manage-card__topline">
          <span className="data-manage-card__name">{dataset.label}</span>
        </div>
      </button>
      <div className="data-manage-card__quality">
        <div className="data-manage-quality-pill">
          <span>{t('dataManageAutoCleanStatus')}</span>
          <strong className={cn(`is-${autoCleanStatus}`)}>{manageQualityStatusLabel(autoCleanStatus, t)}</strong>
        </div>
        <div className="data-manage-quality-pill">
          <span>{t('dataManageManualReviewStatus')}</span>
          <strong className={cn(`is-${manualReviewStatus}`)}>{manageQualityStatusLabel(manualReviewStatus, t)}</strong>
        </div>
      </div>
    </article>
  )
}

function PackageRow({
  packageItem,
  active,
  onSelect,
}: {
  packageItem: DatasetPackage
  active: boolean
  onSelect: () => void
}) {
  const { t } = useI18n()
  const summary = packageItem.evaluation_summary
  return (
    <article className={cn('data-manage-assembly', active && 'is-active')}>
      <button type="button" className="data-manage-card__main" onClick={onSelect}>
        <div className="data-manage-card__topline">
          <span className="data-manage-card__name">{packageItem.label}</span>
          <span className={cn('data-manage-stage', `is-${packageItem.lifecycle_stage}`)}>
            {t(PACKAGE_STAGE_LABELS[packageItem.lifecycle_stage])}
          </span>
        </div>
        <div className="data-manage-card__stats">
          <span>{t('dataManageDatasetsShort', { count: packageItem.dataset_ids.length })}</span>
          <span>{t('dataManageEpisodesShort', { count: packageItem.stats.total_episodes })}</span>
          <span>{t('dataManageFramesShort', { count: packageItem.stats.total_frames })}</span>
        </div>
        <div className="data-manage-card__footer">
          <span>{t('dataManageScore', { score: String(summary.overall_score ?? '-') })}</span>
          <span>{t('dataManageEvaluatedCount', { count: String(summary.total ?? 0) })}</span>
        </div>
      </button>
    </article>
  )
}

function DrawerLayer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <>
      <button
        type="button"
        className="data-manage-drawer-backdrop"
        aria-label={t('dataManageCloseDrawer')}
        onClick={onClose}
      />
      {children}
    </>
  )
}

function DatasetDrawer({
  dataset,
  onClose,
  onDelete,
  onAnalyze,
  onReview,
  onResizeStart,
  style,
}: {
  dataset: Dataset
  onClose: () => void
  onDelete: () => void
  onAnalyze: () => void
  onReview: () => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  style: CSSProperties
}) {
  const { t } = useI18n()
  return (
    <aside className="data-manage-drawer" style={style}>
      <DrawerResizeHandle onResizeStart={onResizeStart} />
      <DrawerHeader
        title={dataset.label}
        onClose={onClose}
      />
      <DrawerSection
        title={t('dataManageStatsSection')}
        action={(
          <button type="button" className="data-manage-drawer-action" onClick={onAnalyze}>
            {t('dataManageOpenAnalysis')}
          </button>
        )}
      >
        <div className="data-manage-kv-grid">
          <KeyValue wide label={t('dataManageTaskDescription')} value={datasetTaskDescription(dataset) || t('dataManageNoTaskDescription')} />
          <KeyValue label={t('dataManageEpisodes')} value={String(dataset.stats.total_episodes)} />
          <KeyValue label={t('dataManageFrames')} value={String(dataset.stats.total_frames)} />
          <KeyValue label="FPS" value={String(dataset.stats.fps || 0)} />
          <KeyValue label={t('dataManageRobot')} value={dataset.stats.robot_type || '-'} />
          <KeyValue wide label={t('dataManagePath')} value={dataset.path} />
        </div>
      </DrawerSection>
      <DrawerSection title={t('dataManageQualitySection')}>
        <DatasetQualityPanel dataset={dataset} onReview={onReview} />
      </DrawerSection>
      <DrawerDangerZone>
        <button type="button" className="data-manage-danger" onClick={onDelete}>{t('del')}</button>
      </DrawerDangerZone>
    </aside>
  )
}

function DatasetQualityPanel({ dataset, onReview }: { dataset: Dataset; onReview: () => void }) {
  const { t } = useI18n()
  const quality = buildDatasetQualityView(dataset)
  const autoCleanStatus = datasetAutoCleanDisplayStatus(dataset, quality)
  const manualReviewStatus = datasetManualReviewDisplayStatus(dataset, quality)
  const autoCleanFallbackSteps = autoCleanStepFallbacks(quality.autoCleanStatus, quality.autoCleanMessage)
  const [activeLane, setActiveLane] = useState<QualityLane | null>(null)
  const [loadingLane, setLoadingLane] = useState<QualityLane | null>(null)
  const [runs, setRuns] = useState<Partial<Record<QualityLane, DataQcRun>>>({})
  const [runErrors, setRunErrors] = useState<Partial<Record<QualityLane, string>>>({})

  async function openLane(lane: QualityLane) {
    if (activeLane === lane) {
      setActiveLane(null)
      return
    }
    setActiveLane(lane)
    if (runs[lane]) return
    const runId = qualityLaneLastRunId(dataset, lane)
    if (!runId) return
    setLoadingLane(lane)
    setRunErrors((current) => ({ ...current, [lane]: '' }))
    try {
      const run = await dataApi.qcRun({ dataset_id: dataset.id, run_id: runId })
      setRuns((current) => ({ ...current, [lane]: run }))
    } catch (error) {
      setRunErrors((current) => ({
        ...current,
        [lane]: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setLoadingLane(null)
    }
  }

  return (
    <div className="data-manage-quality-panel">
      <button
        type="button"
        className={cn('data-manage-quality-row data-manage-quality-row--button', activeLane === 'auto_clean' && 'is-active')}
        onClick={() => void openLane('auto_clean')}
      >
        <span>{t('dataManageAutoCleanStatus')}</span>
        <strong className={cn(`is-${autoCleanStatus}`)}>
          {manageQualityStatusLabel(autoCleanStatus, t)}
        </strong>
      </button>
      {activeLane === 'auto_clean' && (
        <QualityRunDetails
          lane="auto_clean"
          run={runs.auto_clean}
          loading={loadingLane === 'auto_clean'}
          error={runErrors.auto_clean || ''}
          message={quality.autoCleanMessage}
          fallbackSteps={autoCleanFallbackSteps}
        />
      )}
      <button
        type="button"
        className="data-manage-quality-row data-manage-quality-row--button"
        onClick={onReview}
      >
        <span>{t('dataManageManualReviewStatus')}</span>
        <strong className={cn(`is-${manualReviewStatus}`)}>
          {manageQualityStatusLabel(manualReviewStatus, t)}
        </strong>
      </button>
    </div>
  )
}

function QualityRunDetails({
  lane,
  run,
  loading,
  error,
  message,
  fallbackSteps,
}: {
  lane: QualityLane
  run?: DataQcRun
  loading: boolean
  error: string
  message: string
  fallbackSteps: QualityRunStepView[]
}) {
  const { t } = useI18n()
  const steps = lane === 'auto_clean'
    ? autoCleanOrderedSteps(run?.steps ?? [], fallbackSteps)
    : (run?.steps.length ? run.steps : fallbackSteps)
  if (loading) {
    return <div className="data-manage-quality-detail">{t('dataManageQualityLoading')}</div>
  }
  if (!run && !steps.length) {
    return (
      <div className="data-manage-quality-detail">
        <p>{lane === 'auto_clean' ? t('dataManageQualityNoRun') : (message || (error ? t('dataManageQualityRunUnavailable') : t('dataManageQualityNoRun')))}</p>
      </div>
    )
  }
  return (
    <div className="data-manage-quality-detail">
      {run && (
        <dl>
          <div>
            <dt>{t('dataManageQualityRunId')}</dt>
            <dd>{run.run_id}</dd>
          </div>
          <div>
            <dt>{t('dataManageQualityRunStatus')}</dt>
            <dd>{run.status}</dd>
          </div>
        </dl>
      )}
      <QualityStepList
        title={t(lane === 'auto_clean' ? 'dataManageQualityAutoCleanSteps' : 'dataManageQualityManualReviewSteps')}
        steps={steps}
        emptyMessage={lane === 'auto_clean' ? t('dataManageQualityNoSteps') : (message || t('dataManageQualityNoSteps'))}
        hideMessages={lane === 'auto_clean'}
      />
      {run?.failure && (
        <p className="data-manage-quality-detail__note">
          {t('dataManageQualityFailure')}: {compactRecord(run.failure)}
        </p>
      )}
    </div>
  )
}

function QualityStepList({
  title,
  steps,
  emptyMessage,
  hideMessages,
}: {
  title: string
  steps: QualityRunStepView[]
  emptyMessage: string
  hideMessages?: boolean
}) {
  const { t } = useI18n()
  return (
    <>
      <strong>{title}</strong>
      <ol className="data-manage-quality-steps">
        {steps.map((step, index) => (
          <li key={`${step.id}-${step.updated_at || step.message}`} className="data-manage-quality-step">
            <span className="data-manage-quality-step__index" aria-hidden="true">{index + 1}</span>
            <div>
              <span className="data-manage-quality-step__title">{qualityStepLabel(step.id, t)}</span>
              {!hideMessages && qualityDisplayMessage(step.message) && <p>{qualityDisplayMessage(step.message)}</p>}
            </div>
            <em className={cn(`is-${qualityStepStatusClass(step.status)}`)}>{qualityStepStatusLabel(step.status, t)}</em>
          </li>
        ))}
        {!steps.length && (
          <li className="data-manage-quality-step data-manage-quality-step--empty">
            <p>{emptyMessage}</p>
          </li>
        )}
      </ol>
    </>
  )
}

function PackageDrawer({
  packageItem,
  repoId,
  token,
  privateRepo,
  onRepoIdChange,
  onTokenChange,
  onPrivateChange,
  onClose,
  onUpload,
  onDelete,
  onOpenGate,
  onResizeStart,
  style,
}: {
  packageItem: DatasetPackage
  repoId: string
  token: string
  privateRepo: boolean
  onRepoIdChange: (value: string) => void
  onTokenChange: (value: string) => void
  onPrivateChange: (value: boolean) => void
  onClose: () => void
  onUpload: () => void
  onDelete: () => void
  onOpenGate: (gateKey: string) => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  style: CSSProperties
}) {
  const { t } = useI18n()
  const summary = packageItem.evaluation_summary
  return (
    <aside className="data-manage-drawer" style={style}>
      <DrawerResizeHandle onResizeStart={onResizeStart} />
      <DrawerHeader
        title={packageItem.label}
        stageLabel={t(PACKAGE_STAGE_LABELS[packageItem.lifecycle_stage])}
        stageTone={packageItem.lifecycle_stage}
        onClose={onClose}
      />
      <DrawerSection title={t('dataManageUploadSection')}>
        <div className="data-manage-upload-form">
          <input value={repoId} onChange={(event) => onRepoIdChange(event.target.value)} placeholder={t('dataManageRepoPlaceholder')} />
          <input value={token} onChange={(event) => onTokenChange(event.target.value)} placeholder={t('dataManageTokenPlaceholder')} type="password" />
          <label>
            <input type="checkbox" checked={privateRepo} onChange={(event) => onPrivateChange(event.target.checked)} />
            {t('dataManagePrivateRepo')}
          </label>
          <button type="button" onClick={onUpload} disabled={!repoId.trim()}>{t('dataManageUploadPackage')}</button>
        </div>
      </DrawerSection>
      <DrawerSection title={t('dataManageStatsSection')}>
        <div className="data-manage-kv-grid">
          <KeyValue label={t('dataManageSources')} value={String(packageItem.dataset_ids.length)} />
          <KeyValue label={t('dataManageEpisodes')} value={String(packageItem.stats.total_episodes)} />
          <KeyValue label={t('dataManageFrames')} value={String(packageItem.stats.total_frames)} />
          <KeyValue wide label={t('dataManageEvaluation')} value={t('dataManageEvaluationValue', { score: String(summary.overall_score ?? '-'), count: String(summary.total ?? 0) })} />
          <KeyValue wide label={t('dataManagePath')} value={packageItem.path} />
        </div>
      </DrawerSection>
      <DrawerSection title={t('dataManageSourceDatasetSection')}>
        <div className="data-manage-source-list">
          {packageItem.dataset_ids.map((datasetId) => <span key={datasetId}>{datasetId}</span>)}
        </div>
      </DrawerSection>
      <DrawerSection title={t('dataManageGatesSection')}>
        <GateList gates={packageItem.gates} onOpenGate={onOpenGate} />
      </DrawerSection>
      <DrawerDangerZone>
        <button type="button" className="data-manage-danger" onClick={onDelete}>{t('del')}</button>
      </DrawerDangerZone>
    </aside>
  )
}

function DrawerResizeHandle({
  onResizeStart,
}: {
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}) {
  const { t } = useI18n()
  return (
    <div
      role="separator"
      aria-label={t('dataManageResizeDrawer')}
      className="data-manage-drawer__resize"
      onPointerDown={onResizeStart}
    />
  )
}

function DrawerHeader({
  title,
  stageLabel,
  stageTone,
  onClose,
}: {
  title: string
  stageLabel?: string
  stageTone?: string
  onClose: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="data-manage-drawer__header">
      <div className="data-manage-drawer__title">
        <h3>{title}</h3>
        {stageLabel && (
          <span className={cn('data-manage-stage', stageTone && `is-${stageTone}`)}>{stageLabel}</span>
        )}
      </div>
      <button type="button" className="data-manage-icon-button" onClick={onClose} title={t('dataManageCloseDrawer')}>×</button>
    </div>
  )
}

function DrawerSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="data-manage-drawer__section">
      <div className="data-manage-drawer__section-head">
        <h4>{title}</h4>
        {action}
      </div>
      {children}
    </section>
  )
}

function DrawerDangerZone({ children }: { children: ReactNode }) {
  return (
    <div className="data-manage-drawer__danger-zone">
      {children}
    </div>
  )
}

function DeleteConfirmDialog({
  message,
  onCancel,
  onConfirm,
}: {
  message: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="data-manage-confirm" role="dialog" aria-modal="true" aria-labelledby="data-manage-confirm-title">
      <div className="data-manage-confirm__panel">
        <h3 id="data-manage-confirm-title">{t('dataManageDeleteTitle')}</h3>
        <p>{message}</p>
        <div className="data-manage-confirm__actions">
          <button type="button" className="data-manage-secondary" onClick={onCancel}>{t('dataManageDeleteCancel')}</button>
          <button type="button" className="data-manage-danger" onClick={onConfirm}>{t('dataManageDeleteConfirmAction')}</button>
        </div>
      </div>
    </div>
  )
}

function AutoCleanJobDialog({ job, onClose }: { job: DataJob; onClose: () => void }) {
  const { t } = useI18n()
  const total = Math.max(job.total, 1)
  const progress = Math.min(100, Math.max(0, (job.processed / total) * 100))
  return (
    <div className="data-manage-job-dialog" role="dialog" aria-modal="true" aria-labelledby="data-manage-job-title">
      <div className="data-manage-job-dialog__panel">
        <div className="data-manage-job-dialog__head">
          <div>
            <h3 id="data-manage-job-title">{t('dataManageAutoCleanProgress')}</h3>
            <p>{t('dataManageAutoCleanProgressCount', { processed: job.processed, total: job.total })}</p>
          </div>
          <button type="button" className="data-manage-icon-button" onClick={onClose} title={t('dataManageCloseJobDialog')}>×</button>
        </div>
        <div className="data-manage-job-dialog__bar" aria-hidden="true">
          <i style={{ width: `${progress}%` }} />
        </div>
        <div className="data-manage-job-dialog__meta">
          <span className={`data-badge data-badge--${job.phase}`}>{t(JOB_PHASE_LABELS[job.phase])}</span>
          <span>{job.message || t('dataManageAutoCleanProgressWaiting')}</span>
        </div>
        {job.error && <p className="data-manage-job-dialog__error">{job.error}</p>}
      </div>
    </div>
  )
}

function KeyValue({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={cn('data-manage-kv', wide && 'data-manage-kv--wide')}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function GateList({ gates, onOpenGate }: { gates: Record<string, DataGate>; onOpenGate: (gateKey: string) => void }) {
  const sortedGates = sortDataGateKeys(Object.keys(gates)).map((key) => gates[key]).filter(Boolean)
  return (
    <div className="data-manage-gates">
      {sortedGates.map((gate) => (
        <GateButton key={gate.key} gate={gate} onOpenGate={onOpenGate} />
      ))}
    </div>
  )
}

function GateButton({ gate, onOpenGate }: { gate: DataGate; onOpenGate: (gateKey: string) => void }) {
  const { t } = useI18n()
  const message = gateMessage(gate, t)
  return (
    <button type="button" className="data-manage-gate" onClick={() => onOpenGate(gate.key)}>
      <span className={cn('data-manage-gate__dot', `is-${gate.status}`)} />
      <div>
        <strong>{gateLabel(gate.key, t)}</strong>
        {message && <p>{message}</p>}
      </div>
      <span>{t(dataGateStatusLabelKey(gate.status))}</span>
    </button>
  )
}

function Pager({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  leading,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
  leading?: ReactNode
}) {
  const { t } = useI18n()
  const count = pageCount(total, pageSize)
  return (
    <div className="data-manage-column__pager">
      <div className="data-manage-column__pager-left">{leading}</div>
      <div className="data-manage-column__pager-right">
        <label className="data-manage-page-size">
          <span>{t('dataManagePageSize')}</span>
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
            {PAGE_SIZE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <div className="data-manage-page-picker">
          <button type="button" onClick={() => onPageChange(page - 1)} disabled={page === 1}>{t('dataManagePrevPage')}</button>
          <span>{page} / {count}</span>
          <button type="button" onClick={() => onPageChange(page + 1)} disabled={page === count}>{t('dataManageNextPage')}</button>
        </div>
      </div>
    </div>
  )
}

function matchesDatasetFilters(
  dataset: Dataset,
  dateFilter: DateFilterValue,
  taskFilter: string[],
  autoCleanFilter: QualityStatusFilter,
  manualReviewFilter: QualityStatusFilter,
): boolean {
  const quality = buildDatasetQualityView(dataset)
  return (
    isDateInFilter(quality.createdDate, dateFilter)
    && matchesTaskFilter(quality.taskDescription, taskFilter)
    && matchesQualityFilter(datasetAutoCleanDisplayStatus(dataset, quality), autoCleanFilter)
    && matchesQualityFilter(datasetManualReviewDisplayStatus(dataset, quality), manualReviewFilter)
  )
}

function matchesPackageFilters(
  packageItem: DatasetPackage,
  datasetsById: Map<string, Dataset>,
  dateFilter: DateFilterValue,
  taskFilter: string[],
): boolean {
  const packageDate = packageItem.updated_at ? packageItem.updated_at.slice(0, 10) : ''
  if (!isDateInFilter(packageDate, dateFilter)) return false
  if (!taskFilter.length) return true
  const sourceTasks = packageItem.dataset_ids
    .map((datasetId) => datasetsById.get(datasetId))
    .filter(isDataset)
    .map(datasetTaskDescription)
  return sourceTasks.some((task) => matchesTaskFilter(task, taskFilter))
}

function matchesTaskFilter(task: string, taskFilter: string[]): boolean {
  if (!taskFilter.length) return true
  return taskFilter.includes(task)
}

function matchesQualityFilter(status: ManageQualityStatus, filter: QualityStatusFilter): boolean {
  return filter === 'all' || status === filter
}

function datasetSectionStatusSummary(datasets: Dataset[]): DatasetSectionStatusSummary {
  const summary: DatasetSectionStatusSummary = {
    autoClean: emptyStatusCounts(),
    manualReview: emptyStatusCounts(),
  }
  for (const dataset of datasets) {
    const quality = buildDatasetQualityView(dataset)
    summary.autoClean[datasetAutoCleanDisplayStatus(dataset, quality)] += 1
    summary.manualReview[datasetManualReviewDisplayStatus(dataset, quality)] += 1
  }
  return summary
}

function emptyStatusCounts(): LaneStatusCounts {
  return { pending: 0, running: 0, passed: 0, failed: 0 }
}

function taskOptionsFromDatasets(datasets: Dataset[]): TaskFilterOption[] {
  const counts = new Map<string, number>()
  for (const dataset of datasets) {
    const task = datasetTaskDescription(dataset)
    if (!task) continue
    counts.set(task, (counts.get(task) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => left.value.localeCompare(right.value))
}

function isDataset(value: Dataset | undefined): value is Dataset {
  return Boolean(value)
}

function isPackableDataset(dataset: Dataset): boolean {
  const quality = buildDatasetQualityView(dataset)
  return quality.autoCleanStatus === 'passed' && quality.manualReviewStatus === 'passed'
}

function isReviewBatchReady(dataset: Dataset): boolean {
  return qcReviewStatus(dataset) === 'ready_for_batch'
    && datasetAutoCleanDisplayStatus(dataset) === 'passed'
    && datasetManualReviewDisplayStatus(dataset) === 'passed'
}

function isAutoCleanPassedDataset(dataset: Dataset): boolean {
  return datasetAutoCleanDisplayStatus(dataset) === 'passed'
}

function datasetAutoCleanDisplayStatus(
  dataset: Dataset,
  quality = buildDatasetQualityView(dataset),
): ManageQualityStatus {
  return displayQualityStatus(quality.autoCleanStatus, 'auto_clean')
}

function datasetManualReviewDisplayStatus(
  dataset: Dataset,
  quality = buildDatasetQualityView(dataset),
): ManageQualityStatus {
  const reviewStatus = qcReviewStatus(dataset)
  if (reviewStatus === 'applied') return 'passed'
  if (reviewStatus === 'ready_for_batch') return reviewDecisionDisplayStatus(dataset)
  return displayQualityStatus(quality.manualReviewStatus, 'manual_review')
}

function reviewDecisionDisplayStatus(dataset: Dataset): ManageQualityStatus {
  const decisions = reviewEpisodeDecisions(dataset)
  if (decisions.some((decision) => decision.decision === 'failed')) return 'failed'
  if (dataset.stats.total_episodes > 0 && decisions.length >= dataset.stats.total_episodes) return 'passed'
  return 'pending'
}

function reviewEpisodeDecisions(dataset: Dataset): Array<Record<string, unknown>> {
  const review = asRecord(asRecord(dataset.qc).review)
  const episodes = asRecord(review.episodes)
  return Object.values(episodes)
    .map(asRecord)
    .filter((decision) => stringValue(decision.decision) === 'passed' || stringValue(decision.decision) === 'failed')
}

function manualReviewBatchDisabledReason(
  datasets: Dataset[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (!datasets.length) return t('dataManageBatchDisabledNoDataset')
  const blockedCount = datasets.filter((dataset) => datasetAutoCleanDisplayStatus(dataset) !== 'passed').length
  if (blockedCount) return t('dataManageManualReviewDisabledAutoCleanNotPassed', { count: blockedCount })
  return ''
}

function applyReviewBatchDisabledReason(
  datasets: Dataset[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (!datasets.length) return t('dataManageBatchDisabledNoDataset')
  const autoCleanBlockedCount = datasets.filter((dataset) => datasetAutoCleanDisplayStatus(dataset) !== 'passed').length
  if (autoCleanBlockedCount) {
    return t('dataManageReviewBatchDisabledAutoCleanNotPassed', { count: autoCleanBlockedCount })
  }
  const manualReviewBlockedCount = datasets.filter((dataset) => datasetManualReviewDisplayStatus(dataset) !== 'passed').length
  if (manualReviewBlockedCount) {
    return t('dataManageReviewBatchDisabledManualReviewNotPassed', { count: manualReviewBlockedCount })
  }
  const notReadyCount = datasets.filter((dataset) => qcReviewStatus(dataset) !== 'ready_for_batch').length
  if (notReadyCount) {
    return t('dataManageReviewBatchDisabledNotReady', { count: notReadyCount })
  }
  return ''
}

function currentReviewerId(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.id || user?.phone || user?.nickname || ''
}

function displayQualityStatus(status: QualityStatus, lane: QualityLane): ManageQualityStatus {
  if (lane === 'manual_review' && status === 'running') return 'pending'
  if (status === 'passed' || status === 'running' || status === 'failed' || status === 'pending') return status
  if (status === 'needs_review') return lane === 'auto_clean' ? 'failed' : 'pending'
  return 'pending'
}

function manageQualityStatusLabel(status: ManageQualityStatus, t: (key: TranslationKey) => string): string {
  return t(qualityStatusLabelKey(status))
}

function qualityStepStatusClass(status: string): QualityStepStatusClass {
  const normalized = normalizedQualityStepStatus(status)
  if (normalized === 'skipped') return 'skipped'
  if (normalized === 'needs_review') return 'failed'
  return normalized
}

function qualityStepStatusLabel(status: string, t: (key: TranslationKey) => string): string {
  if (normalizedQualityStepStatus(status) === 'skipped') return t('dataGateStatusSkipped')
  return t(qualityStatusLabelKey(normalizedQualityStepStatus(status)))
}

function qualityStepLabel(stepId: string, t: (key: TranslationKey) => string): string {
  const labelKey = QUALITY_STEP_LABELS[stepId]
  return labelKey ? t(labelKey) : stepId
}

function qualityDisplayMessage(message: string): string {
  return message.trim() === 'Dataset is already clean' ? '' : message
}

function normalizedQualityStepStatus(status: string): QualityStatus {
  if (status === 'completed') return 'passed'
  if (status === 'queued') return 'running'
  if (status === 'rejected') return 'failed'
  if (status === 'pending' || status === 'running' || status === 'passed' || status === 'failed') return status
  if (status === 'needs_review' || status === 'skipped') return status
  return 'pending'
}

function autoCleanStepFallbacks(status: QualityStatus, message: string): QualityRunStepView[] {
  const displayStatus = displayQualityStatus(status, 'auto_clean')
  const failedStepId = displayStatus === 'failed' ? autoCleanFailureStepId(message) : ''
  const alreadyClean = displayStatus === 'passed' && message.toLowerCase().includes('already clean')
  return ['empty_dataset_check', 'damage_diagnosis', 'repair_if_possible', 'repair_verify'].map((stepId) => ({
    id: stepId,
    status: autoCleanFallbackStepStatus(stepId, displayStatus, failedStepId, alreadyClean),
    message: autoCleanFallbackStepMessage(stepId, failedStepId, alreadyClean, message),
    details: {},
  }))
}

function autoCleanOrderedSteps(runSteps: QualityRunStepView[], fallbackSteps: QualityRunStepView[]): QualityRunStepView[] {
  const runStepsById = new Map(runSteps.map((step) => [step.id, step]))
  const fallbackStepsById = new Map(fallbackSteps.map((step) => [step.id, step]))
  return ['empty_dataset_check', 'damage_diagnosis', 'repair_if_possible', 'repair_verify'].map((stepId) => (
    runStepsById.get(stepId)
    ?? fallbackStepsById.get(stepId)
    ?? { id: stepId, status: 'pending', message: '', details: {} }
  ))
}

function autoCleanFallbackStepStatus(
  stepId: string,
  status: ManageQualityStatus,
  failedStepId: string,
  alreadyClean: boolean,
): string {
  if (status === 'pending') return 'pending'
  if (status === 'running') return stepId === 'empty_dataset_check' ? 'running' : 'pending'
  if (status === 'failed') {
    if (stepId === failedStepId) return 'failed'
    return autoCleanStepIndex(stepId) < autoCleanStepIndex(failedStepId) ? 'passed' : 'pending'
  }
  if (alreadyClean && (stepId === 'repair_if_possible' || stepId === 'repair_verify')) return 'skipped'
  return 'passed'
}

function autoCleanFallbackStepMessage(stepId: string, failedStepId: string, alreadyClean: boolean, message: string): string {
  if (stepId === failedStepId) return message
  if (alreadyClean && stepId === 'repair_if_possible') return message
  return ''
}

function autoCleanFailureStepId(message: string): string {
  const stepIds = ['empty_dataset_check', 'damage_diagnosis', 'repair_if_possible', 'repair_verify']
  return stepIds.find((stepId) => message.includes(stepId)) || 'repair_if_possible'
}

function autoCleanStepIndex(stepId: string): number {
  return ['empty_dataset_check', 'damage_diagnosis', 'repair_if_possible', 'repair_verify'].indexOf(stepId)
}

function qualityLanePayload(dataset: Dataset, lane: QualityLane): Record<string, unknown> {
  const qc = asRecord(dataset.qc)
  const lanes = asRecord(qc.lanes)
  return asRecord(lanes[lane])
}

function qualityLaneLastRunId(dataset: Dataset, lane: QualityLane): string {
  return stringValue(qualityLanePayload(dataset, lane).last_run_id)
}

function compactRecord(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, entry]) => `${key}: ${stringValue(entry) || JSON.stringify(entry)}`)
    .join(', ')
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function readSectionOpenState(): SectionOpenState {
  const fallback: SectionOpenState = { raw: true, clean: false, packages: false }
  if (typeof window === 'undefined') return fallback
  const stored = window.localStorage.getItem(MANAGE_SECTION_STORAGE_KEY)
  if (!stored) return fallback
  const parsed = JSON.parse(stored) as Partial<SectionOpenState>
  return {
    raw: parsed.raw ?? fallback.raw,
    clean: parsed.clean ?? fallback.clean,
    packages: parsed.packages ?? fallback.packages,
  }
}

function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const current = clampPage(page, pageCount(items.length, pageSize))
  return items.slice((current - 1) * pageSize, current * pageSize)
}

function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

function clampPage(page: number, count: number): number {
  return Math.min(Math.max(1, page), count)
}

function packageGateRoute(packageId: string, gateKey: string): string {
  const id = encodeURIComponent(packageId)
  const gate = encodeURIComponent(gateKey)
  if (gateKey === 'validate') return `/data/analysis?package=${id}&gate=${gate}`
  if (gateKey === 'annotate') return `/data/annotation?package=${id}&gate=${gate}`
  return `/data/manage?package=${id}&gate=${gate}`
}

function gateLabel(gateKey: string, t: (key: TranslationKey) => string): string {
  const labelKey = dataGateLabelKey(gateKey)
  return labelKey ? t(labelKey) : gateKey
}

function gateMessage(gate: DataGate, t: (key: TranslationKey) => string): string {
  const message = gate.message.trim()
  const statusText = t(dataGateStatusLabelKey(gate.status))
  if (!message) return ''
  const messageKey = dataGateMessageLabelKey(message)
  const displayMessage = messageKey ? t(messageKey) : message
  return displayMessage === statusText ? '' : displayMessage
}
