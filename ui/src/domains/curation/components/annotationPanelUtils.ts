import {
  type AnnotationItem,
  type AnnotationWorkspacePayload,
  type WorkflowTaskContext,
} from '@/domains/curation/store/useCurationStore'

export const ANNOTATION_SEED_COLORS = [
  '#44d7ff',
  '#ff8a5b',
  '#b7ff5c',
  '#ffd84d',
  '#ff6ba8',
  '#8c9bff',
]
export const CLIP_TIME_EPSILON = 0.05

export interface ComparisonEntry {
  key: string
  label: string
  actionValues: Array<number | null>
  stateValues: Array<number | null>
  xValues: number[]
}

export interface SavedComparisonContext {
  jointName: string
  timeS: number | null
  frameIndex: number | null
  actionValue: number | null
  stateValue: number | null
  source: string
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function clampAnnotationTime(value: number, maxValue: number): number {
  return Math.min(Math.max(value, 0), Math.max(maxValue, 0))
}

export function getClipStart(videoItem: AnnotationWorkspacePayload['videos'][number] | null): number {
  return typeof videoItem?.from_timestamp === 'number' ? videoItem.from_timestamp : 0
}

export function getClipEnd(
  videoItem: AnnotationWorkspacePayload['videos'][number] | null,
): number | null {
  return typeof videoItem?.to_timestamp === 'number' ? videoItem.to_timestamp : null
}

export function clampToClipWindow(
  videoItem: AnnotationWorkspacePayload['videos'][number] | null,
  absoluteTime: number,
  duration = Number.POSITIVE_INFINITY,
): number {
  const clipStart = getClipStart(videoItem)
  const clipEnd = getClipEnd(videoItem)
  let nextTime = Number.isFinite(absoluteTime) ? absoluteTime : clipStart

  nextTime = Math.max(nextTime, clipStart)
  if (isFiniteNumber(clipEnd)) {
    nextTime = Math.min(nextTime, clipEnd)
  }
  if (Number.isFinite(duration)) {
    nextTime = Math.min(nextTime, duration)
  }

  return nextTime
}

export function getRelativePlaybackTime(
  videoItem: AnnotationWorkspacePayload['videos'][number] | null,
  absoluteTime: number,
): number {
  return Math.max(absoluteTime - getClipStart(videoItem), 0)
}

export function findClosestPlaybackIndex(timeValues: number[], currentTime: number): number {
  if (!timeValues.length) return 0

  let closestIndex = 0
  let smallestDiff = Number.POSITIVE_INFINITY

  timeValues.forEach((timeValue, index) => {
    const diff = Math.abs(timeValue - currentTime)
    if (diff < smallestDiff) {
      smallestDiff = diff
      closestIndex = index
    }
  })

  return closestIndex
}

export function buildDefaultAnnotationText(summary: AnnotationWorkspacePayload['summary'] | null): string {
  if (!summary) return 'Add an annotation for the current task.'
  if (summary.task_label) return summary.task_label
  if (summary.task_value) return summary.task_value
  return `Episode: ${summary.record_key}`
}

export function deriveAnnotationLabel(text: string, fallback: string): string {
  const firstLine = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return fallback
  return firstLine.slice(0, 48)
}

export function normalizeAnnotation(
  annotation: Partial<AnnotationItem> | null | undefined,
  fallbackKey = 'episode',
): AnnotationItem | null {
  if (!annotation || typeof annotation !== 'object') return null

  return {
    id:
      annotation.id ??
      `${fallbackKey}-annotation-${Math.random().toString(36).slice(2, 8)}`,
    label:
      annotation.label ||
      deriveAnnotationLabel(annotation.text || '', 'Annotation'),
    category: annotation.category || 'movement',
    color: annotation.color || ANNOTATION_SEED_COLORS[0],
    startTime: Number(annotation.startTime ?? 0),
    endTime:
      annotation.endTime === null || annotation.endTime === undefined
        ? null
        : Number(annotation.endTime),
    text: String(annotation.text || ''),
    tags: Array.isArray(annotation.tags) ? annotation.tags : [],
    source: annotation.source || 'user',
  }
}

export function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '0.00'
}

