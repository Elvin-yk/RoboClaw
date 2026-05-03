import { useEffect, useRef } from 'react'
import {
  clampAbsolutePlaybackTime,
  formatClipWindowLabel,
  getClipStart,
  getRelativePlaybackTime,
  shouldLoopVideo,
  type EpisodeVideo,
} from '@/domains/datasets/shared/playback/playbackWindow'
import type { ReviewVideo } from '../api'

function toEpisodeVideo(video: ReviewVideo): EpisodeVideo {
  return {
    path: video.path,
    url: video.url,
    stream: video.stream ?? video.name ?? video.relative_path,
    from_timestamp: video.from_timestamp ?? null,
    to_timestamp: video.to_timestamp ?? null,
  }
}

function syncIntoClip(
  element: HTMLVideoElement,
  meta: EpisodeVideo | null,
  loopToStart: boolean,
  forceSeek: boolean,
): number {
  const nextTime = clampAbsolutePlaybackTime(meta, element.currentTime, element.duration, {
    loopToStart,
  })
  if (forceSeek || Math.abs(element.currentTime - nextTime) > 0.08) {
    try {
      element.currentTime = nextTime
    } catch (_error) {
      // Ignore until metadata is ready.
    }
  }
  return nextTime
}

function seekFollower(
  follower: HTMLVideoElement,
  meta: EpisodeVideo | null,
  leaderRelative: number,
  loopToStart: boolean,
  forceSeek: boolean,
): void {
  const target = clampAbsolutePlaybackTime(
    meta,
    getClipStart(meta) + leaderRelative,
    follower.duration,
    { loopToStart },
  )
  if (forceSeek || Math.abs(follower.currentTime - target) > 0.08) {
    try {
      follower.currentTime = target
    } catch (_error) {
      // Ignore until metadata is ready.
    }
  }
}

function applyPlayState(target: HTMLVideoElement, paused: boolean): void {
  if (paused) {
    if (!target.paused) target.pause()
    return
  }
  if (target.paused) {
    const playPromise = target.play()
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {})
    }
  }
}

interface PlayerInternals {
  videos: ReviewVideo[]
  refs: Array<HTMLVideoElement | null>
  lockRef: { current: boolean }
  playVideo: boolean
}

function syncFromLeader(
  internals: PlayerInternals,
  leaderIndex: number,
  forceSeek: boolean,
): void {
  const leader = internals.refs[leaderIndex]
  if (!leader || internals.lockRef.current) return
  internals.lockRef.current = true

  const leaderMeta = toEpisodeVideo(internals.videos[leaderIndex])
  const leaderAbs = syncIntoClip(
    leader,
    leaderMeta,
    !leader.paused && internals.playVideo,
    forceSeek,
  )
  const leaderRel = getRelativePlaybackTime(leaderMeta, leaderAbs)
  const paused = leader.paused || !internals.playVideo
  const rate = leader.playbackRate

  internals.refs.forEach((target, idx) => {
    if (!target || idx === leaderIndex) return
    const targetMeta = toEpisodeVideo(internals.videos[idx])
    if (target.playbackRate !== rate) target.playbackRate = rate
    seekFollower(target, targetMeta, leaderRel, !paused, forceSeek)
    applyPlayState(target, paused)
  })

  queueMicrotask(() => {
    internals.lockRef.current = false
  })
}

export function ReviewVideoPlayer({ videos, playVideo, emptyLabel }: {
  videos: ReviewVideo[]
  playVideo: boolean
  emptyLabel: string
}) {
  const videoRefs = useRef<Array<HTMLVideoElement | null>>([])
  const lockRef = useRef(false)

  useEffect(() => {
    videoRefs.current = videoRefs.current.slice(0, videos.length)
  }, [videos])

  useEffect(() => {
    const internals: PlayerInternals = {
      videos,
      refs: videoRefs.current,
      lockRef,
      playVideo,
    }
    const cleanups: Array<() => void> = []
    videoRefs.current.forEach((video, index) => {
      if (!video) return
      const handle = (forceSeek: boolean) => () => {
        if (lockRef.current) return
        syncFromLeader({ ...internals, refs: videoRefs.current }, index, forceSeek)
      }
      const onPlay = handle(true)
      const onPause = handle(false)
      const onSeeking = handle(true)
      const onTimeUpdate = handle(false)
      const onLoadedMetadata = handle(true)

      video.addEventListener('play', onPlay)
      video.addEventListener('pause', onPause)
      video.addEventListener('seeking', onSeeking)
      video.addEventListener('timeupdate', onTimeUpdate)
      video.addEventListener('loadedmetadata', onLoadedMetadata)

      cleanups.push(() => {
        video.removeEventListener('play', onPlay)
        video.removeEventListener('pause', onPause)
        video.removeEventListener('seeking', onSeeking)
        video.removeEventListener('timeupdate', onTimeUpdate)
        video.removeEventListener('loadedmetadata', onLoadedMetadata)
      })
    })
    return () => cleanups.forEach((fn) => fn())
  }, [videos, playVideo])

  useEffect(() => {
    const refs = videoRefs.current
    if (!refs.length) return
    if (!playVideo) {
      refs.forEach((video) => video?.pause())
      return
    }
    refs.forEach((video, idx) => {
      if (!video) return
      syncIntoClip(video, toEpisodeVideo(videos[idx]), false, true)
      applyPlayState(video, false)
    })
  }, [playVideo, videos])

  if (videos.length === 0) {
    return <div className="explorer-hover-preview__empty">{emptyLabel}</div>
  }

  return (
    <div className="explorer-hover-preview__body explorer-episode-playback">
      <div className="explorer-hover-preview__video-grid">
        {videos.map((video, index) => {
          const meta = toEpisodeVideo(video)
          const clipLabel = formatClipWindowLabel(meta)
          return (
            <div key={video.path} className="explorer-hover-preview__video-card">
              <div className="explorer-hover-preview__status">
                <strong>{meta.stream}</strong>
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
                loop={shouldLoopVideo(meta)}
                playsInline
                preload="metadata"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default ReviewVideoPlayer
