import { useEffect, useMemo, useState } from 'react'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useDataLifecycleStore } from '@/domains/data/store/lifecycleStore'
import { dataGateLabelKey, dataGateStatusLabelKey } from '@/domains/data/model/gates'
import type { DataGate, Dataset } from '@/domains/data/model/types'
import { useI18n, type TranslationKey } from '@/i18n'

type StageFilter = 'all' | Dataset['lifecycle_stage']
type RepairableFilter = 'all' | 'yes' | 'no'

const STAGE_LABEL_KEYS: Record<string, TranslationKey> = {
  raw: 'dataStageRaw',
  inspecting: 'dataStageInspecting',
  cleaning: 'dataStageCleaning',
  needs_review: 'dataStageNeedsReview',
  clean: 'dataQcStageClean',
  excluded: 'dataStageExcluded',
}

export default function DataQcPage() {
  const { t } = useI18n()
  const { datasets, selectedDatasetIds, loading, error, load, toggleDataset, clearSelection } = useDataLibraryStore()
  const { startDiagnosis, startClean, passReview } = useDataLifecycleStore()
  const { jobs, cancel } = useDataJobStore()
  const [query, setQuery] = useState('')
  const [stageFilter, setStageFilter] = useState<StageFilter>('all')
  const [damageFilter, setDamageFilter] = useState('all')
  const [repairableFilter, setRepairableFilter] = useState<RepairableFilter>('all')

  useEffect(() => {
    void load()
  }, [load])

  const damageTypes = useMemo(() => {
    const values = new Set<string>()
    datasets.forEach((dataset) => {
      const damageType = diagnosis(dataset).damage_type
      if (damageType) values.add(String(damageType))
    })
    return Array.from(values).sort()
  }, [datasets])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return datasets.filter((dataset) => {
      const diagnosisPayload = diagnosis(dataset)
      if (needle && !`${dataset.id} ${dataset.label} ${dataset.path}`.toLowerCase().includes(needle)) {
        return false
      }
      if (stageFilter !== 'all' && dataset.lifecycle_stage !== stageFilter) return false
      if (damageFilter !== 'all' && diagnosisPayload.damage_type !== damageFilter) return false
      if (repairableFilter !== 'all') {
        const repairable = Boolean(diagnosisPayload.repairable)
        if (repairable !== (repairableFilter === 'yes')) return false
      }
      return true
    })
  }, [damageFilter, datasets, query, repairableFilter, stageFilter])

  const summary = useMemo(() => ({
    total: datasets.length,
    raw: datasets.filter((dataset) => dataset.lifecycle_stage === 'raw').length,
    needsReview: datasets.filter((dataset) => dataset.lifecycle_stage === 'needs_review').length,
    clean: datasets.filter((dataset) => dataset.lifecycle_stage === 'clean').length,
    damaged: datasets.filter((dataset) => {
      const damageType = diagnosis(dataset).damage_type
      return damageType && damageType !== 'healthy'
    }).length,
  }), [datasets])

  const qcJobs = Object.values(jobs).filter((job) => job.kind === 'diagnose' || job.kind === 'clean')

  async function runDiagnosis() {
    await startDiagnosis(selectedDatasetIds)
  }

  async function runClean() {
    await startClean(selectedDatasetIds)
  }

  async function approve(datasetId: string) {
    await passReview(datasetId)
    await load()
  }

  return (
    <section className="data-page">
      <div className="data-page__page-actions">
        <div className="data-actions">
          <button type="button" onClick={() => void runDiagnosis()} disabled={selectedDatasetIds.length === 0}>{t('dataQcRunDiagnosis')}</button>
          <button type="button" onClick={() => void runClean()} disabled={selectedDatasetIds.length === 0}>{t('dataQcRunQc')}</button>
          <button type="button" onClick={() => void load()} disabled={loading}>{t('refresh')}</button>
        </div>
      </div>

      {error && <div className="data-alert">{error}</div>}

      <div className="data-grid data-grid--five">
        <Metric title={t('dataQcDatasetsMetric')} value={summary.total} />
        <Metric title={t('dataQcRawMetric')} value={summary.raw} />
        <Metric title={t('dataQcNeedsReviewMetric')} value={summary.needsReview} />
        <Metric title={t('dataQcCleanMetric')} value={summary.clean} />
        <Metric title={t('dataQcDamagedMetric')} value={summary.damaged} />
      </div>

      <section className="data-panel">
        <div className="data-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('dataQcFilterPlaceholder')} />
          <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as StageFilter)}>
            <option value="all">{t('dataQcAllStages')}</option>
            {Object.keys(STAGE_LABEL_KEYS).map((stage) => <option key={stage} value={stage}>{stageLabel(stage, t)}</option>)}
          </select>
          <select value={damageFilter} onChange={(event) => setDamageFilter(event.target.value)}>
            <option value="all">{t('dataQcAllDiagnoses')}</option>
            {damageTypes.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
          <select value={repairableFilter} onChange={(event) => setRepairableFilter(event.target.value as RepairableFilter)}>
            <option value="all">{t('dataQcAllRepairability')}</option>
            <option value="yes">{t('dataQcAutoRepairable')}</option>
            <option value="no">{t('dataQcManualRequired')}</option>
          </select>
          <button type="button" onClick={clearSelection} disabled={selectedDatasetIds.length === 0}>{t('clearSelection')}</button>
        </div>
      </section>

      <section className="data-panel">
        <div className="data-panel__title">
          <h2>{t('dataQcQueueTitle')}</h2>
          <span>{filtered.length} / {datasets.length}</span>
        </div>
        <div className="data-list">
          {filtered.map((dataset) => {
            const diagnosisPayload = diagnosis(dataset)
            return (
              <div key={dataset.id} className="data-row data-row--rich">
                <input
                  type="checkbox"
                  checked={selectedDatasetIds.includes(dataset.id)}
                  onChange={() => toggleDataset(dataset.id)}
                />
                <span>
                  <strong>{dataset.label}</strong>
                  <small>{dataset.id}</small>
                  <small>{dataset.path}</small>
                </span>
                <div className="data-pill-row">
                  <span className={`data-badge data-badge--${dataset.lifecycle_stage}`}>
                    {stageLabel(dataset.lifecycle_stage, t)}
                  </span>
                  <span className="data-badge">{diagnosisLabel(diagnosisPayload.damage_type, t)}</span>
                  {diagnosisPayload.repairable !== undefined && (
                    <span className={`data-badge data-badge--${diagnosisPayload.repairable ? 'passed' : 'failed'}`}>
                      {diagnosisPayload.repairable ? t('dataQcAutoRepairable') : t('dataQcManualRequired')}
                    </span>
                  )}
                </div>
                <span className="data-gates">
                  {Object.values(dataset.gates).map((gate) => (
                    <span key={gate.key} className={`data-gate data-gate--${gate.status}`}>
                      {gateChipText(gate, t)}
                    </span>
                  ))}
                </span>
                {dataset.lifecycle_stage === 'needs_review' && (
                  <button type="button" onClick={() => void approve(dataset.id)}>{t('dataQcApprove')}</button>
                )}
              </div>
            )
          })}
          {!filtered.length && <div className="data-empty">{t('dataQcEmptyDatasets')}</div>}
        </div>
      </section>

      <section className="data-panel">
        <div className="data-panel__title"><h2>{t('dataQcJobsTitle')}</h2></div>
        <div className="data-list">
          {qcJobs.map((job) => (
            <div key={job.job_id} className="data-row">
              <span>
                <strong>{job.kind}</strong>
                <small>{job.target_id}</small>
                <small>{job.message}</small>
              </span>
              <span>{job.processed}/{job.total}</span>
              <span className={`data-badge data-badge--${job.phase}`}>{job.phase}</span>
              {!['completed', 'failed', 'cancelled'].includes(job.phase) && (
                <button type="button" onClick={() => void cancel(job.job_id)}>{t('cancel')}</button>
              )}
            </div>
          ))}
          {!qcJobs.length && <div className="data-empty">{t('dataQcEmptyJobs')}</div>}
        </div>
      </section>
    </section>
  )
}

function Metric({ title, value }: { title: string; value: number }) {
  return (
    <section className="data-panel data-panel--metric">
      <span>{title}</span>
      <strong className="data-metric">{value}</strong>
    </section>
  )
}

function diagnosis(dataset: Dataset): Record<string, unknown> {
  const gate = dataset.gates.diagnose
  return gate?.details || {}
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function diagnosisLabel(value: unknown, t: (key: TranslationKey) => string): string {
  const text = textValue(value)
  if (!text) return t('dataQcNotDiagnosed')
  if (text === 'healthy') return t('dataQcHealthy')
  return text
}

function stageLabel(stage: string, t: (key: TranslationKey) => string): string {
  const key = STAGE_LABEL_KEYS[stage]
  return key ? t(key) : stage
}

function gateChipText(gate: DataGate, t: (key: TranslationKey) => string): string {
  const labelKey = dataGateLabelKey(gate.key)
  const label = labelKey ? t(labelKey) : gate.key
  return `${label}:${t(dataGateStatusLabelKey(gate.status))}`
}
