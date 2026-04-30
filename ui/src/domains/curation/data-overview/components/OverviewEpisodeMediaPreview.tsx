import { useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/shared/lib/cn'
import type { AnnotationWorkspacePayload, JointTrajectoryEntry } from '@/domains/curation/store/useCurationStore'
import {
  findClosestPlaybackIndex,
  formatJointValue,
  getClipEnd,
  getClipStart,
  isFiniteNumber,
  relativeTrajectoryTimes,
} from '../lib/dataOverviewLib'

interface OverviewJointPreviewEntry {
  key: string
  label: string
  actionValues: Array<number | null>
  stateValues: Array<number | null>
  xValues: number[]
}

function buildJointPreviewEntries(
  jointTrajectory: AnnotationWorkspacePayload['joint_trajectory'] | null | undefined,
): OverviewJointPreviewEntry[] {
  const timeValues = jointTrajectory?.time_values || []
  const xValues = relativeTrajectoryTimes(timeValues)
  return (jointTrajectory?.joint_trajectories || [])
    .map((item: JointTrajectoryEntry, index) => {
      const label = item.joint_name || item.state_name || item.action_name || `joint_${index + 1}`
      return {
        key: `${label}-${index}`,
        label,
        actionValues: item.action_values || [],
        stateValues: item.state_values || [],
        xValues,
      }
    })
    .filter((item) =>
      item.xValues.length
      && (
        item.actionValues.some((value) => value !== null && value !== undefined)
        || item.stateValues.some((value) => value !== null && value !== undefined)
      ),
    )
}

function jointSnapshot(entry: OverviewJointPreviewEntry | null, index: number) {
  if (!entry) {
    return { actionValue: null, stateValue: null, deltaValue: null }
  }
  const boundedIndex = Math.min(
    Math.max(index, 0),
    Math.max(entry.actionValues.length, entry.stateValues.length) - 1,
  )
  const actionValue = entry.actionValues[boundedIndex] ?? null
  const stateValue = entry.stateValues[boundedIndex] ?? null
  const deltaValue =
    isFiniteNumber(actionValue) && isFiniteNumber(stateValue)
      ? Number(actionValue) - Number(stateValue)
      : null
  return { actionValue, stateValue, deltaValue }
}

export function OverviewEpisodeMediaPreview({
  workspace,
  loading,
  error,
  locale,
}: {
  workspace: AnnotationWorkspacePayload | null
  loading: boolean
  error: string
  locale: 'zh' | 'en'
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [selectedVideoPath, setSelectedVideoPath] = useState('')
  const [playbackState, setPlaybackState] = useState({ time: 0, index: 0, playing: false })
  const [selectedJointKey, setSelectedJointKey] = useState('')
  const copy = locale === 'zh'
    ? {
      title: '实时视频 / 关节角度',
      loading: '正在读取 episode 视频与关节轨迹...',
      failed: '读取 episode 预览失败',
      noWorkspace: '暂无 episode 预览数据',
      noVideo: '当前 episode 没有可播放视频',
      noJoints: '当前 episode 没有关节角度序列',
      stream: '视频流',
      frame: '帧',
      time: '时间',
      sampled: '采样点',
      currentJoint: '当前关节',
      action: 'Action',
      state: 'State',
      delta: '差值',
      playing: '播放中',
      paused: '已暂停',
    }
    : {
      title: 'Live Video / Joint Angles',
      loading: 'Loading episode video and joint trajectory...',
      failed: 'Failed to load episode preview',
      noWorkspace: 'No episode preview data yet',
      noVideo: 'No playable video for this episode',
      noJoints: 'No joint angle series for this episode',
      stream: 'Video stream',
      frame: 'Frame',
      time: 'Time',
      sampled: 'Samples',
      currentJoint: 'Current joint',
      action: 'Action',
      state: 'State',
      delta: 'Delta',
      playing: 'Playing',
      paused: 'Paused',
    }

  const videos = useMemo(() => workspace?.videos || [], [workspace])
  const effectiveVideo = useMemo(() => {
    if (!videos.length) return null
    return videos.find((video) => video.path === selectedVideoPath) || videos[0]
  }, [selectedVideoPath, videos])
  const entries = useMemo(
    () => buildJointPreviewEntries(workspace?.joint_trajectory),
    [workspace?.joint_trajectory],
  )
  const activeEntry =
    entries.find((entry) => entry.key === selectedJointKey)
    || entries[0]
    || null
  const activeSnapshot = jointSnapshot(activeEntry, playbackState.index)
  const frameValues = workspace?.joint_trajectory.frame_values || []
  const currentFrame = frameValues[playbackState.index] ?? playbackState.index

  useEffect(() => {
    setSelectedVideoPath(videos[0]?.path || '')
  }, [workspace?.episode_index, videos])

  useEffect(() => {
    setPlaybackState({ time: 0, index: 0, playing: false })
    setSelectedJointKey('')
  }, [workspace?.episode_index, selectedVideoPath])

  useEffect(() => {
    if (!entries.length) {
      setSelectedJointKey('')
      return
    }
    setSelectedJointKey((current) =>
      entries.some((entry) => entry.key === current) ? current : entries[0].key,
    )
  }, [entries])

  useEffect(() => {
    const playerEl = videoRef.current
    if (!playerEl || !effectiveVideo) return undefined
    const player = playerEl

    let rafId = 0
    const timeValues = workspace?.joint_trajectory.time_values || []
    const trajectoryBaseTime = isFiniteNumber(timeValues[0]) ? timeValues[0] : 0

    function stopPolling(): void {
      if (!rafId) return
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }

    function updateFromVideo(): void {
      const clipStart = getClipStart(effectiveVideo)
      const clipEnd = getClipEnd(effectiveVideo)
      if (isFiniteNumber(clipEnd) && player.currentTime >= clipEnd) {
        player.pause()
      }
      const relativeTime = Math.max(player.currentTime - clipStart, 0)
      const lookupTime = relativeTime + trajectoryBaseTime
      const index = timeValues.length ? findClosestPlaybackIndex(timeValues, lookupTime) : 0
      setPlaybackState({
        time: relativeTime,
        index,
        playing: !player.paused && !player.ended,
      })
    }

    function poll(): void {
      updateFromVideo()
      if (!player.paused && !player.ended) {
        rafId = window.requestAnimationFrame(poll)
      } else {
        rafId = 0
      }
    }

    function handleLoadedMetadata(): void {
      const clipStart = getClipStart(effectiveVideo)
      const boundedStart = Number.isFinite(player.duration)
        ? Math.min(clipStart, player.duration)
        : clipStart
      if (Math.abs(player.currentTime - boundedStart) > 0.1) {
        player.currentTime = boundedStart
      }
      updateFromVideo()
    }

    function handlePlay(): void {
      stopPolling()
      rafId = window.requestAnimationFrame(poll)
    }

    function handlePause(): void {
      stopPolling()
      updateFromVideo()
    }

    player.addEventListener('loadedmetadata', handleLoadedMetadata)
    player.addEventListener('play', handlePlay)
    player.addEventListener('pause', handlePause)
    player.addEventListener('ended', handlePause)
    player.addEventListener('seeking', updateFromVideo)
    player.addEventListener('timeupdate', updateFromVideo)

    if (player.readyState >= 1) {
      handleLoadedMetadata()
    }

    return () => {
      stopPolling()
      player.removeEventListener('loadedmetadata', handleLoadedMetadata)
      player.removeEventListener('play', handlePlay)
      player.removeEventListener('pause', handlePause)
      player.removeEventListener('ended', handlePause)
      player.removeEventListener('seeking', updateFromVideo)
      player.removeEventListener('timeupdate', updateFromVideo)
    }
  }, [effectiveVideo, workspace?.joint_trajectory.time_values])

  if (loading) {
    return (
      <section className="overview-media-preview">
        <div className="overview-detail-section__title">{copy.title}</div>
        <div className="overview-detail-empty">{copy.loading}</div>
      </section>
    )
  }

  if (error) {
    return (
      <section className="overview-media-preview">
        <div className="overview-detail-section__title">{copy.title}</div>
        <div className="overview-detail-empty is-fail">{copy.failed}: {error}</div>
      </section>
    )
  }

  if (!workspace) {
    return (
      <section className="overview-media-preview">
        <div className="overview-detail-section__title">{copy.title}</div>
        <div className="overview-detail-empty">{copy.noWorkspace}</div>
      </section>
    )
  }

  return (
    <section className="overview-media-preview">
      <div className="overview-media-preview__head">
        <div className="overview-detail-section__title">{copy.title}</div>
        <div className="overview-media-preview__status">
          <span>{playbackState.playing ? copy.playing : copy.paused}</span>
          <span>{copy.time} {playbackState.time.toFixed(2)}s</span>
          <span>{copy.frame} {currentFrame}</span>
          <span>{copy.sampled} {workspace.joint_trajectory.sampled_points}/{workspace.joint_trajectory.total_points}</span>
        </div>
      </div>

      <div className="overview-media-preview__grid">
        <div className="overview-media-preview__video-panel">
          {effectiveVideo ? (
            <>
              <video
                key={effectiveVideo.url}
                ref={videoRef}
                src={effectiveVideo.url}
                controls
                playsInline
                preload="metadata"
              />
              {videos.length > 1 && (
                <div className="overview-media-preview__streams" aria-label={copy.stream}>
                  {videos.map((video) => (
                    <button
                      key={video.path}
                      type="button"
                      className={cn(video.path === effectiveVideo.path && 'is-selected')}
                      onClick={() => setSelectedVideoPath(video.path)}
                    >
                      {video.stream || video.path}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="overview-media-preview__empty">{copy.noVideo}</div>
          )}
        </div>

        <div className="overview-media-preview__joint-panel">
          {activeEntry ? (
            <>
              <div className="overview-media-preview__focus">
                <span>{copy.currentJoint}</span>
                <strong>{activeEntry.label}</strong>
                <em>{copy.action}: {formatJointValue(activeSnapshot.actionValue)}</em>
                <em>{copy.state}: {formatJointValue(activeSnapshot.stateValue)}</em>
                <em>{copy.delta}: {formatJointValue(activeSnapshot.deltaValue)}</em>
              </div>
              <div className="overview-media-preview__joint-list">
                {entries.map((entry) => {
                  const snapshot = jointSnapshot(entry, playbackState.index)
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className={cn(
                        'overview-media-preview__joint-row',
                        activeEntry.key === entry.key && 'is-selected',
                      )}
                      onClick={() => setSelectedJointKey(entry.key)}
                    >
                      <span>{entry.label}</span>
                      <strong>{formatJointValue(snapshot.actionValue)}</strong>
                      <em>{formatJointValue(snapshot.stateValue)}</em>
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="overview-media-preview__empty">{copy.noJoints}</div>
          )}
        </div>
      </div>
    </section>
  )
}
