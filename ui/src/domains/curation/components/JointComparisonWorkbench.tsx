import { useMemo } from 'react'
import { type AnnotationWorkspacePayload } from '@/domains/curation/store/useCurationStore'
import {
  buildComparisonSelectionKey,
  buildJointComparisonEntries,
  buildLinePath,
  buildStepLinePath,
  findClosestPlaybackIndex,
  findWindowBounds,
  formatValue,
  getComparisonSnapshot,
  sampleSeriesWindow,
  type ComparisonEntry,
} from './annotationPanelUtils'

function JointComparisonChart({
  entry,
  currentTime,
  emptyLabel,
  width = 720,
  height = 220,
  windowSize = 4,
}: {
  entry: ComparisonEntry
  currentTime: number
  emptyLabel: string
  width?: number
  height?: number
  windowSize?: number
}) {
  const padding = 12
  const [startIndex, endIndex] = findWindowBounds(entry.xValues, currentTime, windowSize)
  const windowed = sampleSeriesWindow(
    entry.xValues,
    entry.actionValues,
    entry.stateValues,
    startIndex,
    endIndex,
    56,
  )
  const chartXValues = windowed.xValues
  const chartActionValues = windowed.actionValues
  const chartStateValues = windowed.stateValues
  const numericValues = [...chartActionValues, ...chartStateValues].filter(
    (value): value is number => Number.isFinite(value),
  )

  if (!numericValues.length) {
    return <div className="episode-preview-empty">{emptyLabel}</div>
  }

  let minY = Math.min(...numericValues)
  let maxY = Math.max(...numericValues)
  if (Math.abs(maxY - minY) < 1e-6) {
    minY -= 1
    maxY += 1
  }

  const minX = chartXValues[0] || 0
  const maxX = chartXValues[chartXValues.length - 1] || 1
  const safeRangeX = maxX - minX || 1
  const xAxisY = height - padding
  const midX = minX + safeRangeX / 2
  const cursorX =
    padding +
    ((Math.min(Math.max(currentTime, minX), maxX) - minX) / safeRangeX) * (width - padding * 2)

  const currentIndex = chartXValues.length
    ? findClosestPlaybackIndex(chartXValues, Math.min(Math.max(currentTime, minX), maxX))
    : 0
  const currentActionValue = chartActionValues[currentIndex]
  const currentStateValue = chartStateValues[currentIndex]
  const usableHeight = height - padding * 2
  const rangeY = maxY - minY || 1
  const actionDotY =
    Number.isFinite(currentActionValue)
      ? padding + usableHeight - ((Number(currentActionValue) - minY) / rangeY) * usableHeight
      : null
  const stateDotY =
    Number.isFinite(currentStateValue)
      ? padding + usableHeight - ((Number(currentStateValue) - minY) / rangeY) * usableHeight
      : null

  const actionPath = buildStepLinePath(
    chartXValues.map((value) => value - minX),
    chartActionValues,
    minY,
    maxY,
    width,
    height,
    padding,
  )
  const statePath = buildStepLinePath(
    chartXValues.map((value) => value - minX),
    chartStateValues,
    minY,
    maxY,
    width,
    height,
    padding,
  )

  return (
    <svg
      className="joint-comparison-chart"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${entry.label} trajectory`}
    >
      <rect x="0" y="0" width={width} height={height} rx="14" fill="rgba(255, 255, 255, 0.82)" />
      {[0, 0.5, 1].map((ratio) => {
        const y = padding + ratio * (height - padding * 2)
        return (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={y}
            y2={y}
            stroke="rgba(47, 111, 228, 0.12)"
            strokeWidth="1"
          />
        )
      })}
      <line
        x1={padding}
        x2={width - padding}
        y1={xAxisY}
        y2={xAxisY}
        stroke="rgba(47, 111, 228, 0.12)"
        strokeWidth="1"
      />
      <line
        x1={cursorX}
        x2={cursorX}
        y1={padding}
        y2={height - padding}
        stroke="rgba(17, 17, 17, 0.35)"
        strokeDasharray="4 4"
        strokeWidth="1.4"
      />
      {actionPath ? (
        <path
          d={actionPath}
          fill="none"
          stroke="#2f6fe4"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {statePath ? (
        <path
          d={statePath}
          fill="none"
          stroke="#ff8a5b"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {actionDotY !== null ? (
        <circle
          cx={cursorX}
          cy={actionDotY}
          r="3.6"
          fill="#2f6fe4"
          stroke="white"
          strokeWidth="1.6"
        />
      ) : null}
      {stateDotY !== null ? (
        <circle
          cx={cursorX}
          cy={stateDotY}
          r="3.6"
          fill="#ff8a5b"
          stroke="white"
          strokeWidth="1.6"
        />
      ) : null}
      {[
        { label: `${minX.toFixed(1)}s`, x: padding, anchor: 'start' as const },
        { label: `${midX.toFixed(1)}s`, x: width / 2, anchor: 'middle' as const },
        { label: `${maxX.toFixed(1)}s`, x: width - padding, anchor: 'end' as const },
      ].map((tick) => (
        <text
          key={tick.label}
          x={tick.x}
          y={height - 2}
          textAnchor={tick.anchor}
          fill="rgba(95,107,122,0.9)"
          fontSize="11"
          fontWeight="700"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  )
}

function DeltaComparisonChart({
  entry,
  currentTime,
  emptyLabel,
  width = 720,
  height = 140,
  windowSize = 4,
}: {
  entry: ComparisonEntry
  currentTime: number
  emptyLabel: string
  width?: number
  height?: number
  windowSize?: number
}) {
  const padding = 12
  const [startIndex, endIndex] = findWindowBounds(entry.xValues, currentTime, windowSize)
  const windowed = sampleSeriesWindow(
    entry.xValues,
    entry.actionValues,
    entry.stateValues,
    startIndex,
    endIndex,
    48,
  )
  const chartXValues = windowed.xValues
  const deltaValues = chartXValues.map((_, index) => {
    const actionValue = windowed.actionValues[index]
    const stateValue = windowed.stateValues[index]
    if (!Number.isFinite(actionValue) || !Number.isFinite(stateValue)) {
      return null
    }
    return Number(actionValue) - Number(stateValue)
  })
  const numericValues = deltaValues.filter((value): value is number => Number.isFinite(value))

  if (!numericValues.length) {
    return <div className="episode-preview-empty">{emptyLabel}</div>
  }

  const minValue = Math.min(...numericValues, 0)
  const maxValue = Math.max(...numericValues, 0)
  const minX = chartXValues[0] || 0
  const maxX = chartXValues[chartXValues.length - 1] || 1
  const safeRangeX = maxX - minX || 1
  const zeroY =
    padding + (height - padding * 2) - ((0 - minValue) / (maxValue - minValue || 1)) * (height - padding * 2)
  const currentIndex = chartXValues.length
    ? findClosestPlaybackIndex(chartXValues, Math.min(Math.max(currentTime, minX), maxX))
    : 0
  const currentDelta = deltaValues[currentIndex]
  const cursorX =
    padding +
    ((Math.min(Math.max(currentTime, minX), maxX) - minX) / safeRangeX) * (width - padding * 2)
  const currentDeltaY =
    Number.isFinite(currentDelta)
      ? padding + (height - padding * 2) - ((Number(currentDelta) - minValue) / (maxValue - minValue || 1)) * (height - padding * 2)
      : null
  const deltaPath = buildLinePath(
    chartXValues.map((value) => value - minX),
    deltaValues,
    minValue,
    maxValue,
    width,
    height,
    padding,
  )

  return (
    <svg
      className="joint-comparison-chart joint-comparison-chart--delta"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${entry.label} delta trajectory`}
    >
      <rect x="0" y="0" width={width} height={height} rx="14" fill="rgba(255, 255, 255, 0.82)" />
      <line
        x1={padding}
        x2={width - padding}
        y1={zeroY}
        y2={zeroY}
        stroke="rgba(47, 111, 228, 0.16)"
        strokeDasharray="4 4"
        strokeWidth="1.2"
      />
      <line
        x1={cursorX}
        x2={cursorX}
        y1={padding}
        y2={height - padding}
        stroke="rgba(17, 17, 17, 0.28)"
        strokeDasharray="4 4"
        strokeWidth="1.2"
      />
      <path
        d={deltaPath}
        fill="none"
        stroke="#7c68ff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {currentDeltaY !== null ? (
        <circle
          cx={cursorX}
          cy={currentDeltaY}
          r="3.6"
          fill="#7c68ff"
          stroke="white"
          strokeWidth="1.6"
        />
      ) : null}
    </svg>
  )
}

