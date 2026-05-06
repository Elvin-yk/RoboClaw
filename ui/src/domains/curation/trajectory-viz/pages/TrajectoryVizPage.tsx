import { useEffect, useRef } from 'react'
import { useI18n } from '@/i18n'
import { ActionButton } from '@/shared/ui'
import { cn } from '@/shared/lib/cn'
import { useTrajectoryVizStore } from '../store'
import { DualArmScene, buildFrameMetrics } from '../scene'
import { DualArmKinematics } from '../kinematics'
import { PlaybackClock } from '../playbackClock'
import MetricsPanel from '../components/MetricsPanel'
import DistanceSparkline from '../components/DistanceSparkline'
import DistanceControls from '../components/DistanceControls'
import type { ArmReadout, Signal, TrajectoryPayload } from '../types'
import type { ArmFrameSample } from '../scene'

const READOUT_HZ = 10

const selectClass = cn(
    'rounded-lg border border-bd bg-sf px-3 py-1.5 text-sm text-tx shadow-sm',
    'transition focus:border-ac focus:outline-none focus:ring-2 focus:ring-ac/30',
    'disabled:cursor-not-allowed disabled:opacity-50',
)

const fieldLabelClass = 'flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-tx2'

const pagerButtonClass = cn(
    'rounded-md border border-bd bg-sf px-2 py-1 text-xs font-medium text-tx',
    'transition hover:border-ac hover:text-ac',
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-bd disabled:hover:text-tx',
)

