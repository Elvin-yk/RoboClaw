import { create } from 'zustand'
import { fetchSo101Model, fetchTrajectory } from './api'
import {
    fetchExplorerEpisodePage,
    listExplorerDatasets,
    type ExplorerDatasetRef,
    type ExplorerDatasetSuggestion,
    type ExplorerEpisodePage,
} from '@/shared/api/explorer'
import {
    buildBelowThresholdRanges,
    summarizeDistanceSeries,
    type BelowThresholdRange,
    type DistanceStats,
} from './distanceSeries'
import type {
    Signal,
    So101Model,
    TrajectoryMetrics,
    TrajectoryPayload,
} from './types'

interface TrajectoryVizState {
    model: So101Model | null
    payload: TrajectoryPayload | null
    loading: boolean
    error: string | null
    datasetOptions: ExplorerDatasetSuggestion[]
    selectedDataset: ExplorerDatasetRef | null
    episodePage: ExplorerEpisodePage | null
    episodeIndex: number | null
    signal: Signal
    speed: number
    isPlaying: boolean
    timeSec: number
    currentFrame: number
    metrics: TrajectoryMetrics | null
    datasetsLoading: boolean
    episodesLoading: boolean
    distanceSeries: Float32Array | null
    distanceSeriesLoading: boolean
    distanceSeriesTimeS: number[] | null
    distanceStats: DistanceStats | null
    distanceThresholdRanges: BelowThresholdRange[]
    distanceThresholdM: number
    setSignal: (v: Signal) => void
    setSpeed: (v: number) => void
    loadModel: () => Promise<void>
    loadDatasets: () => Promise<void>
    selectDataset: (option: ExplorerDatasetSuggestion) => Promise<void>
    loadEpisodes: (ref?: ExplorerDatasetRef, page?: number) => Promise<void>
    selectEpisode: (v: number) => void
    setMetrics: (m: TrajectoryMetrics | null) => void
    loadTrajectory: () => Promise<void>
    setPlaying: (v: boolean) => void
    setTime: (timeSec: number, frame: number) => void
    setDistanceSeries: (series: Float32Array | null, timeS: number[] | null) => void
    setDistanceSeriesLoading: (v: boolean) => void
    setDistanceThresholdM: (v: number) => void
    bumpDistanceSeq: () => number
    getDistanceSeq: () => number
}

// Module-level monotonic counters guard against stale async writes when
// the user changes selection mid-fetch. Each in-flight request captures the
// counter and bails on commit if a newer request superseded it.
let episodesSeq = 0
let trajectorySeq = 0
let distanceSeq = 0

const DEFAULT_DISTANCE_THRESHOLD_M = 0.05

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
    distanceSeries: null,
    distanceSeriesLoading: false,
    distanceSeriesTimeS: null,
    distanceStats: null,
    distanceThresholdRanges: [],
    distanceThresholdM: DEFAULT_DISTANCE_THRESHOLD_M,

    setSignal: (v) => set({ signal: v }),
    setSpeed: (v) => set({ speed: v }),
    setPlaying: (v) => set({ isPlaying: v }),
    setTime: (timeSec, frame) => set({ timeSec, currentFrame: frame }),
    setMetrics: (m) => set({ metrics: m }),

    setDistanceSeries: (series, timeS) => {
        if (!series || !timeS) {
            set({
                distanceSeries: null,
                distanceSeriesTimeS: null,
                distanceStats: null,
                distanceThresholdRanges: [],
                distanceSeriesLoading: false,
            })
            return
        }
        const threshold = get().distanceThresholdM
        set({
            distanceSeries: series,
            distanceSeriesTimeS: timeS,
            distanceStats: summarizeDistanceSeries(series, threshold),
            distanceThresholdRanges: buildBelowThresholdRanges(series, threshold, timeS),
            distanceSeriesLoading: false,
        })
    },
    setDistanceSeriesLoading: (v) => set({ distanceSeriesLoading: v }),
    setDistanceThresholdM: (v) => {
        const series = get().distanceSeries
        const timeS = get().distanceSeriesTimeS
        if (!series || !timeS) {
            set({ distanceThresholdM: v })
            return
        }
        set({
            distanceThresholdM: v,
            distanceStats: summarizeDistanceSeries(series, v),
            distanceThresholdRanges: buildBelowThresholdRanges(series, v, timeS),
        })
    },
    bumpDistanceSeq: () => ++distanceSeq,
    getDistanceSeq: () => distanceSeq,

    selectEpisode: (v) => {
        trajectorySeq += 1
        distanceSeq += 1
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
            const options = await listExplorerDatasets('local', 500)
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
        distanceSeq += 1
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
            const episodePage = await fetchExplorerEpisodePage(target, page, 200)
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
        if (selectedDataset.source === 'remote') {
            set({ error: 'Remote datasets are not supported by trajectory replay' })
            return
        }
        const my = ++trajectorySeq
        distanceSeq += 1
        set({
            loading: true,
            error: null,
            isPlaying: false,
            distanceSeries: null,
            distanceSeriesTimeS: null,
            distanceStats: null,
            distanceThresholdRanges: [],
            distanceSeriesLoading: false,
        })
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

function datasetRefFromOption(option: ExplorerDatasetSuggestion): ExplorerDatasetRef {
    return {
        source: option.source ?? 'local',
        dataset: option.id,
        path: option.path,
    }
}

function clearedTrajectoryState() {
    return {
        payload: null,
        metrics: null,
        isPlaying: false,
        timeSec: 0,
        currentFrame: 0,
        distanceSeries: null,
        distanceSeriesTimeS: null,
        distanceStats: null,
        distanceThresholdRanges: [],
        distanceSeriesLoading: false,
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
