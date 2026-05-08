import type { TranslationKey } from '@/i18n'
import type { GateStatus } from '@/domains/data/model/types'

export const DATA_GATE_ORDER = [
  'inspect',
  'diagnose',
  'clean',
  'review',
  'assemble',
  'validate',
  'annotate',
  'upload',
]

export const DATA_GATE_LABELS = {
  inspect: 'dataGateInspect',
  diagnose: 'dataGateDiagnose',
  clean: 'dataGateClean',
  review: 'dataGateReview',
  assemble: 'dataGateAssemble',
  validate: 'dataGateValidate',
  annotate: 'dataGateAnnotate',
  upload: 'dataGateUpload',
} satisfies Record<string, TranslationKey>

export const DATA_GATE_STATUS_LABELS: Record<GateStatus, TranslationKey> = {
  pending: 'dataGateStatusPending',
  running: 'dataGateStatusRunning',
  passed: 'dataGateStatusPassed',
  failed: 'dataGateStatusFailed',
  needs_review: 'dataGateStatusNeedsReview',
  skipped: 'dataGateStatusSkipped',
}

const DATA_GATE_MESSAGE_LABELS = {
  pending: 'dataGateStatusPending',
  running: 'dataGateStatusRunning',
  passed: 'dataGateStatusPassed',
  failed: 'dataGateStatusFailed',
  needs_review: 'dataGateStatusNeedsReview',
  manual_required: 'dataGateStatusNeedsReview',
  skipped: 'dataGateStatusSkipped',
} satisfies Record<string, TranslationKey>

export function dataGateLabelKey(gateKey: string): TranslationKey | null {
  return DATA_GATE_LABELS[gateKey as keyof typeof DATA_GATE_LABELS] ?? null
}

export function dataGateStatusLabelKey(status: GateStatus): TranslationKey {
  return DATA_GATE_STATUS_LABELS[status]
}

export function dataGateMessageLabelKey(message: string): TranslationKey | null {
  const normalized = message.trim().toLowerCase().replace(/[\s-]+/g, '_')
  return DATA_GATE_MESSAGE_LABELS[normalized as keyof typeof DATA_GATE_MESSAGE_LABELS] ?? null
}

export function sortDataGateKeys(keys: string[]): string[] {
  const order = new Map(DATA_GATE_ORDER.map((key, index) => [key, index]))
  return [...keys].sort((left, right) => {
    const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftOrder === rightOrder ? left.localeCompare(right) : leftOrder - rightOrder
  })
}
