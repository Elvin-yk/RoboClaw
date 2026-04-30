import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionButton, GlassPanel } from '@/shared/ui'
import { useI18n } from '@/i18n'
import {
  useWorkflow,
  type AlignmentOverviewSpan,
  type AnnotationWorkspacePayload,
} from '@/domains/curation/store/useCurationStore'
import { cn } from '@/shared/lib/cn'
import {
  CoverageStackedBar,
  DtwDelayCell,
  DtwDelayHistogram,
  MissingMatrix,
  PipelineChartPanel,
  PrototypeClusterChart,
  QualityDtwScatter,
  QualityTimelineChart,
  SemanticLabelBars,
  SemanticSpanTimeline,
  SemanticTextCell,
  TaskDescriptionCell,
  ValidatorHeatmap,
} from '../components/DataOverviewCharts'
import { OverviewRowDetailPopover } from '../components/OverviewRowDetailPopover'
import {
  INSPECT_CLOSE_DELAY_MS,
  INSPECT_PREVIEW_DELAY_MS,
  alignmentStatusKey,
  augmentRowsWithPropagationFallback,
  buildExportRows,
  downloadBlob,
  escapeCsvValue,
  formatCompactNumber,
  normalizeOverviewSpan,
  type EpisodeInspectHandlers,
  type QualityOverviewPanel,
} from '../lib/dataOverviewLib'

