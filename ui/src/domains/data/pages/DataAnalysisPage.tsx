import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DatasetStatsPanel } from '@/domains/data/components/DatasetStatsPanel'
import { EpisodePlaybackPanel } from '@/domains/data/components/EpisodePlaybackPanel'
import { dataApi } from '@/domains/data/api/dataApi'
import {
  buildDatasetQualityView,
  datasetTaskDescription,
  qcReviewStatus,
} from '@/domains/data/model/datasetQuality'
import type { DataReviewDecision, DataReviewWorkspace, Dataset } from '@/domains/data/model/types'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useI18n } from '@/i18n'
import type { TranslationKey } from '@/i18n'
import { useAuthStore } from '@/shared/lib/authStore'
import { cn } from '@/shared/lib/cn'
import {
  asArray,
  asRecord,
  numberValue,
  textValue,
} from '@/domains/data/lib/analysisPayload'

type SourceMode = 'remote' | 'local'

const REVIEW_FAILURE_REASONS: Array<{ value: string; labelKey: TranslationKey }> = [
  { value: 'motion_abnormal', labelKey: 'dataReviewReasonMotionAbnormal' },
  { value: 'video_abnormal', labelKey: 'dataReviewReasonVideoAbnormal' },
  { value: 'task_mismatch', labelKey: 'dataReviewReasonTaskMismatch' },
  { value: 'robot_state_abnormal', labelKey: 'dataReviewReasonRobotStateAbnormal' },
  { value: 'other', labelKey: 'dataReviewReasonOther' },
]

