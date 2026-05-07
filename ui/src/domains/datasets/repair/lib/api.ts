import { api, postJson } from '@/shared/api/client'
import type {
  DatasetRepairFilters,
  ListDatasetsResponse,
  RepairJobState,
} from '../types'

const BASE = '/api/dataset-repair'

export class JobConflictError extends Error {
  constructor(public readonly job: RepairJobState) {
    super('已有任务进行中')
    this.name = 'JobConflictError'
  }
}

function buildListUrl(filters: DatasetRepairFilters): string {
  const params = new URLSearchParams()
  if (filters.root.trim()) params.set('root', filters.root.trim())
  if (filters.date_from.trim()) params.set('date_from', filters.date_from.trim())
  if (filters.date_to.trim()) params.set('date_to', filters.date_to.trim())
  if (filters.task.trim()) params.set('task', filters.task.trim())
  if (filters.tag !== 'all') params.set('tag', filters.tag)
  const qs = params.toString()
  return qs ? `${BASE}/datasets?${qs}` : `${BASE}/datasets`
}

export function listDatasets(filters: DatasetRepairFilters): Promise<ListDatasetsResponse> {
  return api<ListDatasetsResponse>(buildListUrl(filters))
}

function buildJobRequestBody(
  filters: DatasetRepairFilters,
  datasetIds?: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    filters: {
      root: filters.root.trim() || null,
      date_from: filters.date_from.trim() || null,
      date_to: filters.date_to.trim() || null,
      task: filters.task.trim() || null,
      tag: filters.tag,
    },
  }
  if (datasetIds && datasetIds.length > 0) {
    body.dataset_ids = datasetIds
  }
  return body
}

async function postJobStart(
  endpoint: 'diagnose' | 'repair',
  filters: DatasetRepairFilters,
  datasetIds?: string[],
): Promise<RepairJobState> {
  // The backend returns 409 + RepairJobState in `detail` when a job is
  // already running. The shared api client stringifies non-string detail to
  // "[object Object]" — bypass it so callers can react to the conflict.
  const response = await fetch(`${BASE}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildJobRequestBody(filters, datasetIds)),
  })
  if (response.status === 409) {
    const payload = (await response.json()) as { detail: RepairJobState }
    throw new JobConflictError(payload.detail)
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `HTTP ${response.status}`)
  }
  return (await response.json()) as RepairJobState
}

export function startDiagnose(
  filters: DatasetRepairFilters,
  datasetIds?: string[],
): Promise<RepairJobState> {
  return postJobStart('diagnose', filters, datasetIds)
}

export function startRepair(
  filters: DatasetRepairFilters,
  datasetIds?: string[],
): Promise<RepairJobState> {
  return postJobStart('repair', filters, datasetIds)
}

export function getCurrentJob(): Promise<{ job: RepairJobState | null }> {
  return api<{ job: RepairJobState | null }>(`${BASE}/jobs/current`)
}

export function getJob(jobId: string): Promise<RepairJobState> {
  return api<RepairJobState>(`${BASE}/jobs/${encodeURIComponent(jobId)}`)
}

export function cancelJob(jobId: string): Promise<RepairJobState> {
  return postJson<RepairJobState>(`${BASE}/jobs/${encodeURIComponent(jobId)}/cancel`)
}

export function jobEventsUrl(jobId: string): string {
  return `${BASE}/jobs/${encodeURIComponent(jobId)}/events`
}
