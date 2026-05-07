import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'

type SourceMode = 'remote' | 'local'

export default function DataAnalysisPage() {
  const [searchParams] = useSearchParams()
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
  const { packages, load } = useDataLibraryStore()
  const { attach } = useDataJobStore()
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [packageId, setPackageId] = useState('')
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null)
  const [results, setResults] = useState<Record<string, unknown> | null>(null)
  const [selectedValidators, setSelectedValidators] = useState<string[]>([])
  const [resultFilter, setResultFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const loadedDatasetFromQuery = useRef('')
  const loadedPackageFromQuery = useRef('')
  const datasetFromQuery = searchParams.get('dataset') || ''
  const packageFromQuery = searchParams.get('package') || ''

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!datasetFromQuery || loadedDatasetFromQuery.current === datasetFromQuery) return
    loadedDatasetFromQuery.current = datasetFromQuery
    setSource('local')
    setDataset(datasetFromQuery)
    void inspect()
  }, [datasetFromQuery, inspect, setDataset, setSource])

  const summaryPayload = asRecord(summary?.summary)
  const detailsPayload = asRecord(details)
  const episodeRows = useMemo(() => asArray(asRecord(episodes).episodes).map(asRecord), [episodes])
  const episodePayload = asRecord(episode)
  const episodeSummary = asRecord(episodePayload.summary)
  const sampleRows = asArray(episodePayload.sample_rows).map(asRecord)
  const videos = asArray(episodePayload.videos).map(asRecord)
  const trajectory = asRecord(episodePayload.joint_trajectory)
  const trajectoryItems = asArray(trajectory.joint_trajectories).map(asRecord)
  const resultPayload = asRecord(results?.results)
  const resultEpisodes = asArray(resultPayload.episodes).map(asRecord)
  const filteredResultEpisodes = resultEpisodes.filter((item) => {
    if (resultFilter === 'all') return true
    return Boolean(item.passed) === (resultFilter === 'passed')
  })
  const checks = asRecord(defaults?.checks)
  const profile = asRecord(defaults?.profile)

  async function runInspect() {
    await inspect()
    setEpisodeIndex(0)
  }

  async function selectPackage(nextPackageId: string) {
    setPackageId(nextPackageId)
    setDefaults(null)
    setResults(null)
    setSelectedValidators([])
    if (!nextPackageId) return
    const [nextDefaults, nextResults] = await Promise.all([
      dataApi.evaluationDefaults(nextPackageId),
      dataApi.evaluationResults(nextPackageId),
    ])
    setDefaults(nextDefaults)
    setResults(nextResults)
    const defaultsValidators = asArray(nextDefaults.selected_validators).map(String)
    setSelectedValidators(defaultsValidators.length ? defaultsValidators : ['metadata'])
  }

  useEffect(() => {
    if (!packageFromQuery || loadedPackageFromQuery.current === packageFromQuery) return
    loadedPackageFromQuery.current = packageFromQuery
    void selectPackage(packageFromQuery)
  }, [packageFromQuery])

  async function runEvaluation() {
    if (!packageId) return
    const job = await dataApi.startEvaluationRun({
      package_id: packageId,
      selected_validators: selectedValidators,
    })
    attach(job)
  }

  function toggleValidator(validator: string) {
    setSelectedValidators((current) => (
      current.includes(validator)
        ? current.filter((item) => item !== validator)
        : [...current, validator]
    ))
  }

  return (
    <section className="data-page">
      <section className="data-panel">
        <div className="data-panel__title data-panel__title--actions-only">
          <button type="button" onClick={() => void runInspect()} disabled={loading}>检查</button>
        </div>
        <div className="data-toolbar">
          <select value={source} onChange={(event) => setSource(event.target.value as SourceMode)}>
            <option value="local">本地数据</option>
            <option value="remote">HuggingFace 数据</option>
          </select>
          <input
            value={dataset}
            onChange={(event) => setDataset(event.target.value)}
            placeholder={source === 'remote' ? 'namespace/dataset' : 'local/name'}
          />
        </div>
        {error && <div className="data-alert">{error}</div>}
      </section>

      <div className="data-grid data-grid--four">
        <Metric title="Episodes" value={numberText(summaryPayload.total_episodes)} />
        <Metric title="Frames" value={numberText(summaryPayload.total_frames)} />
        <Metric title="FPS" value={numberText(summaryPayload.fps)} />
        <Metric title="Robot" value={textValue(summaryPayload.robot_type) || '-'} />
      </div>

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title"><h2>结构概览</h2></div>
          <div className="data-key-values">
            <KeyValue label="Dataset" value={textValue(summary?.dataset) || textValue(detailsPayload.dataset) || '-'} />
            <KeyValue label="数据文件" value={numberText(detailsPayload.data_file_count)} />
            <KeyValue label="视频文件" value={numberText(detailsPayload.video_file_count)} />
            <KeyValue label="Features" value={asArray(summaryPayload.features).map(String).join(', ') || '-'} />
          </div>
        </section>
        <section className="data-panel">
          <div className="data-panel__title">
            <h2>Episodes</h2>
            <span>{numberText(asRecord(episodes).total_episodes || episodeRows.length)}</span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Index</th>
                  <th>Frames</th>
                  <th>Range</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {episodeRows.slice(0, 12).map((row, index) => {
                  const indexValue = Number(row.episode_index ?? index)
                  return (
                    <tr key={`${indexValue}-${index}`}>
                      <td>{indexValue}</td>
                      <td>{numberText(row.length)}</td>
                      <td>{numberText(row.dataset_from_index)} - {numberText(row.dataset_to_index)}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setEpisodeIndex(indexValue)
                            void loadEpisode(indexValue)
                          }}
                        >
                          查看
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="data-panel">
        <div className="data-panel__title">
          <h2>Episode 可视化</h2>
          <div className="data-toolbar data-toolbar--compact">
            <input
              type="number"
              value={episodeIndex}
              onChange={(event) => setEpisodeIndex(Number(event.target.value))}
            />
            <button type="button" onClick={() => void loadEpisode(episodeIndex)}>加载</button>
          </div>
        </div>
        <div className="data-grid data-grid--two">
          <div>
            <div className="data-key-values">
              <KeyValue label="Rows" value={numberText(episodeSummary.row_count)} />
              <KeyValue label="Duration" value={`${numberText(episodeSummary.duration_s)}s`} />
              <KeyValue label="Videos" value={numberText(episodeSummary.video_count)} />
              <KeyValue label="Trajectory points" value={numberText(trajectory.total_points)} />
            </div>
            <div className="data-video-grid">
              {videos.map((video, index) => (
                <figure key={`${textValue(video.path)}-${index}`} className="data-video">
                  <video src={textValue(video.url)} controls preload="metadata" />
                  <figcaption>{textValue(video.stream) || textValue(video.path)}</figcaption>
                </figure>
              ))}
              {!videos.length && <div className="data-empty">未加载视频</div>}
            </div>
          </div>
          <div>
            <h3 className="data-subtitle">Sample rows</h3>
            <SimpleTable rows={sampleRows.slice(0, 5)} />
            <h3 className="data-subtitle">Trajectory</h3>
            <div className="data-bar-list">
              {trajectoryItems.slice(0, 8).map((item, index) => (
                <div key={`${textValue(item.name)}-${index}`} className="data-bar-row">
                  <span>{textValue(item.name) || `joint_${index}`}</span>
                  <strong>{numberText(asArray(item.values).length)}</strong>
                </div>
              ))}
              {!trajectoryItems.length && <div className="data-empty">未加载轨迹</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="data-panel">
        <div className="data-panel__title">
          <h2>数据评估</h2>
          <button type="button" onClick={() => void runEvaluation()} disabled={!packageId || selectedValidators.length === 0}>
            运行评估
          </button>
        </div>
        <div className="data-toolbar">
          <select value={packageId} onChange={(event) => void selectPackage(event.target.value)}>
            <option value="">选择 DatasetPackage</option>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <button type="button" onClick={() => packageId && void selectPackage(packageId)} disabled={!packageId}>刷新结果</button>
        </div>
        <div className="data-grid data-grid--two data-grid--top">
          <div>
            <div className="data-check-list">
              {asArray(defaults?.selected_validators).map(String).map((validator) => (
                <label key={validator} className="data-check">
                  <input
                    type="checkbox"
                    checked={selectedValidators.includes(validator)}
                    onChange={() => toggleValidator(validator)}
                  />
                  <span>{validator}</span>
                </label>
              ))}
              {!defaults && <div className="data-empty">选择 package 后加载评估默认值</div>}
            </div>
            <div className="data-key-values data-key-values--dense">
              {Object.entries(checks).map(([key, value]) => <KeyValue key={key} label={key} value={String(value)} />)}
              {Object.entries(profile).slice(0, 8).map(([key, value]) => (
                <KeyValue key={key} label={key} value={Array.isArray(value) ? value.join(', ') : String(value)} />
              ))}
            </div>
          </div>
          <div>
            <div className="data-grid data-grid--three">
              <Metric title="Total" value={numberText(resultPayload.total)} />
              <Metric title="Passed" value={numberText(resultPayload.passed)} />
              <Metric title="Score" value={numberText(resultPayload.overall_score)} />
            </div>
            <div className="data-toolbar data-toolbar--spaced">
              <button type="button" onClick={() => setResultFilter('all')}>全部</button>
              <button type="button" onClick={() => setResultFilter('passed')}>通过</button>
              <button type="button" onClick={() => setResultFilter('failed')}>风险</button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Episode</th>
                    <th>Score</th>
                    <th>Decision</th>
                    <th>Issues</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResultEpisodes.slice(0, 20).map((item, index) => (
                    <tr key={`${item.episode_index}-${index}`}>
                      <td>{numberText(item.episode_index)}</td>
                      <td>{numberText(item.score)}</td>
                      <td>{textValue(item.decision_label) || (item.passed ? 'accept' : 'reject')}</td>
                      <td>{asArray(item.issues).length}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredResultEpisodes.length && <div className="data-empty">暂无评估结果</div>}
            </div>
          </div>
        </div>
      </section>
    </section>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <section className="data-panel data-panel--metric">
      <span>{title}</span>
      <strong className="data-metric">{value}</strong>
    </section>
  )
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-key-value">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SimpleTable({ rows }: { rows: Array<Record<string, unknown>> }) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 6)
  if (!rows.length || !columns.length) return <div className="data-empty">无样本行</div>
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => <td key={column}>{compactValue(row[column])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function numberText(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2)
  if (typeof value === 'string' && value.trim()) return value
  return '0'
}

function compactValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 4 ? `${value.slice(0, 4).join(', ')}...` : value.join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  return textValue(value)
}
