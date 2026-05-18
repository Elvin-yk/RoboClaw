import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { DataDateRangeFilter, isDateInFilter, type DateFilterValue } from '@/domains/data/components/DataDateRangeFilter'
import { readEpisodeVideos, type EpisodeVideo } from '@/domains/data/lib/episodeMedia'
import { readReviewQueueReturn, writeReviewQueueReturn } from '@/domains/data/lib/reviewQueueReturn'
import {
  dataGateLabelKey,
  dataGateMessageLabelKey,
  dataGateStatusLabelKey,
  sortDataGateKeys,
} from '@/domains/data/model/gates'
import {
  autoCleanStatusLabelKey,
  buildDatasetQualityView,
  datasetTaskDescription,
  manualReviewStatusLabelKey,
  qcLanePayload,
  type AutoCleanStatus,
  type ManualReviewStatus,
} from '@/domains/data/model/datasetQuality'
import { isMarketApplicationSubmitted } from '@/domains/data/model/marketListing'
import {
  DATA_AUTO_CLEAN_STATUSES,
  DATA_REVIEW_STATUSES,
  isTerminalDataJobPhase,
  type DataGate,
  type DataJob,
  type DataQcRun,
  type Dataset,
  type DatasetPackage,
  type GateStatus,
} from '@/domains/data/model/types'
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
type QualityStatus = AutoCleanStatus | ManualReviewStatus
type QualityStepStatusClass = GateStatus
type QualityRunStepView = DataQcRun['steps'][number]

type SectionOpenState = Record<ManageSectionKey, boolean>
type AutoCleanStatusFilter = AutoCleanStatus | 'all'
type ManualReviewStatusFilter = ManualReviewStatus | 'all'
type LaneStatusCounts<T extends string> = Record<T, number>

