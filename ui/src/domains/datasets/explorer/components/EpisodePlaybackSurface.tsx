import { useEffect, useRef } from 'react'
import type { EpisodeDetail } from '../store/useExplorerStore'
import {
  clampAbsolutePlaybackTime,
  formatClipWindowLabel,
  getClipStart,
  getRelativePlaybackTime,
  shouldLoopVideo,
  type EpisodeVideo,
} from '../pages/datasetExplorerPlayback'

function formatAngle(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '--'
  return value.toFixed(3)
}

function syncVideoIntoClipWindow(
  element: HTMLVideoElement,
  video: EpisodeVideo | null | undefined,
  options: { loopToStart?: boolean; forceSeek?: boolean } = {},
): number {
  const nextTime = clampAbsolutePlaybackTime(
    video,
    element.currentTime,
    element.duration,
    { loopToStart: options.loopToStart },
  )
  if (options.forceSeek || Math.abs(element.currentTime - nextTime) > 0.08) {
    try {
      element.currentTime = nextTime
    } catch (_error) {
      // Ignore currentTime assignment failures until metadata is ready.
    }
  }
  return nextTime
}

function getTrajectoryTimeBounds(detail: EpisodeDetail): [number, number] {
  const timeValues = detail.joint_trajectory.time_values
  if (timeValues.length >= 2) {
    return [timeValues[0], timeValues[timeValues.length - 1]]
  }
  const duration = detail.summary.duration_s || 0
  return [0, duration]
}

function getNearestTrajectoryIndex(detail: EpisodeDetail, videoCurrentTime: number): number {
  const timeValues = detail.joint_trajectory.time_values
  if (timeValues.length > 0) {
    let nearestIndex = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    timeValues.forEach((value, index) => {
      const distance = Math.abs(value - videoCurrentTime)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    })
    return nearestIndex
  }

  const firstJoint = detail.joint_trajectory.joint_trajectories[0]
  const totalPoints = Math.max(
    firstJoint?.state_values.length ?? 0,
    firstJoint?.action_values.length ?? 0,
  )
  if (totalPoints <= 1) return 0
  const duration = detail.summary.duration_s || 1
  const progress = Math.min(Math.max(videoCurrentTime / duration, 0), 1)
  return Math.round(progress * (totalPoints - 1))
}

