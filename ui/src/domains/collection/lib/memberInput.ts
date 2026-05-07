import { type OrganizationMember } from '@/shared/api/evoClient'
import { isValidPhone } from '@/shared/lib/phone'

export interface ResolvedMemberRows {
  phones: string[]
  unresolved: string[]
}

export interface MemberInputResolver {
  resolveInput: (value: string) => string | null
  resolveSelection: (value: string) => string | null
  resolveRows: (rows: string[]) => ResolvedMemberRows
  suggestions: (value: string, limit: number) => OrganizationMember[]
}

interface MemberSearchEntry {
  member: OrganizationMember
  phone: string
  normalizedNickname: string
}

function normalized(value: string) {
  return value.trim().toLowerCase()
}

export function memberLabel(member: OrganizationMember) {
  return member.nickname?.trim() || member.phone
}

export function createMemberInputResolver(members: OrganizationMember[]): MemberInputResolver {
  const entries: MemberSearchEntry[] = members.map((member) => ({
    member,
    phone: member.phone,
    normalizedNickname: normalized(member.nickname || ''),
  }))
  const phones = new Set(entries.map((entry) => entry.phone))
  const nicknamePhones = new Map<string, string[]>()

  for (const entry of entries) {
    if (!entry.normalizedNickname) continue
    nicknamePhones.set(entry.normalizedNickname, [
      ...(nicknamePhones.get(entry.normalizedNickname) || []),
      entry.phone,
    ])
  }

  function resolveSelection(value: string) {
    const query = value.trim()
    if (!query) return null
    if (phones.has(query)) return query

    const matches = nicknamePhones.get(normalized(query)) || []
    return matches.length === 1 ? matches[0] : null
  }

  function resolveInput(value: string) {
    const query = value.trim()
    return isValidPhone(query) ? query : resolveSelection(query)
  }

  function resolveRows(rows: string[]) {
    const seenPhones = new Set<string>()
    const resolved: string[] = []
    const unresolved: string[] = []

    for (const row of rows) {
      const query = row.trim()
      if (!query) continue

      const phone = resolveSelection(query)
      if (!phone) {
        unresolved.push(query)
        continue
      }
      if (seenPhones.has(phone)) continue

      seenPhones.add(phone)
      resolved.push(phone)
    }

    return { phones: resolved, unresolved }
  }

  function suggestions(value: string, limit: number) {
    const needle = normalized(value)
    if (!needle) return []

    const matched: OrganizationMember[] = []
    for (const entry of entries) {
      if (!entry.phone.includes(needle) && !entry.normalizedNickname.includes(needle)) continue
      matched.push(entry.member)
      if (matched.length >= limit) break
    }
    return matched
  }

  return { resolveInput, resolveSelection, resolveRows, suggestions }
}