export default function DataAnalysisPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const { attach } = useDataJobStore()
  const { datasets, load: loadLibrary } = useDataLibraryStore()
  const {
    source,
    dataset,
    summary,
    details,
    episodes,
    episode,
    loading,
    error,
    setSource,
    setDataset,
    inspect,
    loadEpisode,
  } = useDataInspectStore()
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [reviewWorkspace, setReviewWorkspace] = useState<DataReviewWorkspace | null>(null)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewSaving, setReviewSaving] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [failureOpen, setFailureOpen] = useState(false)
  const [failureReason, setFailureReason] = useState('')
  const [failureNote, setFailureNote] = useState('')
  const [draftTaskDescription, setDraftTaskDescription] = useState('')
  const loadedDatasetFromQuery = useRef('')
  const datasetFromQuery = searchParams.get('dataset') || ''
  const returnTo = searchParams.get('returnTo') || ''
  const manageDataset = searchParams.get('manageDataset') || datasetFromQuery
  const isReviewMode = searchParams.get('mode') === 'review'
  const reviewerId = currentReviewerId(user)

  useEffect(() => {
    if (!datasetFromQuery || loadedDatasetFromQuery.current === datasetFromQuery) return
    loadedDatasetFromQuery.current = datasetFromQuery
    setSource('local')
    setDataset(datasetFromQuery)
    void (async () => {
      await inspect()
      setEpisodeIndex(0)
      await loadEpisode(0)
    })()
  }, [datasetFromQuery, inspect, loadEpisode, setDataset, setSource])

  useEffect(() => {
    if (!isReviewMode) return
    void loadLibrary()
  }, [isReviewMode, loadLibrary])

  useEffect(() => {
    if (!isReviewMode || source !== 'local' || !dataset.trim()) return
    void loadReviewWorkspace(dataset.trim())
  }, [dataset, isReviewMode, source])

  const summaryPayload = asRecord(summary?.summary)
  const detailsPayload = asRecord(details)
  const episodeRows = useMemo(() => asArray(asRecord(episodes).episodes).map(asRecord), [episodes])
  const episodePayload = asRecord(episode)
  const totalEpisodes = numberValue(summaryPayload.total_episodes) ?? numberValue(asRecord(episodes).total_episodes) ?? 0
  const reviewDatasetCandidates = useMemo(() => datasets.filter(isReviewCandidate), [datasets])

  async function inspectThenLoad(nextEpisodeIndex = 0) {
    if (!dataset.trim()) return
    await inspect()
    setEpisodeIndex(nextEpisodeIndex)
    await loadEpisode(nextEpisodeIndex)
  }

  async function loadSelectedEpisode(nextEpisodeIndex = episodeIndex) {
    setEpisodeIndex(nextEpisodeIndex)
    setFailureOpen(false)
    setFailureReason('')
    setFailureNote('')
    await loadEpisode(nextEpisodeIndex)
  }

  async function loadReviewWorkspace(datasetId: string) {
    setReviewLoading(true)
    setReviewError('')
    try {
      const workspace = await dataApi.reviewWorkspace({ dataset_id: datasetId })
      setReviewWorkspace(workspace)
      setDraftTaskDescription(reviewTaskDescription(workspace))
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewLoading(false)
    }
  }

  async function runAutoClean() {
    if (source !== 'local' || !dataset.trim()) return
    const job = await dataApi.startAutoCleanRun({ dataset_ids: [dataset.trim()], chain_id: 'default', force: true })
    attach(job)
  }

  async function saveDraftTaskDescription() {
    if (!isReviewMode || !dataset.trim()) return
    setReviewSaving(true)
    setReviewError('')
    try {
      const workspace = await dataApi.saveReviewDraft(dataset.trim(), {
        draft_edits: { task_description: draftTaskDescription },
        reviewer_id: reviewerId,
      })
      setReviewWorkspace(workspace)
      await loadLibrary()
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewSaving(false)
    }
  }

  async function saveReviewDecision(decision: DataReviewDecision) {
    if (!isReviewMode || !dataset.trim() || !reviewWorkspace) return
    if (decision === 'failed' && !failureReason) {
      setReviewError(t('dataReviewFailureReasonRequired'))
      return
    }
    setReviewSaving(true)
    setReviewError('')
    try {
      const workspace = await dataApi.saveReviewEpisode(dataset.trim(), episodeIndex, {
        decision,
        reason: decision === 'failed' ? failureReason : '',
        note: decision === 'failed' ? failureNote : '',
        reviewer_id: reviewerId,
      })
      setReviewWorkspace(workspace)
      await loadLibrary()
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
    const nextDatasetId = nextReviewDatasetId(reviewDatasetCandidates, workspace.dataset.id)
    if (nextDatasetId) {
      const encodedDataset = encodeURIComponent(nextDatasetId)
      navigate(`/data/analysis?mode=review&dataset=${encodedDataset}&returnTo=data-manage&manageDataset=${encodedDataset}`)
      return
    }
    setReviewError(t('dataReviewAllDone'))
  }

  function returnToManage() {
    const targetDataset = manageDataset || dataset.trim()
    const query = targetDataset ? `?dataset=${encodeURIComponent(targetDataset)}` : ''
    navigate(`/data/manage${query}`)
  }

  return (
    <section className="data-page data-analysis-page">
      <section className="data-panel">
        <div className="data-analysis-query">
          {returnTo === 'data-manage' && (
            <button type="button" className="data-analysis-return" onClick={returnToManage}>
              {t('dataAnalysisBackToManage')}
            </button>
          )}
          <select value={source} onChange={(event) => setSource(event.target.value as SourceMode)}>
            <option value="local">本地数据</option>
            <option value="remote">HuggingFace 数据</option>
          </select>
          <input
            value={dataset}
            onChange={(event) => setDataset(event.target.value)}
            placeholder={source === 'remote' ? 'namespace/dataset' : 'local/name'}
          />
          <button type="button" onClick={() => void inspectThenLoad(0)} disabled={loading || !dataset.trim()}>
            检查
          </button>
          <button type="button" onClick={() => void runAutoClean()} disabled={loading || source !== 'local' || !dataset.trim()}>
            自动清洗
          </button>
        </div>
        {error && <div className="data-alert">{error}</div>}
      </section>

      {isReviewMode && reviewWorkspace && (
        <ReviewProgressPanel
          workspace={reviewWorkspace}
          episodeIndex={episodeIndex}
          loading={reviewLoading}
          saving={reviewSaving}
          draftTaskDescription={draftTaskDescription}
          onDraftTaskDescriptionChange={setDraftTaskDescription}
          onSaveDraft={() => void saveDraftTaskDescription()}
          onEpisodeSelect={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
        />
      )}
      {isReviewMode && reviewError && <div className="data-alert">{reviewError}</div>}

      <DatasetStatsPanel
        summary={summaryPayload}
        details={detailsPayload}
        episodeRows={episodeRows}
      />

      {isReviewMode && reviewWorkspace && (
        <ReviewDecisionPanel
          workspace={reviewWorkspace}
          episodeIndex={episodeIndex}
          saving={reviewSaving}
          failureOpen={failureOpen}
          failureReason={failureReason}
          failureNote={failureNote}
          onFailureOpen={() => setFailureOpen(true)}
          onFailureReasonChange={setFailureReason}
          onFailureNoteChange={setFailureNote}
          onPass={() => void saveReviewDecision('passed')}
          onFail={() => void saveReviewDecision('failed')}
        />
      )}

      {Object.keys(episodePayload).length > 0 ? (
        <EpisodePlaybackPanel
          episode={episodePayload}
          episodeIndex={episodeIndex}
          totalEpisodes={totalEpisodes}
          loading={loading}
          canLoadEpisode={Boolean(dataset.trim())}
          onEpisodeIndexChange={setEpisodeIndex}
          onLoadEpisode={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
        />
      ) : (
        <section className="data-panel">
          <div className="data-panel__title">
            <h2>Episode 可视化</h2>
            <div className="data-analysis-player__summary">
              <button type="button" onClick={() => void loadSelectedEpisode()} disabled={loading || !dataset.trim()}>
                加载 Episode #{episodeIndex}
              </button>
            </div>
          </div>
          <div className="data-empty">{textValue(summary?.dataset) ? '选择一个 episode 后加载视频和曲线' : '先检查数据集'}</div>
        </section>
      )}
    </section>
  )
}

function ReviewProgressPanel({
  workspace,
  episodeIndex,
  loading,
  saving,
  draftTaskDescription,
  onDraftTaskDescriptionChange,
  onSaveDraft,
  onEpisodeSelect,
}: {
  workspace: DataReviewWorkspace
  episodeIndex: number
  loading: boolean
  saving: boolean
  draftTaskDescription: string
  onDraftTaskDescriptionChange: (value: string) => void
  onSaveDraft: () => void
  onEpisodeSelect: (episodeIndex: number) => void
}) {
  const { t } = useI18n()
  const reviewedCount = workspace.episode_indices.filter((index) => workspace.review.episodes[String(index)]).length
  const total = workspace.episode_indices.length
  const currentPosition = Math.max(0, workspace.episode_indices.indexOf(episodeIndex))
  const progress = total ? Math.round((reviewedCount / total) * 100) : 0
  return (
    <section className="data-panel data-review-progress-panel">
      <div className="data-review-progress-panel__head">
        <div>
          <span>{t('dataReviewModeTitle')}</span>
          <strong>{workspace.dataset.label}</strong>
        </div>
        <div className="data-review-progress-panel__meta">
          <span>{t('dataReviewEpisodeProgress', { current: currentPosition + 1, total: Math.max(total, 1) })}</span>
          <span>{t('dataReviewReviewedCount', { reviewed: reviewedCount, total })}</span>
          <span>{t(reviewStatusLabel(workspace.review.status))}</span>
        </div>
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
      <div className="data-review-draft">
        <label>
          <span>{t('dataReviewTaskDraft')}</span>
          <input
            value={draftTaskDescription}
            onChange={(event) => onDraftTaskDescriptionChange(event.target.value)}
            placeholder={datasetTaskDescription(workspace.dataset) || t('dataReviewTaskDraftPlaceholder')}
          />
        </label>
        <button type="button" className="data-analysis-secondary-button" onClick={onSaveDraft} disabled={saving || loading}>
          {t('dataReviewSaveDraft')}
        </button>
      </div>
    </section>
  )
}

function ReviewDecisionPanel({
  workspace,
  episodeIndex,
  saving,
  failureOpen,
  failureReason,
  failureNote,
  onFailureOpen,
  onFailureReasonChange,
  onFailureNoteChange,
  onPass,
  onFail,
}: {
  workspace: DataReviewWorkspace
  episodeIndex: number
  saving: boolean
  failureOpen: boolean
  failureReason: string
  failureNote: string
  onFailureOpen: () => void
  onFailureReasonChange: (value: string) => void
  onFailureNoteChange: (value: string) => void
  onPass: () => void
  onFail: () => void
}) {
  const { t } = useI18n()
  const currentDecision = workspace.review.episodes[String(episodeIndex)]
  if (!workspace.episode_indices.length) {
    return (
      <section className="data-panel data-review-decision-panel">
        <div className="data-empty">{t('dataReviewNoEpisodes')}</div>
      </section>
    )
  }
  return (
    <section className="data-panel data-review-decision-panel">
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
      <div className="data-review-decision-panel__actions">
        <button type="button" className="data-review-pass-button" onClick={onPass} disabled={saving}>
          {t('dataReviewPass')}
        </button>
        <button type="button" className="data-review-fail-button" onClick={onFailureOpen} disabled={saving}>
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
            disabled={saving || !failureReason}
          >
            {t('dataReviewSubmitFail')}
          </button>
        </div>
      )}
    </section>
  )
}

