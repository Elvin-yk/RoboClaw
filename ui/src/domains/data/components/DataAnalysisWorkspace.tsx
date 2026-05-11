import { useMemo } from 'react'
import { asArray, asRecord, numberValue, textValue } from '@/domains/data/lib/analysisPayload'
import { useI18n } from '@/i18n'
import { DatasetStatsPanel } from './DatasetStatsPanel'
import { EpisodePlaybackPanel } from './EpisodePlaybackPanel'

interface DataAnalysisWorkspaceProps {
  summary: unknown
  details: unknown
  episodes: unknown
  episode: unknown
  episodeIndex: number
  totalEpisodesFallback?: number
  loading: boolean
  canLoadEpisode: boolean
  error?: string
  emptyLabel?: string
  onEpisodeIndexChange: (episodeIndex: number) => void
  onLoadEpisode: (episodeIndex: number) => void
}

export function DataAnalysisWorkspace({
  summary,
  details,
  episodes,
  episode,
  episodeIndex,
  totalEpisodesFallback = 0,
  loading,
  canLoadEpisode,
  error,
  emptyLabel,
  onEpisodeIndexChange,
  onLoadEpisode,
}: DataAnalysisWorkspaceProps) {
  const { t } = useI18n()
  const summaryRoot = asRecord(summary)
  const summaryPayload = asRecord(summaryRoot.summary)
  const detailsPayload = asRecord(details)
  const episodeRows = useMemo(() => asArray(asRecord(episodes).episodes).map(asRecord), [episodes])
  const episodePayload = asRecord(episode)
  const totalEpisodes = numberValue(summaryPayload.total_episodes)
    ?? numberValue(asRecord(episodes).total_episodes)
    ?? totalEpisodesFallback
  const hasLoadedDataset = Boolean(textValue(summaryRoot.dataset) || Object.keys(summaryPayload).length)

  if (!hasLoadedDataset) {
    return (
      <>
        {error && <div className="data-alert">{error}</div>}
        <section className="data-panel">
          <div className="data-empty">{emptyLabel || (loading ? t('dataAnalysisLoading') : t('dataAnalysisInspectFirst'))}</div>
        </section>
      </>
    )
  }

  return (
    <>
      {error && <div className="data-alert">{error}</div>}
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
          canLoadEpisode={canLoadEpisode}
          onEpisodeIndexChange={onEpisodeIndexChange}
          onLoadEpisode={onLoadEpisode}
        />
      ) : (
        <section className="data-panel">
          <div className="data-panel__title">
            <h2>{t('dataAnalysisEpisodeVisualization')}</h2>
            <div className="data-analysis-player__summary">
              <button type="button" onClick={() => onLoadEpisode(episodeIndex)} disabled={loading || !canLoadEpisode}>
                {t('dataAnalysisLoadEpisode', { index: episodeIndex })}
              </button>
            </div>
          </div>
          <div className="data-empty">{emptyLabel || (hasLoadedDataset ? t('dataAnalysisSelectEpisodePrompt') : t('dataAnalysisInspectFirst'))}</div>
        </section>
      )}
    </>
  )
}
