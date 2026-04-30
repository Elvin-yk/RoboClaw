import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import type { FeatureStat, ModalityItem } from '../store/useExplorerStore'

// ---------------------------------------------------------------------------
// Modality chips
// ---------------------------------------------------------------------------

export function ModalityChips({ items }: { items: ModalityItem[] }) {
  return (
    <div className="explorer-modalities">
      {items.map((item) => (
        <span
          key={item.id}
          className={cn('explorer-modality-chip', item.present && 'is-active')}
          title={item.detail}
        >
          {item.label}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feature stats table
// ---------------------------------------------------------------------------

function formatStatValues(values: unknown[] | undefined): string {
  if (!values || values.length === 0) return '-'
  return values
    .map((v) => (typeof v === 'number' ? v.toFixed(3) : String(v)))
    .join(', ')
}

export function FeatureStatsTable({ stats }: { stats: FeatureStat[] }) {
  const { t } = useI18n()

  if (stats.length === 0) {
    return <div className="explorer-empty">{t('noStats')}</div>
  }

  return (
    <div className="quality-table-wrap explorer-feature-stats-wrap">
      <table className="quality-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Dtype</th>
            <th>{t('shape')}</th>
            <th>{t('components')}</th>
            <th>Min</th>
            <th>Max</th>
            <th>Mean</th>
            <th>Std</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((feat) => (
            <tr key={feat.name}>
              <td className="explorer-feature-name">{feat.name}</td>
              <td>{feat.dtype}</td>
              <td>{feat.shape.length > 0 ? `[${feat.shape.join(', ')}]` : '-'}</td>
              <td>
                {feat.component_names.length > 0
                  ? feat.component_names.length > 3
                    ? `${feat.component_names.slice(0, 3).join(', ')}...`
                    : feat.component_names.join(', ')
                  : '-'}
              </td>
              <td>{formatStatValues(feat.stats_preview.min?.values)}</td>
              <td>{formatStatValues(feat.stats_preview.max?.values)}</td>
              <td>{formatStatValues(feat.stats_preview.mean?.values)}</td>
              <td>{formatStatValues(feat.stats_preview.std?.values)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Feature type distribution chart
// ---------------------------------------------------------------------------

export function TypeDistribution({ items }: { items: Array<{ name: string; value: number }> }) {
  const maxValue = Math.max(...items.map((i) => i.value), 1)

  return (
    <div className="explorer-type-dist">
      {items.map((item) => (
        <div key={item.name} className="quality-chart-card__row">
          <div className="quality-chart-card__label">{item.name}</div>
          <div className="quality-chart-card__track">
            <div
              className="quality-chart-card__fill"
              style={{ width: `${(item.value / maxValue) * 100}%` }}
            />
          </div>
          <div className="quality-chart-card__value">{item.value}</div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Episode browser
// ---------------------------------------------------------------------------
