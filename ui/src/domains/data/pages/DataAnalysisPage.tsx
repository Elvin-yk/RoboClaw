import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DatasetStatsPanel } from '@/domains/data/components/DatasetStatsPanel'
import { EpisodePlaybackPanel } from '@/domains/data/components/EpisodePlaybackPanel'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useI18n } from '@/i18n'
import {
  asArray,
  asRecord,
  numberValue,
  textValue,
} from '@/domains/data/lib/analysisPayload'

type SourceMode = 'remote' | 'local'

export default function DataAnalysisPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useI18n()
  const { attach } = useDataJobStore()
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
  const loadedDatasetFromQuery = useRef('')
  const datasetFromQuery = searchParams.get('dataset') || ''
  const returnTo = searchParams.get('returnTo') || ''
  const manageDataset = searchParams.get('manageDataset') || datasetFromQuery

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

  const summaryPayload = asRecord(summary?.summary)
  const detailsPayload = asRecord(details)
  const episodeRows = useMemo(() => asArray(asRecord(episodes).episodes).map(asRecord), [episodes])
  const episodePayload = asRecord(episode)
  const totalEpisodes = numberValue(summaryPayload.total_episodes) ?? numberValue(asRecord(episodes).total_episodes) ?? 0

  async function inspectThenLoad(nextEpisodeIndex = 0) {
    if (!dataset.trim()) return
    await inspect()
    setEpisodeIndex(nextEpisodeIndex)
    await loadEpisode(nextEpisodeIndex)
  }

  async function loadSelectedEpisode(nextEpisodeIndex = episodeIndex) {
    setEpisodeIndex(nextEpisodeIndex)
    await loadEpisode(nextEpisodeIndex)
  }

  async function runAutoClean() {
    if (source !== 'local' || !dataset.trim()) return
    const job = await dataApi.startAutoCleanRun({ dataset_ids: [dataset.trim()], chain_id: 'default', force: true })
    attach(job)
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

      <DatasetStatsPanel
        summary={summaryPayload}
        details={detailsPayload}
        episodeRows={episodeRows}
      />

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
