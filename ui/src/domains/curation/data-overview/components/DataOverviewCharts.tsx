import { Fragment, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from '@/shared/lib/cn'
import type { AlignmentOverviewRow, PrototypeCluster } from '@/domains/curation/store/useCurationStore'
import {
  DELAY_METRICS,
  MISSING_CHECKS,
  VALIDATOR_KEYS,
  averageDelayForRow,
  buildHistogram,
  collectDelayValues,
  firstClusterEpisode,
  formatAlignmentMethod,
  formatChartValue,
  formatCheckLabel,
  formatMissingMatrixState,
  formatSignedSeconds,
  formatSpanSource,
  formatTimeWindow,
  formatValidatorLabel,
  getMissingMatrixState,
  issueMatrixColor,
  maxSpanEnd,
  qualityColor,
  rowSemanticSpans,
  semanticLabel,
  semanticTaskTextForRow,
  spanEnd,
  spanStart,
  taskInfoForRow,
  validatorColor,
  type DelayMetric,
  type EpisodeInspectHandlers,
} from '../lib/dataOverviewLib'

export function PipelineChartPanel({
  title,
  subtitle,
  className,
  children,
}: {
  title: string
  subtitle?: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={cn('pipeline-chart-card', className)}>
      <div className="pipeline-chart-card__head">
        <div>
          <h4>{title}</h4>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

function ChartEmpty({ label }: { label: string }) {
  return <div className="pipeline-chart-empty">{label}</div>
}

export function QualityTimelineChart({
  rows,
  emptyLabel,
  inspectHandlers,
}: {
  rows: AlignmentOverviewRow[]
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  const sortedRows = [...rows].sort((left, right) => left.episode_index - right.episode_index)
  if (sortedRows.length === 0) return <ChartEmpty label={emptyLabel} />

  const width = 680
  const height = 220
  const padX = 40
  const padY = 28
  const minEpisode = sortedRows[0].episode_index
  const maxEpisode = sortedRows[sortedRows.length - 1].episode_index
  const xFor = (episodeIndex: number) =>
    maxEpisode === minEpisode
      ? width / 2
      : padX + ((episodeIndex - minEpisode) / (maxEpisode - minEpisode)) * (width - padX * 2)
  const yFor = (score: number) =>
    height - padY - (Math.max(0, Math.min(score, 100)) / 100) * (height - padY * 2)
  const points = sortedRows.map((row) => ({
    row,
    x: xFor(row.episode_index),
    y: yFor(row.quality_score),
  }))

  return (
    <div className="quality-timeline-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Episode quality timeline">
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={padX}
              y1={yFor(tick)}
              x2={width - padX}
              y2={yFor(tick)}
              className="pipeline-chart-gridline"
            />
            <text x={8} y={yFor(tick) + 4} className="pipeline-chart-axis-label">{tick}</text>
          </g>
        ))}
        <polyline
          points={points.map((point) => `${point.x},${point.y}`).join(' ')}
          className="quality-timeline-chart__line"
          fill="none"
        />
        {points.map((point) => (
          <g
            key={point.row.episode_index}
            data-overview-inspect-trigger="true"
            role="button"
            tabIndex={0}
            onMouseEnter={() => onPreviewEpisode(point.row.episode_index)}
            onMouseLeave={onLeaveEpisode}
            onFocus={() => onPreviewEpisode(point.row.episode_index)}
            onBlur={onLeaveEpisode}
            onClick={() => onCommitEpisode(point.row.episode_index)}
          >
            <title>{`Episode ${point.row.episode_index}: ${point.row.quality_score.toFixed(1)}`}</title>
            <circle
              cx={point.x}
              cy={point.y}
              r={point.row.quality_passed ? 4.2 : 5.2}
              fill={qualityColor(point.row)}
              className="quality-timeline-chart__point"
            />
          </g>
        ))}
        <text x={padX} y={height - 4} className="pipeline-chart-axis-label">
          {minEpisode}
        </text>
        <text x={width - padX} y={height - 4} textAnchor="end" className="pipeline-chart-axis-label">
          {maxEpisode}
        </text>
      </svg>
    </div>
  )
}

export function ValidatorHeatmap({
  rows,
  locale,
  emptyLabel,
  inspectHandlers,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  const sortedRows = [...rows].sort((left, right) => left.episode_index - right.episode_index)
  if (sortedRows.length === 0) return <ChartEmpty label={emptyLabel} />
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `128px repeat(${sortedRows.length}, 28px)`,
  }

  return (
    <div className="validator-heatmap pipeline-matrix-shell">
      <div className="pipeline-matrix-legend">
        <span><i className="is-pass" />{locale === 'zh' ? '通过/高分' : 'Passed / high'}</span>
        <span><i className="is-fail" />{locale === 'zh' ? '失败' : 'Failed'}</span>
        <span><i className="is-missing" />{locale === 'zh' ? '缺失' : 'Missing'}</span>
      </div>
      <div className="pipeline-matrix-scroll">
        <div className="validator-heatmap__grid pipeline-matrix-grid" style={gridStyle}>
        <div className="validator-heatmap__corner">Episode</div>
        {sortedRows.map((row) => (
          <div key={`episode-${row.episode_index}`} className="validator-heatmap__episode">
            {row.episode_index}
          </div>
        ))}
        {VALIDATOR_KEYS.map((validator) => (
          <Fragment key={validator}>
            <div key={`${validator}-label`} className="validator-heatmap__label">
              {formatValidatorLabel(validator, locale)}
            </div>
            {sortedRows.map((row) => {
              const score = row.validator_scores?.[validator]
              const failed = row.failed_validators.includes(validator)
              return (
                <button
                  key={`${validator}-${row.episode_index}`}
                  type="button"
                  data-overview-inspect-trigger="true"
                  className={cn('validator-heatmap__cell', failed && 'is-fail')}
                  style={{ backgroundColor: validatorColor(score, failed) }}
                  title={`Episode ${row.episode_index} · ${validator}: ${
                    typeof score === 'number' ? score.toFixed(1) : 'missing'
                  }`}
                  onMouseEnter={() => onPreviewEpisode(row.episode_index)}
                  onMouseLeave={onLeaveEpisode}
                  onFocus={() => onPreviewEpisode(row.episode_index)}
                  onBlur={onLeaveEpisode}
                  onClick={() => onCommitEpisode(row.episode_index)}
                />
              )
            })}
          </Fragment>
        ))}
        </div>
      </div>
    </div>
  )
}

export function MissingMatrix({
  rows,
  locale,
  emptyLabel,
  inspectHandlers,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  const sortedRows = [...rows].sort((left, right) => left.episode_index - right.episode_index)
  if (sortedRows.length === 0) return <ChartEmpty label={emptyLabel} />
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `104px repeat(${MISSING_CHECKS.length}, 116px)`,
  }

  return (
    <div className="missing-matrix pipeline-matrix-shell">
      <div className="pipeline-matrix-legend">
        <span><i className="is-pass" />{locale === 'zh' ? '存在/通过' : 'Present / passed'}</span>
        <span><i className="is-fail" />{locale === 'zh' ? '缺失/失败' : 'Missing / failed'}</span>
        <span><i className="is-supplemented" />{locale === 'zh' ? '语义补充*' : 'Semantic supplement*'}</span>
        <span><i className="is-missing" />{locale === 'zh' ? '未记录' : 'Not recorded'}</span>
      </div>
      <div className="pipeline-matrix-scroll pipeline-matrix-scroll--tall">
        <div className="missing-matrix__grid pipeline-matrix-grid" style={gridStyle}>
        <div className="missing-matrix__corner">Episode</div>
        {MISSING_CHECKS.map((check) => (
          <div key={check} className="missing-matrix__head">{formatCheckLabel(check, locale)}</div>
        ))}
        {sortedRows.map((row) => (
          <Fragment key={row.episode_index}>
            <div key={`${row.episode_index}-episode`} className="missing-matrix__episode">
              {row.episode_index}
            </div>
            {MISSING_CHECKS.map((check) => {
              const state = getMissingMatrixState(row, check)
              return (
                <button
                  key={`${row.episode_index}-${check}`}
                  type="button"
                  data-overview-inspect-trigger="true"
                  className={cn(
                    'missing-matrix__cell',
                    state === 'pass' && 'is-pass',
                    state === 'fail' && 'is-fail',
                    state === 'supplemented' && 'is-supplemented',
                  )}
                  style={{ backgroundColor: issueMatrixColor(state) }}
                  title={`Episode ${row.episode_index} · ${formatCheckLabel(check, locale)}: ${
                    formatMissingMatrixState(state, locale)
                  }`}
                  onMouseEnter={() => onPreviewEpisode(row.episode_index)}
                  onMouseLeave={onLeaveEpisode}
                  onFocus={() => onPreviewEpisode(row.episode_index)}
                  onBlur={onLeaveEpisode}
                  onClick={() => onCommitEpisode(row.episode_index)}
                />
              )
            })}
          </Fragment>
        ))}
        </div>
      </div>
    </div>
  )
}

export function DtwDelayHistogram({
  rows,
  locale,
  emptyLabel,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
}) {
  const [metric, setMetric] = useState<DelayMetric>('dtw_start_delay_s')
  const values = collectDelayValues(rows, metric)
  const bins = buildHistogram(values)
  const maxCount = Math.max(...bins.map((bin) => bin.count), 1)

  return (
    <div className="dtw-histogram">
      <div className="pipeline-segmented-control" role="group" aria-label="DTW delay metric">
        {DELAY_METRICS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={cn(metric === item.key && 'is-active')}
            onClick={() => setMetric(item.key)}
          >
            {item[locale]}
          </button>
        ))}
      </div>
      {bins.length === 0 ? (
        <ChartEmpty label={emptyLabel} />
      ) : (
        <div className="dtw-histogram__bars">
          {bins.map((bin) => (
            <div key={bin.label} className="dtw-histogram__row">
              <span>{bin.label}s</span>
              <div className="dtw-histogram__track">
                <div className="dtw-histogram__fill" style={{ width: `${(bin.count / maxCount) * 100}%` }} />
              </div>
              <strong>{bin.count}</strong>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SemanticSpanTimeline({
  rows,
  locale,
  emptyLabel,
  inspectHandlers,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  const rowsWithSpans = [...rows]
    .sort((left, right) => left.episode_index - right.episode_index)
    .filter((row) => rowSemanticSpans(row).length > 0)
  if (rowsWithSpans.length === 0) return <ChartEmpty label={emptyLabel} />
  const maxEnd = maxSpanEnd(rowsWithSpans)

  return (
    <div className="semantic-timeline">
      {rowsWithSpans.map((row) => (
        <div key={row.episode_index} className="semantic-timeline__row">
          <button
            type="button"
            data-overview-inspect-trigger="true"
            className="semantic-timeline__episode"
            onMouseEnter={() => onPreviewEpisode(row.episode_index)}
            onMouseLeave={onLeaveEpisode}
            onFocus={() => onPreviewEpisode(row.episode_index)}
            onBlur={onLeaveEpisode}
            onClick={() => onCommitEpisode(row.episode_index)}
          >
            {row.episode_index}
          </button>
          <div className="semantic-timeline__track">
            {rowSemanticSpans(row).map((span, index) => {
              const start = Math.max(0, spanStart(span))
              const end = Math.max(start + 0.05, spanEnd(span))
              const left = Math.min((start / maxEnd) * 100, 98)
              const width = Math.max(((end - start) / maxEnd) * 100, 3.5)
              return (
                <button
                  key={`${span.id || semanticLabel(span, locale)}-${index}`}
                  type="button"
                  data-overview-inspect-trigger="true"
                  className={cn(
                    'semantic-timeline__span',
                    span.source === 'dtw_propagated' && 'is-propagated',
                  )}
                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                  title={`${semanticLabel(span, locale)} · ${formatTimeWindow(span, locale)}`}
                  onMouseEnter={() => onPreviewEpisode(row.episode_index)}
                  onMouseLeave={onLeaveEpisode}
                  onFocus={() => onPreviewEpisode(row.episode_index)}
                  onBlur={onLeaveEpisode}
                  onClick={() => onCommitEpisode(row.episode_index)}
                >
                  <span>{semanticLabel(span, locale)}</span>
                  <em>{formatTimeWindow(span, locale)}</em>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export function SemanticLabelBars({
  rows,
  locale,
  emptyLabel,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
}) {
  const items = Array.from(
    rows
      .flatMap((row) => rowSemanticSpans(row))
      .reduce((counts, span) => {
        const label = semanticLabel(span, locale)
        counts.set(label, (counts.get(label) || 0) + 1)
        return counts
      }, new Map<string, number>()),
  )
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, 12)
  const maxCount = Math.max(...items.map((item) => item.count), 1)

  if (items.length === 0) return <ChartEmpty label={emptyLabel} />
  return (
    <div className="semantic-label-bars">
      {items.map((item) => (
        <div key={item.label} className="semantic-label-bars__row">
          <span>{item.label}</span>
          <div className="semantic-label-bars__track">
            <div style={{ width: `${(item.count / maxCount) * 100}%` }} />
          </div>
          <strong>{item.count}</strong>
        </div>
      ))}
    </div>
  )
}

export function CoverageStackedBar({
  rows,
  locale,
  emptyLabel,
}: {
  rows: AlignmentOverviewRow[]
  locale: 'zh' | 'en'
  emptyLabel: string
}) {
  if (rows.length === 0) return <ChartEmpty label={emptyLabel} />
  const labels = locale === 'zh'
    ? { notStarted: '未开始', annotated: '人工标注', propagated: '自动传播' }
    : { notStarted: 'Not started', annotated: 'Manual', propagated: 'Propagated' }
  const counts = rows.reduce(
    (acc, row) => {
      if (row.propagated_count > 0 || row.alignment_status === 'propagated') acc.propagated += 1
      else if (row.annotation_count > 0 || row.alignment_status === 'annotated') acc.annotated += 1
      else acc.notStarted += 1
      return acc
    },
    { notStarted: 0, annotated: 0, propagated: 0 },
  )
  const total = Math.max(rows.length, 1)
  const segments = [
    { key: 'notStarted', label: labels.notStarted, value: counts.notStarted, className: 'is-empty' },
    { key: 'annotated', label: labels.annotated, value: counts.annotated, className: 'is-manual' },
    { key: 'propagated', label: labels.propagated, value: counts.propagated, className: 'is-propagated' },
  ] as const

  return (
    <div className="coverage-bar">
      <div className="coverage-bar__track">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={cn('coverage-bar__segment', segment.className)}
            style={{ width: `${(segment.value / total) * 100}%` }}
            title={`${segment.label}: ${segment.value}`}
          />
        ))}
      </div>
      <div className="coverage-bar__legend">
        {segments.map((segment) => (
          <div key={segment.key} className={cn('coverage-bar__legend-item', segment.className)}>
            <span />
            <strong>{segment.label}</strong>
            <em>{segment.value}</em>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PrototypeClusterChart({
  clusters,
  emptyLabel,
  inspectHandlers,
}: {
  clusters: PrototypeCluster[]
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  if (clusters.length === 0) return <ChartEmpty label={emptyLabel} />
  const maxMembers = Math.max(...clusters.map((cluster) => cluster.member_count), 1)

  return (
    <div className="prototype-cluster-chart">
      {clusters.map((cluster) => {
        const episodeIndex = firstClusterEpisode(cluster)
        return (
          <button
            key={cluster.cluster_index}
            type="button"
            data-overview-inspect-trigger="true"
            className="prototype-cluster-chart__row"
            disabled={episodeIndex === null}
            onMouseEnter={() => {
              if (episodeIndex !== null) onPreviewEpisode(episodeIndex)
            }}
            onMouseLeave={onLeaveEpisode}
            onFocus={() => {
              if (episodeIndex !== null) onPreviewEpisode(episodeIndex)
            }}
            onBlur={onLeaveEpisode}
            onClick={() => {
              if (episodeIndex !== null) onCommitEpisode(episodeIndex)
            }}
          >
            <span className="prototype-cluster-chart__label">C{cluster.cluster_index}</span>
            <span className="prototype-cluster-chart__track">
              <span style={{ width: `${(cluster.member_count / maxMembers) * 100}%` }} />
            </span>
            <span className="prototype-cluster-chart__meta">
              <strong>{cluster.member_count}</strong>
              <em>{cluster.anchor_record_key || cluster.prototype_record_key}</em>
              {typeof cluster.average_distance === 'number' && (
                <em>avg {formatChartValue(cluster.average_distance)}</em>
              )}
              {typeof cluster.anchor_distance_to_barycenter === 'number' && (
                <em>bary {formatChartValue(cluster.anchor_distance_to_barycenter)}</em>
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function QualityDtwScatter({
  rows,
  emptyLabel,
  inspectHandlers,
}: {
  rows: AlignmentOverviewRow[]
  emptyLabel: string
  inspectHandlers: EpisodeInspectHandlers
}) {
  const { onPreviewEpisode, onCommitEpisode, onLeaveEpisode } = inspectHandlers
  const points = rows
    .map((row) => ({ row, delay: averageDelayForRow(row, 'dtw_start_delay_s') }))
    .filter((point): point is { row: AlignmentOverviewRow; delay: number } => point.delay !== null)
  if (points.length === 0) return <ChartEmpty label={emptyLabel} />

  const width = 520
  const height = 220
  const padX = 38
  const padY = 28
  const minDelay = Math.min(...points.map((point) => point.delay), 0)
  const maxDelay = Math.max(...points.map((point) => point.delay), 0)
  const delayRange = maxDelay - minDelay || 1
  const xFor = (score: number) => padX + (Math.max(0, Math.min(score, 100)) / 100) * (width - padX * 2)
  const yFor = (delay: number) =>
    height - padY - ((delay - minDelay) / delayRange) * (height - padY * 2)

  return (
    <div className="quality-dtw-scatter">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Quality score versus DTW delay">
        <line x1={padX} y1={yFor(0)} x2={width - padX} y2={yFor(0)} className="quality-dtw-scatter__zero" />
        {[0, 50, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={xFor(tick)}
              y1={padY}
              x2={xFor(tick)}
              y2={height - padY}
              className="pipeline-chart-gridline"
            />
            <text x={xFor(tick)} y={height - 4} textAnchor="middle" className="pipeline-chart-axis-label">
              {tick}
            </text>
          </g>
        ))}
        <text x={8} y={yFor(maxDelay) + 4} className="pipeline-chart-axis-label">
          {formatChartValue(maxDelay)}s
        </text>
        <text x={8} y={yFor(minDelay) + 4} className="pipeline-chart-axis-label">
          {formatChartValue(minDelay)}s
        </text>
        {points.map((point) => (
          <g
            key={point.row.episode_index}
            data-overview-inspect-trigger="true"
            role="button"
            tabIndex={0}
            onMouseEnter={() => onPreviewEpisode(point.row.episode_index)}
            onMouseLeave={onLeaveEpisode}
            onFocus={() => onPreviewEpisode(point.row.episode_index)}
            onBlur={onLeaveEpisode}
            onClick={() => onCommitEpisode(point.row.episode_index)}
          >
            <title>{`Episode ${point.row.episode_index}: score ${point.row.quality_score.toFixed(1)}, delay ${formatChartValue(point.delay)}s`}</title>
            <circle
              cx={xFor(point.row.quality_score)}
              cy={yFor(point.delay)}
              r={5}
              fill={qualityColor(point.row)}
              className="quality-dtw-scatter__point"
            />
          </g>
        ))}
      </svg>
    </div>
  )
}

export function TaskDescriptionCell({
  row,
  locale,
  emptyLabel,
}: {
  row: AlignmentOverviewRow
  locale: 'zh' | 'en'
  emptyLabel: string
}) {
  const taskInfo = taskInfoForRow(row)
  if (!taskInfo.text) {
    return <span className="overview-task-cell overview-task-cell--empty">{emptyLabel}</span>
  }
  return (
    <span className={cn('overview-task-cell', taskInfo.supplemental && 'is-supplemented')}>
      <strong>
        {taskInfo.text}
        {taskInfo.supplemental && <sup>*</sup>}
      </strong>
      <em>
        {taskInfo.supplemental
          ? (locale === 'zh' ? '语义对齐补充' : 'Semantic supplement')
          : (locale === 'zh' ? '原始任务字段' : 'Dataset task field')}
      </em>
    </span>
  )
}

export function DtwDelayCell({ row, locale }: { row: AlignmentOverviewRow; locale: 'zh' | 'en' }) {
  const startDelay = averageDelayForRow(row, 'dtw_start_delay_s')
  const endDelay = averageDelayForRow(row, 'dtw_end_delay_s')
  const durationDelta = averageDelayForRow(row, 'duration_delta_s')
  if (startDelay === null && endDelay === null && durationDelta === null) {
    return <span className="overview-data-cell overview-data-cell--empty">-</span>
  }
  return (
    <span className="overview-data-cell overview-dtw-cell">
      <strong>{formatSignedSeconds(startDelay, locale)}</strong>
      <em>
        {formatAlignmentMethod(row.propagation_alignment_method, locale)}
        {endDelay !== null && ` · ${locale === 'zh' ? '终点' : 'end'} ${formatSignedSeconds(endDelay, locale)}`}
        {durationDelta !== null && ` · Δ ${formatSignedSeconds(durationDelta, locale)}`}
      </em>
    </span>
  )
}

export function SemanticTextCell({ row, locale }: { row: AlignmentOverviewRow; locale: 'zh' | 'en' }) {
  const spans = rowSemanticSpans(row)
  const firstSpan = spans[0]
  const text = semanticTaskTextForRow(row)
  if (!text) return <span className="overview-data-cell overview-data-cell--empty">-</span>
  return (
    <span className="overview-data-cell overview-semantic-cell">
      <strong>{text}</strong>
      <em>
        {firstSpan ? `${formatSpanSource(firstSpan.source, locale)} · ${formatTimeWindow(firstSpan, locale)}` : ''}
        {spans.length > 1 && ` · +${spans.length - 1}`}
      </em>
    </span>
  )
}
