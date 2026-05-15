import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { DataEpisodeInspectionWorkspace } from '@/domains/data/components/DataEpisodeInspectionWorkspace'
import {
  readEpisodeTaskDescription,
  resolveEpisodePlaybackDuration,
} from '@/domains/data/components/EpisodePlaybackPanel'
import { asArray, asRecord, formatSeconds, numberValue, textValue } from '@/domains/data/lib/analysisPayload'
import {
  buildDatasetQualityView,
  datasetTaskDescription,
  qualityStatusLabelKey,
  qcReviewStatus,
  type QualityStatus,
} from '@/domains/data/model/datasetQuality'
import type { DataReviewDecision, DataReviewStatus, DataReviewWorkspace, Dataset } from '@/domains/data/model/types'
import { useDataInspectWorkspace } from '@/domains/data/store/inspectStore'
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

interface QcSequenceSummary {
  total: number
  done: number
  remaining: number
  reviewable: number
  percent: number
  nextRecord: QcDatasetRecord | null
}

interface QcFrameVideo {
  path: string
  url: string
  stream: string
  from_timestamp: number | null
  to_timestamp: number | null
}

const REVIEW_FAILURE_REASONS: Array<{ value: string; labelKey: TranslationKey }> = [
  { value: 'motion_abnormal', labelKey: 'dataReviewReasonMotionAbnormal' },
  { value: 'video_abnormal', labelKey: 'dataReviewReasonVideoAbnormal' },
  { value: 'task_mismatch', labelKey: 'dataReviewReasonTaskMismatch' },
  { value: 'robot_state_abnormal', labelKey: 'dataReviewReasonRobotStateAbnormal' },
  { value: 'other', labelKey: 'dataReviewReasonOther' },
]

