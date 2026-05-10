import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { DataDateRangeFilter, isDateInFilter, type DateFilterValue } from '@/domains/data/components/DataDateRangeFilter'
import { EpisodePlaybackPanel } from '@/domains/data/components/EpisodePlaybackPanel'
import { asRecord, numberValue, textValue } from '@/domains/data/lib/analysisPayload'
import {
  buildDatasetQualityView,
  matchesDatasetText,
  type QualityStatus,
} from '@/domains/data/model/datasetQuality'
import type { Dataset } from '@/domains/data/model/types'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'

type ReviewDecision = 'passed' | 'rejected' | 'needs_rework'

interface QcDatasetRecord {
  id: string
  name: string
  path: string
  task: string
  createdDate: string
  autoCleanStatus: QualityStatus
  manualReviewStatus: QualityStatus
  gateFailMessage: string
}

const DEFAULT_DATE_FILTER: DateFilterValue = { preset: 'all', from: '', to: '' }

const QUALITY_STATUS_LABELS: Record<QualityStatus, TranslationKey> = {
  pending: 'dataQualityStatusPending',
  running: 'dataQualityStatusRunning',
  passed: 'dataQualityStatusPassed',
  failed: 'dataQualityStatusFailed',
  needs_review: 'dataQualityStatusNeedsReview',
  skipped: 'dataQualityStatusSkipped',
}

const STAGE_LABEL_KEYS: Record<Dataset['lifecycle_stage'], TranslationKey> = {
  raw: 'dataStageRaw',
  inspecting: 'dataStageInspecting',
  cleaning: 'dataStageCleaning',
  needs_review: 'dataStageNeedsReview',
  clean: 'dataStageClean',
  excluded: 'dataStageExcluded',
}

export default function DataQcPage() {
  const { t } = useI18n()
  const [searchParams, setSearchParams] = useSearchParams()
  const { datasets, error, load } = useDataLibraryStore()
  const [query, setQuery] = useState('')
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(DEFAULT_DATE_FILTER)
  const [activeDatasetId, setActiveDatasetId] = useState(searchParams.get('dataset') || '')
  const [reviewSessionId, setReviewSessionId] = useState('')
  const [reviewMessage, setReviewMessage] = useState('')

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const datasetId = searchParams.get('dataset') || ''
    if (datasetId) {
      setActiveDatasetId(datasetId)
      setReviewSessionId('')
      setReviewMessage('')
    }
  }, [searchParams])

  const records = useMemo(() => datasets.map(buildQcDatasetRecord), [datasets])
  const filtered = useMemo(() => (
    records.filter((record) => {
      const dataset = datasets.find((item) => item.id === record.id)
      if (!dataset) return false
      return matchesDatasetText(dataset, query) && isDateInFilter(record.createdDate, dateFilter)
    })
  ), [datasets, dateFilter, query, records])
  const reviewQueue = filtered.filter((record) => record.manualReviewStatus === 'needs_review')
  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId) ?? null
  const activeRecord = records.find((record) => record.id === activeDatasetId) ?? null

  function openDataset(record: QcDatasetRecord) {
    setActiveDatasetId(record.id)
    setReviewSessionId('')
    setReviewMessage('')
    setSearchParams({ dataset: record.id })
  }

  async function saveReviewDecision(decision: ReviewDecision) {
    if (!activeDataset || !activeRecord || activeRecord.manualReviewStatus !== 'needs_review') return
    let sessionId = reviewSessionId
    if (!sessionId) {
      const session = await dataApi.startManualReviewSession({ dataset_id: activeDataset.id, chain_id: 'default' })
      sessionId = textValue(session.run_id)
      setReviewSessionId(sessionId)
    }
    await dataApi.saveManualReviewDecision(sessionId, {
      decision,
      message: reviewMessage.trim(),
      details: { dataset_id: activeDataset.id, source: 'data_qc_page' },
    })
    setReviewSessionId('')
    setReviewMessage('')
    await load()
  }

  return (
    <section className="data-page data-qc-page">
      {error && <div className="data-alert">{error}</div>}

      <section className="data-panel data-qc-filter-panel">
        <label className="data-qc-task-filter">
          <span>{t('dataQcTaskFilter')}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('dataQcTaskFilterPlaceholder')}
          />
        </label>
        <DataDateRangeFilter value={dateFilter} onChange={setDateFilter} />
      </section>

      <div className="data-qc-review-workspace">
        <section className="data-panel data-qc-review-list-panel">
          <div className="data-qc-lane__head">
            <div>
              <h2>{t('dataQcManualReviewTitle')}</h2>
              <span>{t('dataQcManualReviewQueueCount', { count: reviewQueue.length })}</span>
            </div>
          </div>
          <div className="data-qc-review-queue">
            {reviewQueue.map((record) => (
              <button
                type="button"
                key={record.id}
                className={cn('data-qc-review-item', record.id === activeDatasetId && 'is-active')}
                onClick={() => openDataset(record)}
              >
                <strong>{record.name}</strong>
                <span>{record.task || record.gateFailMessage || t('dataQcNeedsManualReview')}</span>
              </button>
            ))}
            {!reviewQueue.length && <div className="data-empty">{t('dataQcManualQueueEmpty')}</div>}
          </div>
        </section>

        <ManualReviewPanel
          dataset={activeDataset}
          record={activeRecord}
          message={reviewMessage}
          onMessageChange={setReviewMessage}
          onDecision={(decision) => void saveReviewDecision(decision)}
          t={t}
        />
      </div>
    </section>
  )
}

