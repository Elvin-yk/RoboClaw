import { fetchJson } from '@/domains/curation/store/workflowStoreHelpers'

export interface ReviewDatasetSummary {
  id: string
  label: string
  path: string
  total_episodes: number
  fps: number
  reviewed: number
  abnormal: number
  is_critical_phase: boolean
}

export interface ReviewMark {
  episode_index: number
  abnormal: boolean
  updated_at: string
}

export interface ReviewSummary {
  total_episodes: number
  reviewed: number
  abnormal: number
}

export interface ReviewEpisodeListItem {
  episode_index: number
  length: number
  mark: ReviewMark | null
}

export interface ReviewEpisodePage {
  dataset: string
  page: number
  page_size: number
  total_episodes: number
  total_pages: number
  episodes: ReviewEpisodeListItem[]
}

export interface ReviewVideo {
  path: string
  relative_path: string
  name: string
  url: string
  from_timestamp?: number | null
  to_timestamp?: number | null
  stream?: string
}

export interface ReviewEpisodeDetail {
  dataset_id: string
  episode_index: number
  episode_meta: Record<string, unknown>
  videos: ReviewVideo[]
  mark: ReviewMark | null
}

export interface ReviewState {
  dataset_id: string
  version: number
  updated_at: string
  marks: Record<string, ReviewMark>
  commits: unknown[]
}

export interface ReviewStateResponse {
  state: ReviewState
  summary: ReviewSummary
}

export interface ReviewMarkUpdateResponse {
  state: ReviewState
}

export interface CommitDeletionResult {
  source_dataset: string
  output_dataset: string
  output_path: string | null
  kept_episode_indices: number[]
  deleted_episode_indices: number[]
}

export async function fetchReviewDatasets(criticalOnly = true): Promise<ReviewDatasetSummary[]> {
  return fetchJson<ReviewDatasetSummary[]>(
    `/api/curation/review/datasets?critical_only=${criticalOnly}`,
  )
}

export async function fetchReviewState(datasetId: string): Promise<ReviewStateResponse> {
  return fetchJson<ReviewStateResponse>(
    `/api/curation/review/state?dataset=${encodeURIComponent(datasetId)}`,
  )
}

export async function fetchReviewEpisodePage(
  datasetId: string,
  page: number,
  pageSize: number,
): Promise<ReviewEpisodePage> {
  const params = new URLSearchParams({
    dataset: datasetId,
    page: String(page),
    page_size: String(pageSize),
  })
  return fetchJson<ReviewEpisodePage>(`/api/curation/review/episodes?${params.toString()}`)
}

export async function fetchReviewEpisodeDetail(
  datasetId: string,
  episodeIndex: number,
): Promise<ReviewEpisodeDetail> {
  const params = new URLSearchParams({
    dataset: datasetId,
    episode_index: String(episodeIndex),
  })
  return fetchJson<ReviewEpisodeDetail>(`/api/curation/review/episode?${params.toString()}`)
}

export async function putReviewMark(
  datasetId: string,
  episodeIndex: number,
  abnormal: boolean,
): Promise<ReviewMarkUpdateResponse> {
  return fetchJson<ReviewMarkUpdateResponse>(
    `/api/curation/review/marks/${episodeIndex}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: datasetId, abnormal }),
    },
  )
}

export async function putReviewMarksBulk(
  datasetId: string,
  marks: Array<{ episode_index: number; abnormal: boolean }>,
): Promise<ReviewMarkUpdateResponse> {
  return fetchJson<ReviewMarkUpdateResponse>(
    `/api/curation/review/marks`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataset: datasetId, marks }),
    },
  )
}

export async function postCommitDeletion(
  datasetId: string,
  outputDatasetId: string,
  task: string,
  dryRun: boolean,
): Promise<CommitDeletionResult> {
  return fetchJson<CommitDeletionResult>(
    `/api/curation/review/commit-deletion`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dataset_id: datasetId,
        output_dataset_id: outputDatasetId,
        task,
        dry_run: dryRun,
      }),
    },
  )
}
