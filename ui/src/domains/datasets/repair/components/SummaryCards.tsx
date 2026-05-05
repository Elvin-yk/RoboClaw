import { MetricCard } from '@/shared/ui'
import {
  ALL_DAMAGE_TYPES,
  DAMAGE_TYPE_LABELS_ZH,
  type DamageType,
  type DatasetRepairDataset,
} from '../types'

interface DamageCounts {
  total: number
  healthy: number
  dirty: number
  checked: number
  byDamage: Record<DamageType, number>
}

function emptyByDamage(): Record<DamageType, number> {
  const counts: Record<DamageType, number> = {
    healthy: 0,
    empty_shell: 0,
    crash_no_save: 0,
    tmp_videos_stuck: 0,
    partial_tmp_videos_stuck: 0,
    parquet_no_video: 0,
    meta_stale: 0,
    frame_mismatch: 0,
    missing_cp: 0,
  }
  return counts
}

export function summarizeDatasets(datasets: DatasetRepairDataset[]): DamageCounts {
  const byDamage = emptyByDamage()
  let healthy = 0
  let dirty = 0
  let checked = 0
  for (const ds of datasets) {
    // 已被 checked 但残留非 healthy 的 last_damage_type，意味着该数据集已通过
    // 诊断或修复确认，原历史损坏类型不再是当前状态，不再计入损坏分桶。
    if (ds.tag === 'checked' && ds.last_damage_type !== 'healthy') {
      checked += 1
      continue
    }
    if (ds.tag === 'checked') {
      checked += 1
    } else {
      dirty += 1
    }
    const damage = ds.last_damage_type
    if (damage === null) continue
    if (damage === 'healthy') healthy += 1
    byDamage[damage] += 1
  }
  return {
    total: datasets.length,
    healthy,
    dirty,
    checked,
    byDamage,
  }
}

const ACCENTS: Array<'teal' | 'amber' | 'coral' | 'sage'> = ['teal', 'amber', 'coral', 'sage']

export default function SummaryCards({ datasets }: { datasets: DatasetRepairDataset[] }) {
  const counts = summarizeDatasets(datasets)
  const damageEntries = ALL_DAMAGE_TYPES
    .filter((type) => type !== 'healthy' && counts.byDamage[type] > 0)
    .map((type, index) => ({
      label: DAMAGE_TYPE_LABELS_ZH[type],
      value: counts.byDamage[type],
      accent: ACCENTS[(index + 2) % ACCENTS.length],
    }))

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
      <MetricCard label="总数" value={counts.total} accent="teal" />
      <MetricCard label="健康" value={counts.healthy} accent="sage" />
      <MetricCard label="dirty" value={counts.dirty} accent="amber" />
      <MetricCard label="checked" value={counts.checked} accent="teal" />
      {damageEntries.map((entry) => (
        <MetricCard
          key={entry.label}
          label={entry.label}
          value={entry.value}
          accent={entry.accent}
        />
      ))}
    </div>
  )
}
