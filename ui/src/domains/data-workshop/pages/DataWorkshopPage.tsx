import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { persistDataset } from '@/domains/curation/store/workflowStoreHelpers'
import { ActionButton } from '@/shared/ui'
import { cn } from '@/shared/lib/cn'
import { useDataWorkshopStore } from '../store/useDataWorkshopStore'
import type { DatasetAssembly, GateKey, GateStatus, ProcessingGate, WorkshopDataset } from '../types'
import '../styles.css'

const GATE_ORDER: GateKey[] = [
  'repair_diagnosis',
  'auto_prune',
  'repair',
  'manual_boundary_review',
  'quality_validation',
  'organize',
  'assembly',
  'upload',
]

const statusText: Record<GateStatus, string> = {
  pending: '待处理',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  manual_required: '待人工',
  skipped: '跳过',
}

const stageText = {
  dirty: '脏数据',
  clean: '干净数据',
  complete: '完整数据',
  excluded: '剔除候选',
}

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const
const DEFAULT_PAGE_SIZE = 5

interface PaginationControlsState {
  totalItems: number
  pageSize: number
  currentPage: number
  pageCount: number
  rangeStart: number
  rangeEnd: number
  setPage: (page: number) => void
  setPageSize: (pageSize: number) => void
}

interface ClientPagination<T> extends PaginationControlsState {
  pageItems: T[]
}

