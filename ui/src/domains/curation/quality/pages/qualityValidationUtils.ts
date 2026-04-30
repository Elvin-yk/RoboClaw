import { type QualityEpisodeResult } from '@/domains/curation/store/useCurationStore'

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

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

export function formatIssueDetail(issue: Record<string, unknown>): string {
  const message = issue['message']
  return typeof message === 'string' && message.trim() ? message : ''
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

export function formatQualityScalar(value: unknown, locale: 'zh' | 'en'): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : Number(value.toFixed(6)).toString()
  }
  if (typeof value === 'boolean') {
    return value ? (locale === 'zh' ? '是' : 'true') : (locale === 'zh' ? '否' : 'false')
  }
  if (typeof value === 'string') {
    return value
  }
  return String(value)
}

export function isQualityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function formatInlineQualityValue(value: unknown, locale: 'zh' | 'en'): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return locale === 'zh' ? '空' : 'empty'
    }
    if (value.length > 8) {
      return locale === 'zh' ? `${value.length} 项` : `${value.length} items`
    }
    return value.map((item) => formatInlineQualityValue(item, locale)).filter(Boolean).join(', ')
  }
  return formatQualityScalar(value, locale)
}

export function canFormatInlineQualityValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(canFormatInlineQualityValue)
  }
  return !isQualityRecord(value)
}

export function formatQualityKey(key: string): string {
  return key.replace(/_/g, ' ')
}

export function formatQualityValueSummary(value: unknown, locale: 'zh' | 'en'): string {
  if (Array.isArray(value)) {
    return canFormatInlineQualityValue(value)
      ? formatInlineQualityValue(value, locale)
      : (locale === 'zh' ? `${value.length} 项` : `${value.length} items`)
  }

  if (isQualityRecord(value)) {
    if (Object.keys(value).length === 0) {
      return ''
    }

    const directValue = value['value']
    if (directValue !== undefined) {
      if (isQualityRecord(directValue)) {
        return locale === 'zh' ? '存在' : 'present'
      }
      return formatQualityValueSummary(directValue, locale)
    }

    const width = value['width']
    const height = value['height']
    if (typeof width === 'number' && typeof height === 'number') {
      return `${width}x${height}`
    }

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

export function isPresenceDetail(detail: string): boolean {
  return /(present|exists|found|missing)$/i.test(detail.trim())
}

export function formatQualityCheckDetail(issue: Record<string, unknown>, locale: 'zh' | 'en'): string {
  const detail = formatIssueDetail(issue)
  const valueSummary = formatQualityValueSummary(issue['value'], locale)
  if (!detail) {
    return valueSummary
  }
  if (!valueSummary) {
    return detail
  }
  if (isPresenceDetail(detail)) {
    return valueSummary
  }
  if (detail.toLowerCase().includes(valueSummary.toLowerCase())) {
    return detail
  }
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

export function collectIssueTypes(episodes: QualityEpisodeResult[]): string[] {
  const issueTypes = new Set<string>()
  episodes.forEach((episode) => {
    ;(episode.issues || []).forEach((issue) => {
      if (!isFailingIssue(issue)) {
        return
      }
      const checkName = issue['check_name']
      if (typeof checkName === 'string' && checkName.trim()) {
        issueTypes.add(checkName)
      }
    })
  })
  return Array.from(issueTypes).sort()
}

export function issueDistribution(episodes: QualityEpisodeResult[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  episodes.forEach((episode) => {
    ;(episode.issues || []).forEach((issue) => {
      if (!isFailingIssue(issue)) {
        return
      }
      const checkName = issue['check_name']
      if (typeof checkName !== 'string' || !checkName.trim()) {
        return
      }
      counts.set(checkName, (counts.get(checkName) || 0) + 1)
    })
  })
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)
}

export function scoreHistogram(episodes: QualityEpisodeResult[]): Array<{ label: string; count: number }> {
  const bins = [
    { label: '0-20', min: 0, max: 20 },
    { label: '20-40', min: 20, max: 40 },
    { label: '40-60', min: 40, max: 60 },
    { label: '60-80', min: 60, max: 80 },
    { label: '80-100', min: 80, max: 101 },
  ]
  return bins.map((bin) => ({
    label: bin.label,
    count: episodes.filter((episode) => episode.score >= bin.min && episode.score < bin.max).length,
  }))
}

export interface PieSegment {
  label: string
  count: number
  color: string
}

export function buildPieGradient(segments: PieSegment[]): string {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  if (total <= 0) {
    return 'conic-gradient(rgba(47,111,228,0.08) 0deg 360deg)'
  }

  let current = 0
  const stops = segments.map((segment) => {
    const start = current
    current += (segment.count / total) * 360
    return `${segment.color} ${start}deg ${current}deg`
  })
  return `conic-gradient(${stops.join(', ')})`
}

export function clampPieSegments(
  segments: PieSegment[],
  options: {
    maxSegments?: number
    otherLabel: string
    otherColor: string
  },
): PieSegment[] {
  const {
    maxSegments = 4,
    otherLabel,
    otherColor,
  } = options
  const nonZero = segments.filter((segment) => segment.count > 0)
  if (nonZero.length <= maxSegments) {
    return nonZero
  }
  const head = nonZero.slice(0, maxSegments - 1)
  const tail = nonZero.slice(maxSegments - 1)
  return [
    ...head,
    {
      label: otherLabel,
      count: tail.reduce((sum, item) => sum + item.count, 0),
      color: otherColor,
    },
  ]
}
