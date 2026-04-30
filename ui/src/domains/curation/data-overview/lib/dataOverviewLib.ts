import type {
  AlignmentOverviewRow,
  AlignmentOverviewSpan,
  AnnotationWorkspacePayload,
  PropagationResults,
  PrototypeCluster,
} from '@/domains/curation/store/useCurationStore'

export type ValidatorKey = 'metadata' | 'timing' | 'action' | 'visual' | 'depth' | 'ee_trajectory'
export type DelayMetric = 'dtw_start_delay_s' | 'dtw_end_delay_s' | 'duration_delta_s'
export type MissingMatrixState = 'pass' | 'fail' | 'supplemented' | null
export type OverviewVideoClip = AnnotationWorkspacePayload['videos'][number]
export type QualityOverviewPanel = 'timeline' | 'validators' | 'missing'
export type EpisodeInspectHandlers = {
  onPreviewEpisode: (episodeIndex: number) => void
  onCommitEpisode: (episodeIndex: number) => void
  onLeaveEpisode: () => void
}

export const INSPECT_PREVIEW_DELAY_MS = 260
export const INSPECT_CLOSE_DELAY_MS = 220

export const VALIDATOR_KEYS: ValidatorKey[] = [
  'metadata',
  'timing',
  'action',
  'visual',
  'depth',
  'ee_trajectory',
]

export const MISSING_CHECKS = [
  'info.json',
  'episode identity',
  'parquet_data',
  'videos',
  'task_description',
  'robot_type',
  'fps',
  'features',
] as const

export const DELAY_METRICS: Array<{ key: DelayMetric; zh: string; en: string }> = [
  { key: 'dtw_start_delay_s', zh: '起点', en: 'Start' },
  { key: 'dtw_end_delay_s', zh: '终点', en: 'End' },
  { key: 'duration_delta_s', zh: '时长差', en: 'Duration' },
]

export function formatIssueLabel(checkName: string, locale: 'zh' | 'en'): string {
  const labels: Record<string, { zh: string; en: string }> = {
    'info.json': { zh: '缺少信息文件', en: 'Missing info.json' },
    'episode identity': { zh: '回合索引缺失', en: 'Missing episode identity' },
    robot_type: { zh: '机器人类型缺失', en: 'Missing robot type' },
    fps: { zh: '帧率缺失', en: 'Missing FPS' },
    features: { zh: '特征定义缺失', en: 'Missing feature schema' },
    parquet_data: { zh: 'Parquet 数据缺失', en: 'Missing parquet data' },
    videos: { zh: '视频文件缺失', en: 'Missing video files' },
    task_description: { zh: '任务描述缺失', en: 'Missing task description' },
    length: { zh: '回合时长异常', en: 'Episode duration issue' },
    timestamps: { zh: '时间戳不足', en: 'Insufficient timestamps' },
    monotonicity: { zh: '时间戳不单调', en: 'Timestamp monotonicity issue' },
    interval_cv: { zh: '采样间隔不稳定', en: 'Sampling interval variance' },
    estimated_frequency: { zh: '采样频率异常', en: 'Estimated frequency issue' },
    gap_ratio: { zh: '大时间间隔过多', en: 'Too many timestamp gaps' },
    frequency_consistency: { zh: '频率一致性差', en: 'Poor frequency consistency' },
    joint_series: { zh: '缺少关节序列', en: 'Missing joint series' },
    all_static_duration: { zh: '整体静止时间过长', en: 'All-joint static too long' },
    key_static_duration: { zh: '关键关节静止过长', en: 'Key-joint static too long' },
    max_velocity: { zh: '速度过高', en: 'Velocity too high' },
    duration: { zh: '动作时长异常', en: 'Action duration issue' },
    nan_ratio: { zh: '缺失值过多', en: 'Too many missing values' },
    video_count: { zh: '视频数量异常', en: 'Unexpected video count' },
    video_accessibility: { zh: '视频不可访问', en: 'Video accessibility issue' },
    video_resolution: { zh: '视频分辨率不足', en: 'Video resolution issue' },
    video_fps: { zh: '视频帧率不足', en: 'Video FPS issue' },
    overexposure_ratio: { zh: '过曝比例过高', en: 'Overexposure ratio too high' },
    underexposure_ratio: { zh: '欠曝比例过高', en: 'Underexposure ratio too high' },
    abnormal_frame_ratio: { zh: '异常黑白帧过多', en: 'Too many abnormal black/white frames' },
    color_shift: { zh: '色彩偏移过大', en: 'Color shift too high' },
    depth_streams: { zh: '缺少深度流', en: 'Missing depth streams' },
    depth_accessibility: { zh: '深度资源不可访问', en: 'Depth accessibility issue' },
    depth_invalid_ratio: { zh: '深度无效像素过多', en: 'Too many invalid depth pixels' },
    depth_continuity: { zh: '深度连续性不足', en: 'Depth continuity too low' },
    grasp_event_count: { zh: '抓放事件不足', en: 'Too few grasp/place events' },
    gripper_motion_span: { zh: '夹爪运动幅度不足', en: 'Gripper motion span too small' },
  }
  const label = labels[checkName]
  return label ? label[locale] : checkName
}

