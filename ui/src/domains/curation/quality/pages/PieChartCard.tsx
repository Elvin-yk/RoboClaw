import { GlassPanel } from '@/shared/ui'
import { buildPieGradient, type PieSegment } from './qualityValidationUtils'

export default function PieChartCard({
  title,
  segments,
  centerLabel,
}: {
  title: string
  segments: PieSegment[]
  centerLabel: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0)
  const gradient = buildPieGradient(segments)

  return (
    <GlassPanel className="quality-pie-card">
      <div className="quality-pie-card__title">{title}</div>
      <div className="quality-pie-card__body">
        <div className="quality-pie-card__chart" style={{ backgroundImage: gradient }}>
          <div className="quality-pie-card__inner">
            <div className="quality-pie-card__total">{total}</div>
            <div className="quality-pie-card__caption">{centerLabel}</div>
          </div>
        </div>
        <div className="quality-pie-card__legend">
          {segments.length === 0 ? (
            <div className="quality-pie-card__empty">No data</div>
          ) : (
            segments.map((segment) => {
              const percent = total > 0 ? (segment.count / total) * 100 : 0
              return (
                <div key={segment.label} className="quality-pie-card__legend-item">
                  <span
                    className="quality-pie-card__dot"
                    style={{ backgroundColor: segment.color }}
                  />
                  <span className="quality-pie-card__legend-label">{segment.label}</span>
                  <span className="quality-pie-card__legend-value">
                    {segment.count} · {percent.toFixed(0)}%
                  </span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </GlassPanel>
  )
}
