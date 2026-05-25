import { useEffect, useMemo, useRef, useState } from 'react'
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
const CHART_X_MIN = 7
const CHART_X_MAX = 98
const CHART_Y_MIN = 3
const CHART_Y_MAX = 90
const CHART_X_RANGE = CHART_X_MAX - CHART_X_MIN
const CHART_Y_RANGE = CHART_Y_MAX - CHART_Y_MIN
const Y_AXIS_TICK_COUNT = 5

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
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(new Set())
  const relativeTimes = useMemo(() => relativeTimeValues(trajectory.timeValues), [trajectory.timeValues])
  const chartDuration = duration || relativeTimes[relativeTimes.length - 1] || 0
  const series = useMemo(() => buildSeries(trajectory.items), [trajectory.items])

  if (!series.length) {
    return <div className="data-empty">未加载 action / observation 曲线</div>
  }

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

  return (
    <div className="data-analysis-charts">
      <div className="data-analysis-section-title">关节动作曲线</div>
      <div className="data-analysis-combined-chart-list">
        <TrajectoryGroupChart
          series={series}
          hiddenSeries={hiddenSeries}
          relativeTimes={relativeTimes}
          currentTime={currentTime}
          cursorPercent={cursorPercent}
          duration={chartDuration}
          onSeek={onSeek}
          onToggleSeries={toggleSeries}
        />
      </div>
    </div>
  )
}

function TrajectoryGroupChart({
  series,
  hiddenSeries,
  relativeTimes,
  currentTime,
  cursorPercent,
  duration,
  onSeek,
  onToggleSeries,
}: {
  series: TrajectorySeries[]
  hiddenSeries: Set<string>
  relativeTimes: number[]
  currentTime: number
  cursorPercent: number
  duration: number
  onSeek: (seconds: number) => void
  onToggleSeries: (seriesId: string) => void
}) {
  const plotRef = useRef<HTMLButtonElement | null>(null)
  const [plotWidth, setPlotWidth] = useState(0)
  const visibleSeries = series.filter((item) => !hiddenSeries.has(item.id))
  const chartSeries = visibleSeries.length ? visibleSeries : series
  const [yMin, yMax] = yBounds(chartSeries)
  const tickValues = yTicks(yMin, yMax)
  const timeTicks = xTickValues(duration, xTickCount(plotWidth))
  const xGridLines = xAxisPositions(timeTicks.length)
  const currentIndex = closestIndex(relativeTimes, currentTime)
  const title = series.map((item) => item.label).join(', ')

  useEffect(() => {
    const node = plotRef.current
    if (!node) return undefined
    const observer = new ResizeObserver(([entry]) => {
      setPlotWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <section className="data-analysis-group-chart data-analysis-group-chart--combined">
      <button
        ref={plotRef}
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
            {yAxisPositions().map((y) => (
              <line key={`y-${y}`} x1={CHART_X_MIN} y1={y} x2={CHART_X_MAX} y2={y} />
            ))}
            {xGridLines.map((x) => (
              <line key={`x-${x}`} x1={x} y1={CHART_Y_MIN} x2={x} y2={CHART_Y_MAX} />
            ))}
          </g>
          {chartSeries.map((item) => (
            <g key={item.id}>
              <polyline
                points={buildPolyline(item.actionValues, relativeTimes, duration, yMin, yMax)}
                fill="none"
                stroke={item.color}
                strokeWidth="0.45"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={buildPolyline(item.stateValues, relativeTimes, duration, yMin, yMax)}
                fill="none"
                stroke={item.color}
                strokeWidth="0.45"
                strokeDasharray="3 2"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          <line
            x1={CHART_X_MIN + (cursorPercent / 100) * CHART_X_RANGE}
            y1={CHART_Y_MIN}
            x2={CHART_X_MIN + (cursorPercent / 100) * CHART_X_RANGE}
            y2={CHART_Y_MAX}
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

function yBounds(series: TrajectorySeries[]): [number, number] {
  const values = series
    .flatMap((item) => [...item.actionValues, ...item.stateValues])
    .filter((value): value is number => value != null && Number.isFinite(value))
  if (!values.length) return [-1, 1]
  const minValue = Math.min(...values)
  const maxValue = Math.max(...values)
  const range = maxValue - minValue
  const padding = range > 0 ? Math.max(range * 0.02, 0.01) : Math.max(Math.abs(maxValue) * 0.02, 0.01)
  return [minValue - padding, maxValue + padding]
}

function yTicks(minValue: number, maxValue: number): number[] {
  const span = maxValue - minValue || 1
  return Array.from({ length: Y_AXIS_TICK_COUNT }, (_, index) => (
    maxValue - span * (index / (Y_AXIS_TICK_COUNT - 1))
  ))
}

function xTickValues(duration: number, count: number): number[] {
  if (duration <= 0 || count <= 1) return [0]
  return Array.from({ length: count }, (_, index) => duration * (index / (count - 1)))
}

function xAxisPositions(count: number): number[] {
  if (count <= 1) return [CHART_X_MIN]
  return Array.from({ length: count }, (_, index) => (
    CHART_X_MIN + CHART_X_RANGE * (index / (count - 1))
  ))
}

function yAxisPositions(): number[] {
  return Array.from({ length: Y_AXIS_TICK_COUNT }, (_, index) => (
    CHART_Y_MIN + CHART_Y_RANGE * (index / (Y_AXIS_TICK_COUNT - 1))
  ))
}

function xTickCount(width: number): number {
  if (width > 0 && width < 520) return 3
  if (width > 0 && width < 760) return 5
  return 7
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
      const x = duration > 0
        ? CHART_X_MIN + (xSource / duration) * CHART_X_RANGE
        : CHART_X_MIN + (index / lastIndex) * CHART_X_RANGE
      const y = CHART_Y_MIN + ((yMax - value) / yRange) * CHART_Y_RANGE
      return `${clamp(x, CHART_X_MIN, CHART_X_MAX).toFixed(2)},${clamp(y, CHART_Y_MIN, CHART_Y_MAX).toFixed(2)}`
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