export function formatCheckLabel(checkName: string, locale: 'zh' | 'en'): string {
  const labels: Record<string, { zh: string; en: string }> = {
    'info.json': { zh: '信息文件', en: 'Info file' },
    'episode identity': { zh: '回合索引', en: 'Episode identity' },
    robot_type: { zh: '机器人类型', en: 'Robot type' },
    fps: { zh: '数据帧率', en: 'Dataset FPS' },
    features: { zh: '特征定义', en: 'Feature schema' },
    parquet_data: { zh: 'Parquet 数据', en: 'Parquet data' },
    videos: { zh: '视频文件', en: 'Video files' },
    task_description: { zh: '任务描述', en: 'Task description' },
    length: { zh: '回合时长', en: 'Episode duration' },
    timestamps: { zh: '时间戳', en: 'Timestamps' },
    monotonicity: { zh: '时间戳单调性', en: 'Timestamp monotonicity' },
    interval_cv: { zh: '采样间隔 CV', en: 'Sampling interval CV' },
    estimated_frequency: { zh: '估算采样频率', en: 'Estimated frequency' },
    gap_ratio: { zh: '大间隔比例', en: 'Large gap ratio' },
    frequency_consistency: { zh: '频率一致性', en: 'Frequency consistency' },
    joint_series: { zh: '关节序列', en: 'Joint series' },
    all_static_duration: { zh: '整体最长静止', en: 'All-joint static duration' },
    key_static_duration: { zh: '关键关节最长静止', en: 'Key-joint static duration' },
    max_velocity: { zh: '最大速度', en: 'Maximum velocity' },
    duration: { zh: '动作时长', en: 'Action duration' },
    nan_ratio: { zh: '缺失值比例', en: 'Missing value ratio' },
    video_count: { zh: '视频数量', en: 'Video count' },
    video_accessibility: { zh: '视频可访问性', en: 'Video accessibility' },
    video_resolution: { zh: '视频分辨率', en: 'Video resolution' },
    video_fps: { zh: '视频帧率', en: 'Video FPS' },
    overexposure_ratio: { zh: '过曝比例', en: 'Overexposure ratio' },
    underexposure_ratio: { zh: '欠曝比例', en: 'Underexposure ratio' },
    abnormal_frame_ratio: { zh: '异常黑白帧比例', en: 'Abnormal black/white frame ratio' },
    color_shift: { zh: '色彩偏移', en: 'Color shift' },
    depth_streams: { zh: '深度流', en: 'Depth streams' },
    depth_accessibility: { zh: '深度可访问性', en: 'Depth accessibility' },
    depth_invalid_ratio: { zh: '深度无效像素比例', en: 'Invalid depth pixel ratio' },
    depth_continuity: { zh: '深度连续性', en: 'Depth continuity' },
    grasp_event_count: { zh: '抓放事件数', en: 'Grasp/place event count' },
    gripper_motion_span: { zh: '夹爪运动幅度', en: 'Gripper motion span' },
  }
  return labels[checkName]?.[locale] ?? checkName
}

