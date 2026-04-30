import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '@/i18n'
import {
  buildExplorerQuery,
  buildExplorerRefKey,
  listExplorerDatasets,
  searchDatasetSuggestions,
  useExplorer,
  type DatasetSuggestion,
  type EpisodeDetail,
  type ExplorerDatasetRef,
  type ExplorerPageState,
  type ExplorerSource,
} from '@/domains/datasets/explorer/store/useExplorerStore'
import { useWorkflow } from '@/domains/curation/store/useCurationStore'
import { ActionButton, GlassPanel } from '@/shared/ui'
import { formatClipWindowLabel } from './datasetExplorerPlayback'
import { DatasetInsightStack } from '@/domains/datasets/explorer/components/DatasetInsightStack'
import { FeatureStatsTable, ModalityChips, TypeDistribution } from '../components/ExplorerSummaryBlocks'
import { EpisodePlaybackSurface } from '../components/EpisodePlaybackSurface'

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Episode browser
// ---------------------------------------------------------------------------

function EpisodeHoverPreview({
  detail,
  loading,
  error,
  playVideo,
  videoCurrentTime,
  onVideoTimeUpdate,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  detail: EpisodeDetail | null
  loading: boolean
  error: string
  playVideo: boolean
  videoCurrentTime: number
  onVideoTimeUpdate: (seconds: number) => void
  onClose: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}) {
  return createPortal(
    <div className="explorer-hover-preview" onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="explorer-hover-preview__dialog">
        <button
          type="button"
          className="explorer-hover-preview__close"
          onClick={onClose}
          aria-label="Close preview"
        >
          ×
        </button>

        {!detail && loading && (
          <div className="explorer-hover-preview__empty">Loading preview...</div>
        )}

        {!detail && error && (
          <div className="explorer-hover-preview__empty explorer-hover-preview__empty--error">
            {error}
          </div>
        )}

        {detail && (
          <>
            <div className="explorer-hover-preview__header">
              <h3>Episode #{detail.episode_index}</h3>
              <div className="explorer-hover-preview__meta">
                <span>{detail.summary.row_count} frames</span>
                <span>{detail.summary.duration_s}s</span>
                <span>{detail.summary.fps} fps</span>
                <span>{detail.summary.video_count} videos</span>
              </div>
            </div>

            <EpisodePlaybackSurface
              detail={detail}
              playVideo={playVideo}
              videoCurrentTime={videoCurrentTime}
              onVideoTimeUpdate={onVideoTimeUpdate}
              emptyLabel="No video stream available for this episode."
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function EpisodeBrowser({ datasetRef }: { datasetRef: ExplorerDatasetRef }) {
  const { t } = useI18n()
  const {
    episodePage,
    episodePageLoading,
    episodePageError,
    loadEpisodePage,
    selectedEpisodeIndex,
    selectEpisode,
    episodeDetail,
    episodeLoading,
    episodeError,
    clearEpisode,
  } = useExplorer()
  const episodes = episodePage?.episodes ?? []
  const selectedDataset = episodePage?.dataset ?? ''
  const hoverTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const requestTokenRef = useRef(0)
  const previewCacheRef = useRef<Map<number, EpisodeDetail>>(new Map())
  const [hoveredEpisodeIndex, setHoveredEpisodeIndex] = useState<number | null>(null)
  const [hoveredPreview, setHoveredPreview] = useState<EpisodeDetail | null>(null)
  const [hoveredPreviewLoading, setHoveredPreviewLoading] = useState(false)
  const [hoveredPreviewError, setHoveredPreviewError] = useState('')
  const [previewPlayReady, setPreviewPlayReady] = useState(false)
  const [previewVideoCurrentTime, setPreviewVideoCurrentTime] = useState(0)
  const [detailVideoCurrentTime, setDetailVideoCurrentTime] = useState(0)

  useEffect(() => {
    previewCacheRef.current.clear()
    setHoveredEpisodeIndex(null)
    setHoveredPreview(null)
    setHoveredPreviewLoading(false)
    setHoveredPreviewError('')
    setPreviewPlayReady(false)
    setPreviewVideoCurrentTime(0)
    setDetailVideoCurrentTime(0)
  }, [selectedDataset, datasetRef.path, datasetRef.source])

  useEffect(() => {
    setDetailVideoCurrentTime(0)
  }, [episodeDetail?.episode_index])

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) {
        window.clearTimeout(hoverTimerRef.current)
      }
      if (closeTimerRef.current) {
        window.clearTimeout(closeTimerRef.current)
      }
    }
  }, [])

  if (episodePageLoading && !episodePage) {
    return <div className="explorer-empty">{t('running')}...</div>
  }

  if (episodePageError && !episodePageLoading) {
    return <div className="explorer-empty quality-sidebar__error">{episodePageError}</div>
  }

  if (episodes.length === 0) {
    return <div className="explorer-empty">{t('noDatasets')}</div>
  }

  const pageStart = (episodePage!.page - 1) * episodePage!.page_size + 1
  const pageStop = pageStart + episodes.length - 1

  const previewVisible = hoveredEpisodeIndex !== null

  const cancelClosePreview = () => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  const scheduleClosePreview = () => {
    cancelClosePreview()
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    closeTimerRef.current = window.setTimeout(() => {
      setHoveredEpisodeIndex(null)
      setHoveredPreview(null)
      setHoveredPreviewLoading(false)
      setHoveredPreviewError('')
      setPreviewPlayReady(false)
      setPreviewVideoCurrentTime(0)
    }, 180)
  }

  const scheduleHoverPreview = (episodeIndex: number) => {
    cancelClosePreview()
    if (hoverTimerRef.current) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
    setHoveredPreviewError('')
    setPreviewPlayReady(false)
    setPreviewVideoCurrentTime(0)

    hoverTimerRef.current = window.setTimeout(async () => {
      setHoveredEpisodeIndex(episodeIndex)
      setPreviewPlayReady(true)

      const cached = previewCacheRef.current.get(episodeIndex)
      if (cached) {
        setHoveredPreview(cached)
        setHoveredPreviewLoading(false)
        return
      }

      setHoveredPreview(null)
      setHoveredPreviewLoading(true)

      const requestToken = ++requestTokenRef.current
      try {
        const response = await fetch(
          `/api/explorer/episode?${buildExplorerQuery(datasetRef)}&episode_index=${episodeIndex}&preview=true`,
        )
        if (!response.ok) {
          throw new Error(`Failed to load episode preview (${response.status})`)
        }
        const detail: EpisodeDetail = await response.json()
        previewCacheRef.current.set(episodeIndex, detail)
        if (previewCacheRef.current.size > 20) {
          const oldestEpisodeIndex = previewCacheRef.current.keys().next().value
          if (oldestEpisodeIndex !== undefined) {
            previewCacheRef.current.delete(oldestEpisodeIndex)
          }
        }
        if (requestToken === requestTokenRef.current) {
          setHoveredPreview(detail)
        }
      } catch (error) {
        if (requestToken === requestTokenRef.current) {
          setHoveredPreviewError(error instanceof Error ? error.message : 'Failed to load preview')
        }
      } finally {
        if (requestToken === requestTokenRef.current) {
          setHoveredPreviewLoading(false)
        }
      }
    }, 500)
  }

  return (
    <div className="explorer-episodes">
      <div className="explorer-episodes__toolbar">
        <div className="explorer-episodes__summary">
          <span>{episodePage!.total_episodes} {t('episodes')}</span>
          <span>{pageStart}-{pageStop}</span>
          <span>{episodePage!.page}/{episodePage!.total_pages}</span>
        </div>
        <div className="explorer-episodes__pagination">
          <button
            type="button"
            className="explorer-episodes__pager"
            disabled={episodePage!.page <= 1 || episodePageLoading}
            onClick={() => void loadEpisodePage(datasetRef, episodePage!.page - 1, episodePage!.page_size)}
          >
            Prev
          </button>
          <button
            type="button"
            className="explorer-episodes__pager"
            disabled={episodePage!.page >= episodePage!.total_pages || episodePageLoading}
            onClick={() => void loadEpisodePage(datasetRef, episodePage!.page + 1, episodePage!.page_size)}
          >
            Next
          </button>
        </div>
      </div>

      <div className="explorer-episodes__list">
        {episodes.map((ep) => (
          <button
            key={ep.episode_index}
            type="button"
            className={cn(
              'explorer-episode-item',
              selectedEpisodeIndex === ep.episode_index && 'is-selected',
            )}
            onClick={() => {
              if (selectedEpisodeIndex === ep.episode_index) {
                clearEpisode()
              } else {
                void selectEpisode(datasetRef, ep.episode_index)
              }
            }}
            onMouseEnter={() => scheduleHoverPreview(ep.episode_index)}
            onMouseLeave={scheduleClosePreview}
          >
            <span className="explorer-episode-item__idx">#{ep.episode_index}</span>
            <span className="explorer-episode-item__len">{ep.length} frames</span>
          </button>
        ))}
      </div>

      {previewVisible && (
        <EpisodeHoverPreview
          detail={hoveredPreview}
          loading={hoveredPreviewLoading}
          error={hoveredPreviewError}
          onClose={() => {
            setHoveredEpisodeIndex(null)
            setHoveredPreview(null)
            setHoveredPreviewLoading(false)
            setHoveredPreviewError('')
            setPreviewPlayReady(false)
            setPreviewVideoCurrentTime(0)
          }}
          playVideo={previewPlayReady}
          videoCurrentTime={previewVideoCurrentTime}
          onVideoTimeUpdate={setPreviewVideoCurrentTime}
          onMouseEnter={cancelClosePreview}
          onMouseLeave={scheduleClosePreview}
        />
      )}

      {episodeLoading && (
        <div className="explorer-episode-detail">
          <p>{t('running')}...</p>
        </div>
      )}

      {episodeError && !episodeLoading && (
        <div className="explorer-episode-detail">
          <p className="quality-sidebar__error">{episodeError}</p>
        </div>
      )}

      {episodeDetail && !episodeLoading && !episodeError && (
        <div className="explorer-episode-detail">
          <div className="explorer-episode-detail__summary">
            <span>{episodeDetail.summary.row_count} rows</span>
            <span>{episodeDetail.summary.duration_s}s</span>
            <span>{episodeDetail.summary.fps} fps</span>
            <span>{episodeDetail.summary.video_count} videos</span>
          </div>

          {episodeDetail.videos.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>Playback</h4>
              <EpisodePlaybackSurface
                detail={episodeDetail}
                playVideo
                videoCurrentTime={detailVideoCurrentTime}
                onVideoTimeUpdate={setDetailVideoCurrentTime}
                emptyLabel="No video stream available for this episode."
              />
            </div>
          )}

          {episodeDetail.videos.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>Video Sources</h4>
              <ul className="explorer-video-list">
                {episodeDetail.videos.map((v) => (
                  <li key={v.path}>
                    <strong>{v.stream}</strong> — {v.path}
                    {formatClipWindowLabel(v) ? ` (${formatClipWindowLabel(v)})` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {episodeDetail.sample_rows.length > 0 && (
            <div className="explorer-episode-detail__section">
              <h4>{t('sampleRows')}</h4>
              <div className="quality-table-wrap">
                <table className="quality-table explorer-sample-table">
                  <thead>
                    <tr>
                      {Object.keys(episodeDetail.sample_rows[0]).map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {episodeDetail.sample_rows.map((row, idx) => (
                      <tr key={idx}>
                        {Object.values(row).map((val, ci) => (
                          <td key={ci}>
                            {Array.isArray(val)
                              ? `[${val.join(', ')}]`
                              : val == null
                                ? '-'
                                : typeof val === 'number'
                                  ? val.toFixed(4)
                                  : String(val)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export default function DatasetExplorerView() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const {
    prepareRemoteDatasetForWorkflow,
    createLocalDirectorySession,
    selectDataset,
  } = useWorkflow()
  const {
    summary,
    summaryRefKey,
    summaryLoading,
    summaryError,
    dashboard,
    dashboardRefKey,
    dashboardLoading,
    dashboardError,
    episodePage,
    episodePageRefKey,
    source,
    datasetIdInput,
    remoteDatasetSelected,
    localDatasetInput,
    localDatasetPathInput,
    localDatasetPathSelected,
    localPathDatasetLabel,
    prepareStatus,
    prepareError,
    preparingForQuality,
    activeDatasetRef,
    setPageState,
    setActiveDatasetRef,
    loadSummary,
    loadDashboard,
    loadEpisodePage,
  } = useExplorer()
  const [localDatasets, setLocalDatasets] = useState<DatasetSuggestion[]>([])
  const [datasetSuggestions, setDatasetSuggestions] = useState<DatasetSuggestion[]>([])
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [suggestionsLoading, setSuggestionsLoading] = useState(false)
  const [highlightedSuggestionIndex, setHighlightedSuggestionIndex] = useState(-1)
  const datasetInputRef = useRef<HTMLInputElement | null>(null)
  const localDirectoryInputRef = useRef<HTMLInputElement | null>(null)
  const blurTimerRef = useRef<number | null>(null)
  const suggestionRequestRef = useRef(0)
  const requestedDatasetKeyRef = useRef('')
  const preparingForQualityRef = useRef(false)
  const activeRefForSource = activeDatasetRef?.source === source ? activeDatasetRef : null
  const activeRefKey = buildExplorerRefKey(activeRefForSource)
  const summaryMatchesActiveRef = Boolean(activeRefKey && summaryRefKey === activeRefKey)
  const dashboardMatchesActiveRef = Boolean(activeRefKey && dashboardRefKey === activeRefKey)
  const summaryForSource = summaryMatchesActiveRef ? summary : null
  const summaryLoadingForSource = summaryMatchesActiveRef && summaryLoading
  const summaryErrorForSource = summaryMatchesActiveRef ? summaryError : ''
  const dashboardForSource = dashboardMatchesActiveRef ? dashboard : null
  const dashboardLoadingForSource = dashboardMatchesActiveRef && dashboardLoading
  const dashboardErrorForSource = dashboardMatchesActiveRef ? dashboardError : ''
  const episodePageForSource = activeRefKey && episodePageRefKey.startsWith(`${activeRefKey}|`)
    ? episodePage
    : null
  const currentDataset =
    summaryForSource?.dataset || dashboardForSource?.dataset || episodePageForSource?.dataset || ''

  const datasetRef: ExplorerDatasetRef =
    source === 'remote'
      ? { source, dataset: remoteDatasetSelected.trim() || undefined }
      : source === 'local'
        ? { source, dataset: localDatasetInput.trim() || undefined }
        : {
            source,
            dataset: localPathDatasetLabel.trim() || undefined,
            path: localDatasetPathSelected.trim() || undefined,
          }

  async function loadDataset(ref: ExplorerDatasetRef): Promise<void> {
    const requestKey = buildExplorerRefKey(ref)
    requestedDatasetKeyRef.current = requestKey
    setActiveDatasetRef(ref)
    await Promise.allSettled([
      loadSummary(ref),
      loadDashboard(ref),
      loadEpisodePage(ref, 1, 50),
    ])
  }

  useEffect(() => {
    if (source !== 'local') {
      return
    }
    void listExplorerDatasets('local')
      .then((items) => setLocalDatasets(items))
      .catch(() => setLocalDatasets([]))
  }, [source])

  useEffect(() => {
    const activeDataset = datasetRef.dataset?.trim() ?? ''
    const activePath = datasetRef.path?.trim() ?? ''
    const requestKey = buildExplorerRefKey(datasetRef)
    if (!activeDataset && !activePath) {
      return
    }
    const loadedKey = buildExplorerRefKey(activeDatasetRef)
    const hasLoadedActiveDataset =
      loadedKey === requestKey
      && Boolean(summaryForSource || dashboardForSource || episodePageForSource)
    if (requestedDatasetKeyRef.current === requestKey || hasLoadedActiveDataset) {
      return
    }
    void loadDataset(datasetRef)
  }, [
    source,
    remoteDatasetSelected,
    localDatasetInput,
    localDatasetPathSelected,
    localPathDatasetLabel,
    activeDatasetRef,
    summaryForSource,
    dashboardForSource,
    episodePageForSource,
    loadSummary,
    loadDashboard,
    loadEpisodePage,
  ])

  useEffect(() => {
    return () => {
      if (blurTimerRef.current != null) {
        window.clearTimeout(blurTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (source !== 'remote') {
      setDatasetSuggestions([])
      setSuggestionsLoading(false)
      setSuggestionsOpen(false)
      setHighlightedSuggestionIndex(-1)
      return
    }
    const needle = datasetIdInput.trim()
    if (needle.length < 2 || needle === currentDataset.trim()) {
      suggestionRequestRef.current += 1
      setDatasetSuggestions([])
      setSuggestionsLoading(false)
      setSuggestionsOpen(false)
      setHighlightedSuggestionIndex(-1)
      return
    }

    const requestId = suggestionRequestRef.current + 1
    suggestionRequestRef.current = requestId
    setSuggestionsLoading(true)
    const timer = window.setTimeout(() => {
      void searchDatasetSuggestions(needle, source, 8)
        .then((items) => {
          if (suggestionRequestRef.current !== requestId) return
          setDatasetSuggestions(items)
          setHighlightedSuggestionIndex(items.length > 0 ? 0 : -1)
          if (document.activeElement === datasetInputRef.current) {
            setSuggestionsOpen(true)
          }
        })
        .catch(() => {
          if (suggestionRequestRef.current !== requestId) return
          setDatasetSuggestions([])
          setHighlightedSuggestionIndex(-1)
        })
        .finally(() => {
          if (suggestionRequestRef.current === requestId) {
            setSuggestionsLoading(false)
          }
        })
    }, 180)

    return () => {
      window.clearTimeout(timer)
    }
  }, [datasetIdInput, currentDataset, source])

  function openSuggestions(): void {
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    if (datasetIdInput.trim().length >= 2) {
      setSuggestionsOpen(true)
    }
  }

  function closeSuggestionsSoon(): void {
    if (blurTimerRef.current != null) {
      window.clearTimeout(blurTimerRef.current)
    }
    blurTimerRef.current = window.setTimeout(() => {
      setSuggestionsOpen(false)
    }, 120)
  }

  function markExplorerDraft(nextSource: ExplorerSource): void {
    requestedDatasetKeyRef.current = ''
    if (activeDatasetRef?.source === nextSource) {
      setActiveDatasetRef(null)
    }
  }

  async function handleLoad(
    override?: Partial<ExplorerDatasetRef> & { datasetOverride?: string },
  ): Promise<void> {
    const nextSource = override?.source ?? source
    const nextDataset =
      override?.datasetOverride
      ?? override?.dataset
      ?? (nextSource === 'remote'
        ? datasetIdInput
        : nextSource === 'local'
          ? localDatasetInput
          : currentDataset)
    const nextPath = override?.path ?? (nextSource === 'path' ? localDatasetPathInput : undefined)
    const nextRef: ExplorerDatasetRef = {
      source: nextSource,
      dataset: nextDataset?.trim() || undefined,
      path: nextPath?.trim() || undefined,
    }
    if (!nextRef.dataset && !nextRef.path) {
      return
    }
    setPageState({ prepareStatus: '', prepareError: '' })
    if (nextSource === 'remote' && nextRef.dataset) {
      setPageState({
        datasetIdInput: nextRef.dataset,
        remoteDatasetSelected: nextRef.dataset,
      })
    }
    if (nextSource === 'local' && nextRef.dataset) {
      setPageState({ localDatasetInput: nextRef.dataset })
    }
    if (nextSource === 'path' && nextRef.path) {
      setPageState({
        localDatasetPathInput: nextRef.path,
        localDatasetPathSelected: nextRef.path,
        localPathDatasetLabel: nextRef.dataset ?? '',
      })
    }
    setSuggestionsOpen(false)
    setDatasetSuggestions([])
    setHighlightedSuggestionIndex(-1)
    await loadDataset(nextRef)
    if (nextRef.source !== 'remote' && nextRef.dataset) {
      try {
        await selectDataset(nextRef.dataset)
      } catch (error) {
        setPageState({
          prepareError: error instanceof Error ? error.message : t('qualityRunFailed'),
        })
      }
    }
  }

  async function handleSuggestionSelect(datasetId: string): Promise<void> {
    await handleLoad({ source: 'remote', datasetOverride: datasetId })
  }

  async function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): Promise<void> {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (!suggestionsOpen) openSuggestions()
      if (datasetSuggestions.length > 0) {
        setHighlightedSuggestionIndex((current) => (current + 1) % datasetSuggestions.length)
      }
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (!suggestionsOpen) openSuggestions()
      if (datasetSuggestions.length > 0) {
        setHighlightedSuggestionIndex((current) =>
          current <= 0 ? datasetSuggestions.length - 1 : current - 1,
        )
      }
      return
    }
    if (event.key === 'Escape') {
      setSuggestionsOpen(false)
      setHighlightedSuggestionIndex(-1)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const highlighted = datasetSuggestions[highlightedSuggestionIndex]
      if (suggestionsOpen && highlighted) {
        await handleSuggestionSelect(highlighted.id)
        return
      }
      await handleLoad()
    }
  }

  async function handlePrepareRemote(): Promise<void> {
    if (preparingForQualityRef.current) return
    const datasetId = datasetIdInput.trim()
    if (!datasetId) return
    preparingForQualityRef.current = true
    setPageState({
      preparingForQuality: true,
      prepareStatus: t('preparingForQuality'),
      prepareError: '',
      remoteDatasetSelected: datasetId,
    })
    try {
      const payload = await prepareRemoteDatasetForWorkflow(datasetId, false)
      setPageState({ prepareStatus: `${t('preparedForQuality')}: ${payload.dataset_name}` })
      navigate('/curation/quality')
    } catch (error) {
      setPageState({ prepareError: error instanceof Error ? error.message : t('qualityRunFailed') })
    } finally {
      preparingForQualityRef.current = false
      setPageState({ preparingForQuality: false })
    }
  }

  async function handleChooseLocalDirectory(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files || [])
    if (files.length === 0) {
      return
    }
    const relativePaths = files.map((file) => {
      const maybeRelative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
      return maybeRelative && maybeRelative.trim() ? maybeRelative : file.name
    })
    const displayName = relativePaths[0]?.split('/')[0] || files[0].name
    setPageState({
      prepareStatus: t('localDirectoryUploading'),
      prepareError: '',
    })
    try {
      const payload = await createLocalDirectorySession(files, relativePaths, displayName)
      setPageState({
        localDatasetPathInput: payload.local_path,
        localDatasetPathSelected: payload.local_path,
        localPathDatasetLabel: payload.dataset_name,
        prepareStatus: payload.display_name,
      })
      await handleLoad({
        source: 'path',
        path: payload.local_path,
        datasetOverride: payload.dataset_name,
      })
      setPageState({ prepareStatus: payload.display_name })
    } catch (error) {
      setPageState({ prepareError: error instanceof Error ? error.message : t('qualityRunFailed') })
    } finally {
      event.target.value = ''
    }
  }

  const datasetSummary = summaryForSource?.summary
  const modalitiesNode = dashboardLoadingForSource && !dashboardForSource ? (
    <div className="explorer-empty">{t('running')}...</div>
  ) : dashboardForSource ? (
    <ModalityChips items={dashboardForSource.modality_summary} />
  ) : (
    <div className="explorer-empty">{dashboardErrorForSource || t('noStats')}</div>
  )
  const featureStatsNode = dashboardForSource ? (
    <>
      <p className="explorer-section__sub">
        {dashboardForSource.feature_names.length} features
        {dashboardForSource.dataset_stats.features_with_stats > 0 &&
          ` / ${dashboardForSource.dataset_stats.features_with_stats} with stats`}
      </p>
      <FeatureStatsTable stats={dashboardForSource.feature_stats} />
    </>
  ) : (
    <div className="explorer-empty">
      {dashboardLoadingForSource ? t('running') : (dashboardErrorForSource || t('noStats'))}
    </div>
  )
  const typeDistributionNode = dashboardForSource ? (
    <TypeDistribution items={dashboardForSource.feature_type_distribution} />
  ) : (
    <div className="explorer-empty">
      {dashboardLoadingForSource ? t('running') : (dashboardErrorForSource || t('noStats'))}
    </div>
  )

  return (
    <div className="page-enter quality-view">
      <div className="quality-view__hero">
        <div>
          <h2 className="quality-view__title">{t('explorerTitle')}</h2>
          <p className="quality-view__desc">{t('explorerDesc')}</p>
        </div>
      </div>

      <div className="dataset-workbench">
        <div className="dataset-workbench__controls">
          <label className="dataset-workbench__control">
            <span>{t('dataSource')}</span>
            <select
              className="dataset-workbench__select"
              value={source}
              onChange={(event) => {
                const nextSource = event.target.value as ExplorerSource
                setPageState({ source: nextSource })
                setDatasetSuggestions([])
                setSuggestionsOpen(false)
                setHighlightedSuggestionIndex(-1)
                requestedDatasetKeyRef.current = ''
              }}
            >
              <option value="remote">{t('remoteDataset')}</option>
              <option value="local">{t('localDataset')}</option>
              <option value="path">{t('localDirectory')}</option>
            </select>
          </label>

          {source === 'remote' && (
          <label className="dataset-workbench__control dataset-workbench__control--wide">
            <span>{t('hfDatasetId')}</span>
            <div className="dataset-workbench__combobox">
              <input
                ref={datasetInputRef}
                className="dataset-workbench__input"
                type="text"
                value={datasetIdInput}
                onChange={(event) => {
                  const nextValue = event.target.value
                  const patch: Partial<ExplorerPageState> = {
                    datasetIdInput: nextValue,
                    remoteDatasetSelected:
                      nextValue.trim() !== remoteDatasetSelected.trim()
                        ? ''
                        : remoteDatasetSelected,
                  }
                  setPageState(patch)
                  if (nextValue.trim() !== remoteDatasetSelected.trim()) {
                    markExplorerDraft('remote')
                  }
                }}
                onFocus={openSuggestions}
                onBlur={closeSuggestionsSoon}
                onKeyDown={(event) => {
                  void handleInputKeyDown(event)
                }}
                placeholder={t('hfDatasetPlaceholder')}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={suggestionsOpen}
                aria-controls="explorer-dataset-suggestions"
                aria-activedescendant={
                  highlightedSuggestionIndex >= 0
                    ? `explorer-dataset-suggestion-${highlightedSuggestionIndex}`
                    : undefined
                }
              />
              {suggestionsOpen
                && (suggestionsLoading
                  || datasetSuggestions.length > 0
                  || datasetIdInput.trim().length >= 2) && (
                <div
                  className="dataset-workbench__suggestions"
                  id="explorer-dataset-suggestions"
                  role="listbox"
                >
                  {suggestionsLoading ? (
                    <div className="dataset-workbench__suggestion-status">
                      {t('datasetSuggestionsLoading')}
                    </div>
                  ) : datasetSuggestions.length > 0 ? (
                    datasetSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion.id}
                        id={`explorer-dataset-suggestion-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === highlightedSuggestionIndex}
                        className={cn(
                          'dataset-workbench__suggestion',
                          index === highlightedSuggestionIndex && 'is-active',
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setHighlightedSuggestionIndex(index)}
                        onClick={() => {
                          void handleSuggestionSelect(suggestion.id)
                        }}
                      >
                        {suggestion.id}
                      </button>
                    ))
                  ) : (
                    <div className="dataset-workbench__suggestion-status">
                      {t('noDatasetSuggestions')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </label>
          )}

          {source === 'local' && (
            <label className="dataset-workbench__control dataset-workbench__control--wide">
              <span>{t('localDataset')}</span>
              <select
                className="dataset-workbench__select"
                value={localDatasetInput}
                onChange={(event) => {
                  setPageState({ localDatasetInput: event.target.value })
                  markExplorerDraft('local')
                }}
              >
                <option value="">{t('selectDataset')}</option>
                {localDatasets.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label || item.id}
                  </option>
                ))}
              </select>
            </label>
          )}

          {source === 'path' && (
            <label className="dataset-workbench__control dataset-workbench__control--wide">
              <span>{t('localDirectory')}</span>
              <div className="dataset-workbench__path-row">
                <ActionButton
                  type="button"
                  variant="secondary"
                  onClick={() => localDirectoryInputRef.current?.click()}
                  className="dataset-workbench__import-btn"
                >
                  {t('chooseLocalDirectory')}
                </ActionButton>
                <input
                  className="dataset-workbench__input"
                  type="text"
                  value={localDatasetPathInput}
                  onChange={(event) => {
                    setPageState({
                      localDatasetPathInput: event.target.value,
                      localDatasetPathSelected: '',
                      localPathDatasetLabel: '',
                    })
                    markExplorerDraft('path')
                  }}
                  placeholder={t('localPathPlaceholder')}
                />
                <input
                  ref={localDirectoryInputRef}
                  type="file"
                  multiple
                  hidden
                  // @ts-expect-error vendor directory picker attribute
                  webkitdirectory=""
                  onChange={(event) => {
                    void handleChooseLocalDirectory(event)
                  }}
                />
              </div>
            </label>
          )}

          <ActionButton
            type="button"
            variant="secondary"
            onClick={() => void handleLoad()}
            disabled={
              preparingForQuality
              || (source === 'remote'
                ? !datasetIdInput.trim()
                : source === 'local'
                  ? !localDatasetInput.trim()
                  : !localDatasetPathInput.trim())
            }
            className="dataset-workbench__import-btn"
          >
            {t('browseDataset')}
          </ActionButton>

          {source === 'remote' && (
            <ActionButton
              type="button"
              variant="secondary"
              onClick={() => void handlePrepareRemote()}
              disabled={!datasetIdInput.trim() || preparingForQuality}
              className="dataset-workbench__import-btn"
            >
              {preparingForQuality ? t('preparingForQuality') : t('prepareForQuality')}
            </ActionButton>
          )}
        </div>
        {(prepareStatus || prepareError) && (
          <div className={`dataset-workbench__status ${prepareError ? 'is-error' : ''}`}>
            {prepareError || prepareStatus}
          </div>
        )}
      </div>

      {/* Info bar */}
      {currentDataset && datasetSummary ? (
        <div className="workflow-view__info-bar">
          <span>{summaryForSource!.dataset}</span>
          <span>{datasetSummary.total_episodes} {t('episodes')}</span>
          <span>{datasetSummary.fps} fps</span>
          <span>{datasetSummary.robot_type}</span>
          {datasetSummary.codebase_version && <span>{datasetSummary.codebase_version}</span>}
        </div>
      ) : summaryErrorForSource ? (
        <GlassPanel className="quality-view__empty">
          <span className="quality-sidebar__error">{summaryErrorForSource}</span>
        </GlassPanel>
      ) : !summaryLoadingForSource ? (
        <GlassPanel className="quality-view__empty">
          {source === 'remote' ? t('remoteDatasetEmpty') : t('chooseLocalDirectory')}
        </GlassPanel>
      ) : null}

      {summaryLoadingForSource && (
        <GlassPanel className="quality-view__empty">{t('running')}...</GlassPanel>
      )}

      {currentDataset && (datasetSummary || dashboardForSource || episodePageForSource) && (
        <div className="dataset-explorer-workspace">
          <div className="dataset-explorer-workspace__main">
            {datasetSummary && (
              <div className="dataset-explorer-summary-strip" aria-label="Dataset summary">
                <span>{prepareStatus || summaryForSource!.dataset}</span>
                <span>{datasetSummary.total_episodes} {t('episodes')}</span>
                <span>{datasetSummary.total_frames.toLocaleString()} frames</span>
                <span>{datasetSummary.fps} fps</span>
                {datasetSummary.robot_type && <span>{datasetSummary.robot_type}</span>}
                {dashboardForSource && (
                  <span>{dashboardForSource.files.parquet_files} parquet / {dashboardForSource.files.video_files} videos</span>
                )}
              </div>
            )}
            <DatasetInsightStack
              summary={datasetSummary}
              dashboard={dashboardForSource}
              episodePage={episodePageForSource}
              dashboardLoading={dashboardLoadingForSource}
              dashboardError={dashboardErrorForSource}
              modalitiesNode={modalitiesNode}
              featureStatsNode={featureStatsNode}
              typeDistributionNode={typeDistributionNode}
            />
          </div>
          <aside className="dataset-explorer-workspace__episodes" aria-label={t('episodeBrowser')}>
            <div className="dataset-explorer-episodes__header">
              <h3>{t('episodeBrowser')}</h3>
              {episodePageForSource && (
                <span>{episodePageForSource.total_episodes} total</span>
              )}
            </div>
            <EpisodeBrowser datasetRef={datasetRef} />
          </aside>
        </div>
      )}
    </div>
  )
}