export function EpisodePlaybackSurface({
  detail,
  playVideo,
  videoCurrentTime,
  onVideoTimeUpdate,
  emptyLabel,
}: {
  detail: EpisodeDetail
  playVideo: boolean
  videoCurrentTime: number
  onVideoTimeUpdate: (seconds: number) => void
  emptyLabel: string
}) {
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([])
  const syncLockRef = useRef(false)
  const lastTimelineTimeRef = useRef<number>(-1)
  const jointTrajectories = detail.joint_trajectory.joint_trajectories
  const [timeMin, timeMax] = getTrajectoryTimeBounds(detail)
  const timeRange = timeMax - timeMin || 1
  const currentIndex = getNearestTrajectoryIndex(detail, videoCurrentTime)
  const currentTimePercent = Math.min(
    Math.max(((videoCurrentTime - timeMin) / timeRange) * 100, 0),
    100,
  )

  useEffect(() => {
    videoRefs.current = []
    lastTimelineTimeRef.current = -1
  }, [detail.episode_index])

  useEffect(() => {
    const timelineLeaderIndex = 0
    const updateTimelineFrom = (
      index: number,
      absoluteTime: number,
      options: { force?: boolean } = {},
    ) => {
      if (!options.force && index !== timelineLeaderIndex) {
        return
      }
      const relativeTime = getRelativePlaybackTime(getVideoMeta(index), absoluteTime)
      if (
        !options.force &&
        lastTimelineTimeRef.current >= 0 &&
        Math.abs(relativeTime - lastTimelineTimeRef.current) < 0.033
      ) {
        return
      }
      lastTimelineTimeRef.current = relativeTime
      onVideoTimeUpdate(relativeTime)
    }

    const getVideoMeta = (index: number): EpisodeVideo | null => detail.videos[index] ?? null
    const syncFromSource = (
      sourceIndex: number,
      options: { forceSeek?: boolean } = {},
    ) => {
      const source = videoRefs.current[sourceIndex]
      if (!source || syncLockRef.current) return

      syncLockRef.current = true
      const sourceMeta = getVideoMeta(sourceIndex)
      const sourceAbsoluteTime = syncVideoIntoClipWindow(source, sourceMeta, {
        loopToStart: !source.paused && playVideo,
        forceSeek: options.forceSeek,
      })
      const sourceTime = getRelativePlaybackTime(sourceMeta, sourceAbsoluteTime)
      const sourcePaused = source.paused
      const sourceRate = source.playbackRate

      videoRefs.current.forEach((target, targetIndex) => {
        if (!target || targetIndex === sourceIndex) return
        const targetMeta = getVideoMeta(targetIndex)

        if (target.playbackRate !== sourceRate) {
          target.playbackRate = sourceRate
        }

        const targetAbsoluteTime = clampAbsolutePlaybackTime(
          targetMeta,
          getClipStart(targetMeta) + sourceTime,
          target.duration,
          { loopToStart: !sourcePaused && playVideo },
        )
        const shouldSeek =
          options.forceSeek || Math.abs(target.currentTime - targetAbsoluteTime) > 0.08
        if (shouldSeek) {
          try {
            target.currentTime = targetAbsoluteTime
          } catch (_error) {
            // Ignore currentTime assignment failures until metadata is ready.
          }
        }

        if (sourcePaused || !playVideo) {
          if (!target.paused) {
            target.pause()
          }
        } else if (target.paused) {
          const playPromise = target.play()
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {})
          }
        }
      })

      queueMicrotask(() => {
        syncLockRef.current = false
      })
    }

    const listeners: Array<() => void> = []
    videoRefs.current.forEach((video, index) => {
      if (!video) return

      const handlePlay = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta, { loopToStart: true })
        updateTimelineFrom(index, absoluteTime, { force: true })
        syncFromSource(index, { forceSeek: true })
      }
      const handlePause = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta)
        updateTimelineFrom(index, absoluteTime, { force: true })
        syncFromSource(index)
      }
      const handleSeeking = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta, { forceSeek: true })
        updateTimelineFrom(index, absoluteTime, { force: true })
        syncFromSource(index, { forceSeek: true })
      }
      const handleSeeked = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta, { forceSeek: true })
        updateTimelineFrom(index, absoluteTime, { force: true })
        syncFromSource(index, { forceSeek: true })
      }
      const handleRateChange = () => {
        if (syncLockRef.current) return
        syncFromSource(index)
      }
      const handleTimeUpdate = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta, {
          loopToStart: playVideo,
          forceSeek: false,
        })
        updateTimelineFrom(index, absoluteTime)
        if (index !== timelineLeaderIndex) {
          return
        }
        syncFromSource(index)
      }
      const handleLoadedMetadata = () => {
        if (syncLockRef.current) return
        const meta = getVideoMeta(index)
        const absoluteTime = syncVideoIntoClipWindow(video, meta, { forceSeek: true })
        updateTimelineFrom(index, absoluteTime, { force: true })
        syncFromSource(index, { forceSeek: true })
      }

      video.addEventListener('play', handlePlay)
      video.addEventListener('pause', handlePause)
      video.addEventListener('seeking', handleSeeking)
      video.addEventListener('seeked', handleSeeked)
      video.addEventListener('ratechange', handleRateChange)
      video.addEventListener('timeupdate', handleTimeUpdate)
      video.addEventListener('loadedmetadata', handleLoadedMetadata)

      listeners.push(() => {
        video.removeEventListener('play', handlePlay)
        video.removeEventListener('pause', handlePause)
        video.removeEventListener('seeking', handleSeeking)
        video.removeEventListener('seeked', handleSeeked)
        video.removeEventListener('ratechange', handleRateChange)
        video.removeEventListener('timeupdate', handleTimeUpdate)
        video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      })
    })

    return () => {
      listeners.forEach((cleanup) => cleanup())
    }
  }, [detail, onVideoTimeUpdate, playVideo])

  useEffect(() => {
    const videos = videoRefs.current.filter((video): video is HTMLVideoElement => Boolean(video))
    if (!videos.length) return

    if (!playVideo) {
      videos.forEach((video) => video.pause())
      return
    }

    let attempts = 0
    const tryPlay = () => {
      const currentVideos = videoRefs.current
        .map((video, index) => ({ video, index }))
        .filter((entry): entry is { video: HTMLVideoElement; index: number } => Boolean(entry.video))
      if (!currentVideos.length) {
        return
      }

      currentVideos.forEach(({ video, index }) => {
        syncVideoIntoClipWindow(video, detail.videos[index] ?? null, { forceSeek: true })
        if (!video.paused) {
          return
        }
        const playPromise = video.play()
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {})
        }
      })
    }

    tryPlay()
    const retryTimer = window.setInterval(() => {
      attempts += 1
      tryPlay()
      const currentVideos = videoRefs.current
        .map((video, index) => ({ video, index }))
        .filter((entry): entry is { video: HTMLVideoElement; index: number } => Boolean(entry.video))
      const allPlaying = currentVideos.length > 0 && currentVideos.every(({ video }) => !video.paused)
      if (allPlaying || attempts >= 12) {
        window.clearInterval(retryTimer)
      }
    }, 120)

    return () => {
      window.clearInterval(retryTimer)
    }
  }, [playVideo, detail])

  useEffect(() => {
    const interval = window.setInterval(() => {
      const entries = videoRefs.current
        .map((video, index) => ({ video, index }))
        .filter((entry): entry is { video: HTMLVideoElement; index: number } => Boolean(entry.video))
      const [leaderEntry, ...followers] = entries
      if (!leaderEntry || followers.length === 0 || syncLockRef.current) {
        return
      }

      const leaderMeta = detail.videos[leaderEntry.index] ?? null
      const leaderAbsoluteTime = syncVideoIntoClipWindow(leaderEntry.video, leaderMeta, {
        loopToStart: playVideo,
      })
      const leaderTime = getRelativePlaybackTime(leaderMeta, leaderAbsoluteTime)
      const leaderPaused = leaderEntry.video.paused || !playVideo
      const leaderRate = leaderEntry.video.playbackRate

      followers.forEach(({ video, index }) => {
        const videoMeta = detail.videos[index] ?? null
        if (video.playbackRate !== leaderRate) {
          video.playbackRate = leaderRate
        }

        const targetAbsoluteTime = clampAbsolutePlaybackTime(
          videoMeta,
          getClipStart(videoMeta) + leaderTime,
          video.duration,
          { loopToStart: !leaderPaused },
        )
        if (Math.abs(video.currentTime - targetAbsoluteTime) > 0.08) {
          try {
            video.currentTime = targetAbsoluteTime
          } catch (_error) {
            // Ignore currentTime sync failures until metadata is available.
          }
        }

        if (leaderPaused) {
          if (!video.paused) {
            video.pause()
          }
        } else if (video.paused) {
          const playPromise = video.play()
          if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(() => {})
          }
        }
      })
    }, 120)

    return () => {
      window.clearInterval(interval)
    }
  }, [detail, playVideo])

  return (
    <div className="explorer-hover-preview__body explorer-episode-playback">
      <div className="explorer-hover-preview__video-grid">
        {detail.videos.length > 0 ? (
          detail.videos.map((video, index) => {
            const clipLabel = formatClipWindowLabel(video)
            return (
              <div key={video.path} className="explorer-hover-preview__video-card">
                <div className="explorer-hover-preview__status">
                  <strong>{video.stream}</strong>
                  {clipLabel ? <span> · {clipLabel}</span> : null}
                </div>
                <video
                  ref={(node) => {
                    videoRefs.current[index] = node
                  }}
                  src={video.url}
                  autoPlay={playVideo}
                  controls
                  muted
                  loop={shouldLoopVideo(video)}
                  playsInline
                  preload="metadata"
                />
              </div>
            )
          })
        ) : (
          <div className="explorer-hover-preview__empty">{emptyLabel}</div>
        )}
      </div>

      {jointTrajectories.length > 0 && (
        <div className="explorer-hover-preview__charts">
          <h4>Joint Angle Info</h4>
          <div className="explorer-hover-preview__legend">
            <span className="explorer-hover-preview__legend-state">State</span>
            <span className="explorer-hover-preview__legend-action">Action</span>
          </div>

          <div className="explorer-hover-preview__charts-grid">
            {jointTrajectories.map((joint) => {
              const actionValues = joint.action_values.map((value) => value ?? 0)
              const stateValues = joint.state_values.map((value) => value ?? 0)
              const allValues = [...actionValues, ...stateValues]
              const minValue = Math.min(...allValues)
              const maxValue = Math.max(...allValues)
              const padding = (maxValue - minValue || 1) * 0.1
              const yMin = minValue - padding
              const yMax = maxValue + padding
              const yRange = yMax - yMin || 1

              const toY = (value: number) => 10 + ((yMax - value) / yRange) * 40
              const buildPolyline = (values: number[]) =>
                values
                  .map((value, index) => {
                    const x = values.length > 1 ? (index / (values.length - 1)) * 100 : 50
                    return `${x},${toY(value)}`
                  })
                  .join(' ')

              const currentState = stateValues[Math.min(currentIndex, stateValues.length - 1)]
              const currentAction = actionValues[Math.min(currentIndex, actionValues.length - 1)]

              return (
                <div key={joint.joint_name} className="explorer-hover-preview__chart">
                  <div className="explorer-hover-preview__chart-title-row">
                    <div className="explorer-hover-preview__chart-title">{joint.joint_name}</div>
                    <div className="explorer-hover-preview__chart-current">
                      S {formatAngle(currentState)} / A {formatAngle(currentAction)}
                    </div>
                  </div>

                  <div className="explorer-hover-preview__chart-container">
                    <div className="explorer-hover-preview__chart-yaxis">
                      <span>{yMax.toFixed(2)}</span>
                      <span>{((yMax + yMin) / 2).toFixed(2)}</span>
                      <span>{yMin.toFixed(2)}</span>
                    </div>

                    <div className="explorer-hover-preview__chart-svg-wrap">
                      <svg viewBox="0 0 100 60" preserveAspectRatio="none">
                        <polyline
                          points={buildPolyline(stateValues)}
                          fill="none"
                          stroke="#2f6fe4"
                          strokeWidth="0.55"
                          vectorEffect="non-scaling-stroke"
                        />
                        <polyline
                          points={buildPolyline(actionValues)}
                          fill="none"
                          stroke="#f59e0b"
                          strokeWidth="0.55"
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1={currentTimePercent}
                          y1="10"
                          x2={currentTimePercent}
                          y2="50"
                          stroke="#ef4444"
                          strokeWidth="0.35"
                          strokeDasharray="2,2"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <div className="explorer-hover-preview__chart-xaxis">
                        <span>{timeMin.toFixed(1)}s</span>
                        <span>{((timeMin + timeMax) / 2).toFixed(1)}s</span>
                        <span>{timeMax.toFixed(1)}s</span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
