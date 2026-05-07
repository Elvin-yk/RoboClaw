import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import type { InspectSummary } from '@/domains/data/model/types'

type InspectSource = 'remote' | 'local'

interface InspectState {
  source: InspectSource
  dataset: string
  summary: InspectSummary | null
  details: Record<string, unknown> | null
  episodes: Record<string, unknown> | null
  episode: Record<string, unknown> | null
  loading: boolean
  error: string
  setSource: (source: InspectSource) => void
  setDataset: (dataset: string) => void
  inspect: () => Promise<void>
  loadEpisode: (episodeIndex: number) => Promise<void>
}

let inspectRequestId = 0
let episodeRequestId = 0

export const useDataInspectStore = create<InspectState>((set, get) => ({
  source: 'local',
  dataset: '',
  summary: null,
  details: null,
  episodes: null,
  episode: null,
  loading: false,
  error: '',
  setSource: (source) => set({ source }),
  setDataset: (dataset) => set({ dataset }),
  inspect: async () => {
    const { source, dataset } = get()
    const requestId = ++inspectRequestId
    set({ loading: true, error: '' })
    try {
      const params = { source, dataset: dataset || undefined }
      const [summary, details, episodes] = await Promise.all([
        dataApi.inspectSummary(params),
        dataApi.inspectDetails(params),
        dataApi.inspectEpisodes({ ...params, page: 1, page_size: 25 }),
      ])
      if (requestId !== inspectRequestId) return
      set({ summary, details, episodes, episode: null, loading: false })
    } catch (error) {
      if (requestId !== inspectRequestId) return
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
  loadEpisode: async (episodeIndex) => {
    const { source, dataset } = get()
    const requestId = ++episodeRequestId
    set({ loading: true, error: '' })
    try {
      const episode = await dataApi.inspectEpisode({
        source,
        dataset: dataset || undefined,
        episode_index: episodeIndex,
        preview: false,
      })
      const current = get()
      if (requestId !== episodeRequestId || current.source !== source || current.dataset !== dataset) return
      set({ episode, loading: false })
    } catch (error) {
      if (requestId !== episodeRequestId) return
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
}))
