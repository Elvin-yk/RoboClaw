import { useI18n } from '@/i18n'

export class ApiError extends Error {
  meta: Record<string, string>
  constructor(code: string, meta: Record<string, string>) {
    const raw = useI18n.getState().t(code as any, meta)
    super(raw === code ? code : raw)
    this.name = 'ApiError'
    this.meta = meta
  }
}

export async function api<T = any>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, opts)
  let j: any
  try {
    j = await r.json()
  } catch {
    throw new Error(`HTTP ${r.status}: ${r.statusText}`)
  }
  if (!r.ok || j.error) {
    const detail = j.detail
    if (detail && typeof detail === 'object' && detail.code) {
      throw new ApiError(detail.code, detail)
    }
    throw new Error(detail || j.error || j.message || `HTTP ${r.status}`)
  }
  return j as T
}

export function postJson<T = any>(url: string, body?: unknown): Promise<T> {
  return api<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
}

export function patchJson<T = any>(url: string, body: unknown): Promise<T> {
  return api<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export function deleteApi<T = any>(url: string): Promise<T> {
  return api<T>(url, { method: 'DELETE' })
}
