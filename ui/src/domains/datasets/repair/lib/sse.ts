import type { DatasetJobItem, RepairJobState } from '../types'
import { jobEventsUrl } from './api'

export type JobEvent =
  | { type: 'snapshot'; data: RepairJobState }
  | { type: 'item'; data: DatasetJobItem }
  | { type: 'complete'; data: RepairJobState }
  | { type: 'error'; data: { job: RepairJobState; error: string } }

export type JobEventType = JobEvent['type']

const NAMED_EVENTS: JobEventType[] = ['snapshot', 'item', 'complete', 'error']

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
    // Browser-generated transport ``error`` events surface here too (because
    // ``error`` is also one of our named server events); they carry no JSON
    // payload. Skip them — ``onerror`` below already handles disconnects.
    if (typeof raw.data !== 'string') return
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
      case 'error':
        onEvent({
          type: 'error',
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
