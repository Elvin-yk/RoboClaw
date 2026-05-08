import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DatasetStatsPanel } from '@/domains/data/components/DatasetStatsPanel'
import { EpisodePlaybackPanel } from '@/domains/data/components/EpisodePlaybackPanel'
import { useDataInspectStore } from '@/domains/data/store/inspectStore'
import {
  asArray,
  asRecord,
  numberValue,
  textValue,
} from '@/domains/data/lib/analysisPayload'

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
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const loadedDatasetFromQuery = useRef('')
  const datasetFromQuery = searchParams.get('dataset') || ''

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

  return (
    <section className="data-page data-analysis-page">
      <section className="data-panel">
        <div className="data-analysis-query">
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