export default function DataOverviewPage() {
  const { t, locale } = useI18n()
  const {
    selectedDataset,
    datasetInfo,
    alignmentOverview,
    propagationResults,
    prototypeResults,
    loadAlignmentOverview,
    loadPropagationResults,
    loadPrototypeResults,
    fetchAnnotationWorkspace,
    selectDataset,
  } = useWorkflow()
  const [qualityFilter, setQualityFilter] = useState<'all' | 'passed' | 'failed'>('all')
  const [alignmentFilter, setAlignmentFilter] = useState<
    'all' | 'not_started' | 'annotated' | 'propagated'
  >('all')
  const [activeQualityPanel, setActiveQualityPanel] = useState<QualityOverviewPanel>('timeline')
  const [selectedEpisodeIds, setSelectedEpisodeIds] = useState<number[]>([])
  const [inspectedEpisodeId, setInspectedEpisodeId] = useState<number | null>(null)
  const [inspectedWorkspace, setInspectedWorkspace] = useState<AnnotationWorkspacePayload | null>(null)
  const [inspectedWorkspaceLoading, setInspectedWorkspaceLoading] = useState(false)
  const [inspectedWorkspaceError, setInspectedWorkspaceError] = useState('')
  const [propagationSourceSpans, setPropagationSourceSpans] = useState<AlignmentOverviewSpan[]>([])
  const inspectOpenTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)
  const inspectCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null)

  const clearInspectOpenTimer = useCallback(() => {
    if (inspectOpenTimerRef.current) {
      window.clearTimeout(inspectOpenTimerRef.current)
      inspectOpenTimerRef.current = null
    }
  }, [])

  const clearInspectCloseTimer = useCallback(() => {
    if (inspectCloseTimerRef.current) {
      window.clearTimeout(inspectCloseTimerRef.current)
      inspectCloseTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearInspectOpenTimer()
      clearInspectCloseTimer()
    }
  }, [clearInspectOpenTimer, clearInspectCloseTimer])

  const closeInspector = useCallback(() => {
    clearInspectOpenTimer()
    clearInspectCloseTimer()
    setInspectedEpisodeId(null)
  }, [clearInspectOpenTimer, clearInspectCloseTimer])

  const cancelInspectorClose = useCallback(() => {
    clearInspectCloseTimer()
  }, [clearInspectCloseTimer])

  const previewInspectEpisode = useCallback((episodeIndex: number) => {
    clearInspectOpenTimer()
    clearInspectCloseTimer()
    inspectOpenTimerRef.current = window.setTimeout(() => {
      setInspectedEpisodeId(episodeIndex)
      inspectOpenTimerRef.current = null
    }, INSPECT_PREVIEW_DELAY_MS)
  }, [clearInspectOpenTimer, clearInspectCloseTimer])

  const commitInspectEpisode = useCallback((episodeIndex: number) => {
    clearInspectOpenTimer()
    clearInspectCloseTimer()
    setInspectedEpisodeId(episodeIndex)
  }, [clearInspectOpenTimer, clearInspectCloseTimer])

  const scheduleInspectorClose = useCallback(() => {
    clearInspectOpenTimer()
    clearInspectCloseTimer()
    inspectCloseTimerRef.current = window.setTimeout(() => {
      setInspectedEpisodeId(null)
      inspectCloseTimerRef.current = null
    }, INSPECT_CLOSE_DELAY_MS)
  }, [clearInspectOpenTimer, clearInspectCloseTimer])

  const inspectHandlers = useMemo<EpisodeInspectHandlers>(() => ({
    onPreviewEpisode: previewInspectEpisode,
    onCommitEpisode: commitInspectEpisode,
    onLeaveEpisode: scheduleInspectorClose,
  }), [previewInspectEpisode, commitInspectEpisode, scheduleInspectorClose])

  useEffect(() => {
    if (inspectedEpisodeId === null) return undefined

    const handlePointerMove = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (
        target.closest('.overview-row-detail-popover')
        || target.closest('[data-overview-inspect-trigger="true"]')
      ) {
        cancelInspectorClose()
        return
      }
      scheduleInspectorClose()
    }

    document.addEventListener('pointermove', handlePointerMove)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
    }
  }, [inspectedEpisodeId, cancelInspectorClose, scheduleInspectorClose])

  useEffect(() => {
    if (selectedDataset && !datasetInfo) {
      void selectDataset(selectedDataset)
    }
  }, [selectedDataset, datasetInfo, selectDataset])

  useEffect(() => {
    if (selectedDataset) {
      void loadAlignmentOverview()
      void loadPropagationResults()
      void loadPrototypeResults()
    }
  }, [selectedDataset, loadAlignmentOverview, loadPropagationResults, loadPrototypeResults])

  useEffect(() => {
    const sourceEpisodeIndex = propagationResults?.source_episode_index
    if (!selectedDataset || sourceEpisodeIndex === null || sourceEpisodeIndex === undefined) {
      setPropagationSourceSpans([])
      return
    }
    let cancelled = false
    void fetch(
      `/api/curation/annotations?dataset=${encodeURIComponent(selectedDataset)}&episode_index=${sourceEpisodeIndex}`,
    )
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { annotations?: Array<Record<string, unknown>> } | null) => {
        if (cancelled) return
        const annotations = Array.isArray(payload?.annotations) ? payload.annotations : []
        setPropagationSourceSpans(annotations.map((span) => normalizeOverviewSpan(span)))
      })
      .catch(() => {
        if (!cancelled) setPropagationSourceSpans([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedDataset, propagationResults?.source_episode_index])

  useEffect(() => {
    if (inspectedEpisodeId === null) {
      setInspectedWorkspace(null)
      setInspectedWorkspaceLoading(false)
      setInspectedWorkspaceError('')
      return undefined
    }

    let cancelled = false
    setInspectedWorkspace(null)
    setInspectedWorkspaceLoading(true)
    setInspectedWorkspaceError('')

    void fetchAnnotationWorkspace(inspectedEpisodeId)
      .then((payload) => {
        if (cancelled) return
        setInspectedWorkspace(payload)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setInspectedWorkspaceError(error instanceof Error ? error.message : 'Failed to load episode workspace')
      })
      .finally(() => {
        if (!cancelled) setInspectedWorkspaceLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [fetchAnnotationWorkspace, inspectedEpisodeId])

  const rawRows = alignmentOverview?.rows || []
  const rows = useMemo(
    () => augmentRowsWithPropagationFallback(rawRows, propagationResults, propagationSourceSpans),
    [rawRows, propagationResults, propagationSourceSpans],
  )
  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (qualityFilter === 'passed' && !row.quality_passed) return false
      if (qualityFilter === 'failed' && row.quality_passed) return false
      if (alignmentFilter !== 'all' && row.alignment_status !== alignmentFilter) return false
      return true
    })
  }, [rows, qualityFilter, alignmentFilter])

  const visibleSelectedRows = useMemo(
    () => filteredRows.filter((row) => selectedEpisodeIds.includes(row.episode_index)),
    [filteredRows, selectedEpisodeIds],
  )
  const exportSourceRows = visibleSelectedRows.length > 0 ? visibleSelectedRows : filteredRows
  const exportRows = useMemo(
    () => buildExportRows(exportSourceRows, locale, t),
    [exportSourceRows, locale, t],
  )
  const inspectedRow = useMemo(
    () => filteredRows.find((row) => row.episode_index === inspectedEpisodeId) || null,
    [filteredRows, inspectedEpisodeId],
  )

  const allVisibleSelected =
    filteredRows.length > 0
    && filteredRows.every((row) => selectedEpisodeIds.includes(row.episode_index))
  const clusterCount = prototypeResults?.cluster_count ?? alignmentOverview?.summary.prototype_cluster_count ?? 0
  const overviewCopy = locale === 'zh'
    ? {
      title: 'Pipeline 分析驾驶舱',
      subtitle: '同屏查看质量、语义、DTW 和原型聚类结果',
      showingRows: '当前结果',
      total: '总数',
      failed: '失败',
      annotated: '已标注',
      propagated: '已传播',
      clusters: '聚类数',
      toolbar: '筛选与导出',
      qualitySection: '质量',
      semanticSection: '语义 / DTW',
      coverageSection: '覆盖 / 原型',
      stackedCharts: '堆叠分析卡片',
      timeline: 'Episode 质量时间线',
      timelineDesc: '连续低分区间会直接浮现',
      validatorHeatmap: 'Validator × Episode 热力图',
      validatorDesc: '红色为失败，深绿为高分通过',
      missingMatrix: '缺失项矩阵',
      missingDesc: '元数据、视频、任务描述等存在性',
      dtwHistogram: 'DTW 延迟分布',
      dtwDesc: '起点、终点和时长差可切换',
      semanticTimeline: '语义片段时间轴',
      semanticTimelineDesc: '每个 episode 的语义 span 区间',
      labelBars: '语义标签分布',
      labelBarsDesc: '优先统计 label，其次 text/category',
      coverage: '人工标注 vs 自动传播',
      coverageDesc: '自动传播优先于人工标注计数',
      prototype: '原型聚类图',
      prototypeDesc: '成员数、anchor 与距离摘要',
      scatter: '质量分数 vs DTW 延迟',
      scatterDesc: '定位低质量且延迟异常的 episode',
      empty: '暂无可绘制数据',
      tableTitle: '结果明细',
      tableDesc: '悬浮或点击 episode 可查看质量、DTW 与语义详情',
      semanticTextColumn: '语义文本',
      dtwColumn: 'DTW 延迟',
      supplementLegend: '* 表示由语义对齐文本补充的任务描述',
      qualityPanelTabs: [
        { key: 'timeline' as const, label: '时间线' },
        { key: 'validators' as const, label: '验证器' },
        { key: 'missing' as const, label: '缺失项' },
      ],
    }
    : {
      title: 'Pipeline Analytics Cockpit',
      subtitle: 'Quality, semantics, DTW, and prototype clusters in one dense view',
      showingRows: 'Current rows',
      total: 'Total',
      failed: 'Failed',
      annotated: 'Annotated',
      propagated: 'Propagated',
      clusters: 'Clusters',
      toolbar: 'Filters and export',
      qualitySection: 'Quality',
      semanticSection: 'Semantic / DTW',
      coverageSection: 'Coverage / Prototype',
      stackedCharts: 'Stacked analytics cards',
      timeline: 'Episode Quality Timeline',
      timelineDesc: 'Consecutive low-score ranges stand out',
      validatorHeatmap: 'Validator × Episode Heatmap',
      validatorDesc: 'Red means failed, darker green means higher passed score',
      missingMatrix: 'Missing Item Matrix',
      missingDesc: 'Metadata, videos, task description, and schema presence',
      dtwHistogram: 'DTW Delay Distribution',
      dtwDesc: 'Switch start, end, and duration delta',
      semanticTimeline: 'Semantic Span Timeline',
      semanticTimelineDesc: 'Semantic span windows per episode',
      labelBars: 'Semantic Label Distribution',
      labelBarsDesc: 'Counts label first, then text/category',
      coverage: 'Manual Annotation vs Propagation',
      coverageDesc: 'Propagation takes priority over manual annotation',
      prototype: 'Prototype Cluster Chart',
      prototypeDesc: 'Member count, anchor, and distance summary',
      scatter: 'Quality Score vs DTW Delay',
      scatterDesc: 'Find low-quality episodes with abnormal delay',
      empty: 'No drawable data yet',
      tableTitle: 'Result Details',
      tableDesc: 'Hover or click an episode to inspect quality, DTW, and semantics',
      semanticTextColumn: 'Semantic Text',
      dtwColumn: 'DTW Delay',
      supplementLegend: '* marks task descriptions supplemented from semantic alignment text',
      qualityPanelTabs: [
        { key: 'timeline' as const, label: 'Timeline' },
        { key: 'validators' as const, label: 'Validators' },
        { key: 'missing' as const, label: 'Missing' },
      ],
    }

  function toggleEpisodeSelection(episodeIndex: number) {
    setSelectedEpisodeIds((current) =>
      current.includes(episodeIndex)
        ? current.filter((value) => value !== episodeIndex)
        : [...current, episodeIndex],
    )
  }

  function selectFilteredRows() {
    setSelectedEpisodeIds((current) => {
      const next = new Set(current)
      filteredRows.forEach((row) => next.add(row.episode_index))
      return Array.from(next).sort((left, right) => left - right)
    })
  }

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      const visibleIds = new Set(filteredRows.map((row) => row.episode_index))
      setSelectedEpisodeIds((current) => current.filter((id) => !visibleIds.has(id)))
      return
    }
    selectFilteredRows()
  }

  function clearSelection() {
    setSelectedEpisodeIds([])
  }

  function exportCsv() {
    if (!exportRows.length) return
    const headers = Object.keys(exportRows[0])
    const csv = [
      headers.join(','),
      ...exportRows.map((row) =>
        headers.map((header) => escapeCsvValue(row[header as keyof typeof row])).join(','),
      ),
    ].join('\n')
    const baseName = datasetInfo?.label || selectedDataset || 'pipeline-overview'
    downloadBlob(csv, `${baseName}-pipeline-overview.csv`, 'text/csv;charset=utf-8;')
  }

  function exportJson() {
    if (!exportRows.length) return
    const baseName = datasetInfo?.label || selectedDataset || 'pipeline-overview'
    downloadBlob(
      JSON.stringify(exportRows, null, 2),
      `${baseName}-pipeline-overview.json`,
      'application/json;charset=utf-8;',
    )
  }

  return (
    <div className="page-enter quality-view pipeline-page pipeline-compact-shell pipeline-data-overview">
      {selectedDataset && datasetInfo ? (
        <div className="workflow-view__info-bar">
          <span>{datasetInfo.label}</span>
          <span>{datasetInfo.stats.total_episodes} {t('episodes')}</span>
          <span>{datasetInfo.stats.fps} fps</span>
          <span>{datasetInfo.stats.robot_type}</span>
        </div>
      ) : (
        <GlassPanel className="quality-view__empty">{t('noWorkflowDataset')}</GlassPanel>
      )}

      <div className="pipeline-page-title">
        <div>
          <h2>{overviewCopy.title}</h2>
          <p>{overviewCopy.subtitle}</p>
        </div>
        <span>{overviewCopy.showingRows}: {filteredRows.length} / {rows.length}</span>
      </div>

      <div className="pipeline-metric-strip">
        <div className="pipeline-mini-metric">
          <span>{overviewCopy.total}</span>
          <strong>{formatCompactNumber(alignmentOverview?.summary.total_checked ?? rows.length)}</strong>
        </div>
        <div className="pipeline-mini-metric is-fail">
          <span>{overviewCopy.failed}</span>
          <strong>{formatCompactNumber(alignmentOverview?.summary.failed_count ?? 0)}</strong>
        </div>
        <div className="pipeline-mini-metric">
          <span>{overviewCopy.annotated}</span>
          <strong>{formatCompactNumber(alignmentOverview?.summary.annotated_count ?? 0)}</strong>
        </div>
        <div className="pipeline-mini-metric">
          <span>{overviewCopy.propagated}</span>
          <strong>{formatCompactNumber(alignmentOverview?.summary.propagated_count ?? 0)}</strong>
        </div>
        <div className="pipeline-mini-metric">
          <span>{overviewCopy.clusters}</span>
          <strong>{formatCompactNumber(clusterCount)}</strong>
        </div>
      </div>

      <div className="pipeline-toolbar" aria-label={overviewCopy.toolbar}>
        <label>
          <span>{t('qualityValidation')}</span>
          <select
            className="dataset-selector__select"
            value={qualityFilter}
            onChange={(event) => setQualityFilter(event.target.value as 'all' | 'passed' | 'failed')}
          >
            <option value="all">{t('allValidated')}</option>
            <option value="passed">{t('passedEpisodes')}</option>
            <option value="failed">{t('failedEpisodes')}</option>
          </select>
        </label>
        <label>
          <span>{t('textAlignment')}</span>
          <select
            className="dataset-selector__select"
            value={alignmentFilter}
            onChange={(event) =>
              setAlignmentFilter(
                event.target.value as 'all' | 'not_started' | 'annotated' | 'propagated',
              )
            }
          >
            <option value="all">{t('allAlignmentStates')}</option>
            <option value="not_started">{t('alignmentNotStarted')}</option>
            <option value="annotated">{t('alignmentAnnotated')}</option>
            <option value="propagated">{t('alignmentPropagated')}</option>
          </select>
        </label>
        <ActionButton variant="secondary" onClick={selectFilteredRows} disabled={!filteredRows.length}>
          {t('selectFiltered')}
        </ActionButton>
        <ActionButton variant="secondary" onClick={clearSelection} disabled={!selectedEpisodeIds.length}>
          {t('clearSelection')}
        </ActionButton>
        <ActionButton variant="secondary" onClick={exportCsv} disabled={!exportRows.length}>
          {t('exportCsv')}
        </ActionButton>
        <ActionButton variant="secondary" onClick={exportJson} disabled={!exportRows.length}>
          {t('exportJson')}
        </ActionButton>
        <div className="pipeline-toolbar__hint">
          {visibleSelectedRows.length > 0 ? t('exportSelectedHint') : t('exportFilteredHint')}
        </div>
      </div>

      <section className="pipeline-stacked-charts" aria-label={overviewCopy.stackedCharts}>
        <div className="pipeline-stack-card">
          <div className="pipeline-stack-card__head">
            <div>
              <h3>{overviewCopy.qualitySection}</h3>
              <p>
                {activeQualityPanel === 'timeline'
                  ? overviewCopy.timelineDesc
                  : activeQualityPanel === 'validators'
                    ? overviewCopy.validatorDesc
                    : overviewCopy.missingDesc}
              </p>
            </div>
            <div className="pipeline-segmented-control" role="tablist" aria-label={overviewCopy.qualitySection}>
              {overviewCopy.qualityPanelTabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={activeQualityPanel === item.key}
                  className={cn(activeQualityPanel === item.key && 'is-active')}
                  onClick={() => setActiveQualityPanel(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
          <div className="pipeline-stack-card__body">
            {activeQualityPanel === 'timeline' && (
              <PipelineChartPanel
                title={overviewCopy.timeline}
                subtitle={overviewCopy.timelineDesc}
                className="pipeline-chart-card--stacked-active"
              >
                <QualityTimelineChart
                  rows={filteredRows}
                  emptyLabel={overviewCopy.empty}
                  inspectHandlers={inspectHandlers}
                />
              </PipelineChartPanel>
            )}
            {activeQualityPanel === 'validators' && (
              <PipelineChartPanel
                title={overviewCopy.validatorHeatmap}
                subtitle={overviewCopy.validatorDesc}
                className="pipeline-chart-card--stacked-active pipeline-chart-card--matrix"
              >
                <ValidatorHeatmap
                  rows={filteredRows}
                  locale={locale}
                  emptyLabel={overviewCopy.empty}
                  inspectHandlers={inspectHandlers}
                />
              </PipelineChartPanel>
            )}
            {activeQualityPanel === 'missing' && (
              <PipelineChartPanel
                title={overviewCopy.missingMatrix}
                subtitle={overviewCopy.missingDesc}
                className="pipeline-chart-card--stacked-active pipeline-chart-card--matrix"
              >
                <MissingMatrix
                  rows={filteredRows}
                  locale={locale}
                  emptyLabel={overviewCopy.empty}
                  inspectHandlers={inspectHandlers}
                />
              </PipelineChartPanel>
            )}
          </div>
        </div>

        <div className="pipeline-stack-card">
          <div className="pipeline-stack-card__head">
            <div>
              <h3>{overviewCopy.semanticSection}</h3>
              <p>{overviewCopy.semanticTimelineDesc}</p>
            </div>
          </div>
          <div className="pipeline-stack-card__grid pipeline-stack-card__grid--semantic">
            <PipelineChartPanel
              title={overviewCopy.dtwHistogram}
              subtitle={overviewCopy.dtwDesc}
              className="pipeline-chart-card--flat"
            >
              <DtwDelayHistogram rows={filteredRows} locale={locale} emptyLabel={overviewCopy.empty} />
            </PipelineChartPanel>
            <PipelineChartPanel
              title={overviewCopy.semanticTimeline}
              subtitle={overviewCopy.semanticTimelineDesc}
              className="pipeline-chart-card--flat pipeline-chart-card--wide"
            >
              <SemanticSpanTimeline
                rows={filteredRows}
                locale={locale}
                emptyLabel={overviewCopy.empty}
                inspectHandlers={inspectHandlers}
              />
            </PipelineChartPanel>
            <PipelineChartPanel
              title={overviewCopy.labelBars}
              subtitle={overviewCopy.labelBarsDesc}
              className="pipeline-chart-card--flat"
            >
              <SemanticLabelBars rows={filteredRows} locale={locale} emptyLabel={overviewCopy.empty} />
            </PipelineChartPanel>
          </div>
        </div>

        <div className="pipeline-stack-card">
          <div className="pipeline-stack-card__head">
            <div>
              <h3>{overviewCopy.coverageSection}</h3>
              <p>{overviewCopy.coverageDesc}</p>
            </div>
          </div>
          <div className="pipeline-stack-card__grid">
            <PipelineChartPanel
              title={overviewCopy.coverage}
              subtitle={overviewCopy.coverageDesc}
              className="pipeline-chart-card--flat"
            >
              <CoverageStackedBar rows={filteredRows} locale={locale} emptyLabel={overviewCopy.empty} />
            </PipelineChartPanel>
            <PipelineChartPanel
              title={overviewCopy.prototype}
              subtitle={overviewCopy.prototypeDesc}
              className="pipeline-chart-card--flat"
            >
              <PrototypeClusterChart
                clusters={prototypeResults?.clusters || []}
                emptyLabel={overviewCopy.empty}
                inspectHandlers={inspectHandlers}
              />
            </PipelineChartPanel>
            <PipelineChartPanel
              title={overviewCopy.scatter}
              subtitle={overviewCopy.scatterDesc}
              className="pipeline-chart-card--flat"
            >
              <QualityDtwScatter
                rows={filteredRows}
                emptyLabel={overviewCopy.empty}
                inspectHandlers={inspectHandlers}
              />
            </PipelineChartPanel>
          </div>
        </div>
      </section>

      <GlassPanel className="quality-results-card pipeline-overview-table-card">
        <div className="quality-results-card__head">
          <div>
            <h3>{overviewCopy.tableTitle}</h3>
            <p>
              {overviewCopy.tableDesc} · {filteredRows.length} / {rows.length} rows
            </p>
          </div>
          <div className="quality-results-card__filters">
            <span className="quality-sidebar__path">{overviewCopy.supplementLegend}</span>
            <span className="quality-sidebar__path">{t('selectedRows')}: {selectedEpisodeIds.length}</span>
            <span className="quality-sidebar__path">{t('exportRows')}: {exportRows.length}</span>
          </div>
        </div>

        <div className="quality-table-wrap quality-results-table-wrap">
          <table className="quality-table">
            <thead>
              <tr>
                <th className="quality-table__checkbox-cell">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    aria-label={t('selectFiltered')}
                  />
                </th>
                <th>Episode</th>
                <th>{t('taskDesc')}</th>
                <th>{t('qualityValidation')}</th>
                <th>{t('score')}</th>
                <th>{t('validators')}</th>
                <th>{t('textAlignment')}</th>
                <th>{overviewCopy.semanticTextColumn}</th>
                <th>{overviewCopy.dtwColumn}</th>
                <th>{t('annotation')}</th>
                <th>{t('runPropagation')}</th>
                <th>{t('updatedAt')}</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => {
                const selected = selectedEpisodeIds.includes(row.episode_index)
                return (
                  <tr
                    key={row.episode_index}
                    data-overview-inspect-trigger="true"
                    className={cn(
                      'quality-result-row',
                      'overview-result-row',
                      selected && 'quality-table__row--selected',
                      inspectedEpisodeId === row.episode_index && 'is-inspected',
                    )}
                    tabIndex={0}
                    onClick={() => commitInspectEpisode(row.episode_index)}
                    onPointerEnter={() => previewInspectEpisode(row.episode_index)}
                    onPointerLeave={scheduleInspectorClose}
                    onFocus={() => previewInspectEpisode(row.episode_index)}
                    onBlur={scheduleInspectorClose}
                  >
                    <td className="quality-table__checkbox-cell">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleEpisodeSelection(row.episode_index)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`${t('selectedRows')} ${row.episode_index}`}
                      />
                    </td>
                    <td>{row.episode_index}</td>
                    <td>
                      <TaskDescriptionCell row={row} locale={locale} emptyLabel={t('untitledTask')} />
                    </td>
                    <td className={cn(row.quality_passed ? 'is-pass' : 'is-fail')}>
                      {row.quality_passed ? t('passed') : t('failed')}
                    </td>
                    <td>{row.quality_score.toFixed(1)}</td>
                    <td>{row.failed_validators.join(', ') || '-'}</td>
                    <td>{t(alignmentStatusKey(row.alignment_status))}</td>
                    <td><SemanticTextCell row={row} locale={locale} /></td>
                    <td><DtwDelayCell row={row} locale={locale} /></td>
                    <td>{row.annotation_count}</td>
                    <td>{row.propagated_count}</td>
                    <td>{row.updated_at || '-'}</td>
                  </tr>
                )
              })}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={12} className="quality-table__empty">No results</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </GlassPanel>
      {inspectedRow && (
        <OverviewRowDetailPopover
          row={inspectedRow}
          locale={locale}
          workspace={inspectedWorkspace}
          workspaceLoading={inspectedWorkspaceLoading}
          workspaceError={inspectedWorkspaceError}
          onClose={closeInspector}
          onInspectorEnter={cancelInspectorClose}
          onInspectorLeave={scheduleInspectorClose}
        />
      )}

    </div>
  )
}