export default function DataWorkshopPage() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const {
    datasets,
    assemblies,
    selectedDataset,
    loading,
    acting,
    error,
    load,
    selectDataset,
    diagnoseDataset,
    repairDataset,
    updateGate,
    promoteDataset,
    createAssembly,
    queueUpload,
  } = useDataWorkshopStore()
  const [selectedCleanIds, setSelectedCleanIds] = useState<string[]>([])
  const [assemblyName, setAssemblyName] = useState('完整数据包')
  const [organizeGroups, setOrganizeGroups] = useState('')
  const [organizeBatch, setOrganizeBatch] = useState('')
  const [organizeNotes, setOrganizeNotes] = useState('')
  const [query, setQuery] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedDataset) {
      setOrganizeGroups('')
      setOrganizeBatch('')
      setOrganizeNotes('')
      return
    }
    setOrganizeGroups(selectedDataset.groups.join(', '))
    setOrganizeBatch(selectedDataset.batch)
    setOrganizeNotes(selectedDataset.notes)
  }, [selectedDataset])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleDatasets = useMemo(
    () => datasets.filter((dataset) => matchesWorkshopQuery(dataset, normalizedQuery)),
    [datasets, normalizedQuery],
  )
  const visibleAssemblies = useMemo(
    () => assemblies.filter((assembly) => matchesAssemblyQuery(assembly, normalizedQuery)),
    [assemblies, normalizedQuery],
  )
  const dirtyDatasets = useMemo(
    () => visibleDatasets.filter((dataset) => dataset.stage === 'dirty' || dataset.stage === 'excluded'),
    [visibleDatasets],
  )
  const cleanDatasets = useMemo(
    () => visibleDatasets.filter((dataset) => dataset.stage === 'clean'),
    [visibleDatasets],
  )
  const completeDatasetCount = useMemo(
    () => visibleDatasets.filter((dataset) => dataset.stage === 'complete').length,
    [visibleDatasets],
  )
  const dirtyPagination = useClientPagination(dirtyDatasets)
  const cleanPagination = useClientPagination(cleanDatasets)
  const assemblyPagination = useClientPagination(visibleAssemblies)

  function openCurationRoute(route: string): void {
    if (selectedDataset) {
      persistDataset(selectedDataset.id)
    }
    navigate(route)
  }

  function toggleCleanSelection(datasetId: string): void {
    setSelectedCleanIds((current) => (
      current.includes(datasetId)
        ? current.filter((item) => item !== datasetId)
        : [...current, datasetId]
    ))
  }

  async function handleCreateAssembly(): Promise<void> {
    if (selectedCleanIds.length === 0) return
    const groups = buildAssemblyGroups(selectedCleanIds, cleanDatasets)
    const assembly = await createAssembly(assemblyName, selectedCleanIds, groups)
    setSelectedCleanIds([])
    setAssemblyName(assembly.name)
  }

  async function saveOrganizeGate(): Promise<void> {
    if (!selectedDataset) return
    const groups = parseGroups(organizeGroups)
    await updateGate(selectedDataset.id, 'organize', {
      status: 'passed',
      message: '整理信息已保存',
      groups,
      batch: organizeBatch,
      notes: organizeNotes,
    })
  }

  return (
    <div className="page-enter data-workshop-page">
      <header className="data-workshop-header">
        <div>
          <div className="eyebrow">{t('pipelineNav')}</div>
          <h2 className="data-workshop-title">数据车间</h2>
        </div>
        <div className="data-workshop-actions">
          <button
            type="button"
            className="data-workshop-icon-button"
            onClick={() => void load()}
            disabled={loading}
            title="刷新"
          >
            ↻
          </button>
        </div>
      </header>

      <section className="data-workshop-toolbar">
        <label className="data-workshop-search">
          <span>筛选</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="数据集、阶段、流程、批次、备注"
          />
        </label>
        <div className="data-workshop-filter-summary">
          显示 {visibleDatasets.length}/{datasets.length} 个数据集，{visibleAssemblies.length}/{assemblies.length} 个完整数据包
        </div>
      </section>

      <section className="data-workshop-metrics" aria-label="workshop metrics">
        <Metric label="脏数据" value={dirtyDatasets.length} />
        <Metric label="干净数据" value={cleanDatasets.length} />
        <Metric label="完整数据包" value={visibleAssemblies.length} />
        <Metric label="已入包数据" value={completeDatasetCount} />
      </section>

      {error && <div className="data-workshop-error">{error}</div>}

      <main className="data-workshop-grid">
        <WorkshopColumn
          title="脏数据车间"
          count={dirtyDatasets.length}
          pager={<PaginationControls title="脏数据车间" pagination={dirtyPagination} />}
        >
          {dirtyPagination.pageItems.map((dataset) => (
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              active={selectedDataset?.id === dataset.id}
              onClick={() => void selectDataset(dataset.id)}
            />
          ))}
        </WorkshopColumn>

        <WorkshopColumn
          title="干净数据车间"
          count={cleanDatasets.length}
          pager={<PaginationControls title="干净数据车间" pagination={cleanPagination} />}
        >
          <div className="data-workshop-assembly-form">
            <input
              value={assemblyName}
              onChange={(event) => setAssemblyName(event.target.value)}
              className="data-workshop-input"
              placeholder="完整数据包名称"
            />
            <ActionButton
              variant="secondary"
              className="data-workshop-small-action"
              disabled={selectedCleanIds.length === 0 || acting}
              onClick={() => void handleCreateAssembly().catch(() => undefined)}
            >
              生成完整数据包
            </ActionButton>
          </div>
          {cleanPagination.pageItems.map((dataset) => (
            <DatasetCard
              key={dataset.id}
              dataset={dataset}
              active={selectedDataset?.id === dataset.id}
              selected={selectedCleanIds.includes(dataset.id)}
              onToggle={() => toggleCleanSelection(dataset.id)}
              onClick={() => void selectDataset(dataset.id)}
            />
          ))}
        </WorkshopColumn>

        <WorkshopColumn
          title="完整数据车间"
          count={visibleAssemblies.length}
          pager={<PaginationControls title="完整数据车间" pagination={assemblyPagination} />}
        >
          {assemblyPagination.pageItems.map((assembly) => (
            <AssemblyCard
              key={assembly.id}
              assembly={assembly}
              acting={acting}
              onUpload={() => void queueUpload(assembly.id).catch(() => undefined)}
            />
          ))}
        </WorkshopColumn>
      </main>

      {selectedDataset && (
        <DatasetDrawer
          dataset={selectedDataset}
          acting={acting}
          organizeGroups={organizeGroups}
          organizeBatch={organizeBatch}
          organizeNotes={organizeNotes}
          onClose={() => useDataWorkshopStore.setState({ selectedDataset: null })}
          onDiagnose={() => void diagnoseDataset(selectedDataset.id).catch(() => undefined)}
          onRepair={() => void repairDataset(selectedDataset.id).catch(() => undefined)}
          onManualPass={() => void updateGate(selectedDataset.id, 'manual_boundary_review', {
            status: 'passed',
            message: '人工检查通过',
          }).catch(() => undefined)}
          onQualityPass={() => void updateGate(selectedDataset.id, 'quality_validation', {
            status: 'passed',
            message: '质量验证通过',
          }).catch(() => undefined)}
          onPromote={() => void promoteDataset(selectedDataset.id).catch(() => undefined)}
          onSaveOrganize={() => void saveOrganizeGate().catch(() => undefined)}
          onGroupsChange={setOrganizeGroups}
          onBatchChange={setOrganizeBatch}
          onNotesChange={setOrganizeNotes}
          onOpenQuality={() => openCurationRoute('/curation/quality')}
          onOpenText={() => openCurationRoute('/curation/text-alignment')}
          onOpenOverview={() => openCurationRoute('/curation/data-overview')}
        />
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="data-workshop-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function matchesWorkshopQuery(dataset: WorkshopDataset, query: string): boolean {
  if (!query) return true
  const gateValues = Object.values(dataset.gates).flatMap((gate) => [
    gate.key,
    gate.status,
    gate.label,
    gate.message,
  ])
  const issueValues = dataset.structure.issues.flatMap((issue) => [
    issue.check,
    issue.level,
    issue.message,
  ])
  const text = [
    dataset.id,
    dataset.name,
    stageText[dataset.stage],
    dataset.batch,
    dataset.notes,
    ...dataset.groups,
    ...gateValues,
    ...issueValues,
  ].join(' ').toLowerCase()
  return text.includes(query)
}

function matchesAssemblyQuery(assembly: DatasetAssembly, query: string): boolean {
  if (!query) return true
  const uploadValues = assembly.upload_task
    ? [assembly.upload_task.status, assembly.upload_task.message, assembly.upload_task.target]
    : []
  const groupValues = Object.entries(assembly.groups).flatMap(([group, datasetIds]) => [group, ...datasetIds])
  const text = [
    assembly.id,
    assembly.name,
    assembly.status,
    ...assembly.dataset_ids,
    ...groupValues,
    ...uploadValues,
  ].join(' ').toLowerCase()
  return text.includes(query)
}

function useClientPagination<T>(items: T[]): ClientPagination<T> {
  const [pageSize, setPageSizeState] = useState(DEFAULT_PAGE_SIZE)
  const [page, setPageState] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageItems = useMemo(
    () => items.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [items, currentPage, pageSize],
  )
  const rangeStart = items.length === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const rangeEnd = Math.min(currentPage * pageSize, items.length)

  useEffect(() => {
    setPageState((current) => Math.min(current, pageCount))
  }, [pageCount])

  function setPage(pageNumber: number): void {
    setPageState(clampPage(pageNumber, pageCount))
  }

  function setPageSize(nextPageSize: number): void {
    setPageSizeState(nextPageSize)
    setPageState(1)
  }

  return {
    totalItems: items.length,
    pageSize,
    currentPage,
    pageCount,
    pageItems,
    rangeStart,
    rangeEnd,
    setPage,
    setPageSize,
  }
}

function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1
  return Math.min(Math.max(1, Math.trunc(page)), pageCount)
}

function WorkshopColumn({
  title,
  count,
  pager,
  children,
}: {
  title: string
  count: number
  pager?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="data-workshop-column">
      <div className="data-workshop-column__header">
        <h3>{title}</h3>
        <span>{count}</span>
      </div>
      {pager}
      <div className="data-workshop-column__body">
        {children}
      </div>
    </section>
  )
}

function PaginationControls({
  title,
  pagination,
}: {
  title: string
  pagination: PaginationControlsState
}) {
  if (pagination.totalItems === 0) return null

  return (
    <div className="data-workshop-column__pager">
      <label>
        每页
        <select value={pagination.pageSize} onChange={(event) => pagination.setPageSize(Number(event.target.value))}>
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
      <div className="data-workshop-page-picker">
        <button
          type="button"
          onClick={() => pagination.setPage(pagination.currentPage - 1)}
          disabled={pagination.currentPage === 1}
        >
          上页
        </button>
        <input
          type="number"
          min={1}
          max={pagination.pageCount}
          value={pagination.currentPage}
          onChange={(event) => pagination.setPage(Number(event.target.value))}
          className="data-workshop-page-input"
          aria-label={`${title} 页码`}
        />
        <span>/ {pagination.pageCount}</span>
        <button
          type="button"
          onClick={() => pagination.setPage(pagination.currentPage + 1)}
          disabled={pagination.currentPage === pagination.pageCount}
        >
          下页
        </button>
      </div>
      <span className="data-workshop-page-range">{pagination.rangeStart}-{pagination.rangeEnd}</span>
    </div>
  )
}


function DatasetCard({
  dataset,
  active,
  selected,
  onClick,
  onToggle,
}: {
  dataset: WorkshopDataset
  active: boolean
  selected?: boolean
  onClick: () => void
  onToggle?: () => void
}) {
  const criticalCount = dataset.structure.issues.filter((issue) => issue.level === 'critical').length
  const gateProgress = GATE_ORDER.filter((key) => dataset.gates[key].status === 'passed').length
  return (
    <article className={cn('data-workshop-card', active && 'is-active')}>
      <button type="button" className="data-workshop-card__main" onClick={onClick}>
        <div className="data-workshop-card__topline">
          <span className="data-workshop-card__name">{dataset.name}</span>
          <span className={cn('data-workshop-stage', `is-${dataset.stage}`)}>
            {stageText[dataset.stage]}
          </span>
        </div>
        <div className="data-workshop-card__stats">
          <span>{dataset.stats.total_episodes} ep</span>
          <span>{dataset.stats.total_frames} fr</span>
          <span>{dataset.stats.video_files} video</span>
        </div>
        <div className="data-workshop-card__footer">
          <span>{gateProgress}/{GATE_ORDER.length} 流程</span>
          <span className={criticalCount > 0 ? 'is-critical' : ''}>{criticalCount} critical</span>
        </div>
      </button>
      {onToggle && (
        <button
          type="button"
          className={cn('data-workshop-select', selected && 'is-selected')}
          onClick={onToggle}
          title={selected ? '取消选择' : '选择'}
        >
          {selected ? '✓' : '+'}
        </button>
      )}
    </article>
  )
}

function AssemblyCard({
  assembly,
  acting,
  onUpload,
}: {
  assembly: DatasetAssembly
  acting: boolean
  onUpload: () => void
}) {
  return (
    <article className="data-workshop-assembly">
      <div className="data-workshop-card__topline">
        <span className="data-workshop-card__name">{assembly.name}</span>
        <span className="data-workshop-stage is-complete">{assembly.status}</span>
      </div>
      <div className="data-workshop-card__stats">
        <span>{assembly.dataset_ids.length} datasets</span>
        <span>{String(assembly.quality_summary.passed_episodes ?? 0)} pass</span>
        <span>{String(assembly.quality_summary.failed_episodes ?? 0)} fail</span>
      </div>
      <div className="data-workshop-assembly__upload">
        <span>{assembly.upload_task ? assembly.upload_task.status : '未上传'}</span>
        <ActionButton
          variant="secondary"
          className="data-workshop-small-action"
          disabled={acting}
          onClick={onUpload}
        >
          预留上传
        </ActionButton>
      </div>
    </article>
  )
}

function DatasetDrawer({
  dataset,
  acting,
  organizeGroups,
  organizeBatch,
  organizeNotes,
  onClose,
  onDiagnose,
  onRepair,
  onManualPass,
  onQualityPass,
  onPromote,
  onSaveOrganize,
  onGroupsChange,
  onBatchChange,
  onNotesChange,
  onOpenQuality,
  onOpenText,
  onOpenOverview,
}: {
  dataset: WorkshopDataset
  acting: boolean
  organizeGroups: string
  organizeBatch: string
  organizeNotes: string
  onClose: () => void
  onDiagnose: () => void
  onRepair: () => void
  onManualPass: () => void
  onQualityPass: () => void
  onPromote: () => void
  onSaveOrganize: () => void
  onGroupsChange: (value: string) => void
  onBatchChange: (value: string) => void
  onNotesChange: (value: string) => void
  onOpenQuality: () => void
  onOpenText: () => void
  onOpenOverview: () => void
}) {
  const canRepair = dataset.diagnosis?.repairable || dataset.gates.repair.status === 'manual_required'
  const canPromote = dataset.stage === 'dirty'
  return (
    <aside className="data-workshop-drawer">
      <div className="data-workshop-drawer__header">
        <div>
          <div className="eyebrow">{dataset.id}</div>
          <h3>{dataset.name}</h3>
        </div>
        <button type="button" className="data-workshop-icon-button" onClick={onClose} title="关闭">×</button>
      </div>

      <div className="data-workshop-drawer__actions">
        <ActionButton variant="secondary" disabled={acting} onClick={onDiagnose}>诊断</ActionButton>
        <ActionButton variant="secondary" disabled={acting || !canRepair} onClick={onRepair}>修复</ActionButton>
        <ActionButton variant="secondary" disabled={acting} onClick={onManualPass}>人工通过</ActionButton>
        <ActionButton variant="secondary" disabled={acting} onClick={onQualityPass}>质量通过</ActionButton>
        <ActionButton variant="primary" disabled={acting || !canPromote} onClick={onPromote}>进入干净车间</ActionButton>
      </div>

      <section className="data-workshop-drawer__section">
        <h4>处理流程</h4>
        <div className="data-workshop-gates">
          {GATE_ORDER.map((key) => (
            <GateRow key={key} gate={dataset.gates[key]} />
          ))}
        </div>
      </section>

      <section className="data-workshop-drawer__section">
        <h4>结构检查</h4>
        <div className="data-workshop-issues">
          {dataset.structure.issues.length === 0 ? (
            <span className="data-workshop-muted">无结构问题</span>
          ) : dataset.structure.issues.map((issue) => (
            <div key={`${issue.check}-${issue.message}`} className={cn('data-workshop-issue', `is-${issue.level}`)}>
              <span>{issue.level}</span>
              <p>{issue.message}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="data-workshop-drawer__section">
        <h4>数据整理</h4>
        <div className="data-workshop-form-grid">
          <label>
            <span>分组</span>
            <input value={organizeGroups} onChange={(event) => onGroupsChange(event.target.value)} />
          </label>
          <label>
            <span>批次</span>
            <input value={organizeBatch} onChange={(event) => onBatchChange(event.target.value)} />
          </label>
          <label className="is-wide">
            <span>备注</span>
            <textarea value={organizeNotes} onChange={(event) => onNotesChange(event.target.value)} />
          </label>
        </div>
        <ActionButton variant="secondary" disabled={acting} onClick={onSaveOrganize}>
          保存整理
        </ActionButton>
      </section>

      <section className="data-workshop-drawer__section">
        <h4>已有页面</h4>
        <div className="data-workshop-link-row">
          <button type="button" onClick={onOpenQuality}>质量验证</button>
          <button type="button" onClick={onOpenText}>文本对齐</button>
          <button type="button" onClick={onOpenOverview}>数据总览</button>
        </div>
      </section>
    </aside>
  )
}

function GateRow({ gate }: { gate: ProcessingGate }) {
  return (
    <div className="data-workshop-gate">
      <span className={cn('data-workshop-gate__dot', `is-${gate.status}`)} />
      <div>
        <strong>{gate.label}</strong>
        <p>{gate.message || statusText[gate.status]}</p>
      </div>
      <span>{statusText[gate.status]}</span>
    </div>
  )
}

function parseGroups(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function buildAssemblyGroups(
  datasetIds: string[],
  datasets: WorkshopDataset[],
): Record<string, string[]> {
  const groups: Record<string, string[]> = {}
  for (const datasetId of datasetIds) {
    const dataset = datasets.find((item) => item.id === datasetId)
    const keys = dataset?.groups.length ? dataset.groups : ['default']
    keys.forEach((key) => {
      groups[key] = [...(groups[key] || []), datasetId]
    })
  }
  return groups
}