export function formatValidatorLabel(name: string, locale: 'zh' | 'en'): string {
  const labels: Record<string, { zh: string; en: string }> = {
    metadata: { zh: '元数据', en: 'Metadata' },
    timing: { zh: '时序', en: 'Timing' },
    action: { zh: '动作连续性', en: 'Action continuity' },
    visual: { zh: '视觉质量', en: 'Visual quality' },
    depth: { zh: '深度', en: 'Depth' },
    ee_trajectory: { zh: '末端轨迹', en: 'EE trajectory' },
  }
  return labels[name]?.[locale] ?? name
}

function formatIssueDetail(issue: Record<string, unknown>): string {
  const message = issue['message']
  return typeof message === 'string' && message.trim() ? message : ''
}

function formatQualityScalar(value: unknown, locale: 'zh' | 'en'): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString()
  }
  if (typeof value === 'boolean') {
    return value ? (locale === 'zh' ? '是' : 'true') : (locale === 'zh' ? '否' : 'false')
  }
  if (typeof value === 'string') return value
  return String(value)
}

function isQualityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function formatInlineQualityValue(value: unknown, locale: 'zh' | 'en'): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return locale === 'zh' ? '空' : 'empty'
    if (value.length > 8) return locale === 'zh' ? `${value.length} 项` : `${value.length} items`
    return value.map((item) => formatInlineQualityValue(item, locale)).filter(Boolean).join(', ')
  }
  return formatQualityScalar(value, locale)
}

function canFormatInlineQualityValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(canFormatInlineQualityValue)
  return !isQualityRecord(value)
}

function formatQualityKey(key: string): string {
  return key.replace(/_/g, ' ')
}

function formatQualityValueSummary(value: unknown, locale: 'zh' | 'en'): string {
  if (Array.isArray(value)) {
    return canFormatInlineQualityValue(value)
      ? formatInlineQualityValue(value, locale)
      : (locale === 'zh' ? `${value.length} 项` : `${value.length} items`)
  }

  if (isQualityRecord(value)) {
    if (Object.keys(value).length === 0) return ''
    const directValue = value['value']
    if (directValue !== undefined) {
      if (isQualityRecord(directValue)) return locale === 'zh' ? '存在' : 'present'
      return formatQualityValueSummary(directValue, locale)
    }

    const width = value['width']
    const height = value['height']
    if (typeof width === 'number' && typeof height === 'number') return `${width}x${height}`

    const entries = Object.entries(value)
      .filter(([, nestedValue]) => !isQualityRecord(nestedValue) && !Array.isArray(nestedValue))
      .slice(0, 3)
    if (entries.length > 0) {
      return entries
        .map(([key, nestedValue]) => `${formatQualityKey(key)}=${formatQualityScalar(nestedValue, locale)}`)
        .join(', ')
    }

    return locale === 'zh' ? '存在' : 'present'
  }

  return formatQualityScalar(value, locale)
}

function isPresenceDetail(detail: string): boolean {
  return /(present|exists|found|missing)$/i.test(detail.trim())
}

export function formatQualityCheckDetail(issue: Record<string, unknown>, locale: 'zh' | 'en'): string {
  const detail = formatIssueDetail(issue)
  const valueSummary = formatQualityValueSummary(issue['value'], locale)
  if (!detail) return valueSummary
  if (!valueSummary) return detail
  if (isPresenceDetail(detail)) return valueSummary
  if (detail.toLowerCase().includes(valueSummary.toLowerCase())) return detail
  return detail
}

export function groupQualityIssues(issues: Array<Record<string, unknown>>): Array<{
  validator: string
  checks: Array<Record<string, unknown>>
}> {
  const groups = new Map<string, Array<Record<string, unknown>>>()
  issues.forEach((issue) => {
    const operatorName = issue['operator_name']
    const validator = typeof operatorName === 'string' && operatorName.trim()
      ? operatorName
      : 'unknown'
    groups.set(validator, [...(groups.get(validator) || []), issue])
  })
  return Array.from(groups.entries()).map(([validator, checks]) => ({ validator, checks }))
}

