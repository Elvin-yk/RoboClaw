import { asRecord } from '@/domains/data/lib/analysisPayload'
import { useI18n } from '@/i18n'
import { EpisodePlaybackPanel } from './EpisodePlaybackPanel'

interface DataEpisodeInspectionWorkspaceProps {
  episode: unknown
  episodeIndex: number
  totalEpisodes: number
  loading: boolean
  canLoadEpisode: boolean
  error?: string
  emptyLabel?: string
  onEpisodeIndexChange: (episodeIndex: number) => void
  onLoadEpisode: (episodeIndex: number) => void
}

export function DataEpisodeInspectionWorkspace({
  episode,
  episodeIndex,
  totalEpisodes,
  loading,
  canLoadEpisode,
  error,
  emptyLabel,
  onEpisodeIndexChange,
  onLoadEpisode,
}: DataEpisodeInspectionWorkspaceProps) {
  const { t } = useI18n()
  const episodePayload = asRecord(episode)

  return (
    <>
      {error && <div className="data-alert">{error}</div>}
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
        <section className="data-panel data-qc-episode-inspection">
          <div className="data-panel__title">
            <h2>{t('dataQcEpisodeInspectionTitle')}</h2>
            <div className="data-analysis-player__summary">
              <button type="button" onClick={() => onLoadEpisode(episodeIndex)} disabled={loading || !canLoadEpisode}>
                {t('dataAnalysisLoadEpisode', { index: episodeIndex })}
              </button>
            </div>
          </div>
          <div className="data-empty">{emptyLabel || t('dataQcReviewVisualsLoading')}</div>
        </section>
      )}
    </>
  )
}
