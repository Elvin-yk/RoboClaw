import { api, deleteApi, patchJson, postJson } from '@/shared/api/client'
import type { DataJob, DataOverview, Dataset, DatasetPackage, InspectSuggestion, InspectSummary } from '@/domains/data/model/types'

const DATA_API = '/api/data'

function query(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams()
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value))
    }
  })
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const dataApi = {
  listDatasets: () => api<Dataset[]>(`${DATA_API}/library/datasets`),
  getDataset: (datasetId: string) => api<Dataset>(`${DATA_API}/library/datasets/${encodePath(datasetId)}`),
  deleteDataset: (datasetId: string) => deleteApi<{ status: string; dataset_id: string }>(`${DATA_API}/library/datasets/${encodePath(datasetId)}`),
  importDataset: (body: { dataset_id: string; include_videos: boolean; force: boolean }) => postJson<DataJob>(`${DATA_API}/library/imports`, body),
  inspectSuggestions: (params: { q: string; source: string; limit?: number }) => api<InspectSuggestion[]>(`${DATA_API}/inspect/suggestions${query(params)}`),
  inspectSummary: (params: { dataset?: string; source: string; path?: string }) => api<InspectSummary>(`${DATA_API}/inspect/summary${query(params)}`),
  inspectDetails: (params: { dataset?: string; source: string; path?: string }) => api<Record<string, unknown>>(`${DATA_API}/inspect/details${query(params)}`),
  inspectEpisodes: (params: { dataset?: string; source: string; path?: string; page?: number; page_size?: number }) => api<Record<string, unknown>>(`${DATA_API}/inspect/episodes${query(params)}`),
  inspectEpisode: (params: { dataset?: string; source: string; path?: string; episode_index?: number; preview?: boolean }) => api<Record<string, unknown>>(`${DATA_API}/inspect/episode${query(params)}`),
  startCleanRun: (body: { dataset_ids: string[]; task?: string; vcodec?: string; force?: boolean }) => postJson<DataJob>(`${DATA_API}/clean/runs`, body),
  updateDatasetGate: (datasetId: string, gateKey: string, body: { status: string; message?: string; details?: Record<string, unknown> }) => (
    patchJson<{ dataset: Dataset }>(`${DATA_API}/lifecycle/datasets/${encodePath(datasetId)}/gates/${gateKey}`, body)
  ),
  listPackages: () => api<DatasetPackage[]>(`${DATA_API}/packages`),
  getPackage: (packageId: string) => api<DatasetPackage>(`${DATA_API}/packages/${encodeURIComponent(packageId)}`),
  createPackage: (body: { package_id: string; dataset_ids: string[]; groups?: Record<string, string[]>; force?: boolean }) => postJson<DatasetPackage>(`${DATA_API}/packages`, body),
  startQualityRun: (body: { package_id: string; selected_validators: string[]; episode_indices?: number[]; threshold_overrides?: Record<string, number> }) => postJson<DataJob>(`${DATA_API}/quality/runs`, body),
  qualityDefaults: (packageId: string) => api<Record<string, unknown>>(`${DATA_API}/quality/defaults${query({ package_id: packageId })}`),
  qualityResults: (packageId: string) => api<Record<string, unknown>>(`${DATA_API}/quality/results${query({ package_id: packageId })}`),
  annotationWorkspace: (packageId: string, episodeIndex: number) => api<Record<string, unknown>>(`${DATA_API}/annotation/workspace${query({ package_id: packageId, episode_index: episodeIndex })}`),
  saveAnnotations: (body: { package_id: string; episode_index: number; task_context: Record<string, unknown>; annotations: Array<Record<string, unknown>> }) => postJson<Record<string, unknown>>(`${DATA_API}/annotation/annotations`, body),
  startPrototypeRun: (body: { package_id: string; cluster_count?: number; candidate_limit?: number; episode_indices?: number[]; quality_filter_mode?: string }) => postJson<DataJob>(`${DATA_API}/annotation/prototype-runs`, body),
  startPropagationRun: (body: { package_id: string; source_episode_index: number }) => postJson<DataJob>(`${DATA_API}/annotation/propagation-runs`, body),
  overview: () => api<DataOverview>(`${DATA_API}/overview`),
  job: (jobId: string) => api<DataJob>(`${DATA_API}/jobs/${jobId}`),
  cancelJob: (jobId: string) => postJson<DataJob>(`${DATA_API}/jobs/${jobId}/cancel`, {}),
}

export function jobEventsUrl(jobId: string) {
  return `${DATA_API}/jobs/${jobId}/events`
}

function encodePath(value: string) {
  return value.split('/').map(encodeURIComponent).join('/')
}
