// Mirrors roboclaw/data/repair/schemas.py.  Keep in sync.

export type RepairTag = 'dirty' | 'checked'

export type DamageType =
  | 'healthy'
  | 'empty_shell'
  | 'crash_no_save'
  | 'tmp_videos_stuck'
  | 'partial_tmp_videos_stuck'
  | 'parquet_no_video'
  | 'meta_stale'
  | 'frame_mismatch'
  | 'missing_cp'

export type JobPhase =
  | 'idle'
  | 'diagnosing'
  | 'repairing'
  | 'completed'
  | 'failed'
  | 'cancelling'
  | 'cancelled'

export type ItemStatus =
  | 'queued'
  | 'diagnosing'
  | 'repairing'
  | 'done'
  | 'failed'
  | 'cancelled'

export type JobKind = 'diagnose' | 'repair'

export type TagFilter = 'dirty' | 'checked' | 'all'

export interface DamageSummary {
  healthy: number
  empty_shell: number
  crash_no_save: number
  tmp_videos_stuck: number
  partial_tmp_videos_stuck: number
  parquet_no_video: number
  meta_stale: number
  frame_mismatch: number
  missing_cp: number
  unrepairable: number
  total: number
}

export interface DatasetRepairDataset {
  id: string
  name: string
  path: string
  created_date: string | null
  task: string | null
  tag: RepairTag
  last_damage_type: DamageType | null
  repairable: boolean | null
  cleaned_dataset_id: string | null
}

export interface DatasetJobItem {
  dataset_id: string
  dataset_path: string
  status: ItemStatus
  damage_type: DamageType | null
  repairable: boolean | null
  output_path: string | null
  error: string | null
}

export interface RepairJobState {
  job_id: string
  kind: JobKind
  phase: JobPhase
  total: number
  processed: number
  summary: DamageSummary
  items: DatasetJobItem[]
  started_at: string
  updated_at: string
  error: string | null
}

export interface ListDatasetsResponse {
  root: string
  datasets: DatasetRepairDataset[]
}

export interface DatasetRepairFilters {
  root: string
  date_from: string
  date_to: string
  task: string
  tag: TagFilter
}

export const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set<JobPhase>([
  'completed',
  'failed',
  'cancelled',
])

export const TERMINAL_ITEM_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  'done',
  'failed',
  'cancelled',
])

export const DAMAGE_TYPE_LABELS_ZH: Record<DamageType, string> = {
  healthy: '健康',
  empty_shell: '空壳',
  crash_no_save: '崩溃未保存',
  tmp_videos_stuck: '视频卡死',
  partial_tmp_videos_stuck: '视频部分卡死',
  parquet_no_video: '缺视频',
  meta_stale: '元数据过期',
  frame_mismatch: '帧数不一致',
  missing_cp: '缺校验点',
}

export const ALL_DAMAGE_TYPES: ReadonlyArray<DamageType> = [
  'healthy',
  'empty_shell',
  'crash_no_save',
  'tmp_videos_stuck',
  'partial_tmp_videos_stuck',
  'parquet_no_video',
  'meta_stale',
  'frame_mismatch',
  'missing_cp',
]
