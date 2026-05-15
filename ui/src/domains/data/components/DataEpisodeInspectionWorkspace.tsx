import { asRecord } from '@/domains/data/lib/analysisPayload'
import type { RobotTrajectorySource } from '@/domains/data/model/types'
import { useI18n } from '@/i18n'
import { EpisodePlaybackPanel, type EpisodePlaybackDisplayMode } from './EpisodePlaybackPanel'

interface DataEpisodeInspectionWorkspaceProps {
  source: RobotTrajectorySource
  dataset: string
  path?: string
  episode: unknown
  episodeIndex: number
  totalEpisodes: number
  loading: boolean
  canLoadEpisode: boolean
  error?: string
  emptyLabel?: string
  showEpisodeControls?: boolean
  showTitle?: boolean
  displayMode?: EpisodePlaybackDisplayMode
  onEpisodeIndexChange: (episodeIndex: number) => void
  onLoadEpisode: (episodeIndex: number) => void
}

export function DataEpisodeInspectionWorkspace({
  source,
  dataset,
  path,
  episode,
  episodeIndex,
  totalEpisodes,
  loading,
  canLoadEpisode,
  error,
  emptyLabel,
  showEpisodeControls = true,
  showTitle = true,
  displayMode = 'full',
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
          showEpisodeControls={showEpisodeControls}
          showTitle={showTitle}
          displayMode={displayMode}
          emptyLabel={emptyLabel}
          source={source}
          dataset={dataset}
          path={path}
        />
      ) : (
        <section className="data-panel data-qc-episode-inspection">
          {showTitle && (
            <div className="data-panel__title">
              <h2>{t('dataQcEpisodeInspectionTitle')}</h2>
              {showEpisodeControls && (
                <div className="data-analysis-player__summary">
                  <button type="button" onClick={() => onLoadEpisode(episodeIndex)} disabled={loading || !canLoadEpisode}>
                    {t('dataAnalysisLoadEpisode', { index: episodeIndex })}
                  </button>
                </div>
              )}
            </div>
          )}
          <div className="data-empty">{emptyLabel || t('dataQcReviewVisualsLoading')}</div>
        </section>
      )}
    </>
  )
}
