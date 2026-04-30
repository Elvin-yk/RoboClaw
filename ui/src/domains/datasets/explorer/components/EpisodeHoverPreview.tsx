import { createPortal } from 'react-dom'
import type { EpisodeDetail } from '../store/useExplorerStore'
import { EpisodePlaybackSurface } from './EpisodePlaybackSurface'

function hasTrajectoryData(detail: EpisodeDetail | null | undefined): boolean {
  if (!detail) return false
  return (
    detail.joint_trajectory.joint_trajectories.length > 0 ||
    detail.joint_trajectory.total_points > 0
  )
}

export function EpisodeHoverPreview({
  detail,
  loading,
  trajectoryLoading,
  error,
  playVideo,
  videoCurrentTime,
  onVideoTimeUpdate,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  detail: EpisodeDetail | null
  loading: boolean
  trajectoryLoading: boolean
  error: string
  playVideo: boolean
  videoCurrentTime: number
  onVideoTimeUpdate: (seconds: number) => void
  onClose: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  return createPortal(
    <div className="explorer-hover-preview" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="explorer-hover-preview__dialog">
        <button
          type="button"
          className="explorer-hover-preview__close"
          onClick={onClose}
          aria-label="Close preview"
        >
          ×
        </button>

        {!detail && loading && (
          <div className="explorer-hover-preview__empty">Loading preview...</div>
        )}

        {!detail && error && (
          <div className="explorer-hover-preview__empty explorer-hover-preview__empty--error">
            {error}
          </div>
        )}

        {detail && (
          <>
            <div className="explorer-hover-preview__header">
              <h3>Episode #{detail.episode_index}</h3>
              <div className="explorer-hover-preview__meta">
                <span>{detail.summary.row_count} frames</span>
                <span>{detail.summary.duration_s}s</span>
                <span>{detail.summary.fps} fps</span>
                <span>{detail.summary.video_count} videos</span>
              </div>
            </div>

            <EpisodePlaybackSurface
              detail={detail}
              playVideo={playVideo}
              videoCurrentTime={videoCurrentTime}
              onVideoTimeUpdate={onVideoTimeUpdate}
              emptyLabel="No video stream available for this episode."
            />

            {!hasTrajectoryData(detail) && trajectoryLoading && (
              <div className="explorer-hover-preview__empty">
                Loading trajectory comparison...
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
