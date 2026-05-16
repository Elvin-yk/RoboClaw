import { asRecord, textValue } from '@/domains/data/lib/analysisPayload'
import type { DataAutoCleanOutcome, DataGate, DataManualReviewOutcome, Dataset } from '@/domains/data/model/types'
import type { TranslationKey } from '@/i18n'

export type AutoCleanOutcome = DataAutoCleanOutcome
export type AutoCleanStatus = 'pending' | 'passed' | 'failed'
export type ManualReviewOutcome = DataManualReviewOutcome

const AUTO_CLEAN_OUTCOME_LABELS: Record<AutoCleanOutcome, TranslationKey> = {
  pending: 'dataAutoCleanOutcomePending',
  no_repair_needed: 'dataAutoCleanOutcomeNoRepairNeeded',
  repaired: 'dataAutoCleanOutcomeRepaired',
  failed: 'dataAutoCleanOutcomeFailed',
}

const AUTO_CLEAN_STATUS_LABELS: Record<AutoCleanStatus, TranslationKey> = {
  pending: 'dataAutoCleanOutcomePending',
  passed: 'dataAutoCleanOutcomePassed',
  failed: 'dataAutoCleanOutcomeFailed',
}

const MANUAL_REVIEW_OUTCOME_LABELS: Record<ManualReviewOutcome, TranslationKey> = {
  pending: 'dataManualReviewOutcomePending',
  passed: 'dataManualReviewOutcomePassed',
  needs_fix: 'dataManualReviewOutcomeNeedsFix',
  failed: 'dataManualReviewOutcomeFailed',
}

export interface DatasetQualityView {
  taskDescription: string
  createdDate: string
  autoCleanOutcome: AutoCleanOutcome
  manualReviewOutcome: ManualReviewOutcome
  autoCleanMessage: string
  manualReviewMessage: string
}

export function buildDatasetQualityView(dataset: Dataset): DatasetQualityView {
  const cleanGate = gateOrPending(dataset.gates.clean)
  const reviewGate = gateOrPending(dataset.gates.review)

  return {
    taskDescription: datasetTaskDescription(dataset),
    createdDate: datasetCreatedDate(dataset),
    autoCleanOutcome: qcAutoCleanOutcome(dataset),
    manualReviewOutcome: qcManualReviewOutcome(dataset),
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

export function qcReviewStatus(dataset: Dataset): string {
  const qc = asRecord(dataset.qc)
  const review = asRecord(qc.review)
  const status = textValue(review.status).toLowerCase()
  if (status === 'pending' || status === 'ready_for_batch' || status === 'applied') {
    return status
  }
  return ''
}

export function autoCleanOutcomeLabelKey(outcome: AutoCleanOutcome): TranslationKey {
  return AUTO_CLEAN_OUTCOME_LABELS[outcome]
}

export function autoCleanStatusLabelKey(status: AutoCleanStatus): TranslationKey {
  return AUTO_CLEAN_STATUS_LABELS[status]
}

export function autoCleanDisplayStatus(outcome: AutoCleanOutcome): AutoCleanStatus {
  if (outcome === 'failed') return 'failed'
  if (outcome === 'no_repair_needed' || outcome === 'repaired') return 'passed'
  return 'pending'
}

export function manualReviewOutcomeLabelKey(outcome: ManualReviewOutcome): TranslationKey {
  return MANUAL_REVIEW_OUTCOME_LABELS[outcome]
}

function qcAutoCleanOutcome(dataset: Dataset): AutoCleanOutcome {
  const outcome = textValue(qcLanePayload(dataset, 'auto_clean').outcome).toLowerCase()
  if (
    outcome === 'pending'
    || outcome === 'no_repair_needed'
    || outcome === 'repaired'
    || outcome === 'failed'
  ) {
    return outcome
  }
  return 'pending'
}

function qcManualReviewOutcome(dataset: Dataset): ManualReviewOutcome {
  const qc = asRecord(dataset.qc)
  const review = asRecord(qc.review)
  const outcome = textValue(review.outcome).toLowerCase()
  if (
    outcome === 'pending'
    || outcome === 'passed'
    || outcome === 'needs_fix'
    || outcome === 'failed'
  ) {
    return outcome
  }
  return 'pending'
}

function qcLanePayload(dataset: Dataset, lane: 'auto_clean' | 'manual_review'): Record<string, unknown> {
  const qc = asRecord(dataset.qc)
  const lanes = asRecord(qc.lanes)
  return asRecord(lanes[lane])
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
