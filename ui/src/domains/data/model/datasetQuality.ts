import { textValue } from '@/domains/data/lib/analysisPayload'
import type { DataGate, Dataset, GateStatus } from '@/domains/data/model/types'

export type QualityStatus = GateStatus

export interface DatasetQualityView {
  taskDescription: string
  createdDate: string
  autoCleanStatus: QualityStatus
  manualReviewStatus: QualityStatus
  autoCleanMessage: string
  manualReviewMessage: string
}

export function buildDatasetQualityView(dataset: Dataset): DatasetQualityView {
  const cleanGate = gateOrPending(dataset.gates.clean)
  const reviewGate = gateOrPending(dataset.gates.review)
  const autoCleanLaneStatus = qcLaneStatus(dataset, 'auto_clean')
  const manualReviewLaneStatus = qcLaneStatus(dataset, 'manual_review')
  const reviewState = qcReviewStatus(dataset)

  return {
    taskDescription: datasetTaskDescription(dataset),
    createdDate: datasetCreatedDate(dataset),
    autoCleanStatus: autoCleanStatus(dataset, autoCleanLaneStatus, cleanGate.status),
    manualReviewStatus: manualReviewStatus(manualReviewLaneStatus, reviewGate.status, reviewState),
    autoCleanMessage: cleanGate.message,
    manualReviewMessage: reviewGate.message,
  }
}

export function datasetTaskDescription(dataset: Dataset): string {
  const stats = dataset.stats as unknown as Record<string, unknown>
  return firstString(
    stats.task_description,
    stats.task,
    stats.description,
    stats.task_desc,
  )
}

export function datasetCreatedDate(dataset: Dataset): string {
  const match = dataset.name.match(/(\d{8})/)
  if (match) {
    return `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`
  }
  return dataset.updated_at ? dataset.updated_at.slice(0, 10) : ''
}

export function matchesDatasetText(dataset: Dataset, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const task = datasetTaskDescription(dataset)
  return `${dataset.id} ${dataset.name} ${dataset.label} ${dataset.path} ${dataset.real_path} ${task}`
    .toLowerCase()
    .includes(needle)
}

function autoCleanStatus(
  dataset: Dataset,
  laneStatus: QualityStatus,
  gateStatus: QualityStatus,
): QualityStatus {
  if (laneStatus !== 'pending') return laneStatus
  if (dataset.lifecycle_stage === 'clean') return 'passed'
  if (dataset.lifecycle_stage === 'cleaning') return 'running'
  if (gateStatus === 'passed' || gateStatus === 'failed' || gateStatus === 'running') return gateStatus
  if (gateStatus === 'needs_review') return 'failed'
  return 'pending'
}

function manualReviewStatus(laneStatus: QualityStatus, gateStatus: QualityStatus, reviewStatus: string): QualityStatus {
  if (reviewStatus === 'applied') return 'passed'
  if (reviewStatus === 'ready_for_batch') return 'needs_review'
  if (laneStatus === 'passed' || laneStatus === 'failed' || laneStatus === 'needs_review' || laneStatus === 'skipped') return laneStatus
  if (gateStatus === 'passed' || gateStatus === 'failed' || gateStatus === 'needs_review') {
    return gateStatus
  }
  if (gateStatus === 'skipped') return 'skipped'
  return 'pending'
}

export function qcReviewStatus(dataset: Dataset): string {
  const qc = recordValue(dataset.qc)
  const review = recordValue(qc.review)
  const status = textValue(review.status).toLowerCase()
  if (status === 'pending' || status === 'ready_for_batch' || status === 'applied') {
    return status
  }
  return ''
}

function qcLaneStatus(dataset: Dataset, lane: 'auto_clean' | 'manual_review'): QualityStatus {
  const qc = recordValue(dataset.qc)
  const lanes = recordValue(qc.lanes)
  const payload = recordValue(lanes[lane])
  const status = textValue(payload.status).toLowerCase()
  if (status === 'completed' || status === 'passed') return 'passed'
  if (status === 'failed' || status === 'rejected') return 'failed'
  if (status === 'needs_review' || status === 'needs_rework') return 'needs_review'
  if (status === 'running' || status === 'queued' || status === 'in_progress' || status === 'started') return 'running'
  if (status === 'skipped') return 'skipped'
  return 'pending'
}

function gateOrPending(gate: DataGate | undefined): Pick<DataGate, 'status' | 'message'> {
  return gate ? { status: gate.status, message: gate.message } : { status: 'pending', message: '' }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
