import { create } from 'zustand'
import type { DatasetImportJob, DatasetRef } from '@/domains/datasets/types'
import type {
  AlignmentOverview,
  AnnotationWorkspacePayload,
  LocalDirectorySessionResult,
  PropagationResults,
  PrototypeResults,
  QualityDefaults,
  QualityResults,
  RemoteWorkflowPrepareResult,
  SavedAnnotationsPayload,
  TrainingTaskApplyResult,
  WorkflowState,
  WorkflowStore,
} from './workflowTypes'
import {
  fetchJson,
  getStoredDataset,
  normalizeAlignmentSourceMode,
  normalizePropagationResults,
  normalizePrototypeResults,
  normalizeQualityFilterMode,
  normalizeQualityResults,
  persistDataset,
} from './workflowStoreHelpers'

export type {
  AlignmentOverview,
  AlignmentOverviewRow,
  AlignmentOverviewSpan,
  AlignmentSourceMode,
  AnnotationItem,
  AnnotationVideoClip,
  AnnotationWorkspacePayload,
  AnnotationWorkspaceSummary,
  JointTrajectoryEntry,
  JointTrajectoryPayload,
  LocalDirectorySessionResult,
  PropagationResultItem,
  PropagationResults,
  PropagationSpan,
  PrototypeCluster,
  PrototypeClusterMember,
  PrototypeGroupSummary,
  PrototypeResults,
  PrototypeSelectionDiagnostics,
  PrototypeSelectionEvaluation,
  QualityDefaults,
  QualityEpisodeResult,
  QualityFilterMode,
  QualityResults,
  RemoteWorkflowPrepareResult,
  SavedAnnotationsPayload,
  StageState,
  TrainingTaskApplyResult,
  WorkflowState,
  WorkflowTaskContext,
} from './workflowTypes'

const WORKFLOW_REFRESH_INTERVAL_MS = 6000

