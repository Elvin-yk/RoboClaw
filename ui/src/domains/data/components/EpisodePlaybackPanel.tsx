import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  TrajectoryCharts,
  type TrajectoryPayload,
} from '@/domains/data/components/TrajectoryCharts'
import {
  asArray,
  asRecord,
  clamp,
  formatSeconds,
  numberValue,
  relativeTimeValues,
  textValue,
  type AnyRecord,
} from '@/domains/data/lib/analysisPayload'
import {
  getAbsoluteClipTime,
  getClipEnd,
  getClipStart,
  readEpisodeVideos,
  type EpisodeVideo,
} from '@/domains/data/lib/episodeMedia'
import type { RobotTrajectorySource } from '@/domains/data/model/types'
import { cn } from '@/shared/lib/cn'
import { RobotTrajectory3DPanel } from './robotTrajectory3D/RobotTrajectory3DPanel'

export type EpisodePlaybackDisplayMode = 'full' | 'video' | 'trajectory'
export type EpisodePlaybackChrome = 'panel' | 'plain'
export type EpisodePlaybackSummaryMode = 'full' | 'duration'

const VIDEO_SYNC_TOLERANCE = 0.15
const LOOP_EPSILON = 0.05
const PLAYBACK_TIME_EPSILON = 0.001
const EMPTY_VIDEOS: EpisodeVideo[] = []
const EMPTY_TRAJECTORY: TrajectoryPayload = { timeValues: [], items: [], totalPoints: 0 }

