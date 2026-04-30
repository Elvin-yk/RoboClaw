import { cn } from '@/shared/lib/cn'
import type { AlignmentOverviewRow, AnnotationWorkspacePayload } from '@/domains/curation/store/useCurationStore'
import { OverviewEpisodeMediaPreview } from './OverviewEpisodeMediaPreview'
import {
  formatAlignmentMethod,
  formatCheckLabel,
  formatQualityCheckDetail,
  formatSignedSeconds,
  formatSourceTimeWindow,
  formatSpanSource,
  formatSpanTitle,
  formatTimeWindow,
  formatValidatorLabel,
  groupQualityIssues,
  taskInfoForRow,
} from '../lib/dataOverviewLib'

export function OverviewRowDetailPopover({
  row,
  locale,
  workspace,
  workspaceLoading,
  workspaceError,
  onClose,
  onInspectorEnter,
  onInspectorLeave,
}: {
  row: AlignmentOverviewRow
  locale: 'zh' | 'en'
  workspace: AnnotationWorkspacePayload | null
  workspaceLoading: boolean
  workspaceError: string
  onClose: () => void
  onInspectorEnter: () => void
  onInspectorLeave: () => void
}) {
  const copy = locale === 'zh'
    ? {
      title: '数据纵览',
      close: '关闭数据纵览',
      quality: '质量验证结果',
      validators: '验证器',
      checks: '检查项',
      dtw: 'DTW 延迟结果',
      semantic: '语义对齐',
      passed: '通过',
      failed: '未通过',
      noChecks: '没有详细检查记录',
      noPropagation: '暂无传播或 DTW 延迟结果',
      noSemantic: '暂无语义标注',
      method: '方法',
      sourceEpisode: '源回合',
      targetWindow: '目标区间',
      sourceWindow: '源区间',
      startDelay: '起点延迟',
      endDelay: '终点延迟',
      durationDelta: '时长差',
      confidence: '置信度',
      taskDescription: '任务描述',
      semanticSupplement: '语义对齐补充',
      datasetTask: '原始任务字段',
      status: '状态',
      annotationCount: '标注数',
      propagatedCount: '传播数',
      source: '来源',
    }
    : {
      title: 'Data Overview',
      close: 'Close data overview',
      quality: 'Quality validation result',
      validators: 'Validators',
      checks: 'Checks',
      dtw: 'DTW delay result',
      semantic: 'Semantic alignment',
      passed: 'Passed',
      failed: 'Failed',
      noChecks: 'No detailed check records',
      noPropagation: 'No propagation or DTW delay result',
      noSemantic: 'No semantic annotation',
      method: 'Method',
      sourceEpisode: 'Source episode',
      targetWindow: 'Target window',
      sourceWindow: 'Source window',
      startDelay: 'Start delay',
      endDelay: 'End delay',
      durationDelta: 'Duration delta',
      confidence: 'Confidence',
      taskDescription: 'Task description',
      semanticSupplement: 'Semantic supplement',
      datasetTask: 'Dataset task field',
      status: 'Status',
      annotationCount: 'Annotations',
      propagatedCount: 'Propagated',
      source: 'Source',
    }
  const validatorEntries = Object.entries(row.validator_scores || {})
  const issueGroups = groupQualityIssues(row.issues || [])
  const propagationSpans = row.propagation_spans || []
  const annotationSpans = row.annotation_spans || []
  const semanticSpans = propagationSpans.length > 0 ? propagationSpans : annotationSpans
  const taskInfo = taskInfoForRow(row)

  return (
    <div
      className="quality-detail-inspector overview-row-detail-popover"
      role="status"
      onPointerEnter={onInspectorEnter}
      onPointerLeave={onInspectorLeave}
    >
      <div className="quality-detail-inspector__head">
        <div>
          <div className="quality-detail-inspector__eyebrow">{copy.title}</div>
          <h4>Episode {row.episode_index}</h4>
        </div>
        <div className="quality-detail-inspector__score">
          <span>{row.quality_score.toFixed(1)}</span>
          <span className={cn(row.quality_passed ? 'is-pass' : 'is-fail')}>
            {row.quality_passed ? copy.passed : copy.failed}
          </span>
        </div>
        <button
          type="button"
          className="overview-row-detail-popover__close"
          onClick={onClose}
          aria-label={copy.close}
          title={copy.close}
        >
          ×
        </button>
      </div>

      <div className="overview-detail-sections">
        <OverviewEpisodeMediaPreview
          workspace={workspace}
          loading={workspaceLoading}
          error={workspaceError}
          locale={locale}
        />

        <section className="overview-detail-section">
          <div className="overview-detail-section__title">{copy.quality}</div>
          {validatorEntries.length > 0 && (
            <div className="overview-detail-lines" aria-label={copy.validators}>
              {validatorEntries.map(([name, score]) => {
                const failed = row.failed_validators.includes(name)
                return (
                  <div key={name} className="overview-detail-line">
                    <strong>{formatValidatorLabel(name, locale)}</strong>
                    <span className={cn(failed ? 'is-fail' : 'is-pass')}>
                      {Number(score.toFixed(1))} · {failed ? copy.failed : copy.passed}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          {issueGroups.length > 0 ? (
            <div className="overview-detail-check-list" aria-label={copy.checks}>
              {issueGroups.map((group) => (
                <div key={group.validator} className="overview-detail-check-group">
                  <div className="overview-detail-check-group__name">
                    {formatValidatorLabel(group.validator, locale)}
                  </div>
                  {group.checks.map((issue, index) => {
                    const checkName = issue['check_name']
                    const checkKey = typeof checkName === 'string' && checkName.trim()
                      ? checkName
                      : `check-${index}`
                    const passed = issue['passed'] === true
                    const detail = formatQualityCheckDetail(issue, locale)
                    return (
                      <div
                        key={`${group.validator}-${checkKey}-${index}`}
                        className={cn('overview-detail-check', passed ? 'is-pass' : 'is-fail')}
                      >
                        <span>{passed ? '✓' : '×'}</span>
                        <span>{formatCheckLabel(checkKey, locale)}</span>
                        {detail && <em>{detail}</em>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          ) : (
            <div className="overview-detail-empty">{copy.noChecks}</div>
          )}
        </section>

        <section className="overview-detail-section">
          <div className="overview-detail-section__title">{copy.dtw}</div>
          {propagationSpans.length > 0 ? (
            <>
              <div className="overview-detail-lines">
                <div className="overview-detail-line">
                  <strong>{copy.method}</strong>
                  <span>{formatAlignmentMethod(row.propagation_alignment_method, locale)}</span>
                </div>
                {row.propagation_source_episode_index !== null
                  && row.propagation_source_episode_index !== undefined && (
                  <div className="overview-detail-line">
                    <strong>{copy.sourceEpisode}</strong>
                    <span>Episode {row.propagation_source_episode_index}</span>
                  </div>
                )}
              </div>
              <div className="overview-detail-span-list">
                {propagationSpans.map((span, index) => (
                  <div key={`${span.id || span.label || 'span'}-${index}`} className="overview-detail-span">
                    <div className="overview-detail-span__title">{formatSpanTitle(span, locale)}</div>
                    <div className="overview-detail-span__meta">
                      <span>{copy.targetWindow}: {formatTimeWindow(span, locale)}</span>
                      <span>{copy.sourceWindow}: {formatSourceTimeWindow(span, locale)}</span>
                      <span>{copy.startDelay}: {formatSignedSeconds(span.dtw_start_delay_s, locale)}</span>
                      <span>{copy.endDelay}: {formatSignedSeconds(span.dtw_end_delay_s, locale)}</span>
                      <span>{copy.durationDelta}: {formatSignedSeconds(span.duration_delta_s, locale)}</span>
                      {typeof span.prototype_score === 'number' && (
                        <span>{copy.confidence}: {Number(span.prototype_score.toFixed(3))}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="overview-detail-empty">{copy.noPropagation}</div>
          )}
        </section>

        <section className="overview-detail-section">
          <div className="overview-detail-section__title">{copy.semantic}</div>
          <div className="overview-detail-lines">
            <div className="overview-detail-line">
              <strong>{copy.taskDescription}</strong>
              <span className={cn(taskInfo.supplemental && 'is-supplemented')}>
                {taskInfo.text ? (
                  <>
                    {taskInfo.text}
                    {taskInfo.supplemental ? '*' : ''}
                    {' · '}
                    {taskInfo.supplemental ? copy.semanticSupplement : copy.datasetTask}
                  </>
                ) : (
                  locale === 'zh' ? '未填写任务' : 'Untitled task'
                )}
              </span>
            </div>
            <div className="overview-detail-line">
              <strong>{copy.status}</strong>
              <span>{locale === 'zh'
                ? (row.alignment_status === 'propagated' ? '已自动传播' : row.alignment_status === 'annotated' ? '已人工标注' : '未开始对齐')
                : (row.alignment_status === 'propagated' ? 'Propagated' : row.alignment_status === 'annotated' ? 'Annotated' : 'Not started')}
              </span>
            </div>
            <div className="overview-detail-line">
              <strong>{copy.annotationCount}</strong>
              <span>{row.annotation_count}</span>
            </div>
            <div className="overview-detail-line">
              <strong>{copy.propagatedCount}</strong>
              <span>{row.propagated_count}</span>
            </div>
          </div>
          {semanticSpans.length > 0 ? (
            <div className="overview-detail-span-list overview-detail-span-list--compact">
              {semanticSpans.map((span, index) => (
                <div key={`${span.id || span.label || 'semantic'}-${index}`} className="overview-detail-span">
                  <div className="overview-detail-span__title">{formatSpanTitle(span, locale)}</div>
                  <div className="overview-detail-span__meta">
                    <span>{copy.targetWindow}: {formatTimeWindow(span, locale)}</span>
                    <span>{copy.source}: {formatSpanSource(span.source, locale)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="overview-detail-empty">{copy.noSemantic}</div>
          )}
        </section>
      </div>
    </div>
  )
}
