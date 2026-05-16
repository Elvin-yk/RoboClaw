const REVIEW_QUEUE_RETURN_KEY = 'roboclaw:data-qc:return-query'

export function readReviewQueueReturn(): string {
  if (typeof window === 'undefined') return ''
  return window.sessionStorage.getItem(REVIEW_QUEUE_RETURN_KEY) || ''
}

export function writeReviewQueueReturn(query: string) {
  if (typeof window === 'undefined') return
  if (!query) return
  window.sessionStorage.setItem(REVIEW_QUEUE_RETURN_KEY, query)
}

export function clearReviewQueueReturn() {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(REVIEW_QUEUE_RETURN_KEY)
}
