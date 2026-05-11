import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { DataAnalysisWorkspace } from '@/domains/data/components/DataAnalysisWorkspace'
import { asRecord } from '@/domains/data/lib/analysisPayload'
import {
  buildDatasetQualityView,
  datasetTaskDescription,
  qcReviewStatus,
  type QualityStatus,
} from '@/domains/data/model/datasetQuality'
import type { DataReviewDecision, DataReviewStatus, DataReviewWorkspace, Dataset } from '@/domains/data/model/types'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useAuthStore } from '@/shared/lib/authStore'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'

type ReviewWorkStatus = DataReviewStatus | 'blocked'

interface QcDatasetRecord {
  id: string
  name: string
  path: string
  task: string
  createdDate: string
  autoCleanStatus: QualityStatus
  reviewStatus: ReviewWorkStatus
  reviewedCount: number
  passedCount: number
  failedCount: number
  totalEpisodes: number
  reviewerIds: string[]
}

interface QcSummary {
  total: number
  remainingEpisodes: number
  pending: number
  inProgress: number
  readyForBatch: number
  applied: number
  blocked: number
}

interface QcSequenceSummary {
  total: number
  done: number
  remaining: number
  reviewable: number
  percent: number
  nextRecord: QcDatasetRecord | null
}

const REVIEW_FAILURE_REASONS: Array<{ value: string; labelKey: TranslationKey }> = [
  { value: 'motion_abnormal', labelKey: 'dataReviewReasonMotionAbnormal' },
  { value: 'video_abnormal', labelKey: 'dataReviewReasonVideoAbnormal' },
  { value: 'task_mismatch', labelKey: 'dataReviewReasonTaskMismatch' },
  { value: 'robot_state_abnormal', labelKey: 'dataReviewReasonRobotStateAbnormal' },
  { value: 'other', labelKey: 'dataReviewReasonOther' },
]

const QUALITY_STATUS_LABELS: Record<QualityStatus, TranslationKey> = {
  pending: 'dataQualityStatusPending',
  running: 'dataQualityStatusRunning',
  passed: 'dataQualityStatusPassed',
  failed: 'dataQualityStatusFailed',
  needs_review: 'dataQualityStatusNeedsReview',
  skipped: 'dataQualityStatusSkipped',
}