function ManualReviewPanel({
  dataset,
  record,
  message,
  onMessageChange,
  onDecision,
  t,
}: {
  dataset: Dataset | null
  record: QcDatasetRecord | null
  message: string
  onMessageChange: (value: string) => void
  onDecision: (decision: ReviewDecision) => void
  t: (key: TranslationKey, params?: Record<string, string | number>) => string
}) {
  const {
    setSource,
    setDataset,
    inspect,
    loadEpisode,
    episodes,
    episode,
    loading,
    error,
  } = useDataInspectStore()
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [loadedVisualDatasetId, setLoadedVisualDatasetId] = useState('')

  useEffect(() => {
    if (!dataset) return
    const datasetId = dataset.id
    setSource('local')
    setDataset(datasetId)
    setEpisodeIndex(0)
    setLoadedVisualDatasetId('')
    void (async () => {
      await inspect()
      await loadEpisode(0)
      setLoadedVisualDatasetId(datasetId)
    })()
  }, [dataset, inspect, loadEpisode, setDataset, setSource])

  if (!dataset || !record) {
    return <section className="data-panel data-qc-review-empty">{t('dataQcSelectReviewDataset')}</section>
  }

  const diagnosis = asRecord(dataset.gates.diagnose?.details)
  const qc = asRecord(dataset.qc)
  const reports = asRecord(qc.reports)
  const episodePayload = asRecord(episode)
  const totalEpisodes = numberValue(asRecord(episodes).total_episodes) ?? dataset.stats.total_episodes
  const canDecide = record.manualReviewStatus === 'needs_review'

  async function loadSelectedEpisode(nextEpisodeIndex: number) {
    setEpisodeIndex(nextEpisodeIndex)
    await loadEpisode(nextEpisodeIndex)
  }

  return (
    <section className="data-panel data-qc-review-detail">
      <div className="data-qc-review-detail__title">
        <div>
          <strong>{dataset.label}</strong>
          <span>{dataset.stats.task_description || record.task || '-'}</span>
        </div>
        <div className="data-qc-review-detail__statuses">
          <StatusBadge status={record.autoCleanStatus}>{t('dataManageAutoCleanStatus')} · {qualityStatusLabel(record.autoCleanStatus, t)}</StatusBadge>
          <StatusBadge status={record.manualReviewStatus}>{t('dataManageManualReviewStatus')} · {qualityStatusLabel(record.manualReviewStatus, t)}</StatusBadge>
          <span>{t(STAGE_LABEL_KEYS[dataset.lifecycle_stage])}</span>
        </div>
      </div>

      <div className="data-qc-review-cards">
        <InfoCard title={t('dataQcGateFail')}>{record.gateFailMessage || dataset.gates.clean?.message || '-'}</InfoCard>
        <InfoCard title={t('dataQcDoctorReport')}>{reportSummary(reports.lerobot_doctor) || t('dataQcDoctorReportMissing')}</InfoCard>
        <InfoCard title={t('dataQcDatasetPath')}>{dataset.path}</InfoCard>
      </div>

      <InfoCard title={t('dataQcDiagnosisDetails')} wide>
        <pre>{JSON.stringify(diagnosis, null, 2)}</pre>
      </InfoCard>

      <div className="data-qc-review-visuals">
        {error && <div className="data-alert">{error}</div>}
        {loadedVisualDatasetId === dataset.id && Object.keys(episodePayload).length > 0 ? (
          <EpisodePlaybackPanel
            episode={episodePayload}
            episodeIndex={episodeIndex}
            totalEpisodes={totalEpisodes}
            loading={loading}
            canLoadEpisode={Boolean(dataset.id)}
            onEpisodeIndexChange={setEpisodeIndex}
            onLoadEpisode={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
          />
        ) : (
          <div className="data-empty">{t('dataQcReviewVisualsLoading')}</div>
        )}
      </div>

      {canDecide ? (
        <>
          <textarea
            value={message}
            onChange={(event) => onMessageChange(event.target.value)}
            placeholder={t('dataQcReviewMessagePlaceholder')}
          />
          <div className="data-qc-review-actions">
            <button type="button" onClick={() => onDecision('passed')}>{t('dataQcDecisionPassed')}</button>
            <button type="button" onClick={() => onDecision('needs_rework')}>{t('dataQcDecisionNeedsRework')}</button>
            <button type="button" className="data-qc-danger" onClick={() => onDecision('rejected')}>{t('dataQcDecisionRejected')}</button>
          </div>
        </>
      ) : (
        <div className="data-qc-readonly-note">
          {t('dataQcReadonlyStatus', { status: qualityStatusLabel(record.manualReviewStatus, t) })}
        </div>
      )}
    </section>
  )
}

function InfoCard({ title, wide = false, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn('data-qc-info-card', wide && 'data-qc-info-card--wide')}>
      <span>{title}</span>
      <div>{children}</div>
    </div>
  )
}

function StatusBadge({ status, children }: { status: QualityStatus; children: ReactNode }) {
  return <span className={cn('data-qc-status', `is-${status}`)}>{children}</span>
}

function buildQcDatasetRecord(dataset: Dataset): QcDatasetRecord {
  const quality = buildDatasetQualityView(dataset)
  return {
    id: dataset.id,
    name: dataset.label || dataset.name,
    path: dataset.real_path || dataset.path,
    task: quality.taskDescription,
    createdDate: quality.createdDate,
    autoCleanStatus: quality.autoCleanStatus,
    manualReviewStatus: quality.manualReviewStatus,
    gateFailMessage: quality.autoCleanStatus === 'failed' ? quality.autoCleanMessage : '',
  }
}

function qualityStatusLabel(status: QualityStatus, t: (key: TranslationKey) => string): string {
  return t(QUALITY_STATUS_LABELS[status])
}

function reportSummary(value: unknown): string {
  const report = asRecord(value)
  return textValue(report.relative_path) || textValue(value)
}
