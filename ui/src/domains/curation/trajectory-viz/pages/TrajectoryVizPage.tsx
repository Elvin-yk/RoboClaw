import { useEffect, useRef } from 'react'
import { useTrajectoryVizStore } from '../store'
import { DualArmScene } from '../scene'
import { PlaybackClock } from '../playbackClock'
import type { Signal, TrajectoryPayload } from '../types'

const READOUT_HZ = 10

export default function TrajectoryVizPage() {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const sceneRef = useRef<DualArmScene | null>(null)
    const clockRef = useRef<PlaybackClock | null>(null)
    const lastReadoutRef = useRef(0)

    const model = useTrajectoryVizStore((s) => s.model)
    const payload = useTrajectoryVizStore((s) => s.payload)
    const loading = useTrajectoryVizStore((s) => s.loading)
    const error = useTrajectoryVizStore((s) => s.error)
    const dataset = useTrajectoryVizStore((s) => s.dataset)
    const episodeIndex = useTrajectoryVizStore((s) => s.episodeIndex)
    const signal = useTrajectoryVizStore((s) => s.signal)
    const speed = useTrajectoryVizStore((s) => s.speed)
    const isPlaying = useTrajectoryVizStore((s) => s.isPlaying)
    const timeSec = useTrajectoryVizStore((s) => s.timeSec)
    const currentFrame = useTrajectoryVizStore((s) => s.currentFrame)
    const ee = useTrajectoryVizStore((s) => s.ee)
    const setDataset = useTrajectoryVizStore((s) => s.setDataset)
    const setEpisodeIndex = useTrajectoryVizStore((s) => s.setEpisodeIndex)
    const setSignal = useTrajectoryVizStore((s) => s.setSignal)
    const setSpeed = useTrajectoryVizStore((s) => s.setSpeed)
    const loadModel = useTrajectoryVizStore((s) => s.loadModel)
    const loadTrajectory = useTrajectoryVizStore((s) => s.loadTrajectory)
    const setPlaying = useTrajectoryVizStore((s) => s.setPlaying)
    const setTime = useTrajectoryVizStore((s) => s.setTime)
    const setEe = useTrajectoryVizStore((s) => s.setEe)

    useEffect(() => {
        void loadModel()
    }, [loadModel])

    useEffect(() => {
        if (!model || !containerRef.current || sceneRef.current) return
        const scene = new DualArmScene(containerRef.current)
        sceneRef.current = scene
        void scene.loadArm('left', model)

        const clock = new PlaybackClock()
        clockRef.current = clock
        // Read payload via getState() so the subscriber always sees the latest
        // store value — re-subscribing on every payload change would tear down
        // and rebuild the WebGL scene.
        const unsubscribePlaying = clock.subscribePlaying((playing) => setPlaying(playing))
        const unsubscribe = clock.subscribe((tick) => {
            const current: TrajectoryPayload | null = useTrajectoryVizStore.getState().payload
            if (!current) return
            const startTs = current.time_s[0] ?? 0
            const nextTs = current.time_s[Math.min(current.frame_count - 1, tick.frame + 1)]
            const curTs = current.time_s[tick.frame]
            const span = Math.max(1e-6, nextTs - curTs)
            const alpha = (tick.timeSec - curTs) / span
            const samples = scene.applyFrame(current, tick.frame, alpha)
            const now = performance.now()
            if (now - lastReadoutRef.current < 1000 / READOUT_HZ) return
            lastReadoutRef.current = now
            setTime(tick.timeSec - startTs, tick.frame)
            const left = samples.find((s) => s.side === 'left') ?? null
            const right = samples.find((s) => s.side === 'right') ?? null
            setEe({
                leftWorld: left ? [left.eeWorld.x, left.eeWorld.y, left.eeWorld.z] : null,
                rightWorld: right ? [right.eeWorld.x, right.eeWorld.y, right.eeWorld.z] : null,
                relative: left && right
                    ? {
                        dx: right.eeWorld.x - left.eeWorld.x,
                        dy: right.eeWorld.y - left.eeWorld.y,
                        dz: right.eeWorld.z - left.eeWorld.z,
                        dist: right.eeWorld.distanceTo(left.eeWorld),
                    }
                    : null,
            })
        })
        return () => {
            unsubscribe()
            unsubscribePlaying()
            clock.pause()
            scene.dispose()
            sceneRef.current = null
            clockRef.current = null
        }
    }, [model, setEe, setTime, setPlaying])

    useEffect(() => {
        if (!payload || !clockRef.current) return
        clockRef.current.setTimeline(payload.time_s)
    }, [payload])

    useEffect(() => {
        clockRef.current?.setSpeed(speed)
    }, [speed])

    useEffect(() => {
        if (!clockRef.current) return
        if (isPlaying) clockRef.current.play()
        else clockRef.current.pause()
    }, [isPlaying])

    const duration = payload ? payload.time_s[payload.frame_count - 1] - payload.time_s[0] : 0

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '12px', gap: '12px' }}>
            <header style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>Trajectory Replay</strong>
                <input
                    aria-label="dataset"
                    value={dataset}
                    onChange={(e) => setDataset(e.target.value)}
                    placeholder="dataset name"
                    style={{ padding: '4px 8px', minWidth: 240 }}
                />
                <label>
                    episode{' '}
                    <input
                        aria-label="episode index"
                        type="number"
                        value={episodeIndex}
                        onChange={(e) => setEpisodeIndex(Number(e.target.value))}
                        style={{ width: 60 }}
                    />
                </label>
                <label>
                    signal{' '}
                    <select value={signal} onChange={(e) => setSignal(e.target.value as Signal)}>
                        <option value="state">state</option>
                        <option value="action">action</option>
                    </select>
                </label>
                <button onClick={() => void loadTrajectory()} disabled={loading}>
                    Load
                </button>
                {loading && <span>loading…</span>}
                {error && <span style={{ color: 'crimson' }}>{error}</span>}
            </header>

            <div
                ref={containerRef}
                style={{
                    flex: 1,
                    minHeight: 320,
                    border: '1px solid #d1d5db',
                    borderRadius: 4,
                    overflow: 'hidden',
                }}
            />

            <footer style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button onClick={() => setPlaying(!isPlaying)} disabled={!payload}>
                        {isPlaying ? 'Pause' : 'Play'}
                    </button>
                    <input
                        type="range"
                        min={0}
                        max={duration}
                        step={1 / 60}
                        value={timeSec}
                        onChange={(e) => {
                            const v = Number(e.target.value)
                            const startTs = payload?.time_s[0] ?? 0
                            // Reset throttle so the subscriber syncs the new
                            // frame to React state on this scrub emit.
                            lastReadoutRef.current = 0
                            clockRef.current?.scrubTo(startTs + v)
                        }}
                        disabled={!payload}
                        style={{ flex: 1 }}
                    />
                    <span>
                        {timeSec.toFixed(2)}s / {duration.toFixed(2)}s
                    </span>
                    <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                        {[0.25, 0.5, 1, 2, 4].map((v) => (
                            <option key={v} value={v}>
                                {v}x
                            </option>
                        ))}
                    </select>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#374151' }}>
                    frame {currentFrame}{payload ? ` / ${payload.frame_count - 1}` : ''}
                    {ee.leftWorld && (
                        <>
                            {' '}| left ee=[
                            {ee.leftWorld.map((v) => v.toFixed(3)).join(', ')}]
                        </>
                    )}
                    {ee.relative && (
                        <>
                            {' '}| dist={ee.relative.dist.toFixed(3)}m
                        </>
                    )}
                </div>
            </footer>
        </div>
    )
}
