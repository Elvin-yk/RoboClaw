import { ActionButton } from '@/shared/ui'
import type { DatasetRepairFilters, TagFilter } from '../types'

interface FilterBarProps {
  filters: DatasetRepairFilters
  effectiveRoot: string
  loading: boolean
  disabled: boolean
  onChange: <K extends keyof DatasetRepairFilters>(
    key: K,
    value: DatasetRepairFilters[K],
  ) => void
  onScan: () => void
}

const TAG_OPTIONS: ReadonlyArray<{ value: TagFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'dirty', label: 'dirty' },
  { value: 'checked', label: 'checked' },
]

const fieldClass =
  'rounded-xl border border-[color:rgba(47,111,228,0.18)] bg-white/95 px-3 py-2 text-sm text-tx outline-none transition focus:border-ac focus:ring-2 focus:ring-[color:rgba(47,111,228,0.18)] disabled:opacity-50'

const labelClass = 'flex flex-col gap-1 text-xs text-tx2'

export default function FilterBar({
  filters,
  effectiveRoot,
  loading,
  disabled,
  onChange,
  onScan,
}: FilterBarProps) {
  return (
    <div className="flex flex-col gap-3 rounded-[24px] border border-[color:rgba(47,111,228,0.12)] bg-white/80 p-4 backdrop-blur md:p-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className={labelClass}>
          <span>开始日期</span>
          <input
            type="date"
            className={fieldClass}
            value={filters.date_from}
            disabled={disabled}
            onChange={(event) => onChange('date_from', event.target.value)}
          />
        </label>
        <label className={labelClass}>
          <span>结束日期</span>
          <input
            type="date"
            className={fieldClass}
            value={filters.date_to}
            disabled={disabled}
            onChange={(event) => onChange('date_to', event.target.value)}
          />
        </label>
        <label className={labelClass}>
          <span>任务</span>
          <input
            type="text"
            className={fieldClass}
            placeholder="任务关键字"
            value={filters.task}
            disabled={disabled}
            onChange={(event) => onChange('task', event.target.value)}
          />
        </label>
        <label className={labelClass}>
          <span>标签</span>
          <select
            className={fieldClass}
            value={filters.tag}
            disabled={disabled}
            onChange={(event) => onChange('tag', event.target.value as TagFilter)}
          >
            {TAG_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${labelClass} flex-1 min-w-[220px]`}>
          <span>数据集根目录（留空使用默认）</span>
          <input
            type="text"
            className={fieldClass}
            placeholder="例如 /home/kye/.roboclaw/workspace/embodied/datasets/local"
            value={filters.root}
            disabled={disabled}
            onChange={(event) => onChange('root', event.target.value)}
          />
        </label>
        <ActionButton
          variant="secondary"
          onClick={onScan}
          disabled={disabled || loading}
        >
          {loading ? '扫描中...' : '重新扫描'}
        </ActionButton>
      </div>
      {effectiveRoot && (
        <div className="text-xs text-tx2">
          当前根目录：<span className="font-mono text-tx">{effectiveRoot}</span>
        </div>
      )}
    </div>
  )
}