export default function DataQcPage() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const user = useAuthStore((state) => state.user)
  const { datasets, error, load } = useDataLibraryStore()
  const {
    episode,
    loading,
    error: inspectError,
    setSource,
    setDataset,
    loadEpisode,
  } = useDataInspectWorkspace()
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
  const [datasetIdCopied, setDatasetIdCopied] = useState(false)
  const reviewLoadRequestRef = useRef(0)
  const inspectionLoadRequestRef = useRef(0)
  const reviewerId = currentReviewerId(user)
  const reviewerLabel = currentReviewerLabel(user)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const datasetId = searchParams.get('dataset') || ''
    if (datasetId === activeDatasetId) return
    setActiveDatasetId(datasetId)
    if (!datasetId) {
      reviewLoadRequestRef.current += 1
      inspectionLoadRequestRef.current += 1
      setReviewWorkspace(null)
      setReviewLoading(false)
      setReviewError('')
      setFailureOpen(false)
      setFailureReason('')
      setFailureNote('')
      setDraftTaskDescription('')
    }
  }, [activeDatasetId, searchParams])

  const scopedDatasetIds = useMemo(() => scopedDatasetIdsFromSearch(searchParams), [searchParams])
  const scopedDatasetIdSet = useMemo(() => new Set(scopedDatasetIds), [scopedDatasetIds])
  const records = useMemo(() => datasets.map(buildQcDatasetRecord), [datasets])
  const filteredRecords = useMemo(() => (
    scopedDatasetIds.length
      ? records.filter((record) => scopedDatasetIdSet.has(record.id))
      : records
  ), [records, scopedDatasetIdSet, scopedDatasetIds.length])
  const hasReviewSelection = activeDatasetId.trim().length > 0
  const summaryRecords = useMemo(() => (hasReviewSelection ? filteredRecords : []), [filteredRecords, hasReviewSelection])
  const reviewableRecords = useMemo(() => summaryRecords.filter(isReviewableRecord), [summaryRecords])
  const sequenceSummary = useMemo(() => buildSequenceSummary(summaryRecords, activeDatasetId), [activeDatasetId, summaryRecords])
  const activeRecord = filteredRecords.find((record) => record.id === activeDatasetId)
    ?? records.find((record) => record.id === activeDatasetId)
    ?? null
  const activeDataset = reviewWorkspace?.dataset
    ?? datasets.find((datasetItem) => datasetItem.id === activeDatasetId)
    ?? null

  useEffect(() => {
    if (!activeDatasetId) return
    void loadReviewWorkspace(activeDatasetId)
  }, [activeDatasetId])

  useEffect(() => {
    setDatasetIdCopied(false)
  }, [activeDatasetId, episodeIndex])

  function openDataset(record: QcDatasetRecord) {
    setActiveDatasetId(record.id)
    const params = new URLSearchParams()
    params.set('dataset', record.id)
    scopedDatasetIds.forEach((datasetId) => params.append('datasets', datasetId))
    setSearchParams(params)
  }

  async function loadReviewWorkspace(datasetId: string) {
    const requestId = ++reviewLoadRequestRef.current
    setReviewLoading(true)
    setReviewError('')
    setFailureOpen(false)
    setFailureReason('')
    setFailureNote('')
    try {
      const workspace = await dataApi.reviewWorkspace({ dataset_id: datasetId })
      if (requestId !== reviewLoadRequestRef.current) return
      const nextEpisodeIndex = firstUnreviewedEpisodeIndex(workspace)
        ?? lastReviewedEpisodeIndex(workspace)
        ?? workspace.episode_indices[0]
        ?? 0
      setReviewWorkspace(workspace)
      setDraftTaskDescription(reviewTaskDescription(workspace))
      setFailureDraftFromWorkspace(workspace, nextEpisodeIndex, false)
      setEpisodeIndex(nextEpisodeIndex)
      setReviewLoading(false)
      void loadInspectionEpisode(datasetId, nextEpisodeIndex)
    } catch (error) {
      if (requestId !== reviewLoadRequestRef.current) return
      setReviewWorkspace(null)
      setReviewError(error instanceof Error ? error.message : String(error))
      setReviewLoading(false)
    }
  }

  async function loadInspectionEpisode(datasetId: string, nextEpisodeIndex: number) {
    const requestId = ++inspectionLoadRequestRef.current
    setSource('local')
    setDataset(datasetId)
    if (requestId !== inspectionLoadRequestRef.current) return
    await loadEpisode(nextEpisodeIndex)
  }

  async function loadSelectedEpisode(nextEpisodeIndex: number) {
    inspectionLoadRequestRef.current += 1
    setEpisodeIndex(nextEpisodeIndex)
    if (reviewWorkspace) {
      setFailureDraftFromWorkspace(reviewWorkspace, nextEpisodeIndex, false)
    } else {
      setFailureOpen(false)
      setFailureReason('')
      setFailureNote('')
    }
    await loadEpisode(nextEpisodeIndex)
  }

  async function saveDraftTaskDescription(): Promise<boolean> {
    if (!activeDatasetId) return false
    setReviewSaving(true)
    setReviewError('')
    try {
      const workspace = await dataApi.saveReviewDraft(activeDatasetId, {
        draft_edits: { task_description: draftTaskDescription },
        reviewer_id: reviewerId,
      })
      setReviewWorkspace(workspace)
      await load()
      return true
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
      return false
    } finally {
      setReviewSaving(false)
    }
  }

  async function copyActiveDatasetId() {
    if (!activeDataset) return
    await navigator.clipboard.writeText(activeDataset.label || activeDataset.id)
    setDatasetIdCopied(true)
  }

  async function saveReviewDecision(decision: DataReviewDecision) {
    if (!activeDatasetId || !reviewWorkspace) return
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
    advanceToNextDatasetOrClear(workspace.dataset.id, workspace.dataset)
  }

  function advanceToNextDatasetOrClear(currentDatasetId: string, fallbackDataset: Dataset) {
    const nextDatasetId = nextReviewDatasetId(reviewableRecords, currentDatasetId)
    if (nextDatasetId) {
      const nextRecord = records.find((record) => record.id === nextDatasetId)
      openDataset(nextRecord ?? { ...workspaceRecordFallback(fallbackDataset), id: nextDatasetId })
      return
    }
    clearReviewSequence()
  }

  function setFailureDraftFromWorkspace(workspace: DataReviewWorkspace, targetEpisodeIndex: number, open: boolean) {
    const decision = workspace.review.episodes[String(targetEpisodeIndex)]
    if (decision?.decision !== 'failed') {
      setFailureOpen(false)
      setFailureReason('')
      setFailureNote('')
      return
    }
    setFailureOpen(open)
    setFailureReason(decision.reason)
    setFailureNote(decision.note)
  }

  function clearReviewSequence() {
    reviewLoadRequestRef.current += 1
    inspectionLoadRequestRef.current += 1
    setActiveDatasetId('')
    setReviewWorkspace(null)
    setReviewLoading(false)
    setReviewError('')
    setEpisodeIndex(0)
    setFailureOpen(false)
    setFailureReason('')
    setFailureNote('')
    setDraftTaskDescription('')
    setSearchParams(new URLSearchParams())
  }

  return (
    <section className="data-page data-qc-page">
      {error && <div className="data-alert">{error}</div>}
      {reviewError && <div className="data-alert">{reviewError}</div>}

      <div className="data-qc-review-workspace">
        <section className="data-panel data-qc-review-list-panel">
          <ReviewSequenceSummary
            activeRecord={activeRecord}
            nextRecord={sequenceSummary.nextRecord}
            summary={sequenceSummary}
            scoped={scopedDatasetIds.length > 0}
            onCancel={hasReviewSelection ? clearReviewSequence : undefined}
            t={t}
          />
        </section>

        <div className="data-qc-review-main">
          {activeDataset && activeRecord && reviewWorkspace ? (
            <>
              <section className="data-panel data-qc-review-control-panel">
                <div className="data-qc-review-control-panel__head">
                  <div className="data-qc-dataset-title">
                    <span>{t('dataQcManualReviewTitle')}</span>
                    <div className="data-qc-dataset-title__row">
                      <strong>{activeDataset.label}</strong>
                      <button
                        type="button"
                        className="data-qc-copy-icon-button"
                        onClick={() => void copyActiveDatasetId()}
                        aria-label={datasetIdCopied ? t('dataCopied') : t('dataCopy')}
                        title={datasetIdCopied ? t('dataCopied') : t('dataCopy')}
                      >
                        <CopyIcon />
                      </button>
                    </div>
                  </div>
                </div>
                <ReviewStatusCards activeRecord={activeRecord} reviewerLabel={reviewerLabel} t={t} />
                <ReviewDecisionControls
                  workspace={reviewWorkspace}
                  saving={reviewSaving}
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
              </section>

              <ReviewInspectionWorkspace
                source="local"
                dataset={activeDatasetId}
                episode={episode}
                episodeIndex={episodeIndex}
                totalEpisodes={reviewWorkspace.total_episodes || activeDataset.stats.total_episodes}
                loading={loading}
                canLoadEpisode={Boolean(activeDatasetId)}
                error={inspectError}
                datasetTask={datasetTaskDescription(activeDataset)}
                draftTaskDescription={draftTaskDescription}
                saving={reviewSaving}
                reviewLoading={reviewLoading}
                onEpisodeIndexChange={setEpisodeIndex}
                onLoadEpisode={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
                onDraftTaskDescriptionChange={setDraftTaskDescription}
                onSaveDraftTaskDescription={() => void saveDraftTaskDescription()}
                t={t}
              />
            </>
          ) : (
            <section className="data-panel">
              <div className="data-empty">
                {reviewLoading ? t('dataQcReviewVisualsLoading') : t('dataQcSelectReviewDataset')}
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  )
}

function ReviewSequenceSummary({
  activeRecord,
  nextRecord,
  summary,
  scoped,
  onCancel,
  t,
}: {
  activeRecord: QcDatasetRecord | null
  nextRecord: QcDatasetRecord | null
  summary: QcSequenceSummary
  scoped: boolean
  onCancel?: () => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const percent = `${summary.percent}%`
  return (
    <div className="data-qc-sequence-summary">
      <div className="data-qc-sequence-summary__head">
        <div>
          <h2>{t('dataQcWorkQueue')}</h2>
          {scoped && <span>{t('dataQcSequenceScopeSelected')}</span>}
        </div>
        <div className="data-qc-sequence-summary__actions">
          {onCancel && (
            <button type="button" className="data-analysis-secondary-button" onClick={onCancel}>
              {t('dataQcCancelSequence')}
            </button>
          )}
          <strong>{percent}</strong>
        </div>
      </div>
      <div className="data-review-progress-panel__bar" aria-hidden="true">
        <i style={{ width: percent }} />
      </div>
      <div className="data-qc-sequence-summary__grid">
        <SequenceTile
          label={t('dataQcSequenceCurrent')}
          value={activeRecord?.name || t('dataQcManualQueueEmpty')}
        />
        <SequenceTile
          label={t('dataQcSequenceNext')}
          value={nextRecord?.name || t('dataQcSequenceNoNext')}
        />
        <SequenceTile label={t('dataQcSequenceDone')} value={String(summary.done)} />
        <SequenceTile label={t('dataQcSequenceRemaining')} value={String(summary.remaining)} />
      </div>
    </div>
  )
}

function SequenceTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-qc-sequence-tile">
      <span>{label}</span>
      <strong>{value}</strong>
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
        <strong>{t(qualityStatusLabelKey(activeRecord.autoCleanStatus))}</strong>
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
  const progress = total ? Math.round((reviewedCount / total) * 100) : 0
  return (
    <div className="data-qc-review-ledger">
      <div className="data-qc-review-ledger__head">
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

function ReviewInspectionWorkspace({
  source,
  dataset,
  episode,
  episodeIndex,
  totalEpisodes,
  loading,
  canLoadEpisode,
  error,
  datasetTask,
  draftTaskDescription,
  saving,
  reviewLoading,
  onEpisodeIndexChange,
  onLoadEpisode,
  onDraftTaskDescriptionChange,
  onSaveDraftTaskDescription,
  t,
}: {
  source: 'local'
  dataset: string
  episode: unknown
  episodeIndex: number
  totalEpisodes: number
  loading: boolean
  canLoadEpisode: boolean
  error?: string
  datasetTask: string
  draftTaskDescription: string
  saving: boolean
  reviewLoading: boolean
  onEpisodeIndexChange: (episodeIndex: number) => void
  onLoadEpisode: (episodeIndex: number) => void
  onDraftTaskDescriptionChange: (value: string) => void
  onSaveDraftTaskDescription: () => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const episodePayload = asRecord(episode)
  const taskDescription = readEpisodeTaskDescription(episodePayload)
  const duration = resolveEpisodePlaybackDuration(episodePayload)

  return (
    <div className="data-review-inspection-groups">
      <section className="data-panel data-review-inspection-checklist">
        <div className="data-panel__title data-review-inspection-checklist__title">
          <h2>{t('dataReviewInspectionChecklistTitle')}</h2>
          <div className="data-qc-episode-duration">
            <span>{t('dataAnalysisEpisodeLengths')}</span>
            <strong>{formatSeconds(duration)}</strong>
          </div>
        </div>

        {taskDescription && (
          <section className="data-analysis-section data-qc-review-task-summary">
            <div className="data-analysis-section-title">{t('collectionTaskDescription')}</div>
            <div className="data-analysis-section-card data-analysis-task-card">
              {taskDescription}
            </div>
          </section>
        )}

        <article className="data-review-inspection-item">
          <div className="data-review-inspection-item__head">
            <div>
              <strong>{t('dataReviewInspectionFirstLastFrame')}</strong>
            </div>
          </div>
          <FirstLastFrameInspection episode={episode} t={t} />
        </article>

        <div className="data-qc-review-visuals">
          <DataEpisodeInspectionWorkspace
            source={source}
            dataset={dataset}
            episode={episode}
            episodeIndex={episodeIndex}
            totalEpisodes={totalEpisodes}
            loading={loading}
            canLoadEpisode={canLoadEpisode}
            error={error}
            emptyLabel={t('dataQcReviewVisualsLoading')}
            showEpisodeControls={false}
            showTitle={false}
            displayMode="full"
            showRobot3D
            allowStaticRobot3D
            showTrajectoryCharts={false}
            showTaskDescription={false}
            chrome="plain"
            summaryMode="duration"
            onEpisodeIndexChange={onEpisodeIndexChange}
            onLoadEpisode={onLoadEpisode}
          />
        </div>
      </section>

      <section className="data-panel data-review-edit-items">
        <div className="data-panel__title">
          <h2>{t('dataReviewEditSectionTitle')}</h2>
        </div>
        <article className="data-review-inspection-item">
          <div className="data-review-inspection-item__head">
            <div>
              <strong>{t('dataReviewTaskDraft')}</strong>
              <em>{t('dataReviewInspectionDatasetScope')}</em>
            </div>
          </div>
          <TaskDescriptionInspection
            datasetTask={datasetTask}
            draftTaskDescription={draftTaskDescription}
            saving={saving}
            reviewLoading={reviewLoading}
            onDraftTaskDescriptionChange={onDraftTaskDescriptionChange}
            onSaveDraftTaskDescription={onSaveDraftTaskDescription}
            t={t}
          />
        </article>
      </section>
    </div>
  )
}

function TaskDescriptionInspection({
  datasetTask,
  draftTaskDescription,
  saving,
  reviewLoading,
  onDraftTaskDescriptionChange,
  onSaveDraftTaskDescription,
  t,
}: {
  datasetTask: string
  draftTaskDescription: string
  saving: boolean
  reviewLoading: boolean
  onDraftTaskDescriptionChange: (value: string) => void
  onSaveDraftTaskDescription: () => void
  t: (key: TranslationKey) => string
}) {
  return (
    <div className="data-review-draft data-review-draft--inspection">
      <label>
        <span>{t('dataReviewTaskDraft')}</span>
        <input
          value={draftTaskDescription}
          onChange={(event) => onDraftTaskDescriptionChange(event.target.value)}
          placeholder={datasetTask || t('dataReviewTaskDraftPlaceholder')}
        />
      </label>
      <button
        type="button"
        className="data-analysis-secondary-button"
        onClick={onSaveDraftTaskDescription}
        disabled={saving || reviewLoading}
      >
        {t('dataReviewSaveDraft')}
      </button>
    </div>
  )
}

function FirstLastFrameInspection({
  episode,
  t,
}: {
  episode: unknown
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const videos = useMemo(() => readQcFrameVideos(episode), [episode])
  if (!videos.length) {
    return <div className="data-empty">{t('dataReviewFirstLastFrameEmpty')}</div>
  }
  return (
    <div className="data-review-first-last-frame">
      <div className="data-review-first-last-frame__grid">
        {videos.map((video, index) => (
          <div key={`${video.path}-${index}`} className="data-review-first-last-frame__stream">
            <strong>{video.stream || video.path}</strong>
            <div className="data-review-first-last-frame__frames">
              <FramePreviewVideo video={video} label={t('dataReviewFirstFrame')} position="first" />
              <FramePreviewVideo video={video} label={t('dataReviewLastFrame')} position="last" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FramePreviewVideo({
  video,
  label,
  position,
}: {
  video: QcFrameVideo
  label: string
  position: 'first' | 'last'
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const node = videoRef.current
    if (!node) return undefined
    const seekFrame = () => {
      const duration = Number.isFinite(node.duration) ? node.duration : null
      node.currentTime = framePreviewTime(video, position, duration)
    }
    node.addEventListener('loadedmetadata', seekFrame)
    if (node.readyState >= 1) seekFrame()
    return () => node.removeEventListener('loadedmetadata', seekFrame)
  }, [position, video])

  return (
    <figure className="data-review-frame-preview">
      <video ref={videoRef} src={video.url} muted playsInline preload="metadata" />
      <figcaption>{label}</figcaption>
    </figure>
  )
}

function ReviewDecisionControls({
  workspace,
  saving,
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
  saving: boolean
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
  if (!workspace.episode_indices.length) {
    return <div className="data-empty">{t('dataReviewNoEpisodes')}</div>
  }
  const savingReason = saving ? t('saving') : undefined
  const submitFailDisabledReason = savingReason || (!failureReason ? t('dataReviewFailureReasonRequired') : undefined)
  return (
    <div className="data-qc-review-decision">
      <div className="data-review-verdict-panel">
        <div className="data-review-decision-panel__actions">
          <span className="data-review-verdict-action data-tooltip-host" data-tooltip={savingReason}>
            <button type="button" className="data-review-pass-button" onClick={onPass} disabled={saving}>
              {t('dataReviewPass')}
            </button>
          </span>
          <span className="data-review-verdict-action data-tooltip-host" data-tooltip={savingReason}>
            <button type="button" className="data-review-fail-button" onClick={onFailureOpen} disabled={saving}>
              {t('dataReviewFail')}
            </button>
          </span>
        </div>
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
          <span className="data-review-submit-fail-action data-tooltip-host" data-tooltip={submitFailDisabledReason}>
            <button
              type="button"
              className="data-review-submit-fail-button"
              onClick={onFail}
              disabled={saving || !failureReason}
            >
              {t('dataReviewSubmitFail')}
            </button>
          </span>
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
  if (status === 'pending' || status === 'ready_for_batch' || status === 'applied') {
    return status
  }
  if (autoCleanStatus === 'failed' || autoCleanStatus === 'running') return 'blocked'
  return 'pending'
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
  return record.reviewStatus === 'pending'
}

function isReviewCompleteRecord(record: QcDatasetRecord): boolean {
  return record.reviewStatus === 'ready_for_batch' || record.reviewStatus === 'applied'
}

function scopedDatasetIdsFromSearch(searchParams: URLSearchParams): string[] {
  const scopedIds = searchParams.getAll('datasets').filter(Boolean)
  if (scopedIds.length) return Array.from(new Set(scopedIds))
  const datasetId = searchParams.get('dataset')
  return datasetId ? [datasetId] : []
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

function lastReviewedEpisodeIndex(workspace: DataReviewWorkspace): number | null {
  const reviewedIndices = workspace.episode_indices.filter((index) => workspace.review.episodes[String(index)])
  return reviewedIndices[reviewedIndices.length - 1] ?? null
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

function readQcFrameVideos(episode: unknown): QcFrameVideo[] {
  const episodePayload = asRecord(episode)
  return asArray(episodePayload.videos).map(asRecord).map((video) => ({
    path: textValue(video.path),
    url: textValue(video.url),
    stream: textValue(video.stream) || textValue(video.path),
    from_timestamp: numberValue(video.from_timestamp),
    to_timestamp: numberValue(video.to_timestamp),
  })).filter((video) => Boolean(video.url))
}

function framePreviewTime(video: QcFrameVideo, position: 'first' | 'last', duration: number | null): number {
  const start = video.from_timestamp != null && Number.isFinite(video.from_timestamp) ? video.from_timestamp : 0
  const end = video.to_timestamp != null && Number.isFinite(video.to_timestamp)
    ? video.to_timestamp
    : duration
  const target = position === 'first'
    ? start
    : Math.max((end ?? duration ?? 0) - 0.05, start)
  if (duration == null || duration <= 0) return Math.max(target, 0)
  return Math.min(Math.max(target, 0), Math.max(duration - 0.05, 0))
}

function workspaceRecordFallback(dataset: Dataset): QcDatasetRecord {
  return buildQcDatasetRecord(dataset)
}

function currentReviewerId(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.id || user?.phone || user?.nickname || ''
}

function currentReviewerLabel(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.nickname || user?.phone || user?.id || ''
}

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  )
}
