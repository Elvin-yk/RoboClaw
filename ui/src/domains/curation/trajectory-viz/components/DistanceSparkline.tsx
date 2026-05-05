import { useMemo, useRef, useState } from 'react'
import { downsampleDistanceSeries } from '../distanceSeries'
import type { BelowThresholdRange } from '../distanceSeries'

const VIEW_W = 1000
const MAX_POINTS = 1000

interface DistanceSparklineProps {
    series: Float32Array
    thresholdM: number
    ranges: BelowThresholdRange[]
    currentFrame: number
    height?: number
    onScrub?: (frame: number) => void
}

export default function DistanceSparkline({
    series,
    thresholdM,
    ranges,
    currentFrame,
    height = 80,
    onScrub,
}: DistanceSparklineProps) {
    const svgRef = useRef<SVGSVGElement | null>(null)
    const [hoverFrame, setHoverFrame] = useState<number | null>(null)
    const length = series.length

    const yMax = useMemo(() => {
        if (length === 0) return Math.max(thresholdM * 1.5, 0.001)
        let max = series[0]
        for (let i = 1; i < length; i += 1) {
            if (series[i] > max) max = series[i]
        }
        return Math.max(thresholdM * 1.5, max, 0.001)
    }, [series, length, thresholdM])

    const path = useMemo(() => {
        if (length === 0) return ''
        const pts = downsampleDistanceSeries(series, MAX_POINTS)
        const denom = Math.max(1, length - 1)
        let d = ''
        for (let i = 0; i < pts.frames.length; i += 1) {
            const x = (pts.frames[i] / denom) * VIEW_W
            const y = height - (pts.values[i] / yMax) * height
            d += i === 0 ? `M${x.toFixed(2)} ${y.toFixed(2)}` : ` L${x.toFixed(2)} ${y.toFixed(2)}`
        }
        return d
    }, [series, length, yMax, height])

    const denom = Math.max(1, length - 1)
    const cursorX = (currentFrame / denom) * VIEW_W
    const thresholdY = Math.max(0, Math.min(height, height - (thresholdM / yMax) * height))

    const frameFromEvent = (event: React.MouseEvent<SVGSVGElement>): number => {
        const svg = svgRef.current
        if (!svg) return 0
        const rect = svg.getBoundingClientRect()
        const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
        const clamped = Math.max(0, Math.min(1, ratio))
        return Math.round(clamped * denom)
    }

    const hoverValue = hoverFrame !== null && hoverFrame >= 0 && hoverFrame < length
        ? series[hoverFrame]
        : null
    const hoverX = hoverFrame !== null ? (hoverFrame / denom) * VIEW_W : null

    return (
        <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_W} ${height}`}
            preserveAspectRatio="none"
            style={{
                width: '100%',
                height,
                background: '#f9fafb',
                border: '1px solid #d1d5db',
                borderRadius: 4,
                cursor: onScrub ? 'pointer' : 'default',
                display: 'block',
            }}
            onMouseMove={(e) => setHoverFrame(frameFromEvent(e))}
            onMouseLeave={() => setHoverFrame(null)}
            onClick={(e) => {
                if (!onScrub) return
                onScrub(frameFromEvent(e))
            }}
        >
            {ranges.map((range) => {
                // Cell-based math: each frame occupies VIEW_W/length pixels.
                // Point-based math (used by the line path) places points at
                // i/(length-1) * VIEW_W; for spans we want i/length so a single
                // frame at the last index renders inside the viewBox, not at x=VIEW_W.
                const cellW = VIEW_W / Math.max(1, length)
                const x = range.startFrame * cellW
                const w = (range.endFrame - range.startFrame + 1) * cellW
                return (
                    <rect
                        key={`${range.startFrame}-${range.endFrame}`}
                        x={x}
                        y={0}
                        width={Math.max(0.5, w)}
                        height={height}
                        fill="rgba(220, 38, 38, 0.18)"
                    />
                )
            })}

            <line
                x1={0}
                x2={VIEW_W}
                y1={thresholdY}
                y2={thresholdY}
                stroke="#dc2626"
                strokeWidth={1}
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
            />

            {path && (
                <path
                    d={path}
                    fill="none"
                    stroke="#1f2937"
                    strokeWidth={1.25}
                    vectorEffect="non-scaling-stroke"
                />
            )}

            <line
                x1={cursorX}
                x2={cursorX}
                y1={0}
                y2={height}
                stroke="#2563eb"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
            />

            {hoverX !== null && hoverValue !== null && (
                <g transform={`translate(${Math.min(VIEW_W - 200, Math.max(8, hoverX + 6))} 14)`}>
                    <rect
                        x={-4}
                        y={-12}
                        width={180}
                        height={18}
                        fill="rgba(255,255,255,0.92)"
                        stroke="#d1d5db"
                    />
                    <text
                        x={0}
                        y={1}
                        fontSize={11}
                        fontFamily="monospace"
                        fill="#111827"
                    >
                        frame {hoverFrame} · {hoverValue.toFixed(3)} m
                    </text>
                </g>
            )}
        </svg>
    )
}
