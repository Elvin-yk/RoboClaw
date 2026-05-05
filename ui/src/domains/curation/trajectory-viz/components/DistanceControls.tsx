import { useTrajectoryVizStore } from '../store'

const FALLBACK_MAX_M = 0.5

export default function DistanceControls() {
    const series = useTrajectoryVizStore((s) => s.distanceSeries)
    const stats = useTrajectoryVizStore((s) => s.distanceStats)
    const threshold = useTrajectoryVizStore((s) => s.distanceThresholdM)
    const loading = useTrajectoryVizStore((s) => s.distanceSeriesLoading)
    const setThreshold = useTrajectoryVizStore((s) => s.setDistanceThresholdM)

    const sliderMax = stats?.max && stats.max > 0 ? stats.max : FALLBACK_MAX_M

    return (
        <div
            style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                fontFamily: 'monospace',
                fontSize: 12,
                color: '#374151',
                flexWrap: 'wrap',
            }}
        >
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                threshold
                <input
                    type="number"
                    step={0.005}
                    min={0}
                    value={Number.isFinite(threshold) ? threshold : 0}
                    onChange={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isFinite(v) && v >= 0) setThreshold(v)
                    }}
                    style={{ width: 80 }}
                />
                m
            </label>
            <input
                type="range"
                min={0}
                max={sliderMax}
                step={0.005}
                value={Math.min(threshold, sliderMax)}
                onChange={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v)) setThreshold(v)
                }}
                style={{ flex: 1, minWidth: 120 }}
            />
            {loading && <span style={{ color: '#6b7280' }}>computing distance series…</span>}
            {!loading && series && stats && (
                <span style={{ color: '#374151' }}>
                    min {stats.min.toFixed(3)} · max {stats.max.toFixed(3)} · mean{' '}
                    {stats.mean.toFixed(3)} m · below {threshold.toFixed(3)}m: {stats.belowCount} frames
                </span>
            )}
        </div>
    )
}