export default function DataQcPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((state) => state.user)
  const { datasets, error, load } = useDataLibraryStore()
  const {
    source,
    dataset,
    summary,
    details,
    episodes,
    episode,
    loading,
    error: inspectError,
    setSource,
    setDataset,
    inspect,
    loadEpisode,
  } = useDataInspectStore()
  const [activeDatasetId, setActiveDatasetId] = useState(searchParams.get('dataset') || '')
  const [reviewWorkspace, setReviewWorkspace] = useState<DataReviewWorkspace | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [failureOpen, setFailureOpen] = useState(false)
  const [failureReason, setFailureReason] = useState('')
  const [failureNote, setFailureNote] = useState('')
  const [draftTaskDescription, setDraftTaskDescription] = useState('')
  const [analysisOpen, setAnalysisOpen] = useState(true)
  const [reviewActionsUnlocked, setReviewActionsUnlocked] = useState(false)
  const analysisEndRef = useRef<HTMLDivElement | null>(null)
  const reviewerId = currentReviewerId(user)
  const reviewerLabel = currentReviewerLabel(user)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const datasetId = searchParams.get('dataset') || ''
    if (!datasetId || datasetId === activeDatasetId) return
    setActiveDatasetId(datasetId)
  }, [activeDatasetId, searchParams])

  const scopedDatasetIds = useMemo(() => scopedDatasetIdsFromSearch(searchParams), [searchParams])
  const scopedDatasetIdSet = useMemo(() => new Set(scopedDatasetIds), [scopedDatasetIds])
  const records = useMemo(() => datasets.map(buildQcDatasetRecord), [datasets])
  const filteredRecords = useMemo(() => (
    scopedDatasetIds.length
      ? records.filter((record) => scopedDatasetIdSet.has(record.id))
      : records
  ), [records, scopedDatasetIdSet, scopedDatasetIds.length])
  const reviewableRecords = useMemo(() => filteredRecords.filter(isReviewableRecord), [filteredRecords])
  const qcSummary = useMemo(() => buildQcSummary(filteredRecords), [filteredRecords])
  const sequenceSummary = useMemo(() => buildSequenceSummary(filteredRecords, activeDatasetId), [activeDatasetId, filteredRecords])
  const activeRecord = filteredRecords.find((record) => record.id === activeDatasetId)
    ?? records.find((record) => record.id === activeDatasetId)
    ?? null
  const activeDataset = reviewWorkspace?.dataset
    ?? datasets.find((datasetItem) => datasetItem.id === activeDatasetId)
    ?? null
  const summaryPayload = asRecord(summary?.summary)

  useEffect(() => {
    if (activeDatasetId || !filteredRecords.length) return
    const firstRecord = reviewableRecords[0] ?? filteredRecords[0]
    openDataset(firstRecord)
  }, [activeDatasetId, filteredRecords, reviewableRecords])

  useEffect(() => {
    if (!activeDatasetId) return
    void loadReviewWorkspace(activeDatasetId)
  }, [activeDatasetId])

  useEffect(() => {
    setReviewActionsUnlocked(false)
  }, [activeDatasetId, episodeIndex])

  useEffect(() => {
    const target = analysisEndRef.current
    if (!target || !analysisOpen || reviewActionsUnlocked) return
    let sawReviewScroll = false
    const unlockIfAnalysisEndReached = () => {
      sawReviewScroll = true
      const rect = target.getBoundingClientRect()
      if (rect.top <= window.innerHeight && rect.bottom >= 0) {
        setReviewActionsUnlocked(true)
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (sawReviewScroll && entries.some((entry) => entry.isIntersecting)) {
          setReviewActionsUnlocked(true)
          observer.disconnect()
        }
      },
      { threshold: 0.75 },
    )
    observer.observe(target)
    window.addEventListener('scroll', unlockIfAnalysisEndReached, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', unlockIfAnalysisEndReached)
    }
  }, [analysisOpen, reviewActionsUnlocked, activeDatasetId, episodeIndex, reviewWorkspace?.dataset.id])

  function openDataset(record: QcDatasetRecord) {
    setActiveDatasetId(record.id)
    const params = new URLSearchParams()
    params.set('dataset', record.id)
    scopedDatasetIds.forEach((datasetId) => params.append('datasets', datasetId))
    setSearchParams(params)
  }

  async function loadReviewWorkspace(datasetId: string) {
    setReviewLoading(true)
    setReviewError('')
    setFailureOpen(false)
    setFailureReason('')
    setFailureNote('')
    setReviewActionsUnlocked(false)
    try {
      const workspace = await dataApi.reviewWorkspace({ dataset_id: datasetId })
      const nextEpisodeIndex = firstUnreviewedEpisodeIndex(workspace) ?? workspace.episode_indices[0] ?? 0
      setReviewWorkspace(workspace)
      setDraftTaskDescription(reviewTaskDescription(workspace))
      setEpisodeIndex(nextEpisodeIndex)
      setSource('local')
      setDataset(datasetId)
      if (source !== 'local' || dataset !== datasetId || !Object.keys(summaryPayload).length) {
        await inspect()
      }
      await loadEpisode(nextEpisodeIndex)
    } catch (error) {
      setReviewWorkspace(null)
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewLoading(false)
    }
  }

  async function loadSelectedEpisode(nextEpisodeIndex: number) {
    setEpisodeIndex(nextEpisodeIndex)
    setFailureOpen(false)
    setFailureReason('')
    setFailureNote('')
    setReviewActionsUnlocked(false)
    await loadEpisode(nextEpisodeIndex)
  }

  async function saveDraftTaskDescription() {
    if (!activeDatasetId) return
    setReviewSaving(true)
    setReviewError('')
    try {
      const workspace = await dataApi.saveReviewDraft(activeDatasetId, {
        draft_edits: { task_description: draftTaskDescription },
        reviewer_id: reviewerId,
      })
      setReviewWorkspace(workspace)
      await load()
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewSaving(false)
    }
  }

  async function saveReviewDecision(decision: DataReviewDecision) {
    if (!activeDatasetId || !reviewWorkspace) return
    if (!reviewActionsUnlocked) return
    if (decision === 'failed' && !failureReason) {
      setReviewError(t('dataReviewFailureReasonRequired'))
      return
    }
    setReviewSaving(true)
    setReviewError('')
    try {
      const workspace = await dataApi.saveReviewEpisode(activeDatasetId, episodeIndex, {
        decision,
        reason: decision === 'failed' ? failureReason : '',
        note: decision === 'failed' ? failureNote : '',
        reviewer_id: reviewerId,
      })
      setReviewWorkspace(workspace)
      await load()
      await advanceReviewCursor(workspace)
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewSaving(false)
    }
  }

  async function advanceReviewCursor(workspace: DataReviewWorkspace) {
    const nextEpisodeIndex = nextUnreviewedEpisodeIndex(workspace, episodeIndex)
    if (nextEpisodeIndex !== null) {
      await loadSelectedEpisode(nextEpisodeIndex)
      return
    }
    const nextDatasetId = nextReviewDatasetId(reviewableRecords, workspace.dataset.id)
    if (nextDatasetId) {
      openDataset(records.find((record) => record.id === nextDatasetId) ?? { ...workspaceRecordFallback(workspace.dataset), id: nextDatasetId })
      return
    }
    setReviewError(t('dataReviewAllDone'))
  }

  function openStandaloneAnalysis() {
    if (!activeDatasetId) return
    const encodedDataset = encodeURIComponent(activeDatasetId)
    navigate(`/data/analysis?dataset=${encodedDataset}&returnTo=data-qc&qcDataset=${encodedDataset}`)
  }

  return (
    <section className="data-page data-qc-page">
      {error && <div className="data-alert">{error}</div>}
      {reviewError && <div className="data-alert">{reviewError}</div>}

      <section className="data-qc-hero">
        <div>
          <span>{t('dataQcNav')}</span>
          <h1>{t('dataQcWorkbenchTitle')}</h1>
        </div>
        <div className="data-qc-hero__metrics">
          <Metric label={t('dataQcTotalDatasets')} value={qcSummary.total} />
          <Metric label={t('dataQcRemainingEpisodes')} value={qcSummary.remainingEpisodes} />
          <Metric label={t('dataQcReadyForBatchCount')} value={qcSummary.readyForBatch} />
          <Metric label={t('dataQcAppliedCount')} value={qcSummary.applied} />
        </div>
      </section>

      <div className="data-qc-review-workspace">
        <section className="data-panel data-qc-review-list-panel">
          <ReviewSequenceSummary
            activeRecord={activeRecord}
            nextRecord={sequenceSummary.nextRecord}
            summary={sequenceSummary}
            scoped={scopedDatasetIds.length > 0}
            t={t}
          />
        </section>

        <div className="data-qc-review-main">
          {activeDataset && activeRecord && reviewWorkspace ? (
            <>
              <section className="data-panel data-qc-review-control-panel">
                <div className="data-qc-review-control-panel__head">
                  <div>
                    <span>{t('dataQcManualReviewTitle')}</span>
                    <strong>{activeDataset.label}</strong>
                  </div>
                </div>
                <ReviewStatusCards activeRecord={activeRecord} reviewerLabel={reviewerLabel} t={t} />
                <ReviewDecisionControls
                  workspace={reviewWorkspace}
                  episodeIndex={episodeIndex}
                  saving={reviewSaving}
                  unlocked={reviewActionsUnlocked}
                  failureOpen={failureOpen}
                  failureReason={failureReason}
                  failureNote={failureNote}
                  onFailureOpen={() => setFailureOpen(true)}
                  onFailureReasonChange={setFailureReason}
                  onFailureNoteChange={setFailureNote}
                  onPass={() => void saveReviewDecision('passed')}
                  onFail={() => void saveReviewDecision('failed')}
                  t={t}
                />
                <ReviewLedger
                  workspace={reviewWorkspace}
                  episodeIndex={episodeIndex}
                  onEpisodeSelect={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
                  t={t}
                />
                <div className="data-review-draft">
                  <label>
                    <span>{t('dataReviewTaskDraft')}</span>
                    <input
                      value={draftTaskDescription}
                      onChange={(event) => setDraftTaskDescription(event.target.value)}
                      placeholder={datasetTaskDescription(activeDataset) || t('dataReviewTaskDraftPlaceholder')}
                    />
                  </label>
                  <button
                    type="button"
                    className="data-analysis-secondary-button"
                    onClick={() => void saveDraftTaskDescription()}
                    disabled={reviewSaving || reviewLoading}
                  >
                    {t('dataReviewSaveDraft')}
                  </button>
                </div>
              </section>

              <section className="data-panel data-qc-analysis-toggle">
                <div>
                  <span>{t('dataQcAnalysisTitle')}</span>
                  <strong>{activeDataset.label}</strong>
                </div>
                <div>
                  <button type="button" className="data-analysis-secondary-button" onClick={openStandaloneAnalysis}>
                    {t('dataQcOpenFullAnalysis')}
                  </button>
                  <button type="button" className="data-analysis-secondary-button" onClick={() => setAnalysisOpen((current) => !current)}>
                    {analysisOpen ? t('dataQcHideAnalysis') : t('dataQcShowAnalysis')}
                  </button>
                </div>
              </section>

              {analysisOpen && (
                <>
                  <DataAnalysisWorkspace
                    summary={summary}
                    details={details}
                    episodes={episodes}
                    episode={episode}
                    episodeIndex={episodeIndex}
                    totalEpisodesFallback={activeDataset.stats.total_episodes}
                    loading={loading}
                    canLoadEpisode={Boolean(activeDatasetId)}
                    error={inspectError}
                    emptyLabel={t('dataQcReviewVisualsLoading')}
                    onEpisodeIndexChange={setEpisodeIndex}
                    onLoadEpisode={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
                  />
                  <div ref={analysisEndRef} className="data-qc-analysis-end-marker" aria-hidden="true" />
                </>
              )}
            </>
          ) : (
            <section className="data-panel data-qc-review-empty">
              {reviewLoading ? t('dataQcReviewVisualsLoading') : t('dataQcSelectReviewDataset')}
            </section>
          )}
        </div>
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="data-qc-hero-metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  )
}

function ReviewSequenceSummary({
  activeRecord,
  nextRecord,
  summary,
  scoped,
  t,
}: {
  activeRecord: QcDatasetRecord | null
  nextRecord: QcDatasetRecord | null
  summary: QcSequenceSummary
  scoped: boolean
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const percent = `${summary.percent}%`
  return (
    <div className="data-qc-sequence-summary">
      <div className="data-qc-sequence-summary__head">
        <div>
          <h2>{t('dataQcWorkQueue')}</h2>
          <span>{scoped ? t('dataQcSequenceScopeSelected') : t('dataQcSequenceScopeAll')}</span>
        </div>
        <strong>{percent}</strong>
      </div>
      <div className="data-review-progress-panel__bar" aria-hidden="true">
        <i style={{ width: percent }} />
      </div>
      <div className="data-qc-sequence-summary__grid">
        <SequenceTile
          label={t('dataQcSequenceCurrent')}
          value={activeRecord?.name || t('dataQcManualQueueEmpty')}
          detail={activeRecord ? (activeRecord.task || activeRecord.path) : ''}
        />
        <SequenceTile
          label={t('dataQcSequenceNext')}
          value={nextRecord?.name || t('dataQcSequenceNoNext')}
          detail={nextRecord ? (nextRecord.task || nextRecord.path) : ''}
        />
        <SequenceTile label={t('dataQcSequenceDone')} value={String(summary.done)} detail={t('dataQcSequenceTotal', { count: summary.total })} />
        <SequenceTile label={t('dataQcSequenceRemaining')} value={String(summary.remaining)} detail={t('dataQcManualReviewQueueCount', { count: summary.reviewable })} />
      </div>
    </div>
  )
}

function SequenceTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="data-qc-sequence-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail && <em>{detail}</em>}
    </div>
  )
}

function ReviewStatusCards({
  activeRecord,
  reviewerLabel,
  t,
}: {
  activeRecord: QcDatasetRecord
  reviewerLabel: string
  t: (key: TranslationKey) => string
}) {
  return (
    <div className="data-qc-review-status-cards">
      <div className="data-qc-review-status-card">
        <span>{t('dataManageAutoCleanStatus')}</span>
        <strong>{qualityStatusLabel(activeRecord.autoCleanStatus, t)}</strong>
      </div>
      <div className="data-qc-review-status-card">
        <span>{t('dataQcCurrentAssignee')}</span>
        <strong>{reviewerLabel || t('dataQcUnassigned')}</strong>
      </div>
    </div>
  )
}

function ReviewLedger({
  workspace,
  episodeIndex,
  onEpisodeSelect,
  t,
}: {
  workspace: DataReviewWorkspace
  episodeIndex: number
  onEpisodeSelect: (episodeIndex: number) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const reviewedCount = workspace.episode_indices.filter((index) => workspace.review.episodes[String(index)]).length
  const total = workspace.episode_indices.length
  const currentPosition = Math.max(0, workspace.episode_indices.indexOf(episodeIndex))
  const progress = total ? Math.round((reviewedCount / total) * 100) : 0
  return (
    <div className="data-qc-review-ledger">
      <div className="data-qc-review-ledger__head">
        <span>{t('dataReviewEpisodeProgress', { current: currentPosition + 1, total: Math.max(total, 1) })}</span>
        <span>{t('dataReviewReviewedCount', { reviewed: reviewedCount, total })}</span>
        <span>{t('dataQcRemaining')}: {Math.max(total - reviewedCount, 0)}</span>
      </div>
      <div className="data-review-progress-panel__bar" aria-hidden="true">
        <i style={{ width: `${progress}%` }} />
      </div>
      <div className="data-review-sequence" aria-label={t('dataReviewEpisodeSequence')}>
        {workspace.episode_indices.map((index) => {
          const decision = workspace.review.episodes[String(index)]?.decision
          return (
            <button
              key={index}
              type="button"
              className={cn(
                'data-review-sequence__item',
                episodeIndex === index && 'is-active',
                decision && `is-${decision}`,
              )}
              onClick={() => onEpisodeSelect(index)}
            >
              {index + 1}
            </button>
          )
        })}
        {!workspace.episode_indices.length && <span className="data-review-sequence__empty">{t('dataReviewNoEpisodes')}</span>}
      </div>
    </div>
  )
}

function ReviewDecisionControls({
  workspace,
  episodeIndex,
  saving,
  unlocked,
  failureOpen,
  failureReason,
  failureNote,
  onFailureOpen,
  onFailureReasonChange,
  onFailureNoteChange,
  onPass,
  onFail,
  t,
}: {
  workspace: DataReviewWorkspace
  episodeIndex: number
  saving: boolean
  unlocked: boolean
  failureOpen: boolean
  failureReason: string
  failureNote: string
  onFailureOpen: () => void
  onFailureReasonChange: (value: string) => void
  onFailureNoteChange: (value: string) => void
  onPass: () => void
  onFail: () => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const currentDecision = workspace.review.episodes[String(episodeIndex)]
  if (!workspace.episode_indices.length) {
    return <div className="data-empty">{t('dataReviewNoEpisodes')}</div>
  }
  const decisionDisabled = saving || !unlocked
  return (
    <div className="data-qc-review-decision">
      <div className="data-review-decision-panel__head">
        <div>
          <span>{t('dataReviewCurrentEpisode')}</span>
          <strong>Episode {episodeIndex + 1}</strong>
        </div>
        {currentDecision && (
          <em className={cn('data-review-decision-state', `is-${currentDecision.decision}`)}>
            {t(currentDecision.decision === 'passed' ? 'dataReviewDecisionPassed' : 'dataReviewDecisionFailed')}
          </em>
        )}
      </div>
      <p className={cn('data-qc-review-decision__hint', unlocked && 'is-ready')}>
        {unlocked ? t('dataQcReviewActionsReady') : t('dataQcReviewActionsLocked')}
      </p>
      <div className="data-review-decision-panel__actions">
        <button type="button" className="data-review-pass-button" onClick={onPass} disabled={decisionDisabled}>
          {t('dataReviewPass')}
        </button>
        <button type="button" className="data-review-fail-button" onClick={onFailureOpen} disabled={decisionDisabled}>
          {t('dataReviewFail')}
        </button>
      </div>
      {failureOpen && (
        <div className="data-review-failure-editor">
          <div className="data-review-failure-reasons" role="group" aria-label={t('dataReviewFailureReason')}>
            {REVIEW_FAILURE_REASONS.map((reason) => (
              <button
                key={reason.value}
                type="button"
                className={cn('data-analysis-secondary-button', failureReason === reason.value && 'is-active')}
                onClick={() => onFailureReasonChange(reason.value)}
              >
                {t(reason.labelKey)}
              </button>
            ))}
          </div>
          <textarea
            value={failureNote}
            onChange={(event) => onFailureNoteChange(event.target.value)}
            placeholder={t('dataReviewNotePlaceholder')}
          />
          <button
            type="button"
            className="data-review-submit-fail-button"
            onClick={onFail}
            disabled={decisionDisabled || !failureReason}
          >
            {t('dataReviewSubmitFail')}
          </button>
        </div>
      )}
    </div>
  )
}

function buildQcDatasetRecord(dataset: Dataset): QcDatasetRecord {
  const quality = buildDatasetQualityView(dataset)
  const review = reviewPayload(dataset)
  const episodes = asRecord(review.episodes)
  const decisions = Object.values(episodes).map(asRecord)
  const reviewStatus = datasetReviewStatus(dataset, quality.autoCleanStatus)
  return {
    id: dataset.id,
    name: dataset.label || dataset.name,
    path: dataset.real_path || dataset.path,
    task: quality.taskDescription,
    createdDate: quality.createdDate,
    autoCleanStatus: quality.autoCleanStatus,
    reviewStatus,
    reviewedCount: decisions.length,
    passedCount: decisions.filter((decision) => decision.decision === 'passed').length,
    failedCount: decisions.filter((decision) => decision.decision === 'failed').length,
    totalEpisodes: dataset.stats.total_episodes,
    reviewerIds: Array.from(new Set(decisions.map((decision) => String(decision.reviewer_id || '')).filter(Boolean))),
  }
}

function datasetReviewStatus(dataset: Dataset, autoCleanStatus: QualityStatus): ReviewWorkStatus {
  const status = qcReviewStatus(dataset)
  if (status === 'pending' || status === 'in_progress' || status === 'ready_for_batch' || status === 'applied') {
    return status
  }
  if (autoCleanStatus === 'failed' || autoCleanStatus === 'running') return 'blocked'
  return 'pending'
}

function buildQcSummary(records: QcDatasetRecord[]): QcSummary {
  return records.reduce<QcSummary>((summary, record) => {
    summary.total += 1
    summary.remainingEpisodes += isReviewableRecord(record) ? Math.max(record.totalEpisodes - record.reviewedCount, 0) : 0
    if (record.reviewStatus === 'pending') summary.pending += 1
    if (record.reviewStatus === 'in_progress') summary.inProgress += 1
    if (record.reviewStatus === 'ready_for_batch') summary.readyForBatch += 1
    if (record.reviewStatus === 'applied') summary.applied += 1
    if (record.reviewStatus === 'blocked') summary.blocked += 1
    return summary
  }, { total: 0, remainingEpisodes: 0, pending: 0, inProgress: 0, readyForBatch: 0, applied: 0, blocked: 0 })
}

function buildSequenceSummary(records: QcDatasetRecord[], activeDatasetId: string): QcSequenceSummary {
  const sequenceRecords = records.filter((record) => record.reviewStatus !== 'blocked')
  const done = sequenceRecords.filter(isReviewCompleteRecord).length
  const remaining = sequenceRecords.filter(isReviewPendingRecord).length
  const activeIndex = sequenceRecords.findIndex((record) => record.id === activeDatasetId)
  const nextRecord = activeIndex >= 0
    ? sequenceRecords.slice(activeIndex + 1).find(isReviewPendingRecord) ?? null
    : sequenceRecords.find(isReviewPendingRecord) ?? null
  const percent = sequenceRecords.length ? Math.round((done / sequenceRecords.length) * 100) : 0
  return {
    total: sequenceRecords.length,
    done,
    remaining,
    reviewable: remaining,
    percent,
    nextRecord,
  }
}

function isReviewableRecord(record: QcDatasetRecord): boolean {
  return isReviewPendingRecord(record)
}

function isReviewPendingRecord(record: QcDatasetRecord): boolean {
  return record.reviewStatus === 'pending' || record.reviewStatus === 'in_progress'
}

function isReviewCompleteRecord(record: QcDatasetRecord): boolean {
  return record.reviewStatus === 'ready_for_batch' || record.reviewStatus === 'applied'
}

function scopedDatasetIdsFromSearch(searchParams: URLSearchParams): string[] {
  return Array.from(new Set(searchParams.getAll('datasets').filter(Boolean)))
}

function reviewPayload(dataset: Dataset): Record<string, unknown> {
  return asRecord(asRecord(dataset.qc).review)
}

function reviewTaskDescription(workspace: DataReviewWorkspace): string {
  const draftTask = workspace.review.draft_edits.task_description
  return typeof draftTask === 'string' ? draftTask : datasetTaskDescription(workspace.dataset)
}

function firstUnreviewedEpisodeIndex(workspace: DataReviewWorkspace): number | null {
  return workspace.episode_indices.find((index) => !workspace.review.episodes[String(index)]) ?? null
}

function nextUnreviewedEpisodeIndex(workspace: DataReviewWorkspace, currentEpisodeIndex: number): number | null {
  const indices = workspace.episode_indices
  const currentPosition = indices.indexOf(currentEpisodeIndex)
  const afterCurrent = indices.slice(Math.max(currentPosition + 1, 0))
  const beforeCurrent = currentPosition >= 0 ? indices.slice(0, currentPosition + 1) : indices
  return [...afterCurrent, ...beforeCurrent].find((index) => !workspace.review.episodes[String(index)]) ?? null
}

function nextReviewDatasetId(records: QcDatasetRecord[], currentDatasetId: string): string {
  const ids = records.map((record) => record.id).filter((id) => id !== currentDatasetId)
  const currentIndex = records.findIndex((record) => record.id === currentDatasetId)
  if (currentIndex < 0) return ids[0] || ''
  const after = records.slice(currentIndex + 1).find((record) => record.id !== currentDatasetId)
  return after?.id || ids[0] || ''
}

function workspaceRecordFallback(dataset: Dataset): QcDatasetRecord {
  return buildQcDatasetRecord(dataset)
}

function qualityStatusLabel(status: QualityStatus, t: (key: TranslationKey) => string): string {
  return t(QUALITY_STATUS_LABELS[status])
}

function currentReviewerId(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.id || user?.phone || user?.nickname || ''
}

function currentReviewerLabel(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.nickname || user?.phone || user?.id || ''
}