export default function TrajectoryVizPage() {
    const { t } = useI18n()
    const containerRef = useRef<HTMLDivElement | null>(null)
    const sceneRef = useRef<DualArmScene | null>(null)
    const clockRef = useRef<PlaybackClock | null>(null)
    const kinematicsRef = useRef<DualArmKinematics | null>(null)
    const distanceAbortRef = useRef<AbortController | null>(null)
    const lastReadoutRef = useRef(0)

    const model = useTrajectoryVizStore((s) => s.model)
    const payload = useTrajectoryVizStore((s) => s.payload)
    const loading = useTrajectoryVizStore((s) => s.loading)
    const error = useTrajectoryVizStore((s) => s.error)
    const datasetOptions = useTrajectoryVizStore((s) => s.datasetOptions)
    const selectedDataset = useTrajectoryVizStore((s) => s.selectedDataset)
    const episodePage = useTrajectoryVizStore((s) => s.episodePage)
    const episodeIndex = useTrajectoryVizStore((s) => s.episodeIndex)
    const signal = useTrajectoryVizStore((s) => s.signal)
    const speed = useTrajectoryVizStore((s) => s.speed)
    const isPlaying = useTrajectoryVizStore((s) => s.isPlaying)
    const timeSec = useTrajectoryVizStore((s) => s.timeSec)
    const datasetsLoading = useTrajectoryVizStore((s) => s.datasetsLoading)
    const episodesLoading = useTrajectoryVizStore((s) => s.episodesLoading)
    const setSignal = useTrajectoryVizStore((s) => s.setSignal)
    const setSpeed = useTrajectoryVizStore((s) => s.setSpeed)
    const loadModel = useTrajectoryVizStore((s) => s.loadModel)
    const loadDatasets = useTrajectoryVizStore((s) => s.loadDatasets)
    const selectDataset = useTrajectoryVizStore((s) => s.selectDataset)
    const loadEpisodes = useTrajectoryVizStore((s) => s.loadEpisodes)
    const selectEpisode = useTrajectoryVizStore((s) => s.selectEpisode)
    const loadTrajectory = useTrajectoryVizStore((s) => s.loadTrajectory)
    const setPlaying = useTrajectoryVizStore((s) => s.setPlaying)
    const setTime = useTrajectoryVizStore((s) => s.setTime)
    const setMetrics = useTrajectoryVizStore((s) => s.setMetrics)
    const distanceSeries = useTrajectoryVizStore((s) => s.distanceSeries)
    const distanceSeriesLoading = useTrajectoryVizStore((s) => s.distanceSeriesLoading)
    const distanceThresholdM = useTrajectoryVizStore((s) => s.distanceThresholdM)
    const distanceThresholdRanges = useTrajectoryVizStore((s) => s.distanceThresholdRanges)
    const currentFrame = useTrajectoryVizStore((s) => s.currentFrame)
    const setDistanceSeries = useTrajectoryVizStore((s) => s.setDistanceSeries)
    const setDistanceSeriesLoading = useTrajectoryVizStore((s) => s.setDistanceSeriesLoading)
    const bumpDistanceSeq = useTrajectoryVizStore((s) => s.bumpDistanceSeq)
    const getDistanceSeq = useTrajectoryVizStore((s) => s.getDistanceSeq)

    useEffect(() => {
        void loadModel()
        void loadDatasets()
    }, [loadModel, loadDatasets])

    useEffect(() => {
        if (!model || !containerRef.current || sceneRef.current) return
        const fkDebug = new URLSearchParams(window.location.search).get('fkDebug') === '1'
        const scene = new DualArmScene(containerRef.current, { axesHelper: fkDebug })
        sceneRef.current = scene
        scene.loadArms(model).catch((err) => {
            useTrajectoryVizStore.setState({
                error: err instanceof Error ? err.message : String(err),
            })
        })

        const kinematics = new DualArmKinematics()
        kinematicsRef.current = kinematics
        kinematics.load(model).catch((err) => {
            useTrajectoryVizStore.setState({
                error: err instanceof Error ? err.message : String(err),
            })
        })

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
            const elapsed = tick.timeSec - startTs
            setTime(elapsed, tick.frame)
            const { left, right, relative } = buildFrameMetrics(samples)
            setMetrics({
                frame: tick.frame,
                rawFrame: current.frame_index[tick.frame] ?? null,
                timeSec: elapsed,
                left: armReadout(left),
                right: armReadout(right),
                eeRelativeM: relative,
            })
        })
        return () => {
            unsubscribe()
            unsubscribePlaying()
            clock.pause()
            scene.dispose()
            sceneRef.current = null
            clockRef.current = null
            distanceAbortRef.current?.abort()
            distanceAbortRef.current = null
            kinematics.dispose()
            kinematicsRef.current = null
        }
    }, [model, setMetrics, setTime, setPlaying])

    useEffect(() => {
        if (!payload || !clockRef.current) return
        clockRef.current.setTimeline(payload.time_s)
    }, [payload])

    useEffect(() => {
        if (!payload) return
        const kinematics = kinematicsRef.current
        if (!kinematics) return
        distanceAbortRef.current?.abort()
        const ac = new AbortController()
        distanceAbortRef.current = ac
        const my = bumpDistanceSeq()
        setDistanceSeriesLoading(true)
        kinematics
            .computeDistanceSeries(payload, { signal: ac.signal, chunkSize: 256 })
            .then((series) => {
                if (my !== getDistanceSeq()) return
                setDistanceSeries(series, payload.time_s)
            })
            .catch((err: unknown) => {
                if (err instanceof DOMException && err.name === 'AbortError') return
                if (my !== getDistanceSeq()) return
                setDistanceSeriesLoading(false)
                useTrajectoryVizStore.setState({
                    error: err instanceof Error ? err.message : String(err),
                })
            })
        return () => {
            ac.abort()
        }
    }, [payload, bumpDistanceSeq, getDistanceSeq, setDistanceSeries, setDistanceSeriesLoading])

    useEffect(() => {
        clockRef.current?.setSpeed(speed)
    }, [speed])

    useEffect(() => {
        if (!clockRef.current) return
        if (isPlaying) clockRef.current.play()
        else clockRef.current.pause()
    }, [isPlaying])

    const duration = payload ? payload.time_s[payload.frame_count - 1] - payload.time_s[0] : 0
    const canLoad = !!selectedDataset && episodeIndex !== null && !loading
    const anyLoading = loading || datasetsLoading || episodesLoading

    return (
        <div className="page-enter flex h-full flex-col gap-4 overflow-y-auto px-6 py-4">
            <header className="flex flex-wrap items-center gap-3 rounded-2xl border border-bd/60 bg-sf/95 px-4 py-3 shadow-card">
                <div className="flex items-center gap-2">
                    <h2 className="display-title text-xl text-tx md:text-2xl">{t('trajectoryReplay')}</h2>
                </div>
                <label className={fieldLabelClass}>
                    <span>{t('trajVizDataset')}</span>
                    <select
                        aria-label="dataset"
                        value={selectedDataset?.dataset ?? ''}
                        onChange={(e) => {
                            const opt = datasetOptions.find((o) => o.id === e.target.value)
                            if (opt) void selectDataset(opt)
                        }}
                        disabled={datasetsLoading || datasetOptions.length === 0}
                        className={cn(selectClass, 'min-w-[240px]')}
                    >
                        {selectedDataset === null && <option value="">{t('trajVizSelect')}</option>}
                        {datasetOptions.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                                {opt.label || opt.id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className={fieldLabelClass}>
                    <span>{t('trajVizEpisode')}</span>
                    <select
                        aria-label="episode index"
                        value={episodeIndex ?? ''}
                        onChange={(e) => {
                            const v = Number(e.target.value)
                            if (Number.isFinite(v)) selectEpisode(v)
                        }}
                        disabled={episodesLoading || !episodePage || episodePage.episodes.length === 0}
                        className={cn(selectClass, 'min-w-[80px]')}
                    >
                        {episodeIndex === null && <option value="">—</option>}
                        {episodePage?.episodes.map((ep) => (
                            <option key={ep.episode_index} value={ep.episode_index}>
                                {ep.episode_index}
                            </option>
                        ))}
                    </select>
                </label>
                {episodePage && episodePage.total_pages > 1 && (
                    <div className="flex items-center gap-1.5 text-xs text-tx2">
                        <button
                            type="button"
                            onClick={() => selectedDataset && void loadEpisodes(selectedDataset, episodePage.page - 1)}
                            disabled={episodePage.page <= 1 || episodesLoading}
                            className={pagerButtonClass}
                        >
                            {t('trajVizPrev')}
                        </button>
                        <span className="font-mono tabular-nums text-tx">
                            {episodePage.page} / {episodePage.total_pages}
                        </span>
                        <button
                            type="button"
                            onClick={() => selectedDataset && void loadEpisodes(selectedDataset, episodePage.page + 1)}
                            disabled={episodePage.page >= episodePage.total_pages || episodesLoading}
                            className={pagerButtonClass}
                        >
                            {t('trajVizNext')}
                        </button>
                    </div>
                )}
                <label className={fieldLabelClass}>
                    <span>{t('trajVizSignal')}</span>
                    <select
                        value={signal}
                        onChange={(e) => setSignal(e.target.value as Signal)}
                        className={selectClass}
                    >
                        <option value="state">{t('trajVizSignalState')}</option>
                        <option value="action">{t('trajVizSignalAction')}</option>
                    </select>
                </label>
                <ActionButton
                    variant="primary"
                    onClick={() => void loadTrajectory()}
                    disabled={!canLoad}
                    className="px-5 py-2 text-sm"
                >
                    {t('trajVizLoad')}
                </ActionButton>
                {anyLoading && (
                    <span className="font-mono text-xs text-tx2">{t('trajVizLoadingShort')}</span>
                )}
                {error && (
                    <span className="rounded-md bg-rd/10 px-2 py-1 font-mono text-xs text-rd">{error}</span>
                )}
            </header>

            <div
                ref={containerRef}
                className="flex-1 min-h-[320px] overflow-hidden rounded-2xl border border-bd/60 bg-sf/95 shadow-card"
            />

            <footer className="flex flex-col gap-3 rounded-2xl border border-bd/60 bg-sf/95 p-4 shadow-card">
                {distanceSeries && payload && (
                    <DistanceSparkline
                        series={distanceSeries}
                        thresholdM={distanceThresholdM}
                        ranges={distanceThresholdRanges}
                        currentFrame={currentFrame}
                        onScrub={(frame) => {
                            const ts = payload.time_s[Math.max(0, Math.min(payload.frame_count - 1, frame))]
                            if (typeof ts !== 'number') return
                            lastReadoutRef.current = 0
                            clockRef.current?.scrubTo(ts)
                        }}
                    />
                )}
                {!distanceSeries && distanceSeriesLoading && (
                    <div className="font-mono text-xs text-tx2">{t('trajVizComputingSeries')}</div>
                )}
                {(distanceSeries || distanceSeriesLoading) && <DistanceControls />}
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
                    className="block w-full accent-ac"
                />
                <div className="flex items-center gap-3">
                    <ActionButton
                        variant={isPlaying ? 'secondary' : 'primary'}
                        onClick={() => setPlaying(!isPlaying)}
                        disabled={!payload || distanceSeriesLoading}
                        className="px-4 py-2 text-sm"
                    >
                        {isPlaying ? t('trajVizPause') : t('trajVizPlay')}
                    </ActionButton>
                    <span className="font-mono text-xs tabular-nums text-tx2">
                        {timeSec.toFixed(2)}s / {duration.toFixed(2)}s
                    </span>
                    <select
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                        className={cn(selectClass, 'ml-auto')}
                    >
                        {[0.25, 0.5, 1, 2, 4].map((v) => (
                            <option key={v} value={v}>
                                {v}x
                            </option>
                        ))}
                    </select>
                </div>
                <MetricsPanel />
            </footer>
        </div>
    )
}

function armReadout(sample: ArmFrameSample | null): ArmReadout {
    if (!sample) return { jointDegrees: {}, eeWorldM: null }
    return {
        jointDegrees: sample.jointDegrees,
        eeWorldM: [sample.eeWorld.x, sample.eeWorld.y, sample.eeWorld.z],
    }
}
