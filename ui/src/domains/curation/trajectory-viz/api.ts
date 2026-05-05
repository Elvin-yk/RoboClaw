import { api } from '@/shared/api/client'
import type { So101Model, TrajectoryPayload, Signal } from './types'

export function fetchSo101Model(): Promise<So101Model> {
    return api<So101Model>('/api/trajectory-viz/model/so101')
}

export interface FetchTrajectoryArgs {
    source: 'local' | 'path'
    dataset?: string
    path?: string
    episode_index: number
    signal: Signal
    stride?: number
    start_frame?: number
    end_frame?: number
}

export function fetchTrajectory(args: FetchTrajectoryArgs): Promise<TrajectoryPayload> {
    const params = new URLSearchParams()
    params.set('source', args.source)
    if (args.dataset) params.set('dataset', args.dataset)
    if (args.path) params.set('path', args.path)
    params.set('episode_index', String(args.episode_index))
    params.set('signal', args.signal)
    if (args.stride !== undefined) params.set('stride', String(args.stride))
    if (args.start_frame !== undefined) params.set('start_frame', String(args.start_frame))
    if (args.end_frame !== undefined) params.set('end_frame', String(args.end_frame))
    return api<TrajectoryPayload>(`/api/trajectory-viz/trajectory?${params.toString()}`)
}
