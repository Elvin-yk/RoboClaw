import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import {
  dataGateLabelKey,
  dataGateMessageLabelKey,
  dataGateStatusLabelKey,
  sortDataGateKeys,
} from '@/domains/data/model/gates'
import type { DataGate, DataJob, Dataset, DatasetPackage } from '@/domains/data/model/types'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'

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

const DATASET_STAGE_LABELS: Record<Dataset['lifecycle_stage'], TranslationKey> = {
  raw: 'dataStageRaw',
  inspecting: 'dataStageInspecting',
  cleaning: 'dataStageCleaning',
  needs_review: 'dataStageNeedsReview',
  clean: 'dataStageClean',
  excluded: 'dataStageExcluded',
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

export default function DataManagePage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const {
    datasets,
    packages,
    selectedDatasetIds,
    error,
    load,
    toggleDataset,
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
  const [rawPassedGates, setRawPassedGates] = useState<string[]>([])
  const [uploadRepoId, setUploadRepoId] = useState('')
  const [uploadToken, setUploadToken] = useState('')
  const [uploadPrivate, setUploadPrivate] = useState(false)
  const [drawerWidth, setDrawerWidth] = useState(560)

  useEffect(() => {
    void load()
  }, [load])

  const rawDatasetPool = useMemo(
    () => datasets.filter((dataset) => dataset.lifecycle_stage !== 'clean'),
    [datasets],
  )
  const cleanDatasetPool = useMemo(
    () => datasets.filter((dataset) => dataset.lifecycle_stage === 'clean'),
    [datasets],
  )
  const rawGateKeys = gateKeys(rawDatasetPool)
  const rawDatasets = useMemo(
    () => filterByGateExpectation(rawDatasetPool, rawGateKeys, rawPassedGates),
    [rawDatasetPool, rawGateKeys, rawPassedGates],
  )
  const cleanDatasets = cleanDatasetPool
  const visiblePackages = packages
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
  const activeJobs = Object.values(jobs).filter((job) => (
    ['import', 'package_upload'].includes(job.kind)
  ))

  useEffect(() => {
    setRawPage((current) => clampPage(current, pageCount(rawDatasets.length, pageSize)))
    setCleanPage((current) => clampPage(current, pageCount(cleanDatasets.length, pageSize)))
    setPackagePage((current) => clampPage(current, pageCount(visiblePackages.length, pageSize)))
  }, [cleanDatasets.length, pageSize, rawDatasets.length, visiblePackages.length])

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

  function openDatasetGate(dataset: Dataset, gateKey: string) {
    setDrawerTarget(null)
    navigate(datasetGateRoute(dataset.id, gateKey))
  }

  function openDatasetAnalysis(dataset: Dataset) {
    setDrawerTarget(null)
    navigate(`/data/analysis?dataset=${encodeURIComponent(dataset.id)}`)
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
        <WorkshopColumn
          title={t('dataManageRawColumn')}
          count={rawDatasets.length}
          gateFilter={rawGateKeys.length > 0 ? (
            <GateFilter
              gateKeys={rawGateKeys}
              passedGateKeys={rawPassedGates}
              onToggleGate={(value) => {
                setRawPassedGates((current) => toggleGateKey(current, value))
                setRawPage(1)
              }}
            />
          ) : null}
          pager={(
            <Pager
              page={rawPage}
              pageSize={pageSize}
              total={rawDatasets.length}
              onPageChange={setRawPage}
              onPageSizeChange={changePageSize}
            />
          )}
        >
          {rawPageItems.map((dataset) => (
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              active={drawerTarget?.type === 'dataset' && drawerTarget.id === dataset.id}
              selected={false}
              selectable={false}
              onSelect={() => setDrawerTarget({ type: 'dataset', id: dataset.id })}
            />
          ))}
          {!rawDatasets.length && <div className="data-manage-empty">{t('dataManageEmptyRaw')}</div>}
        </WorkshopColumn>

        <WorkshopColumn
          title={t('dataManageCleanColumn')}
          count={cleanDatasets.length}
          gateFilter={null}
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
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              active={drawerTarget?.type === 'dataset' && drawerTarget.id === dataset.id}
              selected={selectedDatasetIds.includes(dataset.id)}
              selectable
              onSelect={() => setDrawerTarget({ type: 'dataset', id: dataset.id })}
              onToggle={() => toggleDataset(dataset.id)}
            />
          ))}
          {!cleanDatasets.length && <div className="data-manage-empty">{t('dataManageEmptyClean')}</div>}
        </WorkshopColumn>

        <WorkshopColumn
          title={t('dataManagePackageColumn')}
          count={visiblePackages.length}
          wide
          gateFilter={null}
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
            <PackageCard
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
        </WorkshopColumn>
      </main>

      {!!activeJobs.length && (
        <section className="data-manage-jobs">
          {activeJobs.map((job) => (
            <div key={job.job_id} className="data-manage-job">
              <strong>{job.kind === 'import' ? t('dataManageJobImport') : job.kind === 'package_upload' ? t('dataManageJobPackageUpload') : job.kind}</strong>
              <span>{job.target_id}</span>
              <span>{job.processed}/{job.total}</span>
              <span className={`data-badge data-badge--${job.phase}`}>{t(JOB_PHASE_LABELS[job.phase])}</span>
            </div>
          ))}
        </section>
      )}

      {drawerDataset && (
        <DrawerLayer onClose={() => setDrawerTarget(null)}>
          <DatasetDrawer
            dataset={drawerDataset}
            selected={selectedDatasetIds.includes(drawerDataset.id)}
            onClose={() => setDrawerTarget(null)}
            onToggle={() => drawerDataset.lifecycle_stage === 'clean' && toggleDataset(drawerDataset.id)}
            onDelete={() => setDeleteTarget({ type: 'dataset', id: drawerDataset.id })}
            onAnalyze={() => openDatasetAnalysis(drawerDataset)}
            onOpenGate={(gateKey) => openDatasetGate(drawerDataset, gateKey)}
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

function WorkshopColumn({
  title,
  count,
  wide = false,
  gateFilter,
  pager,
  children,
}: {
  title: string
  count: number
  wide?: boolean
  gateFilter: ReactNode
  pager: ReactNode
  children: ReactNode
}) {
  return (
    <section className={cn('data-manage-column', wide && 'data-manage-column--wide')}>
      <div className="data-manage-column__header">
        <h2>{title}</h2>
        <span>{count}</span>
      </div>
      {gateFilter}
      <div className="data-manage-column__body">{children}</div>
      {pager}
    </section>
  )
}

function GateFilter({
  gateKeys,
  passedGateKeys,
  onToggleGate,
}: {
  gateKeys: string[]
  passedGateKeys: string[]
  onToggleGate: (value: string) => void
}) {
  const { t } = useI18n()
  const passed = new Set(passedGateKeys)
  return (
    <div className="data-manage-column__filters">
      <div className="data-manage-gate-filter__chips">
        {gateKeys.map((key) => (
          <label key={key} className={cn('data-manage-gate-chip', passed.has(key) && 'is-passed')}>
            <input
              type="checkbox"
              checked={passed.has(key)}
              onChange={() => onToggleGate(key)}
            />
            <span>{gateLabel(key, t)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

function DatasetCard({
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
  const passedGates = Object.values(dataset.gates).filter((gate) => gate.status === 'passed').length
  const gateCount = Object.values(dataset.gates).length
  const gateRatio = gateCount ? (passedGates / gateCount) * 100 : 0
  return (
    <article className={cn('data-manage-card', active && 'is-active')}>
      <button type="button" className="data-manage-card__main" onClick={onSelect}>
        <div className="data-manage-card__topline">
          <span className="data-manage-card__name">{dataset.label}</span>
          <span className={cn('data-manage-stage', `is-${dataset.lifecycle_stage}`)}>
            {t(DATASET_STAGE_LABELS[dataset.lifecycle_stage])}
          </span>
        </div>
        <div className="data-manage-card__gate-summary">
          <span>{t('dataManageGateCount', { passed: passedGates, total: gateCount })}</span>
          <div className="data-manage-card__gate-bar"><i style={{ width: `${gateRatio}%` }} /></div>
        </div>
      </button>
      {selectable && onToggle && (
        <button
          type="button"
          className={cn('data-manage-select', selected && 'is-selected')}
          onClick={onToggle}
          title={selected ? t('dataManageUnselectPackage') : t('dataManageSelectPackage')}
        >
          {selected ? '✓' : '+'}
        </button>
      )}
    </article>
  )
}

function PackageCard({
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
  selected,
  onClose,
  onToggle,
  onDelete,
  onAnalyze,
  onOpenGate,
  onResizeStart,
  style,
}: {
  dataset: Dataset
  selected: boolean
  onClose: () => void
  onToggle: () => void
  onDelete: () => void
  onAnalyze: () => void
  onOpenGate: (gateKey: string) => void
  onResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
  style: CSSProperties
}) {
  const { t } = useI18n()
  const description = datasetTaskDescription(dataset) || dataset.label
  return (
    <aside className="data-manage-drawer" style={style}>
      <DrawerResizeHandle onResizeStart={onResizeStart} />
      <DrawerHeader
        title={description}
        stageLabel={t(DATASET_STAGE_LABELS[dataset.lifecycle_stage])}
        stageTone={dataset.lifecycle_stage}
        onClose={onClose}
      />
      <DrawerSection title={t('dataManageStatsSection')}>
        <div className="data-manage-kv-grid">
          <KeyValue wide label={t('dataManageTaskDescription')} value={datasetTaskDescription(dataset) || t('dataManageNoTaskDescription')} />
          <KeyValue label={t('dataManageEpisodes')} value={String(dataset.stats.total_episodes)} />
          <KeyValue label={t('dataManageFrames')} value={String(dataset.stats.total_frames)} />
          <KeyValue label="FPS" value={String(dataset.stats.fps || 0)} />
          <KeyValue label={t('dataManageRobot')} value={dataset.stats.robot_type || '-'} />
          <KeyValue wide label={t('dataManagePath')} value={dataset.path} />
        </div>
      </DrawerSection>
      <div className="data-manage-drawer__actions data-manage-drawer__actions--middle">
        <button type="button" onClick={onAnalyze}>
          {t('dataManageOpenAnalysis')}
        </button>
        {dataset.lifecycle_stage === 'clean' && (
          <button type="button" onClick={onToggle}>
            {selected ? t('dataManageRemoveFromPackage') : t('dataManageAddToPackage')}
          </button>
        )}
      </div>
      <DrawerSection title={t('dataManageGatesSection')}>
        <GateList gates={dataset.gates} onOpenGate={onOpenGate} />
      </DrawerSection>
      <DrawerDangerZone>
        <button type="button" className="data-manage-danger" onClick={onDelete}>{t('del')}</button>
      </DrawerDangerZone>
    </aside>
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

function DrawerSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="data-manage-drawer__section">
      <h4>{title}</h4>
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
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}) {
  const { t } = useI18n()
  const count = pageCount(total, pageSize)
  return (
    <div className="data-manage-column__pager">
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
  )
}

function filterByGateExpectation<T extends { gates: Record<string, DataGate> }>(
  items: T[],
  gateKeysToMatch: string[],
  passedGateKeys: string[],
): T[] {
  const passed = new Set(passedGateKeys)
  return items.filter((item) => {
    return gateKeysToMatch.every((key) => {
      const gatePassed = item.gates[key]?.status === 'passed'
      return passed.has(key) ? gatePassed : !gatePassed
    })
  })
}

function gateKeys(items: Array<{ gates: Record<string, DataGate> }>): string[] {
  return sortDataGateKeys(Array.from(new Set(items.flatMap((item) => Object.values(item.gates).map((gate) => gate.key)))))
}

function toggleGateKey(current: string[], key: string): string[] {
  if (current.includes(key)) {
    return current.filter((value) => value !== key)
  }
  return [...current, key]
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

function datasetGateRoute(datasetId: string, gateKey: string): string {
  const id = encodeURIComponent(datasetId)
  const gate = encodeURIComponent(gateKey)
  if (gateKey === 'inspect') return `/data/analysis?dataset=${id}&gate=${gate}`
  return `/data/qc?dataset=${id}&gate=${gate}`
}

function packageGateRoute(packageId: string, gateKey: string): string {
  const id = encodeURIComponent(packageId)
  const gate = encodeURIComponent(gateKey)
  if (gateKey === 'validate') return `/data/analysis?package=${id}&gate=${gate}`
  if (gateKey === 'annotate') return `/data/annotation?package=${id}&gate=${gate}`
  return `/data/manage?package=${id}&gate=${gate}`
}

function datasetTaskDescription(dataset: Dataset): string {
  const stats = dataset.stats as unknown as Record<string, unknown>
  return firstString(
    stats.task_description,
    stats.task,
    stats.description,
    stats.task_desc,
  )
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
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
