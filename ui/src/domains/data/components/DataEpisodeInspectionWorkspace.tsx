import { asRecord } from '@/domains/data/lib/analysisPayload'
import type { RobotTrajectorySource } from '@/domains/data/model/types'
import { useI18n } from '@/i18n'
import { EpisodePicker, EpisodePlaybackPanel, type EpisodePlaybackDisplayMode } from './EpisodePlaybackPanel'

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
  showRobot3D?: boolean
  showTrajectoryCharts?: boolean
  allowStaticRobot3D?: boolean
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
  showRobot3D = true,
  showTrajectoryCharts = true,
  allowStaticRobot3D = false,
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
          showRobot3D={showRobot3D}
          showTrajectoryCharts={showTrajectoryCharts}
          allowStaticRobot3D={allowStaticRobot3D}
        />
      ) : (
        <section className="data-panel data-qc-episode-inspection">
          {showTitle && (
            <div className="data-panel__title">
              {showEpisodeControls && (
                <EpisodePicker
                  value={episodeIndex}
                  totalEpisodes={totalEpisodes}
                  loading={loading}
                  canLoadEpisode={canLoadEpisode}
                  onChange={onEpisodeIndexChange}
                  onLoad={onLoadEpisode}
                />
              )}
            </div>
          )}
          <div className="data-empty">{emptyLabel || t('dataQcReviewVisualsLoading')}</div>
        </section>
      )}
    </>
  )
}
