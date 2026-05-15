export type DatasetStage = 'raw' | 'inspecting' | 'cleaning' | 'needs_review' | 'clean' | 'excluded'

export type DatasetPackageStage =
  | 'assembling'
  | 'assembled'
  | 'validating'
  | 'validated'
  | 'annotating'
  | 'annotated'
  | 'upload_queued'
  | 'uploaded'
  | 'failed'

export type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'needs_review' | 'skipped'

export interface DataGate {
  key: string
  status: GateStatus
  required: boolean
  message: string
  updated_at: string
  details: Record<string, unknown>
}

export interface DatasetStats {
  total_episodes: number
  total_frames: number
  fps: number
  robot_type: string
  features: string[]
  episode_lengths: number[]
  task_description?: string
}

export interface Dataset {
  id: string
  name: string
  label: string
  path: string
  real_path: string
  source: 'local' | 'remote'
  lifecycle_stage: DatasetStage
  stats: DatasetStats
  gates: Record<string, DataGate>
  qc: Record<string, unknown>
  active_output: Record<string, unknown>
  price_credit?: number | null
  has_access?: boolean | null
  updated_at: string
}

export interface DatasetPackage {
  id: string
  name: string
  label: string
  path: string
  real_path: string
  dataset_ids: string[]
  groups: Record<string, string[]>
  lifecycle_stage: DatasetPackageStage
  stats: DatasetStats
  gates: Record<string, DataGate>
  evaluation_summary: Record<string, unknown>
  updated_at: string
}

export type DataJobPhase = 'queued' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled'

export const DATA_JOB_TERMINAL_PHASES: readonly DataJobPhase[] = ['completed', 'failed', 'cancelled']

export function isTerminalDataJobPhase(phase: DataJobPhase): boolean {
  return DATA_JOB_TERMINAL_PHASES.includes(phase)
}

export interface DataJob {
  job_id: string
  kind: string
  target_type: 'dataset' | 'package' | 'global'
  target_id: string
  phase: DataJobPhase
  total: number
  processed: number
  message: string
  started_at: string
  updated_at: string
  error: string | null
  result: Record<string, unknown> | null
  items: Array<Record<string, unknown>>
}

export interface DataQcRunStep {
  id: string
  status: string
  message: string
  details: Record<string, unknown>
  updated_at?: string
}

export interface DataQcRun {
  run_id: string
  dataset_id: string
  lane: string
  chain_id: string
  status: string
  started_at: string
  updated_at: string
  steps: DataQcRunStep[]
  output?: Record<string, unknown>
  failure?: Record<string, unknown>
}

export type DataReviewStatus = 'pending' | 'ready_for_batch' | 'applied'
export type DataReviewDecision = 'passed' | 'failed'

export interface DataReviewEpisodeDecision {
  decision: DataReviewDecision
  reason: string
  note: string
  reviewer_id: string
  reviewed_at: string
}

export interface DataReviewState {
  status: DataReviewStatus
  episodes: Record<string, DataReviewEpisodeDecision>
  draft_edits: Record<string, unknown>
  updated_at: string
}

export interface DataReviewWorkspace {
  dataset: Dataset
  review: DataReviewState
  episode_indices: number[]
  total_episodes: number
}

export interface DataOverview {
  datasets: Dataset[]
  packages: DatasetPackage[]
  summary: {
    dataset_count: number
    package_count: number
    dataset_stage_counts: Record<string, number>
    package_stage_counts: Record<string, number>
  }
}

export interface InspectSuggestion {
  id: string
  label?: string
  path?: string
  source?: string
}

export interface InspectSummary {
  dataset: string
  summary: Record<string, unknown>
}

export type RobotTrajectorySource = 'remote' | 'local' | 'path'
export type RobotTrajectorySignal = 'action' | 'state'
export type RobotArmSide = 'left' | 'right'

export interface RobotModelManifest {
  model: string
  asset_id: string
  asset_base_url: string
  urdf_path: string
  urdf_url: string
  joint_order: string[]
  ee_link: string
  trajectory_schema: string
  scene: {
    left_base_xyz: [number, number, number]
    right_base_xyz: [number, number, number]
  }
  files: Array<{
    path: string
    size: number
    sha256: string
    content_type: string
  }>
}

export interface EpisodeRobotTrajectory {
  model: string
  dataset: string
  source: RobotTrajectorySource
  episode_index: number
  signal: RobotTrajectorySignal
  fps: number
  frame_count: number
  duration_s: number
  time_s: number[]
  frame_index: number[]
  joint_order: string[]
  arms: Record<RobotArmSide, {
    joint_degrees: Record<string, Array<number | null>>
  }>
}
