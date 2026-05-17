import { asRecord, textValue } from '@/domains/data/lib/analysisPayload'
import {
  isDataAutoCleanStatus,
  isDataReviewStatus,
  type DataAutoCleanStatus,
  type DataGate,
  type DataReviewStatus,
  type Dataset,
} from '@/domains/data/model/types'
import type { TranslationKey } from '@/i18n'

export type AutoCleanStatus = DataAutoCleanStatus
export type ManualReviewStatus = DataReviewStatus

const AUTO_CLEAN_STATUS_LABELS: Record<AutoCleanStatus, TranslationKey> = {
  pending: 'dataQualityStatusPending',
  running: 'dataQualityStatusRunning',
  passed: 'dataQualityStatusPassed',
  failed: 'dataQualityStatusFailed',
}

const MANUAL_REVIEW_STATUS_LABELS: Record<ManualReviewStatus, TranslationKey> = {
  pending: 'dataQualityStatusPending',
  passed: 'dataQualityStatusPassed',
  needs_fix: 'dataQualityStatusNeedsFix',
  failed: 'dataQualityStatusFailed',
}

export interface DatasetQualityView {
  taskDescription: string
  createdDate: string
  autoCleanStatus: AutoCleanStatus
  manualReviewStatus: ManualReviewStatus
  autoCleanMessage: string
  manualReviewMessage: string
}

export function buildDatasetQualityView(dataset: Dataset): DatasetQualityView {
  const cleanGate = gateOrPending(dataset.gates.clean)
  const reviewGate = gateOrPending(dataset.gates.review)

  return {
    taskDescription: datasetTaskDescription(dataset),
    createdDate: datasetCreatedDate(dataset),
    autoCleanStatus: qcAutoCleanStatus(dataset),
    manualReviewStatus: qcReviewStatus(dataset) || 'pending',
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

export function qcReviewStatus(dataset: Dataset): DataReviewStatus | '' {
  const review = qcReviewPayload(dataset)
  const status = textValue(review.status).toLowerCase()
  if (status === 'applied') {
    return 'passed'
  }
  if (isDataReviewStatus(status)) {
    return status
  }
  return ''
}

export function autoCleanStatusLabelKey(status: AutoCleanStatus): TranslationKey {
  return AUTO_CLEAN_STATUS_LABELS[status]
}

export function manualReviewStatusLabelKey(status: ManualReviewStatus): TranslationKey {
  return MANUAL_REVIEW_STATUS_LABELS[status]
}

function qcAutoCleanStatus(dataset: Dataset): AutoCleanStatus {
  const status = textValue(gateOrPending(dataset.gates.clean).status).toLowerCase()
  return isDataAutoCleanStatus(status) ? status : 'pending'
}

export function qcLanePayload(dataset: Dataset, lane: 'auto_clean' | 'manual_review'): Record<string, unknown> {
  const qc = asRecord(dataset.qc)
  const lanes = asRecord(qc.lanes)
  return asRecord(lanes[lane])
}

export function qcReviewPayload(dataset: Dataset): Record<string, unknown> {
  return asRecord(asRecord(dataset.qc).review)
}

function gateOrPending(gate: DataGate | undefined): Pick<DataGate, 'status' | 'message'> {
  return gate ? { status: gate.status, message: gate.message } : { status: 'pending', message: '' }
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}
