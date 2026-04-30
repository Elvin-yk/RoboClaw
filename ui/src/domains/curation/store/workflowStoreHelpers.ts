import type {
  AlignmentSourceMode,
  PropagationResults,
  PrototypeResults,
  QualityFilterMode,
  QualityResults,
} from './workflowTypes'

export const CURRENT_DATASET_KEY = 'roboclaw.current_dataset'

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${res.status}: ${text}`)
  }
  return res.json()
}

export function getStoredDataset(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  return window.localStorage.getItem(CURRENT_DATASET_KEY)
}

export function persistDataset(name: string | null): void {
  if (typeof window === 'undefined') {
    return
  }
  if (!name) {
    window.localStorage.removeItem(CURRENT_DATASET_KEY)
    return
  }
  window.localStorage.setItem(CURRENT_DATASET_KEY, name)
}

export function normalizeQualityResults(payload: Partial<QualityResults> | null): QualityResults | null {
  if (!payload) return null
  return {
    total: payload.total ?? 0,
    passed: payload.passed ?? 0,
    failed: payload.failed ?? 0,
    overall_score: payload.overall_score ?? 0,
    selected_validators: payload.selected_validators ?? [],
    threshold_overrides:
      payload.threshold_overrides && typeof payload.threshold_overrides === 'object'
        ? payload.threshold_overrides
        : undefined,
    episodes: payload.episodes ?? [],
    working_parquet_path:
      typeof payload.working_parquet_path === 'string'
        ? payload.working_parquet_path
        : undefined,
    published_parquet_path:
      typeof payload.published_parquet_path === 'string'
        ? payload.published_parquet_path
        : undefined,
  }
}

export function normalizeQualityFilterMode(value: unknown): QualityFilterMode {
  return value === 'failed' || value === 'all' || value === 'raw' ? value : 'passed'
}

export function normalizeAlignmentSourceMode(value: unknown): AlignmentSourceMode {
  return value === 'raw' ? 'raw' : 'quality'
}

export function normalizePrototypeResults(payload: Partial<PrototypeResults> | null): PrototypeResults | null {
  if (!payload) return null
  return {
    candidate_count: payload.candidate_count ?? 0,
    entry_count: payload.entry_count ?? 0,
    cluster_count: payload.cluster_count ?? 0,
    anchor_record_keys: payload.anchor_record_keys ?? [],
    selection_mode: payload.selection_mode ?? '',
    distance_pair_count: payload.distance_pair_count ?? 0,
    distance_backend: payload.distance_backend ?? 'cpu',
    distance_backend_detail: payload.distance_backend_detail ?? {},
    groups: payload.groups ?? [],
    quality_filter_mode: normalizeQualityFilterMode(payload.quality_filter_mode),
    selected_episode_indices: payload.selected_episode_indices ?? [],
    clusters: payload.clusters ?? [],
  }
}

export function normalizePropagationResults(
  payload: Partial<PropagationResults> | null,
): PropagationResults | null {
  if (!payload) return null
  return {
    source_episode_index: payload.source_episode_index ?? null,
    source_episode_indices: payload.source_episode_indices ?? [],
    target_count: payload.target_count ?? 0,
    propagated: payload.propagated ?? [],
    published_parquet_path:
      typeof payload.published_parquet_path === 'string'
        ? payload.published_parquet_path
        : undefined,
  }
}