interface DatasetSectionStatusSummary {
  autoClean: LaneStatusCounts<AutoCleanStatus>
  manualReview: LaneStatusCounts<ManualReviewStatus>
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
  data_integrity_check: 'dataManageQualityStepDataIntegrityCheck',
  damage_diagnosis: 'dataManageQualityStepDamageDiagnosis',
  repair_if_possible: 'dataManageQualityStepRepair',
  repair_verify: 'dataManageQualityStepVerify',
  leading_static_trim: 'dataManageQualityStepLeadingStaticTrim',
  manual_review_decision: 'dataManageQualityStepManualReview',
}
const QUALITY_STEP_MESSAGE_LABELS: Record<string, TranslationKey> = {
  healthy: 'dataManageQualityMessageHealthy',
  empty_shell: 'dataManageQualityMessageEmptyShell',
  structure_incomplete: 'dataManageQualityMessageStructureIncomplete',
  none: 'dataManageQualityMessageNoDamage',
  orphan_data_episodes: 'dataManageQualityMessageOrphanDataEpisodes',
  stale_info_totals: 'dataManageQualityMessageStaleInfoTotals',
  missing_metadata: 'dataManageQualityMessageMissingMetadata',
  missing_data_rows: 'dataManageQualityMessageMissingDataRows',
  missing_video_files: 'dataManageQualityMessageMissingVideoFiles',
  recoverable_tmp_videos: 'dataManageQualityMessageRecoverableTmpVideos',
  tmp_video_residue: 'dataManageQualityMessageTmpVideoResidue',
  unknown_damage: 'dataManageQualityMessageUnknownDamage',
  formalize_data_episodes: 'dataManageQualityMessageFormalizeDataEpisodes',
  'Repair output verified': 'dataManageQualityMessageRepairVerified',
}
const AUTO_CLEAN_STATUSES = DATA_AUTO_CLEAN_STATUSES
const MANUAL_REVIEW_STATUSES = DATA_REVIEW_STATUSES
const AUTO_CLEAN_STEP_IDS: readonly string[] = [
  'data_integrity_check',
  'damage_diagnosis',
  'repair_if_possible',
  'repair_verify',
  'leading_static_trim',
]

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
  const { jobs, attach, cancel } = useDataJobStore()
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
  const [rawAutoCleanFilter, setRawAutoCleanFilter] = useState<AutoCleanStatusFilter>('all')
  const [rawManualReviewFilter, setRawManualReviewFilter] = useState<ManualReviewStatusFilter>('all')
  const [uploadRepoId, setUploadRepoId] = useState('')
  const [uploadToken, setUploadToken] = useState('')
  const [uploadPrivate, setUploadPrivate] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState(560)
  const [reloadedJobSignatures, setReloadedJobSignatures] = useState<string[]>([])
  const [autoCleanDialogJobId, setAutoCleanDialogJobId] = useState<string | null>(null)
  const [storedReturnQcQuery, setStoredReturnQcQuery] = useState(() => readReviewQueueReturn())
  const [applyingMarketPackageId, setApplyingMarketPackageId] = useState('')
  const loadedDrawerDatasetFromQuery = useRef('')
  const returnQcQueryFromUrl = searchParams.get('returnQc') || ''
  const drawerDatasetFromQuery = returnQcQueryFromUrl ? '' : searchParams.get('dataset') || ''

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let mounted = true
    void dataApi.jobs({ kind: 'auto_clean' }).then((activeJobs) => {
      if (!mounted) return
      for (const job of activeJobs) {
        if (!isTerminalDataJobPhase(job.phase)) {
          attach(job)
        }
      }
    })
    return () => {
      mounted = false
    }
  }, [attach])

  const rawDatasetPool = useMemo(
    () => datasets,
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
      matchesPackableDatasetFilters(dataset, cleanDateFilter, cleanTaskFilter)
    )),
    [cleanDatasetPool, cleanDateFilter, cleanTaskFilter],
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
    () => rawDatasets.filter((dataset) => selectedDatasetIdSet.has(dataset.id)),
    [rawDatasets, selectedDatasetIdSet],
  )
  const selectedRawActionDatasets = useMemo(
    () => selectedRawDatasets.filter((dataset) => !isPackableDataset(dataset)),
    [selectedRawDatasets],
  )
  const selectedRawBatchIds = selectedRawActionDatasets.map((dataset) => dataset.id)
  const selectedManualReviewDatasets = selectedRawActionDatasets
  const manualReviewBlockedCount = useMemo(
    () => selectedRawActionDatasets.filter((dataset) => !isManualReviewStartReady(dataset)).length,
    [selectedRawActionDatasets],
  )
  const canStartManualReviewBatch = selectedRawActionDatasets.length > 0 && manualReviewBlockedCount === 0
  const allFilteredRawSelected = rawFilteredIds.length > 0 && rawFilteredIds.every((id) => selectedDatasetIdSet.has(id))
  const selectedReviewDatasets = useMemo(
    () => selectedDatasetIds.map((id) => datasetsById.get(id)).filter(isDataset),
    [datasetsById, selectedDatasetIds],
  )
  const selectedReviewBatchIds = selectedReviewDatasets.map((dataset) => dataset.id)
  const reviewBatchBlockedCount = useMemo(
    () => selectedReviewDatasets.filter((dataset) => !isReviewBatchReady(dataset)).length,
    [selectedReviewDatasets],
  )
  const canApplyReviewBatch = selectedReviewDatasets.length > 0 && reviewBatchBlockedCount === 0
  const manualReviewDisabledReason = manualReviewBatchDisabledReason(selectedRawActionDatasets.length, manualReviewBlockedCount, t)
  const reviewBatchDisabledReason = applyReviewBatchDisabledReason(selectedReviewDatasets.length, reviewBatchBlockedCount, t)
  const cleanFilteredIds = useMemo(() => cleanDatasets.map((dataset) => dataset.id), [cleanDatasets])
  const selectedCleanDatasets = useMemo(
    () => cleanDatasets.filter((dataset) => selectedDatasetIdSet.has(dataset.id)),
    [cleanDatasets, selectedDatasetIdSet],
  )
  const selectedCleanIds = selectedCleanDatasets.map((dataset) => dataset.id)
  const canCreatePackage = selectedCleanIds.length > 0
  const allFilteredCleanSelected = cleanFilteredIds.length > 0 && cleanFilteredIds.every((id) => selectedDatasetIdSet.has(id))
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
  const activeAutoCleanJobs = Object.values(jobs)
    .filter((job) => job.kind === 'auto_clean' && !isTerminalDataJobPhase(job.phase))
    .sort((left, right) => left.started_at.localeCompare(right.started_at))
  const primaryAutoCleanJob = activeAutoCleanJobs[activeAutoCleanJobs.length - 1] ?? null
  const hasActiveAutoCleanJob = Boolean(primaryAutoCleanJob)
  const canStartAutoCleanBatch = selectedRawBatchIds.length > 0 && !hasActiveAutoCleanJob
  const autoCleanDisabledReason = hasActiveAutoCleanJob
    ? t('dataManageAutoCleanDisabledRunning')
    : selectedRawBatchIds.length
      ? ''
      : t('dataManageBatchDisabledNoDataset')
  const terminalJobSignatures = Object.values(jobs)
    .filter((job) => job.kind === 'auto_clean' && isTerminalDataJobPhase(job.phase))
    .map((job) => `${job.job_id}:${job.phase}:${job.updated_at}`)
    .sort()
  const terminalJobSignature = terminalJobSignatures[terminalJobSignatures.length - 1] ?? ''
  const returnQcQuery = returnQcQueryFromUrl || storedReturnQcQuery

  useEffect(() => {
    setRawPage((current) => clampPage(current, pageCount(rawDatasets.length, pageSize)))
    setCleanPage((current) => clampPage(current, pageCount(cleanDatasets.length, pageSize)))
    setPackagePage((current) => clampPage(current, pageCount(visiblePackages.length, pageSize)))
  }, [cleanDatasets.length, pageSize, rawDatasets.length, visiblePackages.length])

  useEffect(() => {
    window.localStorage.setItem(MANAGE_SECTION_STORAGE_KEY, JSON.stringify(sectionOpen))
  }, [sectionOpen])

  useEffect(() => {
    if (!returnQcQueryFromUrl) return
    writeReviewQueueReturn(returnQcQueryFromUrl)
    setStoredReturnQcQuery(returnQcQueryFromUrl)
  }, [returnQcQueryFromUrl])

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
    if (!canCreatePackage) return
    const nextPackageId = mergedPackageId(selectedCleanDatasets)
    await dataApi.createPackage({
      package_id: nextPackageId,
      dataset_ids: selectedCleanIds,
      groups: { default: selectedCleanIds },
      force: false,
    })
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

  async function applyPackageToMarket(packageItem: DatasetPackage) {
    if (isMarketApplicationSubmitted(packageItem)) return
    setApplyingMarketPackageId(packageItem.id)
    try {
      await dataApi.applyPackageMarketListing(packageItem.id)
      await load()
    } finally {
      setApplyingMarketPackageId('')
    }
  }

  async function startSelectedAutoClean() {
    if (!canStartAutoCleanBatch) return
    const job = await dataApi.startAutoCleanRun({ dataset_ids: selectedRawBatchIds, chain_id: 'default', force: true })
    attach(job)
    setAutoCleanDialogJobId(job.job_id)
    await load()
  }

  async function cancelAutoClean(jobId: string) {
    await cancel(jobId)
    if (autoCleanDialogJobId === jobId) {
      setAutoCleanDialogJobId(null)
    }
    await load()
  }

  function openSelectedReviewQueue() {
    if (!canStartManualReviewBatch || !selectedManualReviewDatasets.length) return
    const params = new URLSearchParams()
    params.set('dataset', selectedManualReviewDatasets[0].id)
    params.set('returnTo', 'data-manage')
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

  function toggleCleanFilteredSelection() {
    setDatasetSelection(cleanFilteredIds, !allFilteredCleanSelected)
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
    navigate(`/data/qc?dataset=${encodedDataset}&datasets=${encodedDataset}&returnTo=data-manage`)
  }

  function returnToReviewQueue() {
    if (!returnQcQuery) return
    navigate(`/data/qc?${returnQcQuery}`)
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
      {returnQcQuery && (
        <div className="data-manage-return-banner">
          <div>
            <strong>{t('dataManageReturnedFromQc')}</strong>
            <span>{t('dataManageReturnToQcHint')}</span>
          </div>
          <button type="button" className="data-manage-neutral-button" onClick={returnToReviewQueue}>
            {t('dataManageReturnToQc')}
          </button>
        </div>
      )}

      <main className="data-manage-grid">
        <DataManageDashboard
          title={t('dataManageRawColumn')}
          count={rawDatasetPool.length}
          summary={rawStatusSummary}
        />

        {primaryAutoCleanJob && (
          <AutoCleanBackgroundJobPanel
            job={primaryAutoCleanJob}
            onCancel={() => void cancelAutoClean(primaryAutoCleanJob.job_id)}
          />
        )}

        <ManageSection
          sectionKey="raw"
          title={t('dataManageRawColumn')}
          count={rawDatasetPool.length}
          showCount={false}
          open={sectionOpen.raw}
          onToggle={toggleSection}
          actions={(
            <div className="data-manage-section__action-group">
              <ActionButtonWithReason
                className={cn('data-manage-batch-clean-button', canStartAutoCleanBatch && 'is-armed')}
                disabled={!canStartAutoCleanBatch}
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
              <StatusFilterGroup>
                <FilterField label={t('dataManageAutoCleanStatus')}>
                  <QualityStatusFacetFilter
                    label={t('dataManageAutoCleanStatus')}
                    statuses={AUTO_CLEAN_STATUSES}
                    labelFor={autoCleanStatusLabel}
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
                    labelFor={manualReviewStatusLabel}
                    value={rawManualReviewFilter}
                    onChange={(value) => {
                      setRawManualReviewFilter(value)
                      setRawPage(1)
                    }}
                  />
                </FilterField>
              </StatusFilterGroup>
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
          open={sectionOpen.clean}
          onToggle={toggleSection}
          actions={(
            <ActionButtonWithReason
              className={cn('data-manage-create-package-button', canCreatePackage && 'is-armed')}
              disabled={!canCreatePackage}
              disabledReason={t('dataManageCreatePackageDisabled')}
              onClick={() => void createPackage()}
            >
              {t('dataManageCreatePackage')}
            </ActionButtonWithReason>
          )}
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
            </SectionFilters>
          )}
          pager={(
            <Pager
              page={cleanPage}
              pageSize={pageSize}
              total={cleanDatasets.length}
              onPageChange={setCleanPage}
              onPageSizeChange={changePageSize}
              leading={(
                <div className="data-manage-pager-actions">
                  <span>{t('dataManageSelectedFilterStatus', { selected: selectedCleanIds.length, total: cleanDatasets.length })}</span>
                  <button
                    type="button"
                    className="data-manage-ghost-button"
                    onClick={toggleCleanFilteredSelection}
                    disabled={cleanFilteredIds.length === 0}
                  >
                    {allFilteredCleanSelected ? t('dataManageClearFilteredSelection') : t('dataManageSelectAllFiltered')}
                  </button>
                </div>
              )}
            />
          )}
        >
          {cleanPageItems.map((dataset) => (
            <DatasetRow
              key={dataset.id}
              dataset={dataset}
              variant="packable"
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
            marketApplicationBusy={applyingMarketPackageId === drawerPackage.id}
            marketApplicationPending={isMarketApplicationSubmitted(drawerPackage)}
            onApplyMarket={() => void applyPackageToMarket(drawerPackage)}
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
        <DataManageDashboardLane
          title={t('dataManageAutoCleanStatus')}
          counts={summary.autoClean}
          statuses={AUTO_CLEAN_STATUSES}
          labelFor={(status) => autoCleanStatusLabel(status, t)}
        />
        <DataManageDashboardLane
          title={t('dataManageManualReviewStatus')}
          counts={summary.manualReview}
          statuses={MANUAL_REVIEW_STATUSES}
          labelFor={(status) => manualReviewStatusLabel(status, t)}
        />
      </div>
    </section>
  )
}

function DataManageDashboardLane<T extends QualityStatus>({
  title,
  counts,
  statuses,
  labelFor,
}: {
  title: string
  counts: LaneStatusCounts<T>
  statuses: readonly T[]
  labelFor: (status: T) => string
}) {
  return (
    <div className="data-manage-dashboard-lane">
      <span>{title}</span>
      <StatusCountPills counts={counts} statuses={statuses} labelFor={labelFor} />
    </div>
  )
}

function ManageSection({
  sectionKey,
  title,
  count,
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

function StatusCountPills<T extends QualityStatus>({
  counts,
  statuses,
  labelFor,
}: {
  counts: LaneStatusCounts<T>
  statuses: readonly T[]
  labelFor: (status: T) => string
}) {
  return (
    <div className="data-manage-status-count-pills">
      {statuses.map((status) => (
        <em key={status} className={cn('data-manage-status-count', `is-${status}`)}>
          <i aria-hidden="true" />
          <span>{labelFor(status)}</span>
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

function StatusFilterGroup({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [singleRow, setSingleRow] = useState(false)

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const measure = () => {
      const fields = Array.from(node.querySelectorAll<HTMLElement>(':scope > .data-manage-filter-field'))
      if (fields.length < 2) {
        setSingleRow(false)
        return
      }
      const top = fields[0].offsetTop
      setSingleRow(fields.every((field) => field.offsetTop === top))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={ref} className={cn('data-manage-status-filter-group', singleRow && 'is-single-row')}>
      {children}
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

function QualityStatusFacetFilter<T extends QualityStatus>({
  label,
  statuses,
  labelFor,
  value,
  onChange,
}: {
  label: string
  statuses: readonly T[]
  labelFor: (status: T, t: (key: TranslationKey) => string) => string
  value: T | 'all'
  onChange: (value: T | 'all') => void
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
          {labelFor(status, t)}
        </button>
      ))}
    </div>
  )
}

function DatasetRow({
  dataset,
  variant = 'raw',
  active,
  selected,
  selectable,
  onSelect,
  onToggle,
}: {
  dataset: Dataset
  variant?: 'raw' | 'packable'
  active: boolean
  selected: boolean
  selectable: boolean
  onSelect: () => void
  onToggle?: () => void
}) {
  const { t } = useI18n()
  const quality = buildDatasetQualityView(dataset)
  const autoCleanStatus = quality.autoCleanStatus
  const manualReviewStatus = quality.manualReviewStatus
  const cameraFeatures = datasetCameraFeatures(dataset)
  const taskDescription = datasetTaskDescription(dataset)
  return (
    <article className={cn('data-manage-card data-manage-dataset-row', variant === 'packable' && 'data-manage-dataset-row--packable', active && 'is-active')}>
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
          {variant === 'packable' && (
            <span className="data-manage-packable-episodes">{t('dataManageEpisodesShort', { count: dataset.stats.total_episodes })}</span>
          )}
        </div>
        {variant === 'packable' && (
          <>
            <div className="data-manage-packable-summary">
              <span className="data-manage-packable-summary__task" title={taskDescription || undefined}>
                {taskDescription || t('dataManageNoTaskDescription')}
              </span>
            </div>
            <DatasetCameraPreviewStrip dataset={dataset} cameraFeatures={cameraFeatures} />
          </>
        )}
      </button>
      {variant !== 'packable' && (
        <div className="data-manage-card__quality">
          <div className="data-manage-quality-pill">
            <span>{t('dataManageAutoCleanStatus')}</span>
            <strong className={cn(`is-${autoCleanStatus}`)}>{autoCleanStatusLabel(autoCleanStatus, t)}</strong>
          </div>
          <div className="data-manage-quality-pill">
            <span>{t('dataManageManualReviewStatus')}</span>
            <strong className={cn(`is-${manualReviewStatus}`)}>{manualReviewStatusLabel(manualReviewStatus, t)}</strong>
          </div>
        </div>
      )}
    </article>
  )
}

function DatasetCameraPreviewStrip({ dataset, cameraFeatures }: { dataset: Dataset; cameraFeatures: string[] }) {
  const { t } = useI18n()
  const [videos, setVideos] = useState<EpisodeVideo[]>([])
  useEffect(() => {
    let cancelled = false
    setVideos([])
    if (!cameraFeatures.length || dataset.stats.total_episodes <= 0) return undefined
    void (async () => {
      const episode = await dataApi.inspectEpisode({
        source: 'local',
        dataset: dataset.id,
        episode_index: 0,
        preview: true,
      })
      if (!cancelled) {
        setVideos(readEpisodeVideos(episode).slice(0, 3))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [cameraFeatures.length, dataset.id, dataset.stats.total_episodes])

  if (videos.length) {
    return (
      <div className="data-manage-camera-preview-strip" aria-label={t('dataManageCameraStreams')}>
        {videos.map((video) => (
          <span key={video.path} className="data-manage-camera-preview">
            <video src={video.url} muted playsInline preload="metadata" />
            <em>{cameraFeatureLabel(video.stream)}</em>
          </span>
        ))}
        {cameraFeatures.length > videos.length && (
          <span className="data-manage-camera-preview-more">+{cameraFeatures.length - videos.length}</span>
        )}
      </div>
    )
  }

  return (
    <div className="data-manage-camera-strip" aria-label={t('dataManageCameraStreams')}>
      {cameraFeatures.length ? cameraFeatures.slice(0, 3).map((feature) => (
        <span key={feature} className="data-manage-camera-chip">{cameraFeatureLabel(feature)}</span>
      )) : (
        <span className="data-manage-camera-chip is-empty">{t('dataManageNoCameraStreams')}</span>
      )}
      {cameraFeatures.length > 3 && (
        <span className="data-manage-camera-chip">+{cameraFeatures.length - 3}</span>
      )}
    </div>
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
  const autoCleanStatus = quality.autoCleanStatus
  const manualReviewStatus = quality.manualReviewStatus
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
          {autoCleanStatusLabel(autoCleanStatus, t)}
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
          {manualReviewStatusLabel(manualReviewStatus, t)}
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
      />
      {run?.failure && (
        <p className="data-manage-quality-detail__note">
          {t('dataManageQualityFailure')}: {qualityFailureSummary(run.failure, t)}
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
              {!hideMessages && qualityDisplayMessage(step.message, t) && <p>{qualityDisplayMessage(step.message, t)}</p>}
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
  marketApplicationBusy,
  marketApplicationPending,
  onApplyMarket,
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
  marketApplicationBusy: boolean
  marketApplicationPending: boolean
  onApplyMarket: () => void
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
      <DrawerSection
        title={t('dataManageMarketListingSection')}
        action={(
          <button
            type="button"
            className="data-manage-drawer-action"
            onClick={onApplyMarket}
            disabled={marketApplicationBusy || marketApplicationPending}
          >
            {marketApplicationBusy
              ? t('dataManageMarketApplying')
              : marketApplicationPending ? t('dataManageMarketApplyPending') : t('dataManageApplyMarket')}
          </button>
        )}
      >
        <p className="data-manage-market-note">{t('dataManageMarketListingHint')}</p>
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

function AutoCleanBackgroundJobPanel({ job, onCancel }: { job: DataJob; onCancel: () => void }) {
  const { t } = useI18n()
  const { progress, width } = jobProgress(job)
  const cancelling = job.phase === 'cancelling'
  return (
    <section className="data-manage-background-job">
      <div className="data-manage-background-job__head">
        <div>
          <span>{t('dataManageAutoCleanBackground')}</span>
          <strong>{t('dataManageAutoCleanProgressCount', { processed: job.processed, total: job.total })}</strong>
        </div>
        <button type="button" className="data-manage-danger" onClick={onCancel} disabled={cancelling}>
          {t(cancelling ? 'dataManageAutoCleanCancelling' : 'dataManageAutoCleanCancel')}
        </button>
      </div>
      <div className="data-manage-job-dialog__bar" aria-label={`${progress}%`}>
        <i style={{ width }} />
      </div>
      <div className="data-manage-job-dialog__meta">
        <span className={`data-badge data-badge--${job.phase}`}>{t(JOB_PHASE_LABELS[job.phase])}</span>
        <span>{job.message || t('dataManageAutoCleanProgressWaiting')}</span>
      </div>
    </section>
  )
}

function AutoCleanJobDialog({ job, onClose }: { job: DataJob; onClose: () => void }) {
  const { t } = useI18n()
  const { width } = jobProgress(job)
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
          <i style={{ width }} />
        </div>
        <div className="data-manage-job-dialog__meta">
          <span className={`data-badge data-badge--${job.phase}`}>{t(JOB_PHASE_LABELS[job.phase])}</span>
          <span>{job.message || t('dataManageAutoCleanProgressWaiting')}</span>
        </div>
        {job.error && <p className="data-manage-job-dialog__error">{job.error}</p>}
        <div className="data-manage-job-dialog__actions">
          <button type="button" className="data-manage-neutral-button" onClick={onClose}>
            {t('dataManageAutoCleanRunInBackground')}
          </button>
        </div>
      </div>
    </div>
  )
}

function jobProgress(job: DataJob): { progress: number; width: string } {
  const total = Math.max(job.total, 1)
  const progress = Math.min(100, Math.max(0, (job.processed / total) * 100))
  return { progress, width: `${progress}%` }
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
  autoCleanFilter: AutoCleanStatusFilter,
  manualReviewFilter: ManualReviewStatusFilter,
): boolean {
  const quality = buildDatasetQualityView(dataset)
  return (
    isDateInFilter(quality.createdDate, dateFilter)
    && matchesTaskFilter(quality.taskDescription, taskFilter)
    && matchesQualityFilter(quality.autoCleanStatus, autoCleanFilter)
    && matchesQualityFilter(quality.manualReviewStatus, manualReviewFilter)
  )
}

function matchesPackableDatasetFilters(
  dataset: Dataset,
  dateFilter: DateFilterValue,
  taskFilter: string[],
): boolean {
  const quality = buildDatasetQualityView(dataset)
  return (
    isDateInFilter(quality.createdDate, dateFilter)
    && matchesTaskFilter(quality.taskDescription, taskFilter)
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

function matchesQualityFilter<T extends QualityStatus>(status: T, filter: T | 'all'): boolean {
  return filter === 'all' || status === filter
}

function datasetSectionStatusSummary(datasets: Dataset[]): DatasetSectionStatusSummary {
  const summary: DatasetSectionStatusSummary = {
    autoClean: emptyAutoCleanStatusCounts(),
    manualReview: emptyManualReviewStatusCounts(),
  }
  for (const dataset of datasets) {
    const quality = buildDatasetQualityView(dataset)
    summary.autoClean[quality.autoCleanStatus] += 1
    summary.manualReview[quality.manualReviewStatus] += 1
  }
  return summary
}

function emptyAutoCleanStatusCounts(): LaneStatusCounts<AutoCleanStatus> {
  return { pending: 0, running: 0, passed: 0, failed: 0 }
}

function emptyManualReviewStatusCounts(): LaneStatusCounts<ManualReviewStatus> {
  return { pending: 0, passed: 0, needs_fix: 0, failed: 0 }
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

function datasetCameraFeatures(dataset: Dataset): string[] {
  return dataset.stats.features.filter((feature) => feature.startsWith('observation.images.'))
}

function cameraFeatureLabel(feature: string): string {
  return feature.replace(/^observation\.images\./, '')
}

function mergedPackageId(datasets: Dataset[]): string {
  const base = sanitizePackageId(datasets[0]?.name || 'dataset')
  return `pkg_${base}_${compactTimestamp(new Date())}`
}

function sanitizePackageId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '') || 'dataset'
}

function compactTimestamp(date: Date): string {
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate()),
    padNumber(date.getHours()),
    padNumber(date.getMinutes()),
    padNumber(date.getSeconds()),
    padNumber(date.getMilliseconds(), 3),
  ].join('')
}

function padNumber(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function isPackableDataset(dataset: Dataset): boolean {
  const quality = buildDatasetQualityView(dataset)
  return isAutoCleanPassedStatus(quality.autoCleanStatus)
    && quality.manualReviewStatus === 'passed'
}

function isReviewBatchReady(dataset: Dataset): boolean {
  const quality = buildDatasetQualityView(dataset)
  return !isPackableDataset(dataset)
    && isAutoCleanPassedStatus(quality.autoCleanStatus)
    && isManualReviewBatchApplicableStatus(quality.manualReviewStatus)
}

function isManualReviewStartReady(dataset: Dataset): boolean {
  return isAutoCleanPassedStatus(buildDatasetQualityView(dataset).autoCleanStatus)
}

function manualReviewBatchDisabledReason(
  datasetCount: number,
  blockedCount: number,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (!datasetCount) return t('dataManageBatchDisabledNoDataset')
  if (blockedCount) {
    return t('dataManageManualReviewDisabledAutoCleanNotPassed', { count: blockedCount })
  }
  return ''
}

function applyReviewBatchDisabledReason(
  datasetCount: number,
  blockedCount: number,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (!datasetCount) return t('dataManageBatchDisabledNoDataset')
  if (blockedCount) {
    return t('dataManageReviewBatchDisabledQualityNotPassed', { count: blockedCount })
  }
  return ''
}

function currentReviewerId(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.id || user?.phone || user?.nickname || ''
}

function isAutoCleanPassedStatus(status: AutoCleanStatus): boolean {
  return status === 'passed'
}

function isManualReviewBatchApplicableStatus(status: ManualReviewStatus): boolean {
  return status === 'passed' || status === 'needs_fix'
}

function autoCleanStatusLabel(status: AutoCleanStatus, t: (key: TranslationKey) => string): string {
  return t(autoCleanStatusLabelKey(status))
}

function manualReviewStatusLabel(status: ManualReviewStatus, t: (key: TranslationKey) => string): string {
  return t(manualReviewStatusLabelKey(status))
}

function qualityStepStatusClass(status: string): QualityStepStatusClass {
  const normalized = normalizedQualityStepStatus(status)
  if (normalized === 'skipped') return 'skipped'
  if (normalized === 'needs_review') return 'failed'
  return normalized
}

function qualityStepStatusLabel(status: string, t: (key: TranslationKey) => string): string {
  return t(dataGateStatusLabelKey(normalizedQualityStepStatus(status)))
}

function qualityStepLabel(stepId: string, t: (key: TranslationKey) => string): string {
  const labelKey = QUALITY_STEP_LABELS[stepId]
  return labelKey ? t(labelKey) : stepId
}

function qualityDisplayMessage(message: string, t: (key: TranslationKey) => string): string {
  const trimmed = message.trim()
  if (!trimmed || trimmed === 'Dataset is already clean' || trimmed === 'passed') return ''
  const labelKey = QUALITY_STEP_MESSAGE_LABELS[trimmed]
  return labelKey ? t(labelKey) : trimmed
}

function normalizedQualityStepStatus(status: string): GateStatus {
  if (status === 'completed') return 'passed'
  if (status === 'queued') return 'running'
  if (status === 'rejected') return 'failed'
  if (status === 'pending' || status === 'running' || status === 'passed' || status === 'failed') return status
  if (status === 'needs_review' || status === 'skipped') return status
  return 'pending'
}

function autoCleanStepFallbacks(status: AutoCleanStatus, message: string): QualityRunStepView[] {
  const failedStepId = status === 'failed' ? autoCleanFailureStepId(message) : ''
  const alreadyClean = status === 'passed' && message.toLowerCase().includes('already clean')
  return AUTO_CLEAN_STEP_IDS.map((stepId) => ({
    id: stepId,
    status: autoCleanFallbackStepStatus(stepId, status, failedStepId, alreadyClean),
    message: autoCleanFallbackStepMessage(stepId, failedStepId, alreadyClean, message),
    details: {},
  }))
}

function autoCleanOrderedSteps(runSteps: QualityRunStepView[], fallbackSteps: QualityRunStepView[]): QualityRunStepView[] {
  if (runSteps.length) {
    return [...runSteps].sort((left, right) => autoCleanSortIndex(left.id) - autoCleanSortIndex(right.id))
  }
  const runStepsById = new Map(runSteps.map((step) => [step.id, step]))
  const fallbackStepsById = new Map(fallbackSteps.map((step) => [step.id, step]))
  return AUTO_CLEAN_STEP_IDS.map((stepId) => (
    runStepsById.get(stepId)
    ?? fallbackStepsById.get(stepId)
    ?? { id: stepId, status: 'pending', message: '', details: {} }
  ))
}

function autoCleanFallbackStepStatus(
  stepId: string,
  status: AutoCleanStatus,
  failedStepId: string,
  alreadyClean: boolean,
): string {
  if (status === 'pending') return 'pending'
  if (status === 'running') return autoCleanStepIndex(stepId) === 0 ? 'running' : 'pending'
  if (status === 'failed') {
    if (stepId === failedStepId) return 'failed'
    return autoCleanStepIndex(stepId) < autoCleanStepIndex(failedStepId) ? 'passed' : 'pending'
  }
  if (alreadyClean && (stepId === 'repair_if_possible' || stepId === 'repair_verify')) return 'skipped'
  return 'passed'
}

function autoCleanFallbackStepMessage(
  stepId: string,
  failedStepId: string,
  alreadyClean: boolean,
  message: string,
): string {
  if (stepId === failedStepId) return message
  if (alreadyClean && stepId === 'repair_if_possible') return message
  return ''
}

function autoCleanFailureStepId(message: string): string {
  return AUTO_CLEAN_STEP_IDS.find((stepId) => message.includes(stepId)) || 'repair_if_possible'
}

function autoCleanStepIndex(stepId: string): number {
  return AUTO_CLEAN_STEP_IDS.indexOf(stepId)
}

function autoCleanSortIndex(stepId: string): number {
  const index = autoCleanStepIndex(stepId)
  return index < 0 ? AUTO_CLEAN_STEP_IDS.length : index
}

function qualityLaneLastRunId(dataset: Dataset, lane: QualityLane): string {
  return stringValue(qcLanePayload(dataset, lane).last_run_id)
}

function qualityFailureSummary(
  failure: Record<string, unknown>,
  t: (key: TranslationKey) => string,
): string {
  const stepId = stringValue(failure.step_id)
  const message = stringValue(failure.message)
  const details = recordValue(failure.details)
  const diagnosis = recordValue(details?.diagnosis) ?? details
  const damageType = (
    stringValue(diagnosis?.damage_kind)
    || stringValue(diagnosis?.integrity_status)
    || damageTypeFromMessage(message)
  )
  const reason = damageTypeLabel(damageType, t) || readableFailureMessage(message)
  const stepLabel = stepId ? qualityStepLabel(stepId, t) : ''
  return [stepLabel, reason].filter(Boolean).join('：') || t('dataManageQualityFailureUnknown')
}

function damageTypeLabel(damageType: string, t: (key: TranslationKey) => string): string {
  if (damageType === 'empty_shell') return t('dataManageQualityFailureEmptyShell')
  if (damageType === 'structure_incomplete') return t('dataManageQualityFailureStructureIncomplete')
  if (damageType === 'healthy') return t('dataManageQualityFailureHealthy')
  if (damageType === 'unknown_damage') return t('dataManageQualityFailureUnknownDamage')
  return ''
}

function damageTypeFromMessage(message: string): string {
  if (message.includes('unknown_damage')) return 'unknown_damage'
  if (message.includes('empty_shell')) return 'empty_shell'
  if (message.includes('structure_incomplete')) return 'structure_incomplete'
  if (message.includes('healthy')) return 'healthy'
  return ''
}

function readableFailureMessage(message: string): string {
  return message
    .replace(/^[a-z_]+ failed:\s*/i, '')
    .replace(/_/g, ' ')
    .trim()
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
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