export function isFailingIssue(issue: Record<string, unknown>): boolean {
  return issue['passed'] !== true
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function formatJointValue(value: number | null | undefined): string {
  return Number.isFinite(value) ? Number(value).toFixed(3) : '-'
}

export function getClipStart(videoItem: OverviewVideoClip | null): number {
  return typeof videoItem?.from_timestamp === 'number' ? videoItem.from_timestamp : 0
}

export function getClipEnd(videoItem: OverviewVideoClip | null): number | null {
  return typeof videoItem?.to_timestamp === 'number' ? videoItem.to_timestamp : null
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

export function relativeTrajectoryTimes(timeValues: number[]): number[] {
  const baseTime = isFiniteNumber(timeValues[0]) ? timeValues[0] : 0
  return timeValues.map((timeValue) =>
    isFiniteNumber(timeValue) ? Math.max(timeValue - baseTime, 0) : 0,
  )
}

export function formatSeconds(value: number | null | undefined, locale: 'zh' | 'en'): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return locale === 'zh' ? '无数据' : 'No data'
  const absValue = Math.abs(value)
  const formatted = absValue >= 10 ? value.toFixed(2) : value.toFixed(3)
  return `${Number(formatted)}s`
}

export function formatSignedSeconds(value: number | null | undefined, locale: 'zh' | 'en'): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return locale === 'zh' ? '无延迟数据' : 'No delay data'
  const formatted = Math.abs(value) >= 10 ? value.toFixed(2) : value.toFixed(3)
  const prefix = value > 0 ? '+' : ''
  return `${prefix}${Number(formatted)}s`
}

export function formatTimeWindow(span: AlignmentOverviewSpan, locale: 'zh' | 'en'): string {
  const start = formatSeconds(span.startTime, locale)
  const end = typeof span.endTime === 'number' ? formatSeconds(span.endTime, locale) : (locale === 'zh' ? '未结束' : 'open')
  return `${start}-${end}`
}

export function formatSourceTimeWindow(span: AlignmentOverviewSpan, locale: 'zh' | 'en'): string {
  const start = formatSeconds(span.source_start_time, locale)
  const end = typeof span.source_end_time === 'number'
    ? formatSeconds(span.source_end_time, locale)
    : (locale === 'zh' ? '未结束' : 'open')
  return `${start}-${end}`
}

export function formatSpanTitle(span: AlignmentOverviewSpan, locale: 'zh' | 'en'): string {
  const title = span.text || span.label || span.category || span.id
  return title ? String(title) : (locale === 'zh' ? '未命名片段' : 'Untitled span')
}

export function coerceOverviewNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Number(value.toFixed(4))
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null
  }
  return null
}

