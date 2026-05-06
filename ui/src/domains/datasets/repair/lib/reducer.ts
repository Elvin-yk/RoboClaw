import { TERMINAL_ITEM_STATUSES, type DatasetJobItem, type RepairJobState } from '../types'
import type { JobEvent } from './sse'

function recomputeProcessed(items: DatasetJobItem[]): number {
  return items.filter((item) => TERMINAL_ITEM_STATUSES.has(item.status)).length
}

function applyItem(prev: RepairJobState, incoming: DatasetJobItem): RepairJobState {
  const exists = prev.items.some((item) => item.dataset_id === incoming.dataset_id)
  const items = exists
    ? prev.items.map((item) =>
        item.dataset_id === incoming.dataset_id ? incoming : item,
      )
    : [...prev.items, incoming]
  return { ...prev, items, processed: recomputeProcessed(items) }
}

export function applyJobEvent(
  prev: RepairJobState | null,
  event: JobEvent,
): RepairJobState | null {
  if (event.type === 'snapshot' || event.type === 'complete') return event.data
  if (event.type === 'job-error') return event.data.job ?? prev
  if (event.type === 'item') return prev ? applyItem(prev, event.data) : prev
  return prev
}
