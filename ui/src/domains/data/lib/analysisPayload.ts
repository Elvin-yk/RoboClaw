export type AnyRecord = Record<string, unknown>

export function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function textValue(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

export function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function numberText(value: unknown): string {
  const number = numberValue(value)
  if (number == null) return '0'
  return Number.isInteger(number) ? number.toLocaleString() : number.toFixed(2)
}

export function formatCount(value: unknown): string {
  const number = numberValue(value)
  return number == null ? '0' : Math.round(number).toLocaleString()
}

export function formatSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)}s`
}

export function formatDuration(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0m'
  const rounded = Math.round(totalSeconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const seconds = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(value, min), max)
}

export function relativeTimeValues(timeValues: number[]): number[] {
  if (!timeValues.length) return []
  const start = timeValues[0]
  return timeValues.map((time, index) => (
    Number.isFinite(time) && Number.isFinite(start) ? Math.max(time - start, 0) : index
  ))
}
