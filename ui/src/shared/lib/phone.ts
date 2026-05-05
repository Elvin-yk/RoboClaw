export const PHONE_PATTERN = /^1\d{10}$/

export function isValidPhone(value: string) {
  return PHONE_PATTERN.test(value.trim())
}

export function maskPhone(phone: string) {
  const value = phone.trim()
  if (value.length !== 11) return phone
  return `${value.slice(0, 3)}****${value.slice(7)}`
}
