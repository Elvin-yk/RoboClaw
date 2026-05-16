import { asArray, asRecord, clamp, numberValue, textValue } from '@/domains/data/lib/analysisPayload'

export interface EpisodeVideo {
  path: string
  url: string
  stream: string
  from_timestamp: number | null
  to_timestamp: number | null
}

export function readEpisodeVideos(episode: unknown): EpisodeVideo[] {
  const episodePayload = asRecord(episode)
  return asArray(episodePayload.videos).map(asRecord).map((video) => ({
    path: textValue(video.path),
    url: textValue(video.url),
    stream: textValue(video.stream) || textValue(video.path),
    from_timestamp: numberValue(video.from_timestamp),
    to_timestamp: numberValue(video.to_timestamp),
  })).filter((video) => Boolean(video.url))
}

export function getClipStart(video: EpisodeVideo | null | undefined): number {
  return video?.from_timestamp != null && Number.isFinite(video.from_timestamp) ? video.from_timestamp : 0
}

export function getClipEnd(video: EpisodeVideo | null | undefined, mediaDuration: number): number | null {
  if (video?.to_timestamp != null && Number.isFinite(video.to_timestamp)) return video.to_timestamp
  if (Number.isFinite(mediaDuration) && mediaDuration > 0) return mediaDuration
  return null
}

export function getAbsoluteClipTime(
  video: EpisodeVideo | null | undefined,
  relativeTime: number,
  mediaDuration: number,
): number {
  const start = getClipStart(video)
  const end = getClipEnd(video, mediaDuration)
  const maxRelative = end == null ? Number.POSITIVE_INFINITY : Math.max(end - start, 0)
  return start + clamp(relativeTime, 0, maxRelative)
}

export function framePreviewTime(
  video: EpisodeVideo,
  position: 'first' | 'last',
  duration: number | null,
): number {
  const start = getClipStart(video)
  const end = video.to_timestamp != null && Number.isFinite(video.to_timestamp)
    ? video.to_timestamp
    : duration
  const target = position === 'first'
    ? start
    : Math.max((end ?? duration ?? 0) - 0.05, start)
  if (duration == null || duration <= 0) return Math.max(target, 0)
  return Math.min(Math.max(target, 0), Math.max(duration - 0.05, 0))
}
