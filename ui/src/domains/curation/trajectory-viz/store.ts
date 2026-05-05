import { create } from 'zustand'
import {
    fetchSo101Model,
    fetchTrajectory,
    fetchTrajectoryDatasets,
    fetchTrajectoryEpisodes,
} from './api'
import type {
    Signal,
    So101Model,
    TrajectoryDatasetOption,
    TrajectoryDatasetRef,
    TrajectoryEpisodePage,
    TrajectoryMetrics,
    TrajectoryPayload,
} from './types'

interface TrajectoryVizState {
    model: So101Model | null
    payload: TrajectoryPayload | null
    loading: boolean
    error: string | null
    datasetOptions: TrajectoryDatasetOption[]
    selectedDataset: TrajectoryDatasetRef | null
    episodePage: TrajectoryEpisodePage | null
    episodeIndex: number | null
    signal: Signal
    speed: number
    isPlaying: boolean
    timeSec: number
    currentFrame: number
    metrics: TrajectoryMetrics | null
    datasetsLoading: boolean
    episodesLoading: boolean
    setSignal: (v: Signal) => void
    setSpeed: (v: number) => void
    loadModel: () => Promise<void>
    loadDatasets: () => Promise<void>
    selectDataset: (option: TrajectoryDatasetOption) => Promise<void>
    loadEpisodes: (ref?: TrajectoryDatasetRef, page?: number) => Promise<void>
    selectEpisode: (v: number) => void
    setMetrics: (m: TrajectoryMetrics | null) => void
    loadTrajectory: () => Promise<void>
    setPlaying: (v: boolean) => void
    setTime: (timeSec: number, frame: number) => void
}

// Module-level monotonic counters guard against stale async writes when
// the user changes selection mid-fetch. Each in-flight request captures the
// counter and bails on commit if a newer request superseded it.
let episodesSeq = 0
let trajectorySeq = 0

export const useTrajectoryVizStore = create<TrajectoryVizState>((set, get) => ({
    model: null,
    payload: null,
    loading: false,
    error: null,
    datasetOptions: [],
    selectedDataset: null,
    episodePage: null,
    episodeIndex: null,
    signal: 'state',
    speed: 1,
    isPlaying: false,
    timeSec: 0,
    currentFrame: 0,
    metrics: null,
    datasetsLoading: false,
    episodesLoading: false,

    setSignal: (v) => set({ signal: v }),
    setSpeed: (v) => set({ speed: v }),
    setPlaying: (v) => set({ isPlaying: v }),
    setTime: (timeSec, frame) => set({ timeSec, currentFrame: frame }),
    setMetrics: (m) => set({ metrics: m }),

    selectEpisode: (v) => {
        trajectorySeq += 1
        set({ episodeIndex: v, ...clearedTrajectoryState() })
    },

    loadModel: async () => {
        if (get().model) return
        set({ loading: true, error: null })
        try {
            const model = await fetchSo101Model()
            set({ model, loading: false })
        } catch (e) {
            set({ error: errorMessage(e), loading: false })
        }
    },

    loadDatasets: async () => {
        set({ datasetsLoading: true, error: null })
        try {
            const options = await fetchTrajectoryDatasets()
            set({ datasetOptions: options, datasetsLoading: false })
            if (options.length === 1 && get().selectedDataset === null) {
                await get().selectDataset(options[0])
            }
        } catch (e) {
            set({ error: errorMessage(e), datasetsLoading: false })
        }
    },

    selectDataset: async (option) => {
        // Selection change invalidates any in-flight episode and trajectory fetches.
        episodesSeq += 1
        trajectorySeq += 1
        const ref = datasetRefFromOption(option)
        set({
            selectedDataset: ref,
            episodePage: null,
            episodeIndex: null,
            ...clearedTrajectoryState(),
        })
        await get().loadEpisodes(ref)
    },

    loadEpisodes: async (ref, page = 1) => {
        const target = ref ?? get().selectedDataset
        if (!target) return
        const my = ++episodesSeq
        set({ episodesLoading: true, error: null })
        try {
            const episodePage = await fetchTrajectoryEpisodes(target, page, 200)
            if (my !== episodesSeq) return
            const firstIndex = episodePage.episodes[0]?.episode_index ?? null
            // Pure pagination shouldn't blow away current playback. Only set
            // episodeIndex when the previously selected one is no longer in this
            // page (e.g. on initial dataset selection, set to first episode).
            const current = get().episodeIndex
            const stillInPage = current !== null && episodePage.episodes.some((e) => e.episode_index === current)
            set({
                episodePage,
                episodeIndex: stillInPage ? current : firstIndex,
                episodesLoading: false,
            })
        } catch (e) {
            if (my !== episodesSeq) return
            set({ error: errorMessage(e), episodesLoading: false })
        }
    },

    loadTrajectory: async () => {
        const { selectedDataset, episodeIndex, signal } = get()
        if (!selectedDataset || episodeIndex === null) {
            set({ error: 'Select a dataset and episode first' })
            return
        }
        const my = ++trajectorySeq
        set({ loading: true, error: null, isPlaying: false })
        try {
            const payload = await fetchTrajectory({
                source: selectedDataset.source,
                dataset: selectedDataset.dataset,
                path: selectedDataset.path,
                episode_index: episodeIndex,
                signal,
            })
            if (my !== trajectorySeq) return
            set({
                payload,
                loading: false,
                metrics: null,
                timeSec: payload.time_s[0] ?? 0,
                currentFrame: 0,
            })
        } catch (e) {
            if (my !== trajectorySeq) return
            set({ error: errorMessage(e), loading: false })
        }
    },
}))

function datasetRefFromOption(option: TrajectoryDatasetOption): TrajectoryDatasetRef {
    return {
        source: option.source,
        dataset: option.id,
        label: option.label || option.id,
    }
}

function clearedTrajectoryState() {
    return {
        payload: null,
        metrics: null,
        isPlaying: false,
        timeSec: 0,
        currentFrame: 0,
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