export function formatValue(value: number | null | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(3) : '-'
}

export function buildComparisonSelectionKey(entry: ComparisonEntry): string {
  return `${entry.label}|${entry.key}`
}

export function matchComparisonSelectionKey(
  entries: ComparisonEntry[],
  jointName: string,
): string {
  if (!jointName) return ''
  const normalizedJoint = String(jointName).trim().toLowerCase()
  const matchedEntry = entries.find(
    (entry) => entry.label.toLowerCase() === normalizedJoint,
  )
  return matchedEntry ? buildComparisonSelectionKey(matchedEntry) : ''
}

export function normalizeSavedComparisonContext(
  taskContext: WorkflowTaskContext | null | undefined,
): SavedComparisonContext | null {
  if (!taskContext || typeof taskContext !== 'object') return null

  const timeValue = Number(taskContext.time_s)
  return {
    jointName: String(taskContext.joint_name || '').trim(),
    timeS: Number.isFinite(timeValue) ? Math.max(timeValue, 0) : null,
    frameIndex: Number.isFinite(Number(taskContext.frame_index))
      ? Number(taskContext.frame_index)
      : null,
    actionValue: Number.isFinite(Number(taskContext.action_value))
      ? Number(taskContext.action_value)
      : null,
    stateValue: Number.isFinite(Number(taskContext.state_value))
      ? Number(taskContext.state_value)
      : null,
    source: String(taskContext.source || '').trim(),
  }
}

export function buildJointComparisonEntries(
  jointTrajectory: AnnotationWorkspacePayload['joint_trajectory'] | null,
): ComparisonEntry[] {
  const timeValues = jointTrajectory?.time_values || []
  const baseTime = isFiniteNumber(timeValues[0]) ? timeValues[0] : 0
  const relativeTimes = timeValues.map((timeValue) =>
    isFiniteNumber(timeValue) ? Math.max(timeValue - baseTime, 0) : 0,
  )

  return (jointTrajectory?.joint_trajectories || [])
    .map((item, index) => ({
      key: `${item.joint_name || item.state_name || item.action_name || 'joint'}-${index}`,
      label: item.joint_name || item.state_name || item.action_name || 'Joint',
      actionValues: item.action_values || [],
      stateValues: item.state_values || [],
      xValues: relativeTimes,
    }))
    .filter((item) => {
      const hasAction = item.actionValues.some(
        (value) => value !== null && value !== undefined,
      )
      const hasState = item.stateValues.some(
        (value) => value !== null && value !== undefined,
      )
      return item.xValues.length && (hasAction || hasState)
    })
}

export function buildLinePath(
  xValues: number[],
  series: Array<number | null>,
  minY: number,
  maxY: number,
  width: number,
  height: number,
  padding: number,
): string {
  const maxX = xValues[xValues.length - 1] || 1
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2
  const rangeY = maxY - minY || 1
  let path = ''

  xValues.forEach((xValue, index) => {
    const yValue = series[index]
    if (!Number.isFinite(yValue)) return
    const x = padding + (xValue / maxX) * usableWidth
    const y = padding + usableHeight - ((Number(yValue) - minY) / rangeY) * usableHeight
    path += `${path ? ' L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`
  })

  return path
}

