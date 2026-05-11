import { useCallback, useRef, useState } from 'react'
import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import { asRecord, textValue } from '@/domains/data/lib/analysisPayload'
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

interface InspectSnapshot {
  source: InspectSource
  dataset: string
  summary: InspectSummary | null
  details: Record<string, unknown> | null
  episodes: Record<string, unknown> | null
  episode: Record<string, unknown> | null
  loading: boolean
  error: string
}

let inspectRequestId = 0
let episodeRequestId = 0

const EMPTY_INSPECT_DATA = {
  summary: null,
  details: null,
  episodes: null,
  episode: null,
  error: '',
}

export const useDataInspectStore = create<InspectState>((set, get) => ({
  source: 'local',
  dataset: '',
  summary: null,
  details: null,
  episodes: null,
  episode: null,
  loading: false,
  error: '',
  setSource: (source) => {
    inspectRequestId += 1
    episodeRequestId += 1
    set({ source, ...EMPTY_INSPECT_DATA, loading: false })
  },
  setDataset: (dataset) => {
    inspectRequestId += 1
    episodeRequestId += 1
    set({ dataset, ...EMPTY_INSPECT_DATA, loading: false })
  },
  inspect: async () => {
    const { source, dataset } = get()
    const requestId = ++inspectRequestId
    set({ ...EMPTY_INSPECT_DATA, loading: true })
    try {
      const params = { source, dataset: dataset || undefined }
      const [details, episodes] = await Promise.all([
        dataApi.inspectDetails(params),
        dataApi.inspectEpisodes({ ...params, page: 1, page_size: 25 }),
      ])
      if (requestId !== inspectRequestId) return
      set({ summary: summaryFromDetails(details), details, episodes, episode: null, loading: false })
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
      if (requestId !== episodeRequestId) return
      if (current.source !== source || current.dataset !== dataset) {
        set({ loading: false })
        return
      }
      set({ episode, loading: false })
    } catch (error) {
      if (requestId !== episodeRequestId) return
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
}))

export function useDataInspectWorkspace() {
  const [state, setState] = useState<InspectSnapshot>({
    source: 'local',
    dataset: '',
    summary: null,
    details: null,
    episodes: null,
    episode: null,
    loading: false,
    error: '',
  })
  const stateRef = useRef(state)
  const inspectRequestRef = useRef(0)
  const episodeRequestRef = useRef(0)

  const commit = useCallback((next: Partial<InspectSnapshot> | ((current: InspectSnapshot) => InspectSnapshot)) => {
    const nextState = typeof next === 'function' ? next(stateRef.current) : { ...stateRef.current, ...next }
    stateRef.current = nextState
    setState(nextState)
  }, [])

  const reset = useCallback(() => {
    inspectRequestRef.current += 1
    episodeRequestRef.current += 1
    commit({
      source: 'local',
      dataset: '',
      ...EMPTY_INSPECT_DATA,
      loading: false,
    })
  }, [commit])

  const setSource = useCallback((source: InspectSource) => {
    inspectRequestRef.current += 1
    episodeRequestRef.current += 1
    commit({ source, ...EMPTY_INSPECT_DATA, loading: false })
  }, [commit])

  const setDataset = useCallback((dataset: string) => {
    inspectRequestRef.current += 1
    episodeRequestRef.current += 1
    commit({ dataset, ...EMPTY_INSPECT_DATA, loading: false })
  }, [commit])

  const inspect = useCallback(async () => {
    const { source, dataset } = stateRef.current
    if (!dataset.trim()) {
      commit({ ...EMPTY_INSPECT_DATA, loading: false })
      return
    }
    const requestId = ++inspectRequestRef.current
    commit({ ...EMPTY_INSPECT_DATA, loading: true })
    try {
      const params = { source, dataset: dataset || undefined }
      const [details, episodes] = await Promise.all([
        dataApi.inspectDetails(params),
        dataApi.inspectEpisodes({ ...params, page: 1, page_size: 25 }),
      ])
      if (requestId !== inspectRequestRef.current) return
      commit({ summary: summaryFromDetails(details), details, episodes, episode: null, loading: false })
    } catch (error) {
      if (requestId !== inspectRequestRef.current) return
      commit({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }, [commit])

  const loadEpisode = useCallback(async (episodeIndex: number) => {
    const { source, dataset } = stateRef.current
    if (!dataset.trim()) {
      commit({ loading: false })
      return
    }
    const requestId = ++episodeRequestRef.current
    commit({ loading: true, error: '' })
    try {
      const episode = await dataApi.inspectEpisode({
        source,
        dataset: dataset || undefined,
        episode_index: episodeIndex,
        preview: false,
      })
      const current = stateRef.current
      if (requestId !== episodeRequestRef.current) return
      if (current.source !== source || current.dataset !== dataset) {
        commit({ loading: false })
        return
      }
      commit({ episode, loading: false })
    } catch (error) {
      if (requestId !== episodeRequestRef.current) return
      commit({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  }, [commit])

  return {
    ...state,
    reset,
    setSource,
    setDataset,
    inspect,
    loadEpisode,
  }
}

function summaryFromDetails(details: Record<string, unknown>): InspectSummary {
  return {
    dataset: textValue(details.dataset),
    summary: asRecord(details.summary),
  }
}
