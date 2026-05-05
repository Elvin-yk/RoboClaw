import { useTrajectoryVizStore } from '../store'
import type { ArmReadout } from '../types'

const panelStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
    gap: 8,
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#374151',
} as const

const boxStyle = {
    border: '1px solid #d1d5db',
    borderRadius: 4,
    padding: 8,
    background: '#ffffff',
} as const

export default function MetricsPanel() {
    const metrics = useTrajectoryVizStore((s) => s.metrics)
    if (!metrics) {
        return <div style={{ ...boxStyle, fontSize: 12, color: '#6b7280' }}>No frame metrics</div>
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={panelStyle}>
                <ArmColumn title="left arm" readout={metrics.left} />
                <ArmColumn title="right arm" readout={metrics.right} />
            </div>
            <div style={boxStyle}>
                frame {metrics.frame}
                {metrics.rawFrame !== null ? ` | raw ${metrics.rawFrame}` : ''} | {metrics.timeSec.toFixed(2)}s
                {metrics.eeRelativeM
                    ? ` | relative xyz=[${formatM(metrics.eeRelativeM.dx)}, ${formatM(metrics.eeRelativeM.dy)}, ${formatM(metrics.eeRelativeM.dz)}] distance=${formatM(metrics.eeRelativeM.distance)}m`
                    : ' | relative unavailable'}
            </div>
        </div>
    )
}

function ArmColumn({ title, readout }: { title: string; readout: ArmReadout }) {
    const joints = Object.entries(readout.jointDegrees)
    return (
        <div style={boxStyle}>
            <strong>{title}</strong>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '2px 10px', marginTop: 6 }}>
                {joints.length === 0 ? (
                    <Row label="joints" value="unavailable" />
                ) : (
                    joints.map(([joint, deg]) => (
                        <Row key={joint} label={joint} value={`${deg.toFixed(1)}°`} />
                    ))
                )}
            </div>
            <div style={{ marginTop: 6 }}>
                ee xyz={readout.eeWorldM ? `[${readout.eeWorldM.map(formatM).join(', ')}]m` : 'unavailable'}
            </div>
        </div>
    )
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <>
            <span>{label}</span>
            <span>{value}</span>
        </>
    )
}

function formatM(value: number): string {
    return value.toFixed(3)
}
