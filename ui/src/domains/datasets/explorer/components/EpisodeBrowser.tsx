import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import {
  type EpisodeDetail,
  type ExplorerDatasetRef,
  useExplorer,
} from '../store/useExplorerStore'
import { formatClipWindowLabel } from '../pages/datasetExplorerPlayback'
import { EpisodeHoverPreview } from './EpisodeHoverPreview'
import { EpisodePlaybackSurface } from './EpisodePlaybackSurface'

function hasTrajectoryData(detail: EpisodeDetail | null | undefined): boolean {
  if (!detail) return false
  return (
    detail.joint_trajectory.joint_trajectories.length > 0 ||
    detail.joint_trajectory.total_points > 0
  )
}

export function buildExplorerQuery(ref: ExplorerDatasetRef): string {
  const params = new URLSearchParams()
  params.set('source', ref.source)
  if (ref.dataset) {
    params.set('dataset', ref.dataset)
  }
  if (ref.path) {
    params.set('path', ref.path)
  }
  return params.toString()
}

export function EpisodeBrowser({ datasetRef }: { datasetRef: ExplorerDatasetRef }) {
  const { t } = useI18n()
  const {
    episodePage,
    episodePageLoading,
    episodePageError,
    loadEpisodePage,
    selectedEpisodeIndex,
    selectEpisode,
    episodeDetail,
    episodeLoading,
    episodeError,
    clearEpisode,
  } = useExplorer()
  const episodes = episodePage?.episodes ?? []
  const selectedDataset = datasetRef.dataset ?? episodePage?.dataset ?? ''
  const hoverTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const playReadyTimerRef = useRef<number | null>(null)
  const requestTokenRef = useRef(0)
  const previewCacheRef = useRef<Map<number, EpisodeDetail>>(new Map())
  const previewDetailStateRef = useRef<Map<number, 'loading' | 'loaded'>>(new Map())
  const hoverRequestAbortRef = useRef<AbortController | null>(null)
  const [hoveredEpisodeIndex, setHoveredEpisodeIndex] = useState<number | null>(null)
  const [hoveredPreview, setHoveredPreview] = useState<EpisodeDetail | null>(null)
  const [hoveredPreviewLoading, setHoveredPreviewLoading] = useState(false)
  const [hoveredPreviewTrajectoryLoading, setHoveredPreviewTrajectoryLoading] = useState(false)
  const [hoveredPreviewError, setHoveredPreviewError] = useState('')
  const [previewPlayReady, setPreviewPlayReady] = useState(false)
  const [videoCurrentTime, setVideoCurrentTime] = useState(0)
  const [detailVideoCurrentTime, setDetailVideoCurrentTime] = useState(0)

  useEffect(() => {
    previewCacheRef.current.clear()
    previewDetailStateRef.current.clear()
    hoverRequestAbortRef.current?.abort()
    hoverRequestAbortRef.current = null
    if (playReadyTimerRef.current) {
      window.clearTimeout(playReadyTimerRef.current)
      playReadyTimerRef.current = null
    }
    setHoveredEpisodeIndex(null)
    setHoveredPreview(null)
    setHoveredPreviewLoading(false)
    setHoveredPreviewTrajectoryLoading(false)
    setHoveredPreviewError('')
    setPreviewPlayReady(false)
    setVideoCurrentTime(0)
    setDetailVideoCurrentTime(0)
  }, [selectedDataset, datasetRef.path, datasetRef.source])

  useEffect(() => {
    setDetailVideoCurrentTime(0)
  }, [episodeDetail?.episode_index])

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        window.clearTimeout(hoverTimerRef.current)
      }
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current)
      }
      if (playReadyTimerRef.current) {
        window.clearTimeout(playReadyTimerRef.current)
      }
      hoverRequestAbortRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (
      hoveredEpisodeIndex === null ||
      !hoveredPreview ||
      hasTrajectoryData(hoveredPreview) ||
      previewDetailStateRef.current.get(hoveredEpisodeIndex) === 'loaded'
    ) {
      return
    }

    void hydrateHoverPreviewDetail(datasetRef, hoveredEpisodeIndex, requestTokenRef.current)
  }, [hoveredEpisodeIndex, hoveredPreview, datasetRef, selectedDataset])

  if (episodePageLoading && !episodePage) {
    return <div className="explorer-empty">{t('running')}...</div>
  }

  if (episodePageError && !episodePageLoading) {
    return <div className="explorer-empty quality-sidebar__error">{episodePageError}</div>
  }

  if (episodes.length === 0) {
    return <div className="explorer-empty">{t('noDatasets')}</div>
  }

  const pageStart = (episodePage!.page - 1) * episodePage!.page_size + 1
  const pageStop = pageStart + episodes.length - 1

  const previewVisible = hoveredEpisodeIndex !== null

  const cancelClosePreview = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleClosePreview = () => {
    cancelClosePreview()
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (playReadyTimerRef.current) {
      window.clearTimeout(playReadyTimerRef.current)
      playReadyTimerRef.current = null
    }
    closeTimerRef.current = window.setTimeout(() => {
      hoverRequestAbortRef.current?.abort()
      hoverRequestAbortRef.current = null
      previewDetailStateRef.current.forEach((state, key) => {
        if (state === 'loading') {
          previewDetailStateRef.current.delete(key)
        }
      })
      setHoveredEpisodeIndex(null)
      setHoveredPreview(null)
      setHoveredPreviewLoading(false)
      setHoveredPreviewTrajectoryLoading(false)
      setHoveredPreviewError('')
      setPreviewPlayReady(false)
      setVideoCurrentTime(0)
    }, 180)
  }

  const armPreviewPlayback = (requestToken: number, delayMs = 180) => {
    if (playReadyTimerRef.current) {
      window.clearTimeout(playReadyTimerRef.current)
    }
    playReadyTimerRef.current = window.setTimeout(() => {
      if (requestToken === requestTokenRef.current) {
        setPreviewPlayReady(true)
      }
    }, delayMs)
  }

  const hydrateHoverPreviewDetail = async (
    ref: ExplorerDatasetRef,
    episodeIndex: number,
    requestToken: number,
  ) => {
    const currentState = previewDetailStateRef.current.get(episodeIndex)
    if (currentState === 'loading' || currentState === 'loaded') {
      return
    }

    const controller = new AbortController()
    hoverRequestAbortRef.current = controller
    previewDetailStateRef.current.set(episodeIndex, 'loading')
    if (requestToken === requestTokenRef.current) {
      setHoveredPreviewTrajectoryLoading(true)
    }

    try {
      const response = await fetch(
        `/api/explorer/episode?${buildExplorerQuery(ref)}&episode_index=${episodeIndex}`,
        { signal: controller.signal },
      )
      if (!response.ok) {
        throw new Error(`Failed to load trajectory comparison (${response.status})`)
      }
      const detail: EpisodeDetail = await response.json()
      previewCacheRef.current.set(episodeIndex, detail)
      previewDetailStateRef.current.set(episodeIndex, 'loaded')
      if (requestToken === requestTokenRef.current) {
        setHoveredPreview(detail)
        armPreviewPlayback(requestToken)
      }
    } catch (error) {
      previewDetailStateRef.current.delete(episodeIndex)
      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        return
      }
      if (requestToken === requestTokenRef.current) {
        setHoveredPreviewError(
          error instanceof Error ? error.message : 'Failed to load trajectory comparison',
        )
        armPreviewPlayback(requestToken)
      }
    } finally {
      if (requestToken === requestTokenRef.current) {
        setHoveredPreviewTrajectoryLoading(false)
      }
    }
  }

  const scheduleHoverPreview = (episodeIndex: number) => {
    if (
      hoveredEpisodeIndex === episodeIndex &&
      (hoveredPreview !== null || hoveredPreviewLoading || hoveredPreviewTrajectoryLoading)
    ) {
      cancelClosePreview()
      return
    }

    cancelClosePreview()
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    if (playReadyTimerRef.current) {
      window.clearTimeout(playReadyTimerRef.current)
      playReadyTimerRef.current = null
    }
    hoverRequestAbortRef.current?.abort()
    previewDetailStateRef.current.forEach((state, key) => {
      if (state === 'loading') {
        previewDetailStateRef.current.delete(key)
      }
    })
    setHoveredPreviewError('')
    setPreviewPlayReady(false)
    setVideoCurrentTime(0)
    setHoveredPreviewTrajectoryLoading(false)

    hoverTimerRef.current = window.setTimeout(async () => {
      const controller = new AbortController()
      hoverRequestAbortRef.current = controller
      const requestToken = ++requestTokenRef.current
      setHoveredEpisodeIndex(episodeIndex)
      setPreviewPlayReady(true)

      const cached = previewCacheRef.current.get(episodeIndex)
      if (cached) {
        setHoveredPreview(cached)
        setHoveredPreviewLoading(false)
        if (hasTrajectoryData(cached) || previewDetailStateRef.current.get(episodeIndex) === 'loaded') {
          armPreviewPlayback(requestToken)
        }
        return
      }

      setHoveredPreview(null)
      setHoveredPreviewLoading(true)

      try {
        const response = await fetch(
          `/api/explorer/episode?${buildExplorerQuery(datasetRef)}&episode_index=${episodeIndex}&preview=1`,
          { signal: controller.signal },
        )
        if (!response.ok) {
          throw new Error(`Failed to load episode preview (${response.status})`)
        }
        const detail: EpisodeDetail = await response.json()
        previewCacheRef.current.set(episodeIndex, detail)
        if (requestToken === requestTokenRef.current) {
          setHoveredPreview(detail)
        }
        if (hasTrajectoryData(detail)) {
          previewDetailStateRef.current.set(episodeIndex, 'loaded')
          armPreviewPlayback(requestToken)
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === 'AbortError'
        ) {
          return
        }
        if (requestToken === requestTokenRef.current) {
          setHoveredPreviewError(error instanceof Error ? error.message : 'Failed to load preview')
          armPreviewPlayback(requestToken)
        }
      } finally {
        if (requestToken === requestTokenRef.current) {
          setHoveredPreviewLoading(false)
        }
      }
    }, 500)
  }

  return (
    <div className="explorer-episodes">
      <div className="explorer-episodes__toolbar">
        <div className="explorer-episodes__summary">
          <span>{episodePage!.total_episodes} {t('episodes')}</span>
          <span>{pageStart}-{pageStop}</span>
          <span>{episodePage!.page}/{episodePage!.total_pages}</span>
        </div>
        <div className="explorer-episodes__pagination">
          <button
            type="button"
            className="explorer-episodes__pager"
            disabled={episodePage!.page <= 1 || episodePageLoading}
            onClick={() => void loadEpisodePage(datasetRef, episodePage!.page - 1, episodePage!.page_size)}
          >
            Prev
          </button>
          <button
            type="button"
            className="explorer-episodes__pager"
            disabled={episodePage!.page >= episodePage!.total_pages || episodePageLoading}
            onClick={() => void loadEpisodePage(datasetRef, episodePage!.page + 1, episodePage!.page_size)}
          >
            Next
          </button>
        </div>
      </div>

      <div className="explorer-episodes__list">
        {episodes.map((ep) => (
          <button
            key={ep.episode_index}
            type="button"
            className={cn(
              'explorer-episode-item',
              selectedEpisodeIndex === ep.episode_index && 'is-selected',
            )}
            onClick={() => {
              if (selectedEpisodeIndex === ep.episode_index) {
                clearEpisode()
              } else {
                void selectEpisode(datasetRef, ep.episode_index)
              }
            }}
            onMouseEnter={() => scheduleHoverPreview(ep.episode_index)}
            onMouseLeave={scheduleClosePreview}
          >
            <span className="explorer-episode-item__idx">#{ep.episode_index}</span>
            <span className="explorer-episode-item__len">{ep.length} frames</span>
          </button>
        ))}
      </div>

      {previewVisible && (
        <EpisodeHoverPreview
          detail={hoveredPreview}
          loading={hoveredPreviewLoading}
          trajectoryLoading={hoveredPreviewTrajectoryLoading}
          error={hoveredPreviewError}
          videoCurrentTime={videoCurrentTime}
          onVideoTimeUpdate={setVideoCurrentTime}
          onClose={() => {
            setHoveredEpisodeIndex(null)
            setHoveredPreview(null)
            setHoveredPreviewLoading(false)
            setHoveredPreviewTrajectoryLoading(false)
            setHoveredPreviewError('')
            setPreviewPlayReady(false)
            setVideoCurrentTime(0)
          }}
          playVideo={previewPlayReady}
          onMouseEnter={cancelClosePreview}
          onMouseLeave={scheduleClosePreview}
        />
      )}

      {episodeLoading && (
        <div className="explorer-episode-detail">
          <p>{t('running')}...</p>
        </div>
      )}

      {episodeError && !episodeLoading && (
        <div className="explorer-episode-detail">
          <p className="quality-sidebar__error">{episodeError}</p>
        </div>
      )}

      {episodeDetail && !episodeLoading && !episodeError && (
        <div className="explorer-episode-detail">
          <div className="explorer-episode-detail__summary">
            <span>{episodeDetail.summary.row_count} rows</span>
            <span>{episodeDetail.summary.duration_s}s</span>
            <span>{episodeDetail.summary.fps} fps</span>
            <span>{episodeDetail.summary.video_count} videos</span>
          </div>

          {episodeDetail.videos.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>Playback</h4>
              <EpisodePlaybackSurface
                detail={episodeDetail}
                playVideo
                videoCurrentTime={detailVideoCurrentTime}
                onVideoTimeUpdate={setDetailVideoCurrentTime}
                emptyLabel="No video stream available for this episode."
              />
            </div>
          )}

          {episodeDetail.videos.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>Video Sources</h4>
              <ul className="explorer-video-list">
                {episodeDetail.videos.map((v) => (
                  <li key={v.path}>
                    <strong>{v.stream}</strong> — {v.path}
                    {formatClipWindowLabel(v) ? ` (${formatClipWindowLabel(v)})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {episodeDetail.sample_rows.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>{t('sampleRows')}</h4>
              <div className="quality-table-wrap">
                <table className="quality-table explorer-sample-table">
                  <thead>
                    <tr>
                      {Object.keys(episodeDetail.sample_rows[0]).map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {episodeDetail.sample_rows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.values(row).map((val, ci) => (
                          <td key={ci}>
                            {Array.isArray(val)
                              ? `[${val.join(', ')}]`
                              : val == null
                                ? '-'
                                : typeof val === 'number'
                                  ? val.toFixed(4)
                                  : String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------