export default function JointComparisonWorkbench({
  jointTrajectory,
  currentTime,
  copy,
  activeKey,
  onSelectEntry,
}: {
  jointTrajectory: AnnotationWorkspacePayload['joint_trajectory'] | null
  currentTime: number
  copy: {
    noJointData: string
    actionSeries: string
    stateSeries: string
    focusActionValue: string
    focusStateValue: string
  }
  activeKey: string
  onSelectEntry: (key: string) => void
}) {
  const entries = useMemo(
    () => buildJointComparisonEntries(jointTrajectory),
    [jointTrajectory],
  )

  if (!entries.length) {
    return <div className="episode-preview-empty">{copy.noJointData}</div>
  }

  const activeEntry =
    entries.find((entry) => buildComparisonSelectionKey(entry) === activeKey)
    || entries[0]
  const activeSnapshot = getComparisonSnapshot(activeEntry, currentTime)

  return (
    <div className="joint-comparison-workbench">
      <div className="joint-comparison-main-panel">
        <div className="joint-comparison-main-panel__head">
          <div>
            <strong>{activeEntry.label}</strong>
            <span className="joint-comparison-main-panel__sub">
              {copy.actionSeries} vs {copy.stateSeries}
            </span>
          </div>
          <div className="joint-comparison-main-panel__metrics">
            <span>{copy.focusActionValue}: {formatValue(activeSnapshot.actionValue)}</span>
            <span>{copy.focusStateValue}: {formatValue(activeSnapshot.stateValue)}</span>
            <span>Delta: {formatValue(activeSnapshot.deltaValue)}</span>
          </div>
        </div>
        <JointComparisonChart
          entry={activeEntry}
          currentTime={currentTime}
          emptyLabel={copy.noJointData}
          width={820}
          height={220}
          windowSize={4}
        />
        <DeltaComparisonChart
          entry={activeEntry}
          currentTime={currentTime}
          emptyLabel={copy.noJointData}
          width={820}
          height={132}
          windowSize={4}
        />
      </div>

      <div className="joint-comparison-list">
        {entries.map((entry) => {
          const selectionKey = buildComparisonSelectionKey(entry)
          const isSelected = selectionKey === buildComparisonSelectionKey(activeEntry)
          const snapshot = getComparisonSnapshot(entry, currentTime)
          return (
            <button
              key={entry.key}
              type="button"
              className={isSelected ? 'joint-comparison-list__item is-selected' : 'joint-comparison-list__item'}
              onClick={() => onSelectEntry(selectionKey)}
            >
              <div className="joint-comparison-list__head">
                <strong>{entry.label}</strong>
                <span>{formatValue(snapshot.deltaValue)}</span>
              </div>
              <div className="joint-comparison-list__meta">
                <span>A {formatValue(snapshot.actionValue)}</span>
                <span>S {formatValue(snapshot.stateValue)}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
