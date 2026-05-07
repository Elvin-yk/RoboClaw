import {
  asArray,
  asRecord,
  formatCount,
  formatDuration,
  formatSeconds,
  numberValue,
  textValue,
  type AnyRecord,
} from '@/domains/data/lib/analysisPayload'

interface CameraResolution {
  name: string
  width: number
  height: number
}

interface EpisodeLengthStats {
  shortest: number
  longest: number
  mean: number
  median: number
  stdDev: number
  durations: number[]
}

interface EpisodeLengthBin {
  label: string
  count: number
}

export function DatasetStatsPanel({
  summary,
  details,
  episodeRows,
}: {
  summary: AnyRecord
  details: AnyRecord
  episodeRows: AnyRecord[]
}) {
  const fps = numberValue(summary.fps) ?? 0
  const totalFrames = numberValue(summary.total_frames) ?? 0
  const totalEpisodes = numberValue(summary.total_episodes) ?? 0
  const recordingSeconds = fps > 0 ? totalFrames / fps : 0
  const cameraResolutions = extractCameraResolutions(summary, details)
  const lengthStats = computeEpisodeLengthStats(summary, episodeRows, fps, totalFrames, totalEpisodes)

  return (
    <>
      <div className="data-grid data-grid--four">
        <Metric title="TOTAL FRAMES" value={formatCount(summary.total_frames)} />
        <Metric title="TOTAL EPISODES" value={formatCount(summary.total_episodes)} />
        <Metric title="FPS" value={formatCount(summary.fps)} />
        <Metric title="TOTAL RECORDING TIME" value={formatDuration(recordingSeconds)} />
      </div>

      <section className="data-panel data-analysis-stats">
        <div className="data-analysis-stats__section data-analysis-stats__section--cameras">
          <div className="data-analysis-stats__header">
            <h2>Camera Resolutions</h2>
            <span>{formatCount(cameraResolutions.length)} streams</span>
          </div>
          <div className="data-analysis-camera-list">
            {cameraResolutions.map((camera) => (
              <div key={camera.name} className="data-analysis-camera-row">
                <span title={camera.name}>{camera.name}</span>
                <strong>{camera.width}x{camera.height}</strong>
              </div>
            ))}
            {!cameraResolutions.length && <div className="data-empty">未发现相机分辨率信息</div>}
          </div>
        </div>

        <div className="data-analysis-stats__section data-analysis-stats__section--lengths">
          <div className="data-analysis-stats__header">
            <h2>Episode Lengths</h2>
            <span>{formatCount(lengthStats?.durations.length ?? 0)} episodes</span>
          </div>
          {lengthStats ? (
            <>
              <div className="data-analysis-length-summary">
                <LengthCell label="SHORTEST" value={formatSeconds(lengthStats.shortest)} />
                <LengthCell label="LONGEST" value={formatSeconds(lengthStats.longest)} />
                <LengthCell label="MEAN" value={formatSeconds(lengthStats.mean)} />
                <LengthCell label="MEDIAN" value={formatSeconds(lengthStats.median)} />
                <LengthCell label="STD DEV" value={formatSeconds(lengthStats.stdDev)} />
              </div>
              <EpisodeLengthHistogram durations={lengthStats.durations} />
            </>
          ) : (
            <div className="data-empty">未发现 episode 长度信息</div>
          )}
        </div>
      </section>
    </>
  )
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <section className="data-panel data-panel--metric">
      <span>{title}</span>
      <strong className="data-metric">{value}</strong>
    </section>
  )
}

function LengthCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-analysis-length-cell">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function EpisodeLengthHistogram({ durations }: { durations: number[] }) {
  const bins = buildDurationBins(durations)
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1)

  return (
    <div className="data-analysis-length-histogram">
      <div className="data-analysis-length-histogram__plot" role="img" aria-label="Episode length histogram">
        {bins.map((bin) => (
          <div
            key={bin.label}
            className="data-analysis-length-histogram__bar"
            style={{ height: `${bin.count > 0 ? Math.max((bin.count / maxCount) * 100, 8) : 0}%` }}
            title={`${bin.label}: ${bin.count} episodes`}
          >
            {bin.count > 0 && <span>{bin.count}</span>}
          </div>
        ))}
      </div>
      <div className="data-analysis-length-histogram__axis">
        {bins.map((bin, index) => (
          <span key={bin.label}>{shouldShowBinLabel(index, bins.length) ? bin.label : ''}</span>
        ))}
      </div>
    </div>
  )
}

