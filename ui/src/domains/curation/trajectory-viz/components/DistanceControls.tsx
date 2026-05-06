import { useI18n } from '@/i18n'
import { useTrajectoryVizStore } from '../store'

const FALLBACK_MAX_M = 0.5

export default function DistanceControls() {
    const { t } = useI18n()
    const series = useTrajectoryVizStore((s) => s.distanceSeries)
    const stats = useTrajectoryVizStore((s) => s.distanceStats)
    const threshold = useTrajectoryVizStore((s) => s.distanceThresholdM)
    const loading = useTrajectoryVizStore((s) => s.distanceSeriesLoading)
    const setThreshold = useTrajectoryVizStore((s) => s.setDistanceThresholdM)

    const sliderMax = stats?.max && stats.max > 0 ? stats.max : FALLBACK_MAX_M

    return (
        <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-tx2">
            <label className="flex items-center gap-2">
                <span className="text-2xs font-bold uppercase tracking-[0.16em] text-tx2">
                    {t('trajVizThreshold')}
                </span>
                <input
                    type="number"
                    step={0.005}
                    min={0}
                    value={Number.isFinite(threshold) ? threshold : 0}
                    onChange={(e) => {
                        const v = Number(e.target.value)
                        if (Number.isFinite(v) && v >= 0) setThreshold(v)
                    }}
                    className="w-20 rounded-md border border-bd bg-sf px-2 py-1 text-xs text-tx tabular-nums shadow-sm transition focus:border-ac focus:outline-none focus:ring-2 focus:ring-ac/30"
                />
                <span className="text-tx2">m</span>
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
                className="flex-1 min-w-[120px] accent-ac"
            />
            {loading && (
                <span className="text-tx2">{t('trajVizComputingSeries')}</span>
            )}
            {!loading && series && stats && (
                <span className="tabular-nums text-tx2">
                    <span className="text-tx">{t('trajVizMin')}</span> {stats.min.toFixed(3)}
                    {' · '}
                    <span className="text-tx">{t('trajVizMax')}</span> {stats.max.toFixed(3)}
                    {' · '}
                    <span className="text-tx">{t('trajVizMean')}</span> {stats.mean.toFixed(3)} m
                    {' · '}
                    <span className="text-tx">{t('trajVizBelow')}</span> {threshold.toFixed(3)}m: {stats.belowCount} {t('trajVizFramesUnit')}
                </span>
            )}
        </div>
    )
}
