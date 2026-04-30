import { useEffect, useMemo, useState } from 'react'
import { useI18n } from '@/i18n'
import { useWorkflow } from '@/domains/curation/store/useCurationStore'
import { ActionButton, GlassPanel } from '@/shared/ui'
import PieChartCard from './PieChartCard'
import QualityDetailInspector from './QualityDetailInspector'
import {
  clampPieSegments,
  cn,
  collectIssueTypes,
  formatIssueDetail,
  formatIssueLabel,
  isFailingIssue,
  issueDistribution,
  scoreHistogram,
  type PieSegment,
} from './qualityValidationUtils'

export default function QualityValidationView() {
  const { t, locale } = useI18n()
  const {
    selectedDataset,
    datasetInfo,
    selectedValidators,
    toggleValidator,
    runQualityValidation,
    pauseQualityValidation,
    resumeQualityValidation,
    qualityRunning,
    qualityDefaults,
    qualityResults,
    workflowState,
    deleteQualityResults,
    publishQualityParquet,
    getQualityCsvUrl,
    fetchAnnotationWorkspace,
    qualityThresholds,
    setQualityThreshold,
    selectDataset,
    prepareRemoteDatasetForWorkflow,
    stopPolling,
    selectedDatasetIsRemotePrepared,
  } = useWorkflow()
  const [failureOnly, setFailureOnly] = useState(false)
  const [issueType, setIssueType] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [publishError, setPublishError] = useState('')
  const [publishMessage, setPublishMessage] = useState('')
  const [selectedEpisodeForReview, setSelectedEpisodeForReview] = useState<number | null>(null)
  const [reviewVideoUrl, setReviewVideoUrl] = useState('')
  const [reviewVideoLabel, setReviewVideoLabel] = useState('')
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const [runQualityError, setRunQualityError] = useState('')
  const [rightRailCollapsed, setRightRailCollapsed] = useState(false)
  const [hoveredEpisodeIndex, setHoveredEpisodeIndex] = useState<number | null>(null)
  const [collapsedThresholdValidators, setCollapsedThresholdValidators] = useState<string[]>([
    'metadata',
    'timing',
    'action',
    'visual',
    'depth',
  ])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  useEffect(() => {
    if (selectedDataset && !datasetInfo) {
      void selectDataset(selectedDataset)
    }
  }, [selectedDataset, datasetInfo, selectDataset])

  const qStage = workflowState?.stages.quality_validation
  const isRunning = qualityRunning || qStage?.status === 'running'
  const isPaused = qStage?.status === 'paused'
  const isPauseRequested = isRunning && Boolean(qStage?.pause_requested)
  const controlsLocked = isRunning || isPaused
  const datasetIsWorkflowReady = Boolean(workflowState) || selectedDatasetIsRemotePrepared
  const episodes = qualityResults?.episodes || []
  const canDeleteResults =
    Boolean(selectedDataset)
    && !isRunning
    && (
      episodes.length > 0
      || qStage?.status === 'completed'
      || qStage?.status === 'paused'
      || qStage?.status === 'error'
    )
  const availableIssueTypes = useMemo(() => collectIssueTypes(episodes), [episodes])
  const filteredEpisodes = useMemo(() => {
    return episodes.filter((episode) => {
      if (failureOnly && episode.passed) {
        return false
      }
      if (issueType) {
        return (episode.issues || []).some(
          (issue) => isFailingIssue(issue) && issue.check_name === issueType,
        )
      }
      return true
    })
  }, [episodes, failureOnly, issueType])
  const detailEpisode = useMemo(() => {
    if (hoveredEpisodeIndex === null) {
      return null
    }
    return filteredEpisodes.find((episode) => episode.episode_index === hoveredEpisodeIndex) || null
  }, [filteredEpisodes, hoveredEpisodeIndex])
  const displayedEpisodeCount = useMemo(() => {
    if (failureOnly || issueType) {
      return filteredEpisodes.length
    }
    const completed = qStage?.summary?.['completed']
    if (typeof completed === 'number') {
      return completed
    }
    if (episodes.length > 0) {
      return episodes.length
    }
    return qualityResults?.total ?? '--'
  }, [episodes.length, failureOnly, filteredEpisodes.length, issueType, qStage?.summary, qualityResults?.total])

  const otherLabel = locale === 'zh' ? '其他' : 'Other'
  const qualityPieSegments = useMemo<PieSegment[]>(() => ([
    { label: t('passedEpisodes'), count: qualityResults?.passed ?? 0, color: '#33c36b' },
    { label: t('failedEpisodes'), count: qualityResults?.failed ?? 0, color: '#f26b6b' },
  ]).filter((segment) => segment.count > 0), [qualityResults, t])
  const issuePieSegments = useMemo<PieSegment[]>(
    () =>
      clampPieSegments(
        issueDistribution(episodes).map((item, index) => ({
          label: formatIssueLabel(item.label, locale),
          count: item.count,
          color: ['#4d87ff', '#7c68ff', '#f59e0b', '#ec4899', '#14b8a6'][index % 5],
        })),
        { maxSegments: 4, otherLabel, otherColor: '#94a3b8' },
      ),
    [episodes, locale, otherLabel],
  )
  const scorePieSegments = useMemo<PieSegment[]>(
    () =>
      scoreHistogram(episodes)
        .map((item, index) => ({
          label: item.label,
          count: item.count,
          color: ['#1d4ed8', '#3b82f6', '#60a5fa', '#93c5fd', '#dbeafe'][index % 5],
        }))
        .filter((segment) => segment.count > 0),
    [episodes],
  )

  async function handlePublishParquet(): Promise<void> {
    setPublishing(true)
    setPublishError('')
    setPublishMessage('')
    try {
      const result = await publishQualityParquet()
      setPublishMessage(`${t('qualityParquet')}: ${result.path}`)
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : 'Publish failed')
    } finally {
      setPublishing(false)
    }
  }

  async function handleDeleteQualityResults(): Promise<void> {
    if (!selectedDataset || !window.confirm(t('deleteQualityResultsConfirm'))) {
      return
    }
    setDeleting(true)
    setPublishError('')
    setPublishMessage('')
    try {
      await deleteQualityResults()
      setFailureOnly(false)
      setIssueType('')
      setSelectedEpisodeForReview(null)
      setReviewVideoUrl('')
      setReviewVideoLabel('')
      setReviewError('')
      setPublishMessage(t('deleteQualityResultsSuccess'))
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  async function handleRunQualityAction(): Promise<void> {
    setRunQualityError('')
    try {
      if (!datasetIsWorkflowReady && selectedDataset) {
        await prepareRemoteDatasetForWorkflow(selectedDataset, false)
      }
      if (isPaused) {
        await resumeQualityValidation()
      } else {
        await runQualityValidation()
      }
    } catch (error) {
      setRunQualityError(error instanceof Error ? error.message : t('qualityRunFailed'))
    }
  }

  async function handleReviewEpisode(episodeIndex: number): Promise<void> {
    setSelectedEpisodeForReview(episodeIndex)
    setReviewLoading(true)
    setReviewError('')
    try {
      const workspace = await fetchAnnotationWorkspace(episodeIndex)
      const firstVideo = workspace.videos[0]
      if (!firstVideo) {
        setReviewVideoUrl('')
        setReviewVideoLabel('')
        setReviewError('No video available for this episode')
        return
      }
      setReviewVideoUrl(firstVideo.url)
      setReviewVideoLabel(firstVideo.path)
    } catch (error) {
      setReviewVideoUrl('')
      setReviewVideoLabel('')
      setReviewError(error instanceof Error ? error.message : 'Failed to load episode video')
    } finally {
      setReviewLoading(false)
    }
  }

  const thresholdGroups: Array<{
    validator: string
    fields: Array<{ key: string; label: string; step: number; kind?: 'boolean' }>
  }> = [
    {
      validator: 'metadata',
      fields: [
        { key: 'metadata_require_info_json', label: '检查 meta/info.json', step: 1, kind: 'boolean' },
        { key: 'metadata_require_episode_metadata', label: '检查 episode 元数据', step: 1, kind: 'boolean' },
        { key: 'metadata_require_data_files', label: '检查数据文件缺失', step: 1, kind: 'boolean' },
        { key: 'metadata_require_videos', label: '检查视频文件缺失', step: 1, kind: 'boolean' },
        { key: 'metadata_require_task_description', label: '检查任务描述', step: 1, kind: 'boolean' },
        { key: 'metadata_min_duration_s', label: '最小时长 (s)', step: 0.1 },
      ],
    },
    {
      validator: 'timing',
      fields: [
        { key: 'timing_min_monotonicity', label: '最小单调性', step: 0.001 },
        { key: 'timing_max_interval_cv', label: '最大间隔 CV', step: 0.001 },
        { key: 'timing_min_frequency_hz', label: '最小频率 (Hz)', step: 0.1 },
        { key: 'timing_max_gap_ratio', label: '最大 gap 比例', step: 0.001 },
        { key: 'timing_min_frequency_consistency', label: '最小频率一致性', step: 0.001 },
      ],
    },
    {
      validator: 'action',
      fields: [
        { key: 'action_static_threshold', label: '静止阈值', step: 0.0001 },
        { key: 'action_max_all_static_s', label: '整体最长静止 (s)', step: 0.1 },
        { key: 'action_max_key_static_s', label: '关键关节最长静止 (s)', step: 0.1 },
        { key: 'action_max_velocity_rad_s', label: '最大速度 (rad/s)', step: 0.01 },
        { key: 'action_min_duration_s', label: '动作最小时长 (s)', step: 0.1 },
        { key: 'action_max_nan_ratio', label: '最大缺失比例', step: 0.001 },
      ],
    },
    {
      validator: 'visual',
      fields: [
        { key: 'visual_min_resolution_width', label: '最小宽度', step: 1 },
        { key: 'visual_min_resolution_height', label: '最小高度', step: 1 },
        { key: 'visual_min_frame_rate', label: '最小帧率 (Hz)', step: 0.1 },
        { key: 'visual_frame_rate_tolerance', label: '帧率容差', step: 0.1 },
        { key: 'visual_color_shift_max', label: '最大色偏', step: 0.01 },
        { key: 'visual_overexposure_ratio_max', label: '最大过曝比例', step: 0.01 },
        { key: 'visual_underexposure_ratio_max', label: '最大欠曝比例', step: 0.01 },
        { key: 'visual_abnormal_black_ratio_max', label: '最大黑帧比例', step: 0.01 },
        { key: 'visual_abnormal_white_ratio_max', label: '最大白帧比例', step: 0.01 },
        { key: 'visual_min_video_count', label: '最少视频数量', step: 1 },
        { key: 'visual_min_accessible_ratio', label: '最小可访问比例', step: 0.01 },
      ],
    },
    {
      validator: 'depth',
      fields: [
        { key: 'depth_min_stream_count', label: '最少深度流数量', step: 1 },
        { key: 'depth_min_accessible_ratio', label: '最小可访问比例', step: 0.01 },
        { key: 'depth_invalid_pixel_max', label: '最大无效像素比例', step: 0.01 },
        { key: 'depth_continuity_min', label: '最小连续性', step: 0.01 },
      ],
    },
    {
      validator: 'ee_trajectory',
      fields: [
        { key: 'ee_min_event_count', label: '最少抓放事件数', step: 1 },
        { key: 'ee_min_gripper_span', label: '最小夹爪幅度', step: 0.01 },
      ],
    },
  ] as const

  function toggleThresholdValidator(validator: string): void {
    setCollapsedThresholdValidators((current) =>
      current.includes(validator)
        ? current.filter((item) => item !== validator)
        : [...current, validator],
    )
  }

  return (
    <div className="page-enter quality-view pipeline-page pipeline-compact-shell quality-validation-page pipeline-compact-quality">
      {selectedDataset && datasetInfo ? (
        <div className="workflow-view__info-bar">
          <span>{datasetInfo.label}</span>
          <span>{datasetInfo.stats.total_episodes} {t('episodes')}</span>
          <span>{datasetInfo.stats.fps} fps</span>
          <span>{datasetInfo.stats.robot_type}</span>
        </div>
      ) : (
        <GlassPanel className="quality-view__empty">
          {t('noWorkflowDataset')}
        </GlassPanel>
      )}

      <div className={cn('quality-validation-shell', 'pipeline-compact-quality-shell', rightRailCollapsed && 'is-rail-collapsed')}>
        <div className="quality-validation-shell__main">
          <div className="quality-validation-overview pipeline-compact-quality-overview">
            <GlassPanel className="quality-total-card">
              <div className="quality-total-card__eyebrow">{t('totalEpisodes')}</div>
              <div className="quality-total-card__value">{displayedEpisodeCount}</div>
            </GlassPanel>

            <div className="quality-validation-pies">
              <PieChartCard
                title={`${t('passedEpisodes')} / ${t('failedEpisodes')}`}
                segments={qualityPieSegments}
                centerLabel={t('episodes')}
              />
              <PieChartCard
                title={t('issueDistribution')}
                segments={issuePieSegments}
                centerLabel={locale === 'zh' ? '问题' : 'Issues'}
              />
              <PieChartCard
                title={t('scoreDistribution')}
                segments={scorePieSegments}
                centerLabel={locale === 'zh' ? '区间' : 'Bands'}
              />
            </div>
          </div>

          {runQualityError && (
            <GlassPanel className="quality-results-card">
              <div className="quality-sidebar__error">{runQualityError}</div>
            </GlassPanel>
          )}

          <GlassPanel
            className="quality-results-card"
            onMouseLeave={() => setHoveredEpisodeIndex(null)}
          >
            <div className="quality-results-card__head">
              <div>
                <h3>{t('qualityResults')}</h3>
                <p>
                  {filteredEpisodes.length} / {episodes.length} rows
                </p>
              </div>
              <div className="quality-results-card__filters">
                <label className="quality-checkbox">
                  <input
                    type="checkbox"
                    checked={failureOnly}
                    onChange={() => setFailureOnly((value) => !value)}
                  />
                  <span>{t('failureOnly')}</span>
                </label>
                <select
                  className="dataset-selector__select"
                  value={issueType}
                  onChange={(event) => setIssueType(event.target.value)}
                >
                  <option value="">{t('allIssues')}</option>
                  {availableIssueTypes.map((type) => (
                    <option key={type} value={type}>
                      {formatIssueLabel(type, locale)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="quality-table-wrap quality-results-table-wrap">
              <table className="quality-table">
                <thead>
                  <tr>
                    <th>Episode</th>
                    <th>{t('score')}</th>
                    <th>{t('passed')}</th>
                    <th>{t('validators')}</th>
                    <th>{t('issueType')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEpisodes.map((episode) => {
                    const failedValidators = Object.entries(episode.validators || {})
                      .filter(([, validator]) => !validator.passed)
                      .map(([name]) => name)
                    const issueNames = Array.from(
                      new Set(
                        (episode.issues || [])
                          .filter((issue) => isFailingIssue(issue))
                          .map((issue) => issue['check_name'])
                          .filter((name): name is string => typeof name === 'string' && Boolean(name)),
                      ),
                    )
                    const issueDetails = (episode.issues || [])
                      .filter((issue) => isFailingIssue(issue))
                      .map((issue) => {
                        const checkName = issue['check_name']
                        if (typeof checkName !== 'string' || !checkName) {
                          return null
                        }
                        return {
                          key: checkName,
                          label: formatIssueLabel(checkName, locale),
                          detail: formatIssueDetail(issue),
                        }
                      })
                      .filter((item): item is { key: string; label: string; detail: string } => Boolean(item))
                    return (
                      <tr
                        key={episode.episode_index}
                        className={cn(
                          'quality-result-row',
                          detailEpisode?.episode_index === episode.episode_index && 'is-inspected',
                        )}
                        tabIndex={0}
                        onMouseEnter={() => setHoveredEpisodeIndex(episode.episode_index)}
                        onFocus={() => setHoveredEpisodeIndex(episode.episode_index)}
                      >
                        <td>
                          <button
                            type="button"
                            className="quality-episode-link"
                            onMouseEnter={() => setHoveredEpisodeIndex(episode.episode_index)}
                            onFocus={() => setHoveredEpisodeIndex(episode.episode_index)}
                            onClick={() => {
                              setHoveredEpisodeIndex(episode.episode_index)
                              void handleReviewEpisode(episode.episode_index)
                            }}
                          >
                            {episode.episode_index}
                          </button>
                        </td>
                        <td>{episode.score.toFixed(1)}</td>
                        <td className={cn(episode.passed ? 'is-pass' : 'is-fail')}>
                          {episode.passed ? t('passed') : t('failed')}
                        </td>
                        <td>{failedValidators.join(', ') || '-'}</td>
                        <td>
                          {issueDetails.length > 0 ? (
                            <div className="quality-issue-list">
                              {issueDetails.map((issue) => (
                                <div key={`${episode.episode_index}-${issue.key}`} className="quality-issue-item">
                                  <div className="quality-issue-item__label">{issue.label}</div>
                                  {issue.detail && (
                                    <div className="quality-issue-item__detail">{issue.detail}</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            issueNames.join(', ') || '-'
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {filteredEpisodes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="quality-table__empty">
                        No results
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {detailEpisode && (
              <QualityDetailInspector episode={detailEpisode} locale={locale} />
            )}
          </GlassPanel>
        </div>

        <aside className={cn('quality-validation-rail', rightRailCollapsed && 'is-collapsed')}>
          <GlassPanel className="quality-validation-rail__card">
            <button
              type="button"
              className={cn(
                'quality-validation-rail__toggle',
                rightRailCollapsed && 'is-collapsed',
              )}
              onClick={() => setRightRailCollapsed((value) => !value)}
              aria-expanded={!rightRailCollapsed}
              aria-label={rightRailCollapsed ? 'Expand quality rail' : 'Collapse quality rail'}
            >
              <span className="quality-validation-rail__toggle-icon">‹</span>
              <span className="quality-validation-rail__toggle-label">{t('qualityValidation')}</span>
            </button>

            <div
              className={cn(
                'quality-validation-rail__panel',
                rightRailCollapsed && 'is-collapsed',
              )}
              aria-hidden={rightRailCollapsed}
            >
              <div className="quality-sidebar__section">
                <h3>{t('qualityValidation')}</h3>
                <p>{t('qualityOverview')}</p>
                {qualityDefaults && (
                  <div className="quality-sidebar__path">
                    自动默认值:
                    {' '}
                    {qualityDefaults.profile.fps > 0 ? `${qualityDefaults.profile.fps} fps` : 'fps --'}
                    {qualityDefaults.profile.video_resolution
                      ? ` · ${qualityDefaults.profile.video_resolution.width}x${qualityDefaults.profile.video_resolution.height}`
                      : ''}
                    {' · '}
                    {qualityDefaults.checks.task_descriptions_present ? '任务描述存在' : '任务描述缺失'}
                  </div>
                )}
              </div>

              <div className="quality-sidebar__section">
                {!datasetIsWorkflowReady && selectedDataset && (
                  <div className="quality-sidebar__error">{t('qualityRequiresImportedDataset')}</div>
                )}
                <ActionButton
                  type="button"
                  disabled={
                    !selectedDataset
                    || isRunning
                    || (!isPaused && selectedValidators.length === 0)
                  }
                  onClick={() => void handleRunQualityAction()}
                  className="w-full justify-center"
                >
                  {isRunning ? t('running') : isPaused ? t('resumeQuality') : t('runQuality')}
                </ActionButton>
                {isRunning && (
                  <ActionButton
                    type="button"
                    variant="warning"
                    disabled={!selectedDataset || isPauseRequested}
                    onClick={() => void pauseQualityValidation()}
                    className="mt-3 w-full justify-center"
                  >
                    {isPauseRequested ? t('pauseRequested') : t('pauseQuality')}
                  </ActionButton>
                )}
                {isPauseRequested && (
                  <div className="quality-sidebar__path">{t('pauseRequestedHint')}</div>
                )}
                {isPaused && (
                  <div className="quality-sidebar__path">
                    {t('paused')}
                    {typeof qStage?.summary?.['completed'] === 'number' && typeof qStage?.summary?.['total'] === 'number'
                      ? ` · ${qStage.summary['completed']} / ${qStage.summary['total']}`
                      : ''}
                  </div>
                )}
              </div>

              <div className="quality-sidebar__section">
                <div className="quality-sidebar__label">{t('validators')}</div>
                <div className="quality-threshold-groups">
                  {thresholdGroups.map((group) => {
                    const collapsed = collapsedThresholdValidators.includes(group.validator)
                    const enabled = selectedValidators.includes(group.validator)
                    return (
                      <div
                        key={group.validator}
                        className={cn(
                          'quality-threshold-group',
                          !enabled && 'is-disabled',
                        )}
                      >
                        <div className="quality-threshold-group__toggle">
                          <label className="quality-threshold-group__check">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggleValidator(group.validator)}
                              disabled={controlsLocked || !selectedDataset}
                            />
                            <span>
                              {t(group.validator as 'metadata' | 'timing' | 'action' | 'visual' | 'depth' | 'ee_trajectory')}
                            </span>
                          </label>
                          <button
                            type="button"
                            className="quality-threshold-group__chevron-btn"
                            onClick={() => toggleThresholdValidator(group.validator)}
                          >
                            <span className={cn('quality-threshold-group__chevron', !collapsed && 'is-open')}>
                              ▾
                            </span>
                          </button>
                        </div>
                        {!collapsed && (
                          <div className="quality-threshold-group__body">
                            {group.fields.length > 0 ? (
                              <div className="quality-threshold-list">
                                {group.fields.map((field) => {
                                  const value = qualityThresholds[field.key] ?? 0
                                  return (
                                    <label key={field.key} className="quality-threshold-field">
                                      <span>{field.label}</span>
                                      {field.kind === 'boolean' ? (
                                        <input
                                          type="checkbox"
                                          checked={value >= 0.5}
                                          disabled={!enabled || controlsLocked}
                                          onChange={(event) =>
                                            setQualityThreshold(field.key, event.target.checked ? 1 : 0)
                                          }
                                        />
                                      ) : (
                                        <input
                                          type="number"
                                          step={field.step}
                                          value={value}
                                          disabled={!enabled || controlsLocked}
                                          onChange={(event) =>
                                            setQualityThreshold(field.key, Number(event.target.value))
                                          }
                                        />
                                      )}
                                    </label>
                                  )
                                })}
                              </div>
                            ) : (
                              <div className="quality-threshold-empty">
                                这个验证器当前没有可调阈值
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="quality-sidebar__section">
                <a
                  href={getQualityCsvUrl(failureOnly)}
                  className={cn(
                    'quality-sidebar__link',
                    !selectedDataset && 'is-disabled',
                  )}
                  onClick={(event) => {
                    if (!selectedDataset) {
                      event.preventDefault()
                    }
                  }}
                >
                  {t('exportCsv')}
                </a>
                <ActionButton
                  type="button"
                  variant="secondary"
                  disabled={!selectedDataset || publishing}
                  onClick={() => void handlePublishParquet()}
                  className="w-full justify-center"
                >
                  {publishing ? t('publishing') : t('publishQualityParquet')}
                </ActionButton>
                <ActionButton
                  type="button"
                  variant="danger"
                  disabled={!canDeleteResults || deleting}
                  onClick={() => void handleDeleteQualityResults()}
                  className="w-full justify-center"
                >
                  {deleting ? t('deleting') : t('deleteQualityResults')}
                </ActionButton>
                {qualityResults?.working_parquet_path && (
                  <div className="quality-sidebar__path">
                    working: {qualityResults.working_parquet_path}
                  </div>
                )}
                {qualityResults?.published_parquet_path && (
                  <div className="quality-sidebar__path">
                    published: {qualityResults.published_parquet_path}
                  </div>
                )}
                {publishMessage && (
                  <div className="quality-sidebar__path">{publishMessage}</div>
                )}
                {publishError && (
                  <div className="quality-sidebar__error">{publishError}</div>
                )}
              </div>

              <div className="quality-sidebar__section">
                <div className="quality-sidebar__label">视频验证</div>
                {reviewLoading ? (
                  <div className="quality-sidebar__path">加载视频中...</div>
                ) : reviewError ? (
                  <div className="quality-sidebar__error">{reviewError}</div>
                ) : reviewVideoUrl ? (
                  <div className="quality-review-video">
                    <video
                      className="quality-review-video__player"
                      controls
                      preload="metadata"
                      playsInline
                      src={reviewVideoUrl}
                    />
                    <div className="quality-sidebar__path">
                      episode {selectedEpisodeForReview} · {reviewVideoLabel}
                    </div>
                  </div>
                ) : (
                  <div className="quality-sidebar__path">点击结果表中的 episode 编号开始验证视频</div>
                )}
              </div>
            </div>
          </GlassPanel>
        </aside>
      </div>
    </div>
  )
}