function subtractOverviewNumber(left: number | null | undefined, right: number | null | undefined): number | null {
  if (typeof left !== 'number' || typeof right !== 'number') return null
  return Number((left - right).toFixed(4))
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function spanTaskText(span: AlignmentOverviewSpan): string {
  return stringOrNull(span.text) || stringOrNull(span.label) || stringOrNull(span.category) || ''
}

function semanticTaskTextFromSpans(spans: AlignmentOverviewSpan[]): string {
  for (const span of spans) {
    const text = spanTaskText(span)
    if (text) return text
  }
  return ''
}

export function semanticTaskTextForRow(row: AlignmentOverviewRow): string {
  return (
    stringOrNull(row.semantic_task_text)
    || semanticTaskTextFromSpans(row.propagation_spans || [])
    || semanticTaskTextFromSpans(row.annotation_spans || [])
    || ''
  )
}

export function taskInfoForRow(row: AlignmentOverviewRow): { text: string; supplemental: boolean } {
  const task = stringOrNull(row.task) || semanticTaskTextForRow(row)
  const supplemental = Boolean(
    task
    && (row.task_is_supplemental || row.task_source === 'semantic_supplement' || !stringOrNull(row.task)),
  )
  return { text: task, supplemental }
}

export function hasSemanticTaskSupplement(row: AlignmentOverviewRow): boolean {
  return taskInfoForRow(row).supplemental
}

export function normalizeOverviewSpan(
  span: Record<string, unknown>,
  sourceSpan?: AlignmentOverviewSpan | null,
): AlignmentOverviewSpan {
  const startTime = coerceOverviewNumber(span.startTime)
  const endTime = coerceOverviewNumber(span.endTime)
  const sourceStartTime = sourceSpan ? coerceOverviewNumber(sourceSpan.startTime) : coerceOverviewNumber(span.source_start_time)
  const sourceEndTime = sourceSpan ? coerceOverviewNumber(sourceSpan.endTime) : coerceOverviewNumber(span.source_end_time)
  const durationDelta =
    startTime !== null && endTime !== null && sourceStartTime !== null && sourceEndTime !== null
      ? Number(((endTime - startTime) - (sourceEndTime - sourceStartTime)).toFixed(4))
      : coerceOverviewNumber(span.duration_delta_s)
  return {
    id: stringOrNull(span.id),
    label: stringOrNull(span.label),
    text: stringOrNull(span.text),
    category: stringOrNull(span.category),
    startTime,
    endTime,
    source: stringOrNull(span.source),
    target_record_key: stringOrNull(span.target_record_key),
    prototype_score: coerceOverviewNumber(span.prototype_score),
    source_start_time: sourceStartTime,
    source_end_time: sourceEndTime,
    dtw_start_delay_s: coerceOverviewNumber(span.dtw_start_delay_s) ?? subtractOverviewNumber(startTime, sourceStartTime),
    dtw_end_delay_s: coerceOverviewNumber(span.dtw_end_delay_s) ?? subtractOverviewNumber(endTime, sourceEndTime),
    duration_delta_s: durationDelta,
  }
}

function sourceSpanForFallback(
  span: Record<string, unknown>,
  index: number,
  sourceSpans: AlignmentOverviewSpan[],
): AlignmentOverviewSpan | null {
  const spanId = stringOrNull(span.id)
  if (spanId) {
    const matched = sourceSpans.find((sourceSpan) => String(sourceSpan.id || '') === spanId)
    if (matched) return matched
  }
  return sourceSpans[index] || null
}

function inferAlignmentMethodFromSpans(spans: AlignmentOverviewSpan[]): string {
  if (spans.some((span) => span.source === 'dtw_propagated')) return 'dtw'
  if (spans.some((span) => span.source === 'duration_scaled')) return 'scale'
  return ''
}

function enrichRowTask(row: AlignmentOverviewRow): AlignmentOverviewRow {
  const semanticTask = semanticTaskTextForRow(row)
  const existingTask = stringOrNull(row.task)
  return {
    ...row,
    task: existingTask || semanticTask || '',
    semantic_task_text: semanticTask || row.semantic_task_text || '',
    task_is_supplemental: Boolean(row.task_is_supplemental || (!existingTask && semanticTask)),
    task_source: row.task_source || (existingTask ? 'dataset' : semanticTask ? 'semantic_supplement' : ''),
  }
}

export function augmentRowsWithPropagationFallback(
  rows: AlignmentOverviewRow[],
  propagationResults: PropagationResults | null,
  sourceAnnotationSpans: AlignmentOverviewSpan[],
): AlignmentOverviewRow[] {
  if (!propagationResults) return rows.map(enrichRowTask)

  const propagatedByEpisode = new Map(
    propagationResults.propagated.map((item) => [item.episode_index, item]),
  )
  return rows.map((row) => {
    const item = propagatedByEpisode.get(row.episode_index)
    const existingAnnotationSpans = row.annotation_spans || []
    const annotationSpans =
      row.episode_index === propagationResults.source_episode_index && existingAnnotationSpans.length === 0
        ? sourceAnnotationSpans
        : existingAnnotationSpans
    const existingPropagationSpans = row.propagation_spans || []
    const propagationSpans =
      existingPropagationSpans.length === 0 && item?.spans?.length
        ? item.spans.map((span, index) =>
          normalizeOverviewSpan(
            span as Record<string, unknown>,
            sourceSpanForFallback(span as Record<string, unknown>, index, sourceAnnotationSpans),
          ),
        )
        : existingPropagationSpans
    const sourceEpisodeIndex = row.propagation_source_episode_index ?? item?.source_episode_index ?? propagationResults.source_episode_index
    const enriched: AlignmentOverviewRow = {
      ...row,
      annotation_spans: annotationSpans,
      propagation_spans: propagationSpans,
      propagation_source_episode_index: sourceEpisodeIndex,
      propagation_alignment_method:
        row.propagation_alignment_method || item?.alignment_method || inferAlignmentMethodFromSpans(propagationSpans),
      propagated_count: row.propagated_count || propagationSpans.length,
      prototype_score: row.prototype_score ?? item?.prototype_score ?? null,
    }
    return enrichRowTask(enriched)
  })
}

export function formatAlignmentMethod(method: string | null | undefined, locale: 'zh' | 'en'): string {
  if (method === 'dtw') return 'DTW'
  if (method === 'scale') return locale === 'zh' ? '时长缩放' : 'Duration scale'
  return locale === 'zh' ? '未记录' : 'Not recorded'
}

export function formatSpanSource(source: string | null | undefined, locale: 'zh' | 'en'): string {
  if (source === 'dtw_propagated') return locale === 'zh' ? 'DTW 传播' : 'DTW propagated'
  if (source === 'duration_scaled') return locale === 'zh' ? '时长缩放' : 'Duration scaled'
  if (source === 'user') return locale === 'zh' ? '人工标注' : 'Manual'
  return source || (locale === 'zh' ? '未记录' : 'Not recorded')
}

export function alignmentStatusKey(
  status: AlignmentOverviewRow['alignment_status'],
): 'alignmentPropagated' | 'alignmentAnnotated' | 'alignmentNotStarted' {
  if (status === 'propagated') return 'alignmentPropagated'
  if (status === 'annotated') return 'alignmentAnnotated'
  return 'alignmentNotStarted'
}

export function formatCompactNumber(value: number | string): string {
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) >= 1000000) return `${Number((value / 1000000).toFixed(1))}m`
  if (Math.abs(value) >= 1000) return `${Number((value / 1000).toFixed(1))}k`
  return String(value)
}

