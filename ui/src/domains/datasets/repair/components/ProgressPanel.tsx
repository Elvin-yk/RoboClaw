import { GlassPanel } from '@/shared/ui'
import { cn } from '@/shared/lib/cn'
import {
  DAMAGE_TYPE_LABELS_ZH,
  TERMINAL_ITEM_STATUSES,
  type DatasetJobItem,
  type JobPhase,
  type RepairJobState,
} from '../types'

interface ProgressPanelProps {
  job: RepairJobState
  errorBanner: string | null
}

const PHASE_LABEL: Record<JobPhase, string> = {
  idle: '空闲',
  diagnosing: '诊断中',
  repairing: '修复中',
  completed: '已完成',
  failed: '失败',
  cancelling: '取消中',
  cancelled: '已取消',
}

const PHASE_CLASS: Record<JobPhase, string> = {
  idle: 'bg-[rgba(17,17,17,0.05)] text-tx2',
  diagnosing: 'bg-[rgba(47,111,228,0.12)] text-ac',
  repairing: 'bg-[rgba(47,111,228,0.12)] text-ac',
  completed: 'bg-[rgba(34,160,98,0.12)] text-[color:#1f8b56]',
  failed: 'bg-[rgba(204,68,68,0.12)] text-[color:#b13838]',
  cancelling: 'bg-[rgba(214,150,38,0.16)] text-[color:#a87715]',
  cancelled: 'bg-[rgba(17,17,17,0.05)] text-tx2',
}

function relativeTime(iso: string): string {
  const started = new Date(iso).getTime()
  if (Number.isNaN(started)) return iso
  const now = Date.now()
  const seconds = Math.max(0, Math.round((now - started) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  return `${hours} 小时前`
}

export default function ProgressPanel({ job, errorBanner }: ProgressPanelProps) {
  const recentItems = pickRecent(job.items, 10)
  const percentage = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0
  return (
    <GlassPanel className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn('rounded-full px-3 py-1 text-xs font-semibold', PHASE_CLASS[job.phase])}>
            {PHASE_LABEL[job.phase]}
          </span>
          <span className="text-sm text-tx2">
            进度 {job.processed}/{job.total}（{percentage}%）
          </span>
        </div>
        <span className="text-xs text-tx2">开始于 {relativeTime(job.started_at)}</span>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-[rgba(47,111,228,0.08)]">
        <div
          className="h-full rounded-full bg-ac transition-[width] duration-300"
          style={{ width: `${percentage}%` }}
        />
      </div>

      {job.phase === 'failed' && errorBanner && (
        <div className="rounded-2xl border border-[color:rgba(204,68,68,0.2)] bg-[rgba(204,68,68,0.06)] px-4 py-3 text-sm text-[color:#b13838]">
          {job.kind === 'repair' ? '修复失败' : '诊断失败'}：{errorBanner}
        </div>
      )}

      <RecentItemsList items={recentItems} />
    </GlassPanel>
  )
}

function pickRecent(items: DatasetJobItem[], limit: number): DatasetJobItem[] {
  const completed = items.filter((item) => TERMINAL_ITEM_STATUSES.has(item.status))
  return completed.slice(-limit).reverse()
}

function RecentItemsList({ items }: { items: DatasetJobItem[] }) {
  if (items.length === 0) {
    return <div className="text-sm text-tx2">尚无完成项。</div>
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.dataset_id}
          className="flex items-center justify-between gap-3 rounded-2xl border border-[color:rgba(47,111,228,0.08)] bg-white/70 px-3 py-2 text-sm"
        >
          <span className="truncate text-tx" title={item.dataset_path}>
            {item.dataset_id}
          </span>
          <span className="flex items-center gap-2 text-xs">
            <span className="text-tx2">{describeDamage(item)}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 font-medium',
                item.status === 'failed'
                  ? 'bg-[rgba(204,68,68,0.12)] text-[color:#b13838]'
                  : 'bg-[rgba(34,160,98,0.12)] text-[color:#1f8b56]',
              )}
            >
              {item.status}
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function describeDamage(item: DatasetJobItem): string {
  if (item.error) return item.error
  if (item.damage_type) return DAMAGE_TYPE_LABELS_ZH[item.damage_type]
  return ''
}
