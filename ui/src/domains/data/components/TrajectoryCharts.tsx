import { useMemo, useState, type ReactNode } from 'react'
import { clamp, formatSeconds, relativeTimeValues } from '@/domains/data/lib/analysisPayload'

export interface TrajectoryItem {
  jointName: string
  actionName: string
  stateName: string
  actionValues: Array<number | null>
  stateValues: Array<number | null>
}

export interface TrajectoryPayload {
  timeValues: number[]
  items: TrajectoryItem[]
  totalPoints: number
}

interface TrajectorySeries {
  id: string
  label: string
  color: string
  actionValues: Array<number | null>
  stateValues: Array<number | null>
}

const SERIES_COLORS = [
  '#f97316',
  '#3b82f6',
  '#22c55e',
  '#ef4444',
  '#a855f7',
  '#eab308',
  '#06b6d4',
  '#ec4899',
  '#14b8a6',
  '#f59e0b',
  '#6366f1',
  '#84cc16',
]

type ChartMode = 'grouped' | 'combined'

export function TrajectoryCharts({
  trajectory,
  currentTime,
  duration,
  onSeek,
}: {
  trajectory: TrajectoryPayload
  currentTime: number
  duration: number
  onSeek: (seconds: number) => void
}) {
  const [mode, setMode] = useState<ChartMode>('combined')
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set())
  const relativeTimes = useMemo(() => relativeTimeValues(trajectory.timeValues), [trajectory.timeValues])
  const chartDuration = duration || relativeTimes[relativeTimes.length - 1] || 0
  const series = useMemo(() => buildSeries(trajectory.items), [trajectory.items])

  if (!series.length) {
    return <div className="data-empty">未加载 action / observation 曲线</div>
  }

  const groups = mode === 'combined' ? [series] : chunk(series, 3)
  const cursorPercent = chartDuration > 0 ? clamp((currentTime / chartDuration) * 100, 0, 100) : 0

  function toggleSeries(seriesId: string) {
    setHiddenSeries((current) => {
      const next = new Set(current)
      if (next.has(seriesId)) {
        next.delete(seriesId)
      } else {
        next.add(seriesId)
      }
      return next
    })
  }

  const chartModeControls = (
    <div className="data-analysis-chart-modes" role="group" aria-label="Chart display mode">
      <button
        type="button"
        className={mode === 'grouped' ? 'data-analysis-secondary-button is-active' : 'data-analysis-secondary-button'}
        onClick={() => setMode('grouped')}
      >
        Split
      </button>
      <button
        type="button"
        className={mode === 'combined' ? 'data-analysis-secondary-button is-active' : 'data-analysis-secondary-button'}
        onClick={() => setMode('combined')}
      >
        Combine all
      </button>
    </div>
  )

  return (
    <div className="data-analysis-charts">
      <div className={mode === 'combined' ? 'data-analysis-combined-chart-list' : 'data-analysis-group-chart-list'}>
        {groups.map((group, index) => (
          <TrajectoryGroupChart
            key={`${mode}-${index}`}
            series={group}
            controls={index === 0 ? chartModeControls : null}
            hiddenSeries={hiddenSeries}
            relativeTimes={relativeTimes}
            currentTime={currentTime}
            cursorPercent={cursorPercent}
            duration={chartDuration}
            combined={mode === 'combined'}
            onSeek={onSeek}
            onToggleSeries={toggleSeries}
          />
        ))}
      </div>
    </div>
  )
}

