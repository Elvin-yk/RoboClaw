import { useMemo, useState } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'

export type DatePreset = 'all' | 'today' | '7d' | '30d' | '90d' | 'custom'

export interface DateFilterValue {
  preset: DatePreset
  from: string
  to: string
}

const PRESETS: Array<{ key: DatePreset; labelKey: 'dataDateAll' | 'dataDateToday' | 'dataDateLast7' | 'dataDateLast30' | 'dataDateLast90' | 'dataDateCustom' }> = [
  { key: 'all', labelKey: 'dataDateAll' },
  { key: 'today', labelKey: 'dataDateToday' },
  { key: '7d', labelKey: 'dataDateLast7' },
  { key: '30d', labelKey: 'dataDateLast30' },
  { key: '90d', labelKey: 'dataDateLast90' },
  { key: 'custom', labelKey: 'dataDateCustom' },
]

export function DataDateRangeFilter({
  value,
  onChange,
  className,
}: {
  value: DateFilterValue
  onChange: (value: DateFilterValue) => void
  className?: string
}) {
  const { t } = useI18n()
  const [customOpen, setCustomOpen] = useState(value.preset === 'custom')
  const activeRange = useMemo(() => resolveDateRange(value), [value])

  function selectPreset(preset: DatePreset) {
    setCustomOpen(preset === 'custom')
    onChange({ ...value, preset })
  }

  return (
    <div className={cn('data-date-filter', className)}>
      <div className="data-date-filter__presets" aria-label={t('dataDateRange')}>
        {PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.key}
            className={cn('data-date-filter__preset', value.preset === preset.key && 'is-active')}
            onClick={() => selectPreset(preset.key)}
          >
            {t(preset.labelKey)}
          </button>
        ))}
      </div>
      {customOpen && (
        <div className="data-date-filter__custom">
          <label>
            <span>{t('dataDateFrom')}</span>
            <input
              type="date"
              value={value.from}
              onChange={(event) => onChange({ ...value, preset: 'custom', from: event.target.value })}
            />
          </label>
          <label>
            <span>{t('dataDateTo')}</span>
            <input
              type="date"
              value={value.to}
              onChange={(event) => onChange({ ...value, preset: 'custom', to: event.target.value })}
            />
          </label>
        </div>
      )}
      {activeRange.label && <span className="data-date-filter__summary">{activeRange.label}</span>}
    </div>
  )
}

export function isDateInFilter(date: string, value: DateFilterValue): boolean {
  const range = resolveDateRange(value)
  if (!range.from && !range.to) return true
  if (!date) return false
  if (range.from && date < range.from) return false
  if (range.to && date > range.to) return false
  return true
}

function resolveDateRange(value: DateFilterValue): { from: string; to: string; label: string } {
  if (value.preset === 'custom') {
    return { from: value.from, to: value.to, label: formatCustomLabel(value.from, value.to) }
  }
  if (value.preset === 'all') {
    return { from: '', to: '', label: '' }
  }
  const today = startOfToday()
  const from = new Date(today)
  if (value.preset === '7d') from.setDate(today.getDate() - 6)
  if (value.preset === '30d') from.setDate(today.getDate() - 29)
  if (value.preset === '90d') from.setDate(today.getDate() - 89)
  return {
    from: toInputDate(from),
    to: toInputDate(today),
    label: '',
  }
}

function formatCustomLabel(from: string, to: string): string {
  if (from && to) return `${from} - ${to}`
  if (from) return `${from} +`
  if (to) return `- ${to}`
  return ''
}

function startOfToday(): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date
}

function toInputDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
