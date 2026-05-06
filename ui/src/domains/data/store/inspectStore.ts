import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import type { InspectSuggestion, InspectSummary } from '@/domains/data/model/types'

interface InspectState {
  source: 'remote' | 'local' | 'path'
  query: string
  dataset: string
  path: string
  suggestions: InspectSuggestion[]
  summary: InspectSummary | null
  details: Record<string, unknown> | null
  episodes: Record<string, unknown> | null
  loading: boolean
  error: string
  setSource: (source: 'remote' | 'local' | 'path') => void
  setQuery: (query: string) => void
  setDataset: (dataset: string) => void
  setPath: (path: string) => void
  suggest: () => Promise<void>
  inspect: () => Promise<void>
}

export const useDataInspectStore = create<InspectState>((set, get) => ({
  source: 'local',
  query: '',
  dataset: '',
  path: '',
  suggestions: [],
  summary: null,
  details: null,
  episodes: null,
  loading: false,
  error: '',
  setSource: (source) => set({ source }),
  setQuery: (query) => set({ query }),
  setDataset: (dataset) => set({ dataset }),
  setPath: (path) => set({ path }),
  suggest: async () => {
    const { query, source } = get()
    const suggestions = await dataApi.inspectSuggestions({ q: query, source, limit: 12 })
    set({ suggestions })
  },
  inspect: async () => {
    const { source, dataset, path } = get()
    set({ loading: true, error: '' })
    try {
      const params = { source, dataset: dataset || undefined, path: path || undefined }
      const [summary, details, episodes] = await Promise.all([
        dataApi.inspectSummary(params),
        dataApi.inspectDetails(params),
        dataApi.inspectEpisodes({ ...params, page: 1, page_size: 25 }),
      ])
      set({ summary, details, episodes, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
}))
