import type { DatasetImportJob, DatasetRef } from '@/domains/datasets/types'

export type StageStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error'
export interface StageState {
  status: StageStatus
  summary: Record<string, unknown> | null
}

export interface QualityStage extends StageState {
  selected_validators: string[]
  pause_requested?: boolean
}

export type QualityFilterMode = 'passed' | 'failed' | 'all' | 'raw'
export type AlignmentSourceMode = 'quality' | 'raw'

export interface PrototypeStage extends StageState {
  quality_filter_mode?: string
  selected_episode_indices?: number[]
}

export interface WorkflowState {
  version: number
  dataset: string
  stages: {
    quality_validation: QualityStage
    prototype_discovery: PrototypeStage
    annotation: StageState & {
      annotated_episodes: number[]
      propagated_source_episodes?: number[]
    }
  }
}

export interface QualityEpisodeResult {
  episode_index: number
  passed: boolean
  score: number
  validators: Record<string, { passed: boolean; score: number }>
  issues?: Array<Record<string, unknown>>
}

export interface QualityResults {
  total: number
  passed: number
  failed: number
  overall_score: number
  selected_validators: string[]
  threshold_overrides?: Record<string, number>
  episodes: QualityEpisodeResult[]
  working_parquet_path?: string
  published_parquet_path?: string
}

export interface QualityDefaults {
  dataset: string
  selected_validators: string[]
  threshold_overrides: Record<string, number>
  profile: {
    fps: number
    median_episode_duration_s: number
    video_resolution?: { width: number; height: number } | null
    visual_streams: string[]
    depth_streams: string[]
    has_action: boolean
    has_state: boolean
    has_gripper: boolean
  }
  checks: Record<string, boolean>
}

export interface PrototypeClusterMember {
  record_key: string
  episode_index: number | null
  distance_to_prototype?: number
  distance_to_barycenter?: number
  quality?: {
    score?: number
    passed?: boolean
  }
}

export interface PrototypeCluster {
  cluster_index: number
  prototype_record_key: string
  anchor_record_key: string
  member_count: number
  average_distance?: number
  anchor_distance_to_barycenter?: number
  members: PrototypeClusterMember[]
}

export interface PrototypeSelectionEvaluation {
  k: number
  score: number
  smallest_member_count: number
  member_counts: number[]
  eligible: boolean
  rejection_reason?: string | null
  selected: boolean
  within_tolerance: boolean
}

export interface PrototypeSelectionDiagnostics {
  strategy: string
  selected_k: number
  selected_score: number
  best_k: number
  best_score: number
  tolerance: number
  max_candidate_k: number
  evaluated_count: number
  candidate_pool_count: number
  rejected_singleton_heavy_count: number
  selection_reason: string
  min_member_count: number
  evaluated: PrototypeSelectionEvaluation[]
}

export interface PrototypeGroupSummary {
  group_index: number
  bucket_key: string
  task_key: string
  robot_type: string
  canonical_mode: string
  entry_count: number
  cluster_count: number
  selection_mode: string
  distance_pair_count: number
  distance_backend: string
  selection_diagnostics?: PrototypeSelectionDiagnostics | null
}

export interface PrototypeResults {
  candidate_count: number
  entry_count: number
  cluster_count: number
  anchor_record_keys: string[]
  selection_mode?: string
  distance_pair_count?: number
  distance_backend?: string
  distance_backend_detail?: Record<string, unknown>
  groups?: PrototypeGroupSummary[]
  quality_filter_mode?: string
  selected_episode_indices?: number[]
  clusters: PrototypeCluster[]
}

export interface PropagationSpan {
  label?: string
  startTime?: number
  endTime?: number | null
  text?: string
  [key: string]: unknown
}

export interface PropagationResultItem {
  episode_index: number
  spans: PropagationSpan[]
  prototype_score?: number
  alignment_method?: string
  source_episode_index?: number | null
}

export interface PropagationResults {
  source_episode_index: number | null
  source_episode_indices: number[]
  target_count: number
  propagated: PropagationResultItem[]
  published_parquet_path?: string
}

export interface TrainingTaskApplyResult {
  status: string
  path: string
  manifest_path: string
  backup_dir: string
  updated_episode_count: number
  updated_episode_file_count: number
  updated_data_file_count: number
  updated_task_file_count: number
  updated_info_file_count: number
  synced_quality_episode_count?: number
  task_count: number
  unmatched_episode_indices: number[]
}

export interface RemoteWorkflowPrepareResult {
  dataset_id: string
  local_path: string
  dataset_name: string
  display_name?: string
}

export interface LocalDirectorySessionResult {
  dataset_name: string
  display_name: string
  local_path: string
}
export interface AnnotationItem {
  id: string
  label: string
  category: string
  color: string
  startTime: number
  endTime: number | null
  text: string
  tags: string[]
  source: string
}

export interface WorkflowTaskContext {
  label?: string
  text?: string
  joint_name?: string
  time_s?: number
  frame_index?: number | null
  action_value?: number | null
  state_value?: number | null
  source?: string
  [key: string]: unknown
}

export interface JointTrajectoryEntry {
  joint_name: string
  action_name: string
  state_name: string
  action_values: Array<number | null>
  state_values: Array<number | null>
}

export interface JointTrajectoryPayload {
  x_axis_key: string
  x_values: number[]
  time_values: number[]
  frame_values: number[]
  joint_trajectories: JointTrajectoryEntry[]
  sampled_points: number
  total_points: number
}

export interface AnnotationWorkspaceSummary {
  episode_index: number
  record_key: string
  task_value: string
  task_label: string
  fps: number
  robot_type: string
  row_count: number
  start_timestamp: number | null
  end_timestamp: number | null
  duration_s: number
  video_count: number
  quality_status?: 'passed' | 'failed' | 'unvalidated'
  quality_score?: number | null
}