function extractCameraResolutions(summary: AnyRecord, details: AnyRecord): CameraResolution[] {
  const fromSummary = asArray(summary.camera_resolutions)
    .map(asRecord)
    .map((item) => {
      const name = textValue(item.name)
      const width = numberValue(item.width)
      const height = numberValue(item.height)
      return name && width && height ? { name, width, height } : null
    })
    .filter((item): item is CameraResolution => Boolean(item))

  const fromFeatures = asArray(details.feature_stats)
    .map(asRecord)
    .map(cameraFromFeature)
    .filter((item): item is CameraResolution => Boolean(item))

  const merged = new Map<string, CameraResolution>()
  for (const camera of [...fromSummary, ...fromFeatures]) {
    merged.set(camera.name, camera)
  }
  return [...merged.values()]
}

function cameraFromFeature(feature: AnyRecord): CameraResolution | null {
  const name = textValue(feature.name)
  const dtype = textValue(feature.dtype).toLowerCase()
  const isCamera = name.startsWith('observation.images') || dtype === 'video' || dtype === 'image'
  if (!isCamera) return null

  const shape = asArray(feature.shape)
    .map(numberValue)
    .filter((value): value is number => value != null && value > 0)
  if (shape.length < 2) return null

  const [first, second, third] = shape
  const channelsFirst = shape.length >= 3 && first <= 4 && second > 4 && third > 4
  const height = channelsFirst ? second : first
  const width = channelsFirst ? third : second
  return { name, width: Math.round(width), height: Math.round(height) }
}

function computeEpisodeLengthStats(
  summary: AnyRecord,
  episodeRows: AnyRecord[],
  fps: number,
  totalFrames: number,
  totalEpisodes: number,
): EpisodeLengthStats | null {
  const summaryLengths = asArray(summary.episode_lengths)
    .map(numberValue)
    .filter((value): value is number => value != null && value > 0)
  const rowLengths = episodeRows
    .map((row) => numberValue(row.length))
    .filter((value): value is number => value != null && value > 0)
  const lengths = summaryLengths.length ? summaryLengths : rowLengths.length ? rowLengths : (
    totalEpisodes === 1 && totalFrames > 0 ? [totalFrames] : []
  )
  if (!lengths.length) return null

  const durations = lengths.map((length) => (fps > 0 ? length / fps : length))
  const sortedDurations = [...durations].sort((a, b) => a - b)
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length
  const middle = Math.floor(sortedDurations.length / 2)
  const median = sortedDurations.length % 2 === 1
    ? sortedDurations[middle]
    : (sortedDurations[middle - 1] + sortedDurations[middle]) / 2
  const variance = durations.reduce((sum, value) => sum + (value - mean) ** 2, 0) / durations.length

  return {
    shortest: sortedDurations[0],
    longest: sortedDurations[sortedDurations.length - 1],
    mean,
    median,
    stdDev: Math.sqrt(variance),
    durations,
  }
}

function buildDurationBins(durations: number[]): EpisodeLengthBin[] {
  const finiteDurations = durations.filter((value) => Number.isFinite(value) && value >= 0)
  if (!finiteDurations.length) return []

  const minValue = Math.min(...finiteDurations)
  const maxValue = Math.max(...finiteDurations)
  if (minValue === maxValue) {
    return [{ label: compactSeconds(minValue), count: finiteDurations.length }]
  }

  const binCount = Math.min(12, Math.max(4, Math.ceil(Math.sqrt(finiteDurations.length))))
  const binSize = (maxValue - minValue) / binCount
  const bins = Array.from({ length: binCount }, (_, index) => {
    const start = minValue + binSize * index
    const end = index === binCount - 1 ? maxValue : start + binSize
    return { start, end, count: 0 }
  })

  for (const duration of finiteDurations) {
    const index = Math.min(Math.floor((duration - minValue) / binSize), binCount - 1)
    bins[index].count += 1
  }

  return bins.map((bin) => ({
    label: `${compactSeconds(bin.start)}-${compactSeconds(bin.end)}`,
    count: bin.count,
  }))
}

function compactSeconds(value: number): string {
  if (value >= 100) return `${Math.round(value)}s`
  if (value >= 10) return `${Number(value.toFixed(1))}s`
  return `${Number(value.toFixed(2))}s`
}

function shouldShowBinLabel(index: number, total: number): boolean {
  return total <= 6 || index === 0 || index === total - 1 || index % 2 === 1
}