function reviewTaskDescription(workspace: DataReviewWorkspace): string {
  const draftTask = workspace.review.draft_edits.task_description
  return typeof draftTask === 'string' ? draftTask : datasetTaskDescription(workspace.dataset)
}

function nextUnreviewedEpisodeIndex(workspace: DataReviewWorkspace, currentEpisodeIndex: number): number | null {
  const indices = workspace.episode_indices
  const currentPosition = indices.indexOf(currentEpisodeIndex)
  const afterCurrent = indices.slice(Math.max(currentPosition + 1, 0))
  const beforeCurrent = currentPosition >= 0 ? indices.slice(0, currentPosition + 1) : indices
  const next = [...afterCurrent, ...beforeCurrent].find((index) => !workspace.review.episodes[String(index)])
  return next ?? null
}

function nextReviewDatasetId(datasets: Dataset[], currentDatasetId: string): string {
  const ids = datasets.map((dataset) => dataset.id)
  const currentIndex = ids.indexOf(currentDatasetId)
  if (currentIndex < 0) return ids[0] || ''
  return ids.slice(currentIndex + 1)[0] || ''
}

function isReviewCandidate(dataset: Dataset): boolean {
  const reviewStatus = qcReviewStatus(dataset)
  if (reviewStatus === 'ready_for_batch' || reviewStatus === 'applied') return false
  if (reviewStatus === 'pending' || reviewStatus === 'in_progress') return true
  return buildDatasetQualityView(dataset).manualReviewStatus === 'needs_review'
}

function reviewStatusLabel(status: DataReviewWorkspace['review']['status']): TranslationKey {
  if (status === 'in_progress') return 'dataReviewStatusInProgress'
  if (status === 'ready_for_batch') return 'dataReviewStatusReadyForBatch'
  if (status === 'applied') return 'dataReviewStatusApplied'
  return 'dataReviewStatusPending'
}

function currentReviewerId(user: { id?: string; phone?: string; nickname?: string | null } | null): string {
  return user?.id || user?.phone || user?.nickname || ''
}