export function formatChartValue(value: number): string {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) >= 10) return value.toFixed(1)
  if (Math.abs(value) >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

function getIssueForCheck(
  row: AlignmentOverviewRow,
  checkName: string,
): Record<string, unknown> | undefined {
  return (row.issues || []).find((issue) => issue['check_name'] === checkName)
}

function getIssuePassState(issue: Record<string, unknown> | undefined): boolean | null {
  if (!issue) return null
  if (issue['passed'] === true) return true
  if (issue['passed'] === false) return false
  return null
}

export function getMissingMatrixState(row: AlignmentOverviewRow, checkName: string): MissingMatrixState {
  const state = getIssuePassState(getIssueForCheck(row, checkName))
  if (checkName === 'task_description' && state === false && hasSemanticTaskSupplement(row)) {
    return 'supplemented'
  }
  if (state === true) return 'pass'
  if (state === false) return 'fail'
  return null
}

export function formatMissingMatrixState(state: MissingMatrixState, locale: 'zh' | 'en'): string {
  if (state === 'pass') return locale === 'zh' ? '通过' : 'passed'
  if (state === 'fail') return locale === 'zh' ? '缺失' : 'missing'
  if (state === 'supplemented') return locale === 'zh' ? '语义补充*' : 'semantic supplement*'
  return locale === 'zh' ? '未记录' : 'not recorded'
}

export function rowSemanticSpans(row: AlignmentOverviewRow): AlignmentOverviewSpan[] {
  const propagationSpans = row.propagation_spans || []
  if (propagationSpans.length > 0) return propagationSpans
  return row.annotation_spans || []
}

export function spanEnd(span: AlignmentOverviewSpan): number {
  if (typeof span.endTime === 'number' && Number.isFinite(span.endTime)) return span.endTime
  if (typeof span.startTime === 'number' && Number.isFinite(span.startTime)) return span.startTime
  return 0
}

export function spanStart(span: AlignmentOverviewSpan): number {
  return typeof span.startTime === 'number' && Number.isFinite(span.startTime) ? span.startTime : 0
}

export function maxSpanEnd(rows: AlignmentOverviewRow[]): number {
  return Math.max(
    1,
    ...rows.flatMap((row) => rowSemanticSpans(row).map((span) => spanEnd(span))),
  )
}

export function semanticLabel(span: AlignmentOverviewSpan, locale: 'zh' | 'en'): string {
  const label = span.label || span.text || span.category
  return label ? String(label) : (locale === 'zh' ? '未命名' : 'Untitled')
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function delayValuesForRow(row: AlignmentOverviewRow, metric: DelayMetric): number[] {
  return (row.propagation_spans || [])
    .map((span) => span[metric])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

export function averageDelayForRow(row: AlignmentOverviewRow, metric: DelayMetric): number | null {
  return average(delayValuesForRow(row, metric))
}

export function collectDelayValues(rows: AlignmentOverviewRow[], metric: DelayMetric): number[] {
  return rows.flatMap((row) => delayValuesForRow(row, metric))
}

export function buildHistogram(values: number[], binCount = 8): Array<{ label: string; count: number }> {
  if (values.length === 0) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) {
    return [{ label: formatChartValue(min), count: values.length }]
  }
  const size = (max - min) / binCount
  const bins = Array.from({ length: binCount }, (_, index) => {
    const from = min + index * size
    const to = index === binCount - 1 ? max : from + size
    return {
      label: `${formatChartValue(from)}-${formatChartValue(to)}`,
      count: 0,
    }
  })
  values.forEach((value) => {
    const index = Math.min(Math.floor((value - min) / size), binCount - 1)
    bins[index].count += 1
  })
  return bins
}

export function qualityColor(row: AlignmentOverviewRow): string {
  return row.quality_passed ? '#064e3b' : '#c81e1e'
}

export function validatorColor(score: number | undefined, failed: boolean): string {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'rgba(148, 163, 184, 0.34)'
  if (failed) return '#c81e1e'
  const alpha = Math.min(Math.max(score / 100, 0.25), 1)
  return `rgba(6, 78, 59, ${alpha})`
}

export function issueMatrixColor(state: MissingMatrixState): string {
  if (state === 'pass') return '#064e3b'
  if (state === 'fail') return '#c81e1e'
  if (state === 'supplemented') return '#1d4ed8'
  return 'rgba(148, 163, 184, 0.38)'
}

export function firstClusterEpisode(cluster: PrototypeCluster): number | null {
  const member = cluster.members.find((item) => typeof item.episode_index === 'number')
  return member?.episode_index ?? null
}

function primaryPropagationSpan(row: AlignmentOverviewRow): AlignmentOverviewSpan | null {
  return row.propagation_spans?.[0] || null
}

export function buildExportRows(
  rows: AlignmentOverviewRow[],
  locale: 'zh' | 'en',
  t: (key: 'passed' | 'failed' | 'untitledTask' | 'alignmentPropagated' | 'alignmentAnnotated' | 'alignmentNotStarted') => string,
) {
  return rows.map((row) => {
    const taskInfo = taskInfoForRow(row)
    const propagationSpan = primaryPropagationSpan(row)
    return {
      episode_index: row.episode_index,
      record_key: row.record_key,
      task: taskInfo.text,
      task_source: row.task_source || '',
      task_is_supplemental: taskInfo.supplemental,
      semantic_task_text: semanticTaskTextForRow(row),
      quality_status: row.quality_passed ? t('passed') : t('failed'),
      quality_score: Number(row.quality_score.toFixed(1)),
      failed_validators: row.failed_validators.join(', '),
      issue_types: row.issues
        .filter((issue) => isFailingIssue(issue))
        .map((issue) => {
          const checkName = issue['check_name']
          return typeof checkName === 'string' ? formatIssueLabel(checkName, locale) : ''
        })
        .filter(Boolean)
        .join(', '),
      alignment_status: t(alignmentStatusKey(row.alignment_status)),
      alignment_method: row.propagation_alignment_method || '',
      propagation_source_episode_index: row.propagation_source_episode_index ?? '',
      annotation_count: row.annotation_count,
      propagated_count: row.propagated_count,
      target_start_s: propagationSpan?.startTime ?? '',
      target_end_s: propagationSpan?.endTime ?? '',
      source_start_s: propagationSpan?.source_start_time ?? '',
      source_end_s: propagationSpan?.source_end_time ?? '',
      dtw_start_delay_s: averageDelayForRow(row, 'dtw_start_delay_s') ?? '',
      dtw_end_delay_s: averageDelayForRow(row, 'dtw_end_delay_s') ?? '',
      duration_delta_s: averageDelayForRow(row, 'duration_delta_s') ?? '',
      prototype_score:
        typeof row.prototype_score === 'number' ? Number(row.prototype_score.toFixed(4)) : '',
      updated_at: row.updated_at || '',
    }
  })
}

export function escapeCsvValue(value: unknown): string {
  const text = String(value ?? '')
  if (text.includes('"') || text.includes(',') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
