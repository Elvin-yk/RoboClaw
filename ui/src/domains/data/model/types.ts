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
}

export interface Dataset {
  id: string
  name: string
  label: string
  path: string
  real_path: string
  source: 'local' | 'remote' | 'path'
  lifecycle_stage: DatasetStage
  stats: DatasetStats
  gates: Record<string, DataGate>
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
  quality_summary: Record<string, unknown>
  updated_at: string
}

export interface DataJob {
  job_id: string
  kind: string
  target_type: 'dataset' | 'package' | 'global'
  target_id: string
  phase: 'queued' | 'running' | 'completed' | 'failed' | 'cancelling' | 'cancelled'
  total: number
  processed: number
  message: string
  started_at: string
  updated_at: string
  error: string | null
  result: Record<string, unknown> | null
  items: Array<Record<string, unknown>>
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
