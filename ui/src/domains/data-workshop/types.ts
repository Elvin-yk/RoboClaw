export type WorkshopStage = 'dirty' | 'clean' | 'complete' | 'excluded'
export type GateStatus = 'pending' | 'running' | 'passed' | 'failed' | 'manual_required' | 'skipped'
export type AssemblyStatus = 'draft' | 'upload_queued'
export type UploadStatus = 'queued'
export type GateKey =
  | 'repair_diagnosis'
  | 'auto_prune'
  | 'repair'
  | 'manual_boundary_review'
  | 'quality_validation'
  | 'organize'
  | 'assembly'
  | 'upload'

export interface ProcessingGate {
  key: GateKey
  status: GateStatus
  required: boolean
  label: string
  message: string
  updated_at: string
  details: Record<string, unknown>
  history: Array<Record<string, unknown>>
}

export interface WorkshopDataset {
  id: string
  name: string
  label: string
  path: string
  real_path: string
  is_symlink: boolean
  stage: WorkshopStage
  stats: {
    total_episodes: number
    total_frames: number
    parquet_rows: number
    video_files: number
    episode_metadata_count: number
  }
  gates: Record<GateKey, ProcessingGate>
  diagnosis: {
    damage_type: string
    repairable: boolean
    details: Record<string, unknown>
  } | null
  structure: {
    passed: boolean
    issues: Array<{ check: string; level: string; message: string }>
    counts: Record<string, number>
  }
  groups: string[]
  batch: string
  notes: string
  assembly_ids: string[]
  updated_at: string
}

export interface UploadTask {
  id: string
  status: UploadStatus
  target: string
  created_at: string
  updated_at: string
  message: string
}

export interface DatasetAssembly {
  id: string
  name: string
  status: AssemblyStatus
  dataset_ids: string[]
  groups: Record<string, string[]>
  created_at: string
  updated_at: string
  quality_summary: Record<string, unknown>
  upload_task: UploadTask | null
}
