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
import { useI18n } from '@/i18n'

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
  const { t } = useI18n()
  const fps = numberValue(summary.fps) ?? 0
  const totalFrames = numberValue(summary.total_frames) ?? 0
  const totalEpisodes = numberValue(summary.total_episodes) ?? 0
  const recordingSeconds = fps > 0 ? totalFrames / fps : 0
  const cameraResolutions = extractCameraResolutions(summary, details)
  const lengthStats = computeEpisodeLengthStats(summary, episodeRows, fps, totalFrames, totalEpisodes)

  return (
    <>
      <div className="data-grid data-grid--four">
        <Metric title={t('dataAnalysisTotalFrames')} value={formatCount(summary.total_frames)} />
        <Metric title={t('dataAnalysisTotalEpisodes')} value={formatCount(summary.total_episodes)} />
        <Metric title="FPS" value={formatCount(summary.fps)} />
        <Metric title={t('dataAnalysisTotalRecordingTime')} value={formatDuration(recordingSeconds)} />
      </div>

      <section className="data-panel data-analysis-stats">
        <div className="data-analysis-stats__section data-analysis-stats__section--cameras">
          <div className="data-analysis-stats__header">
            <h2>{t('dataAnalysisCameraResolutions')}</h2>
            <span>{t('dataAnalysisStreams', { count: formatCount(cameraResolutions.length) })}</span>
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
            <h2>{t('dataAnalysisEpisodeLengths')}</h2>
            <span>{t('dataAnalysisEpisodes', { count: formatCount(lengthStats?.durations.length ?? 0) })}</span>
          </div>
          {lengthStats ? (
            <>
              <div className="data-analysis-length-summary">
                <LengthCell label={t('dataAnalysisShortest')} value={formatSeconds(lengthStats.shortest)} />
                <LengthCell label={t('dataAnalysisLongest')} value={formatSeconds(lengthStats.longest)} />
                <LengthCell label={t('dataAnalysisMean')} value={formatSeconds(lengthStats.mean)} />
                <LengthCell label={t('dataAnalysisMedian')} value={formatSeconds(lengthStats.median)} />
                <LengthCell label={t('dataAnalysisStdDev')} value={formatSeconds(lengthStats.stdDev)} />
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
  const { t } = useI18n()
  const bins = buildDurationBins(durations)
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1)

  return (
    <div className="data-analysis-length-histogram">
      <div className="data-analysis-length-histogram__plot" role="img" aria-label={t('dataAnalysisEpisodeLengthHistogram')}>
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
  const finiteDurations = durations
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
  if (!finiteDurations.length) return []

  const minValue = finiteDurations[0]
  const maxValue = finiteDurations[finiteDurations.length - 1]
  if (minValue === maxValue) {
    return [{ label: compactSeconds(minValue), count: finiteDurations.length }]
  }

  const percentileStart = percentile(finiteDurations, 0.01)
  const percentileEnd = percentile(finiteDurations, 0.99)
  const targetBins = Math.max(10, Math.min(50, Math.ceil(Math.log2(finiteDurations.length) + 1)))
  const binSize = niceBinSize(Math.max((percentileEnd - percentileStart) / targetBins, Number.EPSILON))
  const firstBinStart = Math.floor(percentileStart / binSize) * binSize
  const lastBinEnd = Math.ceil(percentileEnd / binSize) * binSize
  const binCount = Math.max(1, Math.round((lastBinEnd - firstBinStart) / binSize))
  const bins = Array.from({ length: binCount }, (_, index) => {
    const start = firstBinStart + binSize * index
    const end = index === binCount - 1 ? lastBinEnd : start + binSize
    return { start, end, count: 0 }
  })

  for (const duration of finiteDurations) {
    const index = Math.min(Math.max(Math.floor((duration - firstBinStart) / binSize), 0), binCount - 1)
    bins[index].count += 1
  }

  return bins.map((bin) => ({
    label: `${compactSeconds(bin.start)}-${compactSeconds(bin.end)}`,
    count: bin.count,
  }))
}

function percentile(values: number[], ratio: number): number {
  const index = Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * ratio)))
  return values[index]
}

function niceBinSize(rawSize: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rawSize))
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= rawSize) ?? 10
  return step * magnitude
}

function compactSeconds(value: number): string {
  if (value >= 100) return `${Math.round(value)}s`
  if (value >= 10) return `${Number(value.toFixed(1))}s`
  return `${Number(value.toFixed(2))}s`
}

function shouldShowBinLabel(index: number, total: number): boolean {
  return total <= 6 || index === 0 || index === total - 1 || index % 2 === 1
}