function TrajectoryGroupChart({
  series,
  controls,
  hiddenSeries,
  relativeTimes,
  currentTime,
  cursorPercent,
  duration,
  combined,
  onSeek,
  onToggleSeries,
}: {
  series: TrajectorySeries[]
  controls: ReactNode
  hiddenSeries: Set<string>
  relativeTimes: number[]
  currentTime: number
  cursorPercent: number
  duration: number
  combined: boolean
  onSeek: (seconds: number) => void
  onToggleSeries: (seriesId: string) => void
}) {
  const visibleSeries = series.filter((item) => !hiddenSeries.has(item.id))
  const chartSeries = visibleSeries.length ? visibleSeries : series
  const [yMin, yMax] = yBounds(chartSeries)
  const tickValues = yTicks(yMin, yMax)
  const timeTicks = xTickValues(duration, combined ? 7 : 5)
  const xGridLines = xAxisPositions(timeTicks.length)
  const currentIndex = closestIndex(relativeTimes, currentTime)
  const title = series.map((item) => item.label).join(', ')

  return (
    <section className={combined ? 'data-analysis-group-chart data-analysis-group-chart--combined' : 'data-analysis-group-chart'}>
      <div className="data-analysis-group-chart__titlebar">
        {!combined && <div className="data-analysis-group-chart__title" title={title}>{title}</div>}
        {controls}
      </div>
      <button
        type="button"
        className="data-analysis-group-chart__plot"
        onClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          const ratio = clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
          onSeek(ratio * duration)
        }}
        aria-label={`Seek ${title}`}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <g className="data-analysis-group-chart__grid">
            {[10, 28, 46, 64, 82].map((y) => <line key={`y-${y}`} x1="6" y1={y} x2="98" y2={y} />)}
            {xGridLines.map((x) => <line key={`x-${x}`} x1={x} y1="10" x2={x} y2="82" />)}
          </g>
          {chartSeries.map((item) => (
            <g key={item.id}>
              <polyline
                points={buildPolyline(item.actionValues, relativeTimes, duration, yMin, yMax)}
                fill="none"
                stroke={item.color}
                strokeWidth={combined ? '0.45' : '0.65'}
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={buildPolyline(item.stateValues, relativeTimes, duration, yMin, yMax)}
                fill="none"
                stroke={item.color}
                strokeWidth={combined ? '0.45' : '0.65'}
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          <line
            x1={6 + (cursorPercent / 100) * 92}
            y1="10"
            x2={6 + (cursorPercent / 100) * 92}
            y2="82"
            className="data-analysis-group-chart__cursor"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <span className="data-analysis-group-chart__yticks">
          {tickValues.map((tick) => <span key={tick}>{formatAxisValue(tick)}</span>)}
        </span>
        <span className="data-analysis-group-chart__xticks">
          {timeTicks.map((tick, index) => <span key={`${index}-${tick}`}>{formatSeconds(tick)}</span>)}
        </span>
      </button>
      <div className="data-analysis-group-chart__legend">
        {series.map((item) => {
          const hidden = hiddenSeries.has(item.id)
          const actionValue = item.actionValues[currentIndex]
          const stateValue = item.stateValues[currentIndex]
          return (
            <label key={item.id} className={hidden ? 'is-hidden' : ''}>
              <input
                type="checkbox"
                checked={!hidden}
                onChange={() => onToggleSeries(item.id)}
                style={{ accentColor: item.color }}
              />
              <span className="data-analysis-group-chart__legend-title" style={{ color: item.color }}>
                {item.label}
              </span>
              <span>action {formatSeriesValue(actionValue)}</span>
              <span>observation.state {formatSeriesValue(stateValue)}</span>
            </label>
          )
        })}
      </div>
    </section>
  )
}

function buildSeries(items: TrajectoryItem[]): TrajectorySeries[] {
  return items.map((item, index) => ({
    id: `${item.jointName}-${index}`,
    label: item.jointName,
    color: SERIES_COLORS[index % SERIES_COLORS.length],
    actionValues: item.actionValues,
    stateValues: item.stateValues,
  }))
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function yBounds(series: TrajectorySeries[]): [number, number] {
  const values = series
    .flatMap((item) => [...item.actionValues, ...item.stateValues])
    .filter((value): value is number => value != null && Number.isFinite(value))
  if (!values.length) return [-1, 1]
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const padding = Math.max((maxValue - minValue) * 0.1, 0.01)
  return [minValue - padding, maxValue + padding]
}

function yTicks(minValue: number, maxValue: number): number[] {
  const span = maxValue - minValue || 1
  return Array.from({ length: 5 }, (_, index) => maxValue - span * (index / 4))
}

function xTickValues(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 1) return [0]
  return Array.from({ length: count }, (_, index) => duration * (index / (count - 1)))
}

function xAxisPositions(count: number): number[] {
  if (count <= 1) return [6]
  return Array.from({ length: count }, (_, index) => 6 + 92 * (index / (count - 1)))
}

function buildPolyline(
  values: Array<number | null>,
  relativeTimes: number[],
  duration: number,
  yMin: number,
  yMax: number,
): string {
  const yRange = yMax - yMin || 1
  const lastIndex = Math.max(values.length - 1, 1)
  return values
    .map((value, index) => {
      if (value == null || !Number.isFinite(value)) return ''
      const xSource = relativeTimes[index] ?? (duration * index) / lastIndex
      const x = duration > 0 ? 6 + (xSource / duration) * 92 : 6 + (index / lastIndex) * 92
      const y = 10 + ((yMax - value) / yRange) * 72
      return `${clamp(x, 6, 98).toFixed(2)},${clamp(y, 10, 82).toFixed(2)}`
    })
    .filter(Boolean)
    .join(' ')
}

function closestIndex(values: number[], target: number): number {
  if (!values.length) return 0
  let bestIndex = 0
  let bestDistance = Number.POSITIVE_INFINITY
  values.forEach((value, index) => {
    const distance = Math.abs(value - target)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  })
  return bestIndex
}

function formatAxisValue(value: number): string {
  if (value === 0) return '0'
  const abs = Math.abs(value)
  if (abs < 0.01 || abs >= 10000) return value.toExponential(1)
  return Number(value.toFixed(2)).toString()
}

function formatSeriesValue(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '--' : value.toFixed(2)
}
