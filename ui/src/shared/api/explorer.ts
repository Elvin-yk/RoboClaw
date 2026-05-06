/** Shared explorer API helpers.
 *
 * Provides typed wrappers around the explorer dataset/episode endpoints used
 * by both the dataset explorer and the trajectory replay viewer. Centralising
 * the types and query construction here keeps the two surfaces aligned and
 * removes duplicated `buildExplorerQuery` definitions.
 */

import { api } from '@/shared/api/client'

export type ExplorerSource = 'remote' | 'local' | 'path'

export interface ExplorerDatasetSuggestion {
  id: string
  label?: string
  path?: string
  source?: ExplorerSource
  source_kind?: string
}

export interface ExplorerDatasetRef {
  source: ExplorerSource
  dataset?: string
  path?: string
}

export interface ExplorerEpisodeSummary {
  episode_index: number
  length: number
}

export interface ExplorerEpisodePage {
  dataset: string
  page: number
  page_size: number
  total_episodes: number
  total_pages: number
  episodes: ExplorerEpisodeSummary[]
}

export function buildExplorerQuery(ref: ExplorerDatasetRef): string {
  const params = new URLSearchParams()
  params.set('source', ref.source)
  if (ref.dataset) params.set('dataset', ref.dataset)
  if (ref.path) params.set('path', ref.path)
  return params.toString()
}

export function buildExplorerRefKey(ref: ExplorerDatasetRef | null | undefined): string {
  if (!ref) return ''
  return `${ref.source}|${ref.dataset?.trim() ?? ''}|${ref.path?.trim() ?? ''}`
}

export function searchDatasetSuggestions(
  query: string,
  source: ExplorerSource = 'remote',
  limit = 8,
): Promise<ExplorerDatasetSuggestion[]> {
  const needle = query.trim()
  if (!needle) return Promise.resolve([])
  const params = new URLSearchParams()
  params.set('q', needle)
  params.set('limit', String(limit))
  params.set('source', source)
  return api<ExplorerDatasetSuggestion[]>(`/api/explorer/suggest?${params.toString()}`)
}

export function listExplorerDatasets(
  source: ExplorerSource = 'local',
  limit = 500,
): Promise<ExplorerDatasetSuggestion[]> {
  const params = new URLSearchParams()
  params.set('source', source)
  params.set('limit', String(limit))
  return api<ExplorerDatasetSuggestion[]>(`/api/explorer/datasets?${params.toString()}`)
}

export function fetchExplorerEpisodePage(
  ref: ExplorerDatasetRef,
  page = 1,
  pageSize = 50,
): Promise<ExplorerEpisodePage> {
  const params = new URLSearchParams(buildExplorerQuery(ref))
  params.set('page', String(page))
  params.set('page_size', String(pageSize))
  return api<ExplorerEpisodePage>(`/api/explorer/episodes?${params.toString()}`)
}