export function EpisodePlaybackPanel({
  episode,
  episodeIndex,
  totalEpisodes,
  loading,
  canLoadEpisode,
  onEpisodeIndexChange,
  onLoadEpisode,
  showEpisodeControls = true,
  showTitle = true,
  displayMode = 'full',
  emptyLabel,
  source = 'local',
  dataset,
  path,
  showRobot3D = true,
  showTrajectoryCharts = true,
  showTaskDescription = true,
  allowStaticRobot3D = false,
  chrome = 'panel',
  summaryMode = 'full',
}: {
  episode: AnyRecord
  episodeIndex: number
  totalEpisodes: number
  loading: boolean
  canLoadEpisode: boolean
  onEpisodeIndexChange: (episodeIndex: number) => void
  onLoadEpisode: (episodeIndex: number) => void
  showEpisodeControls?: boolean
  showTitle?: boolean
  displayMode?: EpisodePlaybackDisplayMode
  emptyLabel?: string
  source?: RobotTrajectorySource
  dataset?: string
  path?: string
  showRobot3D?: boolean
  showTrajectoryCharts?: boolean
  showTaskDescription?: boolean
  allowStaticRobot3D?: boolean
  chrome?: EpisodePlaybackChrome
  summaryMode?: EpisodePlaybackSummaryMode
}) {
  const loadedEpisodeIndex = numberValue(episode.episode_index) ?? episodeIndex
  const summary = asRecord(episode.summary)
  const taskDescription = useMemo(() => readEpisodeTaskDescription(episode), [episode])
  const showVideos = displayMode === 'full' || displayMode === 'video'
  const showTrajectory = displayMode === 'full' || displayMode === 'trajectory'
  const shouldReadTrajectory = showTrajectory && showTrajectoryCharts
  const videos = useMemo(() => readEpisodeVideos(episode), [episode])
  const trajectory = useMemo(
    () => (shouldReadTrajectory ? readTrajectory(episode) : EMPTY_TRAJECTORY),
    [episode, shouldReadTrajectory],
  )
  const showRobotTrajectory3D = displayMode === 'full'
    && showRobot3D
    && source !== 'remote'
    && (source === 'path' ? Boolean(path) : Boolean(dataset))
  const shouldShowTaskDescription = displayMode === 'full' && showTaskDescription
  const visibleVideos = showVideos ? videos : EMPTY_VIDEOS
  const visibleTrajectory = showTrajectory ? trajectory : EMPTY_TRAJECTORY
  const duration = useMemo(
    () => resolvePlaybackDuration(summary, visibleVideos, visibleTrajectory),
    [summary, visibleVideos, visibleTrajectory],
  )
  const [playbackTime, setPlaybackTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackError, setPlaybackError] = useState('')
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([])
  const syncLockRef = useRef(false)
  const playbackTimeRef = useRef(0)
  const dragWasPlayingRef = useRef(false)

  useEffect(() => {
    playbackTimeRef.current = playbackTime
  }, [playbackTime])

  const syncVideosTo = useCallback((relativeTime: number, forceSeek: boolean, skipIndex = -1) => {
    syncLockRef.current = true
    videoRefs.current.forEach((video, index) => {
      if (!video || index === skipIndex || video.readyState === 0) return
      const targetTime = getAbsoluteClipTime(visibleVideos[index], relativeTime, video.duration)
      if (forceSeek || Math.abs(video.currentTime - targetTime) > VIDEO_SYNC_TOLERANCE) {
        video.currentTime = targetTime
      }
    })
    queueMicrotask(() => {
      syncLockRef.current = false
    })
  }, [visibleVideos])

  const seekTo = useCallback((nextTime: number, forceSeek = true) => {
    const bounded = clamp(nextTime, 0, duration || 0)
    playbackTimeRef.current = bounded
    setPlaybackTime(bounded)
    syncVideosTo(bounded, forceSeek)
  }, [duration, syncVideosTo])

  const advancePlaybackTime = useCallback((nextTime: number) => {
    if (Math.abs(nextTime - playbackTimeRef.current) < PLAYBACK_TIME_EPSILON) return
    playbackTimeRef.current = nextTime
    setPlaybackTime(nextTime)
  }, [])

  useEffect(() => {
    videoRefs.current = []
    playbackTimeRef.current = 0
    setPlaybackTime(0)
    setIsPlaying(false)
    setPlaybackError('')
  }, [displayMode, loadedEpisodeIndex])

  useEffect(() => {
    const videosReady = videoRefs.current.filter((video): video is HTMLVideoElement => Boolean(video))
    if (!videosReady.length) return

    if (!isPlaying) {
      videosReady.forEach((video) => video.pause())
      return
    }

    syncVideosTo(playbackTimeRef.current, true)
    videosReady.forEach((video) => {
      const playPromise = video.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error)
          setPlaybackError(message || '视频播放失败')
          setIsPlaying(false)
        })
      }
    })
  }, [isPlaying, syncVideosTo, visibleVideos])

  useEffect(() => {
    if (!isPlaying || duration <= 0) return undefined
    const hasVideos = visibleVideos.length > 0
    const startedAt = performance.now()
    const startTime = playbackTimeRef.current
    let animationFrame = 0
    // Videos: poll the leader video's currentTime each frame so playbackTime
    // tracks the native video frame rate instead of the ~4Hz `timeupdate` event.
    const tickFromVideo = () => {
      const leader = videoRefs.current[0]
      if (leader) {
        const relative = leader.currentTime - getClipStart(visibleVideos[0])
        advancePlaybackTime(clamp(relative, 0, duration))
      }
      animationFrame = window.requestAnimationFrame(tickFromVideo)
    }
    // No videos: advance from a wall clock so trajectory-only playback still runs.
    const tickFromClock = (now: number) => {
      const nextTime = startTime + (now - startedAt) / 1000
      if (nextTime >= duration - LOOP_EPSILON) {
        seekTo(0)
        setIsPlaying(false)
        return
      }
      seekTo(nextTime, false)
      animationFrame = window.requestAnimationFrame(tickFromClock)
    }
    animationFrame = window.requestAnimationFrame(hasVideos ? tickFromVideo : tickFromClock)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [advancePlaybackTime, duration, isPlaying, seekTo, visibleVideos])

  const handleLeaderTimeUpdate = (index: number) => {
    if (syncLockRef.current || index !== 0) return
    const video = videoRefs.current[index]
    if (!video) return

    const videoMeta = visibleVideos[index]
    const clipEnd = getClipEnd(videoMeta, video.duration)
    if (isPlaying && clipEnd != null && video.currentTime >= clipEnd - LOOP_EPSILON) {
      seekTo(0)
      return
    }

    const nextTime = clamp(video.currentTime - getClipStart(videoMeta), 0, duration || 0)
    if (Math.abs(nextTime - playbackTimeRef.current) >= 0.025) {
      playbackTimeRef.current = nextTime
      setPlaybackTime(nextTime)
    }
    syncVideosTo(nextTime, false, index)
  }

  const hasPlaybackData = visibleVideos.length > 0 || visibleTrajectory.items.length > 0 || showRobotTrajectory3D
  const rootClassName = cn(
    chrome === 'panel' && 'data-panel',
    'data-analysis-player',
    chrome === 'plain' && 'data-analysis-player--plain',
  )

  if (!hasPlaybackData) {
    return (
      <section className={rootClassName}>
        {showTitle && showEpisodeControls && (
          <div className="data-panel__title data-analysis-player__title">
            <EpisodePicker
              value={episodeIndex}
              totalEpisodes={totalEpisodes}
              loading={loading}
              canLoadEpisode={canLoadEpisode}
              onChange={onEpisodeIndexChange}
              onLoad={onLoadEpisode}
            />
          </div>
        )}
        <div className="data-empty">{emptyLabel || '加载 episode 后显示视频和 action / observation 曲线'}</div>
      </section>
    )
  }

  return (
    <section className={rootClassName}>
      {showTitle && (
        <div className="data-panel__title data-analysis-player__title">
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
          <div className="data-analysis-player__summary">
            {summaryMode === 'full' && <span>Episode #{loadedEpisodeIndex}</span>}
            <span>{formatSeconds(duration)}</span>
            {summaryMode === 'full' && showVideos && (
              <span>{summary.video_count == null ? visibleVideos.length : textValue(summary.video_count)} videos</span>
            )}
          </div>
        </div>
      )}

      {playbackError && <div className="data-alert">{playbackError}</div>}

      {shouldShowTaskDescription && taskDescription && (
        <section className="data-analysis-section">
          <div className="data-analysis-section-title">任务描述</div>
          <div className="data-analysis-section-card data-analysis-task-card">
            {taskDescription}
          </div>
        </section>
      )}

      {showVideos && visibleVideos.length > 0 && (
        <section className="data-analysis-section">
          <div className="data-analysis-section-title">相机画面</div>
          <div className="data-analysis-section-card">
            <div className="data-analysis-video-grid">
              {visibleVideos.map((video, index) => (
                <figure key={`${loadedEpisodeIndex}-${video.path}-${index}`} className="data-analysis-video">
                  <video
                    ref={(node) => {
                      videoRefs.current[index] = node
                    }}
                    src={video.url}
                    muted
                    playsInline
                    preload="metadata"
                    onClick={() => setIsPlaying((current) => !current)}
                    onLoadedMetadata={() => syncVideosTo(playbackTimeRef.current, true)}
                    onTimeUpdate={() => handleLeaderTimeUpdate(index)}
                  />
                  <figcaption>{video.stream || video.path}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>
      )}

      {showRobotTrajectory3D && (
        <RobotTrajectory3DPanel
          source={source}
          dataset={dataset}
          path={path}
          episodeIndex={loadedEpisodeIndex}
          currentTime={playbackTime}
          allowStaticModel={allowStaticRobot3D}
        />
      )}

      <PlaybackTimeline
        currentTime={playbackTime}
        duration={duration}
        isPlaying={isPlaying}
        onPlayToggle={() => setIsPlaying((current) => !current)}
        onSeek={seekTo}
        onDragStart={() => {
          dragWasPlayingRef.current = isPlaying
          setIsPlaying(false)
        }}
        onDragEnd={() => {
          if (dragWasPlayingRef.current) setIsPlaying(true)
        }}
      />

      {showTrajectory && showTrajectoryCharts && (
        <TrajectoryCharts
          trajectory={visibleTrajectory}
          currentTime={playbackTime}
          duration={duration}
          onSeek={(seconds) => seekTo(seconds)}
        />
      )}
    </section>
  )
}

export function EpisodePicker({
  value,
  totalEpisodes,
  loading,
  canLoadEpisode,
  onChange,
  onLoad,
}: {
  value: number
  totalEpisodes: number
  loading: boolean
  canLoadEpisode: boolean
  onChange: (episodeIndex: number) => void
  onLoad: (episodeIndex: number) => void
}) {
  const hasUpperBound = totalEpisodes > 0
  const maxEpisodeIndex = hasUpperBound ? Math.max(totalEpisodes - 1, 0) : Number.POSITIVE_INFINITY
  const normalizedValue = clamp(value, 0, maxEpisodeIndex)

  function updateValue(rawValue: string) {
    const nextValue = Number(rawValue)
    if (!Number.isFinite(nextValue)) return
    const nextEpisodeIndex = clamp(Math.trunc(nextValue), 0, maxEpisodeIndex)
    onChange(nextEpisodeIndex)
    if (!loading && canLoadEpisode) {
      onLoad(nextEpisodeIndex)
    }
  }

  function loadEpisode(nextEpisodeIndex: number) {
    const normalizedEpisodeIndex = clamp(nextEpisodeIndex, 0, maxEpisodeIndex)
    onChange(normalizedEpisodeIndex)
    onLoad(normalizedEpisodeIndex)
  }

  return (
    <div className="data-analysis-episode-picker">
      <button
        type="button"
        className="data-analysis-secondary-button"
        onClick={() => loadEpisode(normalizedValue - 1)}
        disabled={loading || !canLoadEpisode || normalizedValue <= 0}
        title="上一个 episode"
      >
        Prev
      </button>
      <label>
        <span>Episode</span>
        <input
          type="number"
          min={0}
          max={hasUpperBound ? maxEpisodeIndex : undefined}
          value={normalizedValue}
          disabled={loading || !canLoadEpisode}
          onChange={(event) => updateValue(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="data-analysis-secondary-button"
        onClick={() => loadEpisode(normalizedValue + 1)}
        disabled={loading || !canLoadEpisode || (hasUpperBound && normalizedValue >= maxEpisodeIndex)}
        title="下一个 episode"
      >
        Next
      </button>
    </div>
  )
}

function PlaybackTimeline({
  currentTime,
  duration,
  isPlaying,
  onPlayToggle,
  onSeek,
  onDragStart,
  onDragEnd,
}: {
  currentTime: number
  duration: number
  isPlaying: boolean
  onPlayToggle: () => void
  onSeek: (seconds: number) => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const disabled = duration <= 0
  const progress = duration > 0 ? clamp((currentTime / duration) * 100, 0, 100) : 0
  const rangeStyle = { '--timeline-progress': `${progress}%` } as CSSProperties

  return (
    <div className="data-analysis-timeline">
      <button
        type="button"
        className="data-analysis-icon-button"
        onClick={() => onSeek(Math.max(0, currentTime - 5))}
        disabled={disabled}
        title="后退 5 秒"
        aria-label="后退 5 秒"
      >
        <SkipBackIcon />
      </button>
      <button
        type="button"
        className="data-analysis-play-button"
        onClick={onPlayToggle}
        disabled={disabled}
        title={isPlaying ? '暂停' : '播放'}
        aria-label={isPlaying ? '暂停' : '播放'}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="data-analysis-icon-button"
        onClick={() => onSeek(Math.min(duration, currentTime + 5))}
        disabled={disabled}
        title="前进 5 秒"
        aria-label="前进 5 秒"
      >
        <SkipForwardIcon />
      </button>
      <button
        type="button"
        className="data-analysis-icon-button"
        onClick={() => onSeek(0)}
        disabled={disabled}
        title="回到开头"
        aria-label="回到开头"
      >
        <ResetIcon />
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(duration, 0)}
        step={0.01}
        value={clamp(currentTime, 0, duration || 0)}
        disabled={disabled}
        style={rangeStyle}
        onPointerDown={onDragStart}
        onPointerUp={onDragEnd}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="Episode playback timeline"
      />
      <span className="data-analysis-timeline__time">
        {Math.floor(currentTime)}s / {Math.floor(duration)}s
      </span>
    </div>
  )
}

function SkipBackIcon() {
  return (
    <svg className="data-analysis-timeline__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M11.2 6.4v11.2L5.4 12l5.8-5.6Z" fill="currentColor" />
      <path d="M18.6 6.4v11.2L12.8 12l5.8-5.6Z" fill="currentColor" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg className="data-analysis-timeline__icon data-analysis-timeline__icon--play" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.4v13.2L18.4 12 8 5.4Z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg className="data-analysis-timeline__icon data-analysis-timeline__icon--pause" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="7" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
      <rect x="13.6" y="5.5" width="3.4" height="13" rx="1.1" fill="currentColor" />
    </svg>
  )
}

function SkipForwardIcon() {
  return (
    <svg className="data-analysis-timeline__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12.8 6.4v11.2l5.8-5.6-5.8-5.6Z" fill="currentColor" />
      <path d="M5.4 6.4v11.2l5.8-5.6-5.8-5.6Z" fill="currentColor" />
    </svg>
  )
}

function ResetIcon() {
  return (
    <svg className="data-analysis-timeline__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8.2 7.2h-3V4.1" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <path d="M5.6 7.2A7.3 7.3 0 1 1 4.8 13" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
    </svg>
  )
}

export function readEpisodeTaskDescription(episode: AnyRecord): string {
  const summary = asRecord(episode.summary)
  const candidates = [
    episode.task_description,
    episode.task,
    episode.task_label,
    episode.instruction,
    episode.language_instruction,
    summary.task_description,
    summary.task,
    summary.task_label,
    summary.instruction,
    summary.language_instruction,
  ]
  for (const candidate of candidates) {
    const text = textValue(candidate).trim()
    if (text) return text
  }
  return ''
}

export function resolveEpisodePlaybackDuration(
  episode: AnyRecord,
  options: { includeTrajectory?: boolean } = {},
): number {
  const summary = asRecord(episode.summary)
  const trajectory = options.includeTrajectory === false ? EMPTY_TRAJECTORY : readTrajectory(episode)
  return resolvePlaybackDuration(summary, readEpisodeVideos(episode), trajectory)
}

function readTrajectory(episode: AnyRecord): TrajectoryPayload {
  const trajectory = asRecord(episode.joint_trajectory)
  const timeValues = asArray(trajectory.time_values)
    .map(numberValue)
    .filter((value): value is number => value != null)
  const items = asArray(trajectory.joint_trajectories).map(asRecord).map((item, index) => ({
    jointName: textValue(item.joint_name) || textValue(item.action_name) || textValue(item.state_name) || `joint_${index + 1}`,
    actionName: textValue(item.action_name),
    stateName: textValue(item.state_name),
    actionValues: numericSeries(item.action_values),
    stateValues: numericSeries(item.state_values),
  })).filter((item) => item.actionValues.length > 0 || item.stateValues.length > 0)

  return {
    timeValues,
    items,
    totalPoints: numberValue(trajectory.total_points) ?? 0,
  }
}

function numericSeries(value: unknown): Array<number | null> {
  return asArray(value).map((item) => numberValue(item))
}

function resolvePlaybackDuration(
  summary: AnyRecord,
  videos: EpisodeVideo[],
  trajectory: TrajectoryPayload,
): number {
  const summaryDuration = numberValue(summary.duration_s) ?? 0
  const rowCount = numberValue(summary.row_count) ?? 0
  const fps = numberValue(summary.fps) ?? 0
  const rowDuration = fps > 0 ? rowCount / fps : 0
  const videoDuration = videos.reduce((maxDuration, video) => {
    const end = video.to_timestamp
    const start = getClipStart(video)
    return end != null && end >= start ? Math.max(maxDuration, end - start) : maxDuration
  }, 0)
  const trajectoryTimes = relativeTimeValues(trajectory.timeValues)
  const trajectoryDuration = trajectoryTimes[trajectoryTimes.length - 1] ?? 0
  return Math.max(summaryDuration, rowDuration, videoDuration, trajectoryDuration, 0)
}