export interface AnnotationVideoClip {
  path: string
  url: string
  stream: string
  from_timestamp: number | null
  to_timestamp: number | null
}

export interface SavedAnnotationsPayload {
  episode_index: number
  task_context: WorkflowTaskContext
  annotations: AnnotationItem[]
  version_number: number
  created_at?: string
  updated_at?: string
}

export interface AnnotationWorkspacePayload {
  episode_index: number
  summary: AnnotationWorkspaceSummary
  videos: AnnotationVideoClip[]
  joint_trajectory: JointTrajectoryPayload
  annotations: SavedAnnotationsPayload
  latest_propagation: PropagationResults | null
  quality?: {
    validated: boolean
    passed: boolean | null
    score: number | null
    failed_validators: string[]
    quality_tags: string[]
    issues: Array<Record<string, unknown>>
  }
}

export interface AlignmentOverviewRow {
  episode_index: number
  record_key: string
  task: string
  task_source?: string | null
  task_is_supplemental?: boolean
  semantic_task_text?: string | null
  quality_passed: boolean
  quality_score: number
  quality_status: 'passed' | 'failed'
  validator_scores: Record<string, number>
  failed_validators: string[]
  issues: Array<Record<string, unknown>>
  alignment_status: 'not_started' | 'annotated' | 'propagated'
  annotation_count: number
  propagated_count: number
  annotation_spans?: AlignmentOverviewSpan[]
  propagation_source_episode_index?: number | null
  propagation_alignment_method?: string | null
  propagation_spans?: AlignmentOverviewSpan[]
  prototype_score?: number | null
  updated_at?: string
}

export interface AlignmentOverviewSpan {
  id?: string | null
  label?: string | null
  text?: string | null
  category?: string | null
  startTime?: number | null
  endTime?: number | null
  source?: string | null
  target_record_key?: string | null
  prototype_score?: number | null
  source_start_time?: number | null
  source_end_time?: number | null
  dtw_start_delay_s?: number | null
  dtw_end_delay_s?: number | null
  duration_delta_s?: number | null
}

export interface AlignmentOverview {
  summary: {
    total_checked: number
    passed_count: number
    failed_count: number
    perfect_ratio: number
    aligned_count: number
    annotated_count: number
    propagated_count: number
    prototype_cluster_count: number
    quality_filter_mode: string
  }
  distribution: {
    issue_types: Array<{ label: string; count: number }>
    alignment_status: Array<{ label: string; count: number }>
  }
  rows: AlignmentOverviewRow[]
}

export interface WorkflowStore {
  datasets: DatasetRef[]
  datasetsLoading: boolean
  selectedDataset: string | null
  datasetInfo: DatasetRef | null
  workflowState: WorkflowState | null
  selectedValidators: string[]
  alignmentSourceMode: AlignmentSourceMode
  alignmentQualityFilter: QualityFilterMode
  qualityThresholds: Record<string, number>
  qualityDefaults: QualityDefaults | null
  qualityResults: QualityResults | null
  qualityRunning: boolean
  prototypeResults: PrototypeResults | null
  prototypeRunning: boolean
  propagationResults: PropagationResults | null
  alignmentOverview: AlignmentOverview | null
  datasetImportJob: DatasetImportJob | null
  selectedDatasetIsRemotePrepared: boolean
  pollInterval: ReturnType<typeof setInterval> | null
  loadDatasets: () => Promise<void>
  selectDataset: (datasetId: string) => Promise<void>
  importDatasetFromHf: (datasetId: string, includeVideos?: boolean) => Promise<void>
  prepareRemoteDatasetForWorkflow: (
    datasetId: string,
    includeVideos?: boolean,
  ) => Promise<RemoteWorkflowPrepareResult>
  createLocalDirectorySession: (
    files: File[],
    relativePaths: string[],
    displayName?: string,
  ) => Promise<LocalDirectorySessionResult>
  toggleValidator: (name: string) => void
  setAlignmentSourceMode: (mode: AlignmentSourceMode) => void
  setAlignmentQualityFilter: (mode: QualityFilterMode) => void
  setQualityThreshold: (key: string, value: number) => void
  loadQualityDefaults: () => Promise<QualityDefaults | null>
  runQualityValidation: () => Promise<void>
  pauseQualityValidation: () => Promise<void>
  resumeQualityValidation: () => Promise<void>
  runPrototypeDiscovery: (clusterCount?: number) => Promise<void>
  loadQualityResults: () => Promise<QualityResults | null>
  loadPrototypeResults: () => Promise<PrototypeResults | null>
  loadPropagationResults: () => Promise<PropagationResults | null>
  loadAlignmentOverview: () => Promise<AlignmentOverview | null>
  deleteQualityResults: () => Promise<void>
  publishQualityParquet: () => Promise<{ path: string; row_count: number }>
  publishTextAnnotationsParquet: () => Promise<{ path: string; row_count: number }>
  applyTextAnnotationsToTrainingTasks: () => Promise<TrainingTaskApplyResult>
  getQualityCsvUrl: (failedOnly?: boolean) => string
  fetchAnnotationWorkspace: (episodeIndex: number) => Promise<AnnotationWorkspacePayload>
  saveAnnotations: (
    episodeIndex: number,
    taskContext: WorkflowTaskContext,
    annotations: AnnotationItem[],
  ) => Promise<SavedAnnotationsPayload>
  runPropagation: (sourceEpisodeIndex: number) => Promise<void>
  refreshState: () => Promise<void>
  startPolling: () => void
  stopPolling: () => void
}
