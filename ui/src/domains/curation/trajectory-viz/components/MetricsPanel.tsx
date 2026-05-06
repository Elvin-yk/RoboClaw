import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import { useTrajectoryVizStore } from '../store'
import type { ArmReadout } from '../types'

const cardClass = 'rounded-xl border border-bd/60 bg-sf/95 p-3 shadow-card'

export default function MetricsPanel() {
    const { t } = useI18n()
    const metrics = useTrajectoryVizStore((s) => s.metrics)
    if (!metrics) {
        return (
            <div className={cn(cardClass, 'font-mono text-xs text-tx2')}>
                {t('trajVizNoMetrics')}
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <ArmColumn title={t('trajVizLeftArm')} accentClass="text-ac" readout={metrics.left} />
                <ArmColumn title={t('trajVizRightArm')} accentClass="text-or" readout={metrics.right} />
            </div>
            <div className={cn(cardClass, 'font-mono text-xs text-tx2 leading-6')}>
                <span className="text-tx">{t('trajVizFrame')} {metrics.frame}</span>
                {metrics.rawFrame !== null && (
                    <span> · {t('trajVizRawFrame')} {metrics.rawFrame}</span>
                )}
                <span> · {metrics.timeSec.toFixed(2)}s</span>
                {metrics.eeRelativeM ? (
                    <span>
                        {' · '}
                        <span className="text-tx">{t('trajVizRelative')}</span>
                        {' xyz=['}
                        {formatM(metrics.eeRelativeM.dx)}, {formatM(metrics.eeRelativeM.dy)}, {formatM(metrics.eeRelativeM.dz)}
                        {'] | '}
                        {formatM(metrics.eeRelativeM.distance)}m
                    </span>
                ) : (
                    <span> · {t('trajVizEERelativeUnavailable')}</span>
                )}
            </div>
        </div>
    )
}

function ArmColumn({
    title,
    readout,
    accentClass,
}: {
    title: string
    readout: ArmReadout
    accentClass: string
}) {
    const { t } = useI18n()
    const joints = Object.entries(readout.jointDegrees)
    return (
        <div className={cardClass}>
            <div className={cn('text-2xs font-bold uppercase tracking-[0.22em]', accentClass)}>
                {title}
            </div>
            <div className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono text-xs text-tx2">
                {joints.length === 0 ? (
                    <Row label={t('trajVizJoints')} value={t('trajVizUnavailable')} />
                ) : (
                    joints.map(([joint, deg]) => (
                        <Row key={joint} label={joint} value={`${deg.toFixed(1)}°`} />
                    ))
                )}
            </div>
            <div className="mt-2 font-mono text-xs text-tx2">
                <span className="text-tx">{t('trajVizEEWorld')}</span>
                {' = '}
                {readout.eeWorldM
                    ? `[${readout.eeWorldM.map(formatM).join(', ')}] m`
                    : t('trajVizUnavailable')}
            </div>
        </div>
    )
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <span className="truncate">{label}</span>
            <span className="text-tx tabular-nums">{value}</span>
        </>
    )
}

function formatM(value: number): string {
    return value.toFixed(3)
}