export function buildStepLinePath(
  xValues: number[],
  series: Array<number | null>,
  minY: number,
  maxY: number,
  width: number,
  height: number,
  padding: number,
): string {
  const maxX = xValues[xValues.length - 1] || 1
  const usableWidth = width - padding * 2
  const usableHeight = height - padding * 2
  const rangeY = maxY - minY || 1
  let path = ''
  let hasStarted = false

  for (let index = 0; index < xValues.length; index += 1) {
    const yValue = series[index]
    if (!Number.isFinite(yValue)) continue

    const x = padding + (xValues[index] / maxX) * usableWidth
    const y = padding + usableHeight - ((Number(yValue) - minY) / rangeY) * usableHeight

    if (!hasStarted) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)}`
      hasStarted = true
      continue
    }

    const previousYValue = series[index - 1]
    const previousX = padding + (xValues[index - 1] / maxX) * usableWidth
    const previousY = Number.isFinite(previousYValue)
      ? padding + usableHeight - ((Number(previousYValue) - minY) / rangeY) * usableHeight
      : y

    path += ` L ${x.toFixed(2)} ${previousY.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`
    if (previousX === x) {
      path += ` L ${x.toFixed(2)} ${y.toFixed(2)}`
    }
  }

  return path
}

export function getComparisonSnapshot(
  entry: ComparisonEntry,
  currentTime: number,
): {
  index: number
  time: number
  actionValue: number | null
  stateValue: number | null
  deltaValue: number | null
} {
  if (!entry.xValues.length) {
    return {
      index: 0,
      time: 0,
      actionValue: null,
      stateValue: null,
      deltaValue: null,
    }
  }

  const clampedTime = Math.min(
    Math.max(currentTime, entry.xValues[0] || 0),
    entry.xValues[entry.xValues.length - 1] || currentTime,
  )
  const index = findClosestPlaybackIndex(entry.xValues, clampedTime)
  const actionValue = entry.actionValues[index] ?? null
  const stateValue = entry.stateValues[index] ?? null
  const deltaValue =
    Number.isFinite(actionValue) && Number.isFinite(stateValue)
      ? Number(actionValue) - Number(stateValue)
      : null

  return {
    index,
    time: clampedTime,
    actionValue: Number.isFinite(actionValue) ? Number(actionValue) : null,
    stateValue: Number.isFinite(stateValue) ? Number(stateValue) : null,
    deltaValue,
  }
}

export function findWindowBounds(
  xValues: number[],
  currentTime: number,
  windowSize: number,
): [number, number] {
  if (xValues.length <= 2) return [0, Math.max(xValues.length - 1, 0)]

  const maxX = xValues[xValues.length - 1] || 0
  if (maxX <= windowSize) {
    return [0, xValues.length - 1]
  }

  const halfWindow = windowSize / 2
  let startTime = Math.max(currentTime - halfWindow, 0)
  let endTime = Math.min(currentTime + halfWindow, maxX)
  if (endTime - startTime < windowSize) {
    if (startTime <= 0) {
      endTime = Math.min(windowSize, maxX)
    } else if (endTime >= maxX) {
      startTime = Math.max(maxX - windowSize, 0)
    }
  }

  let startIndex = 0
  while (startIndex < xValues.length - 1 && xValues[startIndex] < startTime) {
    startIndex += 1
  }
  startIndex = Math.max(startIndex - 1, 0)

  let endIndex = xValues.length - 1
  while (endIndex > startIndex && xValues[endIndex] > endTime) {
    endIndex -= 1
  }
  endIndex = Math.min(endIndex + 1, xValues.length - 1)

  return [startIndex, endIndex]
}

export function sampleSeriesWindow(
  xValues: number[],
  actionValues: Array<number | null>,
  stateValues: Array<number | null>,
  startIndex: number,
  endIndex: number,
  maxPoints: number,
) {
  const count = endIndex - startIndex + 1
  if (count <= maxPoints) {
    return {
      xValues: xValues.slice(startIndex, endIndex + 1),
      actionValues: actionValues.slice(startIndex, endIndex + 1),
      stateValues: stateValues.slice(startIndex, endIndex + 1),
    }
  }

  const sampledX: number[] = []
  const sampledAction: Array<number | null> = []
  const sampledState: Array<number | null> = []
  for (let sampleIndex = 0; sampleIndex < maxPoints; sampleIndex += 1) {
    const sourceIndex = Math.round(
      startIndex + (sampleIndex * (count - 1)) / Math.max(maxPoints - 1, 1),
    )
    sampledX.push(xValues[sourceIndex])
    sampledAction.push(actionValues[sourceIndex] ?? null)
    sampledState.push(stateValues[sourceIndex] ?? null)
  }
  return {
    xValues: sampledX,
    actionValues: sampledAction,
    stateValues: sampledState,
  }
}