export const useWorkflow = create<WorkflowStore>((set, get) => ({
  datasets: [],
  datasetsLoading: false,
  selectedDataset: getStoredDataset(),
  datasetInfo: null,
  workflowState: null,
  selectedValidators: ['metadata', 'timing', 'action', 'visual', 'ee_trajectory'],
  alignmentSourceMode: 'quality',
  alignmentQualityFilter: 'passed',
  qualityThresholds: {
    metadata_require_info_json: 1.0,
    metadata_require_episode_metadata: 1.0,
    metadata_require_data_files: 1.0,
    metadata_require_videos: 1.0,
    metadata_require_task_description: 1.0,
    metadata_min_duration_s: 1.0,
    timing_min_monotonicity: 0.99,
    timing_max_interval_cv: 0.05,
    timing_min_frequency_hz: 20.0,
    timing_max_gap_ratio: 0.01,
    timing_min_frequency_consistency: 0.98,
    action_static_threshold: 0.001,
    action_max_all_static_s: 3.0,
    action_max_key_static_s: 5.0,
    action_max_velocity_rad_s: 3.14,
    action_min_duration_s: 1.0,
    action_max_nan_ratio: 0.01,
    visual_min_resolution_width: 640.0,
    visual_min_resolution_height: 480.0,
    visual_min_frame_rate: 20.0,
    visual_frame_rate_tolerance: 2.0,
    visual_color_shift_max: 0.10,
    visual_overexposure_ratio_max: 0.05,
    visual_underexposure_ratio_max: 0.10,
    visual_abnormal_black_ratio_max: 0.95,
    visual_abnormal_white_ratio_max: 0.95,
    visual_min_video_count: 1.0,
    visual_min_accessible_ratio: 1.0,
    depth_min_stream_count: 0.0,
    depth_min_accessible_ratio: 1.0,
    depth_invalid_pixel_max: 0.10,
    depth_continuity_min: 0.90,
    ee_min_event_count: 1.0,
    ee_min_gripper_span: 0.05,
  },
  qualityDefaults: null,
  qualityResults: null,
  qualityRunning: false,
  prototypeResults: null,
  prototypeRunning: false,
  propagationResults: null,
  alignmentOverview: null,
  datasetImportJob: null,
  selectedDatasetIsRemotePrepared: false,
  pollInterval: null,

  loadDatasets: async () => {
    set({ datasetsLoading: true })
    try {
      const datasets = await fetchJson<DatasetRef[]>('/api/curation/datasets')
      set({ datasets })
    } finally {
      set({ datasetsLoading: false })
    }
  },

  selectDataset: async (datasetId: string) => {
    persistDataset(datasetId)
    set({
      selectedDataset: datasetId,
      datasetInfo: null,
      workflowState: null,
      qualityDefaults: null,
      qualityResults: null,
      prototypeResults: null,
      propagationResults: null,
      alignmentOverview: null,
      selectedDatasetIsRemotePrepared: false,
    })
    const info = await fetchJson<DatasetRef>(
      `/api/curation/datasets/${encodeURIComponent(datasetId)}`,
    )
    set({ datasetInfo: info })
    try {
      await get().loadQualityDefaults()
    } catch (error) {
      console.warn('Failed to load quality defaults', error)
    }
    try {
      await get().refreshState()
      set({ selectedDatasetIsRemotePrepared: true })
    } catch {
      set({ workflowState: null, selectedDatasetIsRemotePrepared: false })
    }
  },

  importDatasetFromHf: async (datasetId: string, includeVideos = true) => {
    const payload = await fetchJson<DatasetImportJob>(
      '/api/curation/datasets/import-hf',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_id: datasetId,
          include_videos: includeVideos,
        }),
      },
    )

    let active = true
    while (active) {
      const job = await fetchJson<DatasetImportJob>(
        `/api/curation/datasets/import-status/${payload.job_id}`,
      )
      set({ datasetImportJob: job })
      if (job.status === 'completed') {
        await get().loadDatasets()
        if (job.imported_dataset_id) {
          persistDataset(job.imported_dataset_id)
          await get().selectDataset(job.imported_dataset_id)
        }
        active = false
      } else if (job.status === 'error') {
        throw new Error(job.message || 'Dataset import failed')
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
      }
    }
  },

  prepareRemoteDatasetForWorkflow: async (datasetId: string, includeVideos = false) => {
    const payload = await fetchJson<RemoteWorkflowPrepareResult>('/api/explorer/prepare-remote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset_id: datasetId,
        include_videos: includeVideos,
      }),
    })
    await get().loadDatasets()
    persistDataset(payload.dataset_name)
    await get().selectDataset(payload.dataset_name)
    set({ selectedDatasetIsRemotePrepared: true })
    return payload
  },

  createLocalDirectorySession: async (files, relativePaths, displayName) => {
    const form = new FormData()
    files.forEach((file) => form.append('files', file))
    relativePaths.forEach((path) => form.append('relative_paths', path))
    if (displayName) {
      form.append('display_name', displayName)
    }
    const response = await fetch('/api/explorer/local-directory-session', {
      method: 'POST',
      body: form,
    })
    if (!response.ok) {
      throw new Error(await response.text())
    }
    const payload = (await response.json()) as LocalDirectorySessionResult
    await get().loadDatasets()
    persistDataset(payload.dataset_name)
    await get().selectDataset(payload.dataset_name)
    return payload
  },

  toggleValidator: (name: string) => {
    const current = get().selectedValidators
    if (current.includes(name)) {
      set({ selectedValidators: current.filter((validator) => validator !== name) })
      return
    }
    set({ selectedValidators: [...current, name] })
  },

  setAlignmentSourceMode: (mode) => {
    set({ alignmentSourceMode: mode })
  },

  setAlignmentQualityFilter: (mode) => {
    set({ alignmentQualityFilter: mode })
  },

  setQualityThreshold: (key: string, value: number) => {
    set((state) => ({
      qualityThresholds: {
        ...state.qualityThresholds,
        [key]: value,
      },
    }))
  },

  loadQualityDefaults: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return null
    const defaults = await fetchJson<QualityDefaults>(
      `/api/curation/quality-defaults?dataset=${encodeURIComponent(selectedDataset)}`,
    )
    set((state) => ({
      qualityDefaults: defaults,
      selectedValidators:
        defaults.selected_validators.length > 0
          ? defaults.selected_validators
          : state.selectedValidators,
      qualityThresholds: {
        ...state.qualityThresholds,
        ...defaults.threshold_overrides,
      },
    }))
    return defaults
  },

  runQualityValidation: async () => {
    const { selectedDataset, selectedValidators, qualityThresholds } = get()
    if (!selectedDataset) return
    set({ qualityRunning: true })
    await fetchJson('/api/curation/quality-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: selectedDataset,
        selected_validators: selectedValidators,
        threshold_overrides: qualityThresholds,
      }),
    })
    get().startPolling()
  },

  pauseQualityValidation: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    await fetchJson('/api/curation/quality-pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: selectedDataset }),
    })
    await get().refreshState()
    get().startPolling()
  },

  resumeQualityValidation: async () => {
    const { selectedDataset, selectedValidators, qualityThresholds } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    set({ qualityRunning: true })
    await fetchJson('/api/curation/quality-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: selectedDataset,
        selected_validators: selectedValidators,
        threshold_overrides: qualityThresholds,
      }),
    })
    get().startPolling()
  },

  runPrototypeDiscovery: async (clusterCount?: number) => {
    const { selectedDataset, datasetInfo, qualityResults, alignmentSourceMode, alignmentQualityFilter } = get()
    if (!selectedDataset) return
    const qualityMode = alignmentSourceMode === 'raw' ? 'raw' : alignmentQualityFilter
    const selectedEpisodeIndices =
      alignmentSourceMode === 'raw'
        ? Array.from({ length: datasetInfo?.stats.total_episodes ?? 0 }, (_, index) => index)
        : (qualityResults?.episodes || [])
            .filter((episode) => {
              if (alignmentQualityFilter === 'all') return true
              return alignmentQualityFilter === 'passed' ? episode.passed : !episode.passed
            })
            .map((episode) => episode.episode_index)
    set({ prototypeRunning: true })
    await fetchJson('/api/curation/prototype-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: selectedDataset,
        cluster_count: clusterCount ?? null,
        episode_indices: selectedEpisodeIndices,
        quality_filter_mode: qualityMode,
      }),
    })
    get().startPolling()
  },

  loadQualityResults: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return null
    const results = normalizeQualityResults(
      await fetchJson<QualityResults>(
        `/api/curation/quality-results?dataset=${encodeURIComponent(selectedDataset)}`,
      ),
    )
    set((state) => ({
      qualityResults: results,
      selectedValidators:
        results?.selected_validators && results.selected_validators.length > 0
          ? results.selected_validators
          : state.selectedValidators,
      qualityThresholds:
        results?.threshold_overrides && Object.keys(results.threshold_overrides).length > 0
          ? {
              ...state.qualityThresholds,
              ...results.threshold_overrides,
            }
          : state.qualityThresholds,
    }))
    return results
  },

  loadPrototypeResults: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return null
    const results = normalizePrototypeResults(
      await fetchJson<PrototypeResults>(
        `/api/curation/prototype-results?dataset=${encodeURIComponent(selectedDataset)}`,
      ),
    )
    set({
      prototypeResults: results,
      ...(results?.quality_filter_mode
        ? {
            alignmentSourceMode: normalizeAlignmentSourceMode(results.quality_filter_mode),
            alignmentQualityFilter: normalizeQualityFilterMode(results.quality_filter_mode),
          }
        : {}),
    })
    return results
  },

  loadPropagationResults: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return null
    const results = normalizePropagationResults(
      await fetchJson<PropagationResults>(
        `/api/curation/propagation-results?dataset=${encodeURIComponent(selectedDataset)}`,
      ),
    )
    set({ propagationResults: results })
    return results
  },

  loadAlignmentOverview: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return null
    const results = await fetchJson<AlignmentOverview>(
      `/api/curation/alignment-overview?dataset=${encodeURIComponent(selectedDataset)}`,
    )
    set({ alignmentOverview: results })
    return results
  },

  deleteQualityResults: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    await fetchJson<{ status: string }>(
      `/api/curation/quality-results?dataset=${encodeURIComponent(selectedDataset)}`,
      {
        method: 'DELETE',
      },
    )
    set({ qualityResults: null, qualityRunning: false, prototypeResults: null, alignmentOverview: null })
    await get().refreshState()
  },

  publishQualityParquet: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    const result = await fetchJson<{ path: string; row_count: number }>(
      '/api/curation/quality-publish',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: selectedDataset }),
      },
    )
    await get().loadQualityResults()
    await get().loadAlignmentOverview()
    return result
  },

  publishTextAnnotationsParquet: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    const result = await fetchJson<{ path: string; row_count: number }>(
      '/api/curation/text-annotations-publish',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: selectedDataset }),
      },
    )
    await get().loadPropagationResults()
    await get().loadAlignmentOverview()
    return result
  },

  applyTextAnnotationsToTrainingTasks: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    const result = await fetchJson<TrainingTaskApplyResult>(
      '/api/curation/text-annotations-apply',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset: selectedDataset }),
      },
    )
    await get().loadQualityResults()
    await get().loadAlignmentOverview()
    return result
  },

  getQualityCsvUrl: (failedOnly = false) => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      return ''
    }
    const params = new URLSearchParams({
      dataset: selectedDataset,
    })
    if (failedOnly) {
      params.set('failed_only', 'true')
    }
    return `/api/curation/quality-results.csv?${params.toString()}`
  },

  fetchAnnotationWorkspace: async (episodeIndex: number) => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }
    return fetchJson<AnnotationWorkspacePayload>(
      `/api/curation/annotation-workspace?dataset=${encodeURIComponent(
        selectedDataset,
      )}&episode_index=${episodeIndex}`,
    )
  },

  saveAnnotations: async (episodeIndex, taskContext, annotations) => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }

    const saved = await fetchJson<SavedAnnotationsPayload>('/api/curation/annotations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: selectedDataset,
        episode_index: episodeIndex,
        task_context: taskContext,
        annotations,
      }),
    })

    await get().refreshState()
    await get().loadAlignmentOverview()
    return saved
  },

  runPropagation: async (sourceEpisodeIndex: number) => {
    const { selectedDataset } = get()
    if (!selectedDataset) {
      throw new Error('No dataset selected')
    }

    await fetchJson('/api/curation/propagation-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset: selectedDataset,
        source_episode_index: sourceEpisodeIndex,
      }),
    })
    get().startPolling()
  },

  refreshState: async () => {
    const { selectedDataset } = get()
    if (!selectedDataset) return

    const state = await fetchJson<WorkflowState>(
      `/api/curation/state?dataset=${encodeURIComponent(selectedDataset)}`,
    )
    const qualityStatus = state.stages.quality_validation.status
    const savedQualityValidators = state.stages.quality_validation.selected_validators

    set((current) => ({
      workflowState: state,
      selectedDatasetIsRemotePrepared: true,
      alignmentSourceMode: normalizeAlignmentSourceMode(
        state.stages.prototype_discovery.quality_filter_mode || current.alignmentSourceMode,
      ),
      alignmentQualityFilter: normalizeQualityFilterMode(
        state.stages.prototype_discovery.quality_filter_mode || current.alignmentQualityFilter,
      ),
      selectedValidators:
        ['running', 'paused', 'completed'].includes(qualityStatus) && savedQualityValidators.length > 0
          ? savedQualityValidators
          : current.selectedValidators,
    }))

    const prototypeStatus = state.stages.prototype_discovery.status
    const annotationStatus = state.stages.annotation.status

    if (qualityStatus === 'completed') {
      await get().loadQualityResults()
      set({ qualityRunning: false })
    } else if (qualityStatus === 'running') {
      await get().loadQualityResults()
      set({ qualityRunning: true })
    } else if (qualityStatus === 'paused') {
      await get().loadQualityResults()
      set({ qualityRunning: false })
    } else if (qualityStatus === 'idle') {
      set({ qualityResults: null, qualityRunning: false })
    } else if (qualityStatus === 'error') {
      set({ qualityRunning: false })
    }

    if (prototypeStatus === 'completed') {
      await get().loadPrototypeResults()
      set({ prototypeRunning: false })
    } else if (prototypeStatus === 'error') {
      set({ prototypeRunning: false })
    }

    if (
      annotationStatus === 'completed'
      || state.stages.annotation.annotated_episodes.length > 0
    ) {
      await get().loadPropagationResults()
    }

    if (
      qualityStatus === 'completed'
      || qualityStatus === 'paused'
      || qualityStatus === 'running'
      || prototypeStatus === 'completed'
      || annotationStatus === 'completed'
      || state.stages.annotation.annotated_episodes.length > 0
    ) {
      await get().loadAlignmentOverview()
    }

    if (qualityStatus !== 'running' && prototypeStatus !== 'running' && annotationStatus !== 'running') {
      get().stopPolling()
    }
  },

  startPolling: () => {
    const existing = get().pollInterval
    if (existing) return
    const interval = setInterval(() => {
      void get().refreshState()
    }, WORKFLOW_REFRESH_INTERVAL_MS)
    set({ pollInterval: interval })
  },

  stopPolling: () => {
    const interval = get().pollInterval
    if (!interval) return
    clearInterval(interval)
    set({ pollInterval: null })
  },
}))
