import type { DatasetJobItem, RepairJobState } from '../types'
import { jobEventsUrl } from './api'

export type JobEvent =
  | { type: 'snapshot'; data: RepairJobState }
  | { type: 'item'; data: DatasetJobItem }
  | { type: 'complete'; data: RepairJobState }
  | { type: 'job-error'; data: { job: RepairJobState; error: string } }

export type JobEventType = JobEvent['type']

const NAMED_EVENTS: JobEventType[] = ['snapshot', 'item', 'complete', 'job-error']

export function subscribeJobEvents(
  jobId: string,
  onEvent: (event: JobEvent) => void,
  onClose: () => void,
): () => void {
  const source = new EventSource(jobEventsUrl(jobId))
  let closed = false

  function close(): void {
    if (closed) return
    closed = true
    source.close()
    onClose()
  }

  function dispatch(type: JobEventType, raw: MessageEvent): void {
    const data = JSON.parse(raw.data)
    switch (type) {
      case 'snapshot':
        onEvent({ type: 'snapshot', data: data as RepairJobState })
        break
      case 'item':
        onEvent({ type: 'item', data: data as DatasetJobItem })
        break
      case 'complete':
        onEvent({ type: 'complete', data: data as RepairJobState })
        close()
        break
      case 'job-error':
        onEvent({
          type: 'job-error',
          data: data as { job: RepairJobState; error: string },
        })
        close()
        break
    }
  }

  for (const type of NAMED_EVENTS) {
    source.addEventListener(type, (event) => dispatch(type, event as MessageEvent))
  }

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      close()
    }
  }

  return close
}
