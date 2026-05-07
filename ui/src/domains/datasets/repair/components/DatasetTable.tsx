import { cn } from '@/shared/lib/cn'
import { EmptyState } from '@/shared/ui'
import {
  DAMAGE_TYPE_LABELS_ZH,
  type DamageType,
  type DatasetJobItem,
  type DatasetRepairDataset,
  type ItemStatus,
} from '../types'

const ITEM_STATUS_LABEL: Record<ItemStatus, string> = {
  queued: '排队中',
  diagnosing: '诊断中',
  repairing: '修复中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const ITEM_STATUS_CLASS: Record<ItemStatus, string> = {
  queued: 'bg-[rgba(17,17,17,0.05)] text-tx2',
  diagnosing: 'bg-[rgba(47,111,228,0.12)] text-ac',
  repairing: 'bg-[rgba(47,111,228,0.12)] text-ac',
  done: 'bg-[rgba(34,160,98,0.12)] text-[color:#1f8b56]',
  failed: 'bg-[rgba(204,68,68,0.12)] text-[color:#b13838]',
  cancelled: 'bg-[rgba(17,17,17,0.05)] text-tx2',
}

interface DatasetTableProps {
  datasets: DatasetRepairDataset[]
  itemsByDatasetId: Record<string, DatasetJobItem>
}

function damageLabel(value: DamageType | null): string {
  if (!value) return '-'
  return DAMAGE_TYPE_LABELS_ZH[value]
}

function repairableLabel(value: boolean | null): string {
  if (value === null) return '-'
  return value ? '可修复' : '不可修复'
}

export default function DatasetTable({ datasets, itemsByDatasetId }: DatasetTableProps) {
  if (datasets.length === 0) {
    return (
      <EmptyState
        title="未发现数据集"
        description="尝试调整筛选条件或确认数据集根目录后再次扫描。"
      />
    )
  }

  return (
    <div className="overflow-hidden rounded-[24px] border border-[color:rgba(47,111,228,0.12)] bg-white/85">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-[rgba(47,111,228,0.06)] text-left text-xs uppercase tracking-[0.18em] text-tx2">
            <tr>
              <th className="px-4 py-3">名称</th>
              <th className="px-4 py-3">创建日期</th>
              <th className="px-4 py-3">任务</th>
              <th className="px-4 py-3">标签</th>
              <th className="px-4 py-3">最近损坏类型</th>
              <th className="px-4 py-3">是否可修复</th>
              <th className="px-4 py-3 text-right">本次状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:rgba(17,17,17,0.06)]">
            {datasets.map((dataset) => (
              <DatasetRow
                key={dataset.id}
                dataset={dataset}
                jobItem={itemsByDatasetId[dataset.id]}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function DatasetRow({
  dataset,
  jobItem,
}: {
  dataset: DatasetRepairDataset
  jobItem: DatasetJobItem | undefined
}) {
  return (
    <tr className="text-tx">
      <td className="px-4 py-3">
        <div className="font-medium">{dataset.name}</div>
        <div className="text-xs text-tx2 break-all">{dataset.path}</div>
      </td>
      <td className="px-4 py-3 text-tx2">{dataset.created_date ?? '-'}</td>
      <td className="px-4 py-3 text-tx2">{dataset.task ?? '-'}</td>
      <td className="px-4 py-3">
        <span
          className={cn(
            'tag-pill',
            dataset.tag === 'dirty' ? 'tag-pill--dirty' : 'tag-pill--checked',
          )}
        >
          {dataset.tag}
        </span>
      </td>
      <td className="px-4 py-3 text-tx2">{damageLabel(dataset.last_damage_type)}</td>
      <td className="px-4 py-3 text-tx2">{repairableLabel(dataset.repairable)}</td>
      <td className="px-4 py-3 text-right">
        {jobItem ? (
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium',
              ITEM_STATUS_CLASS[jobItem.status],
            )}
          >
            {ITEM_STATUS_LABEL[jobItem.status]}
          </span>
        ) : (
          <span className="text-xs text-tx2">-</span>
        )}
      </td>
    </tr>
  )
}
