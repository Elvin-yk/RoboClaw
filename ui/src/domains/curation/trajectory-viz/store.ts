import { create } from 'zustand'
import { fetchSo101Model, fetchTrajectory } from './api'
import type { So101Model, TrajectoryPayload, Signal } from './types'

interface EeReadout {
    leftWorld: [number, number, number] | null
    rightWorld: [number, number, number] | null
    relative: { dx: number; dy: number; dz: number; dist: number } | null
}

interface TrajectoryVizState {
    model: So101Model | null
    payload: TrajectoryPayload | null
    loading: boolean
    error: string | null
    dataset: string
    episodeIndex: number
    signal: Signal
    speed: number
    isPlaying: boolean
    timeSec: number
    currentFrame: number
    ee: EeReadout
    setDataset: (v: string) => void
    setEpisodeIndex: (v: number) => void
    setSignal: (v: Signal) => void
    setSpeed: (v: number) => void
    loadModel: () => Promise<void>
    loadTrajectory: () => Promise<void>
    setPlaying: (v: boolean) => void
    setTime: (timeSec: number, frame: number) => void
    setEe: (ee: EeReadout) => void
}

export const useTrajectoryVizStore = create<TrajectoryVizState>((set, get) => ({
    model: null,
    payload: null,
    loading: false,
    error: null,
    dataset: 'screw_20260503_c500b701',
    episodeIndex: 0,
    signal: 'state',
    speed: 1,
    isPlaying: false,
    timeSec: 0,
    currentFrame: 0,
    ee: { leftWorld: null, rightWorld: null, relative: null },

    setDataset: (v) => set({ dataset: v }),
    setEpisodeIndex: (v) => set({ episodeIndex: v }),
    setSignal: (v) => set({ signal: v }),
    setSpeed: (v) => set({ speed: v }),
    setPlaying: (v) => set({ isPlaying: v }),
    setTime: (timeSec, frame) => set({ timeSec, currentFrame: frame }),
    setEe: (ee) => set({ ee }),

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

    loadTrajectory: async () => {
        const { dataset, episodeIndex, signal } = get()
        if (!dataset) {
            set({ error: 'Dataset name required' })
            return
        }
        set({ loading: true, error: null, isPlaying: false })
        try {
            const payload = await fetchTrajectory({
                source: 'local',
                dataset,
                episode_index: episodeIndex,
                signal,
            })
            set({
                payload,
                loading: false,
                timeSec: payload.time_s[0] ?? 0,
                currentFrame: 0,
            })
        } catch (e) {
            set({ error: errorMessage(e), loading: false })
        }
    },
}))

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
