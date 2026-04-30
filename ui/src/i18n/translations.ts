import setupStrings from '../../../roboclaw/i18n/setup.json'
import commonStrings from '../../../roboclaw/i18n/common.json'
import { inlineEn } from './translations.en'
import { inlineZh } from './translations.zh'

type SharedKey = keyof typeof setupStrings | keyof typeof commonStrings
type InlineKey = keyof typeof inlineZh

function transposeJson(
  ...sources: Record<string, Record<string, string>>[]
): { zh: Record<string, string>; en: Record<string, string> } {
  const zh: Record<string, string> = {}
  const en: Record<string, string> = {}
  for (const source of sources) {
    for (const [key, val] of Object.entries(source)) {
      if (val.zh) zh[key] = val.zh
      if (val.en) en[key] = val.en
    }
  }
  return { zh, en }
}

const shared = transposeJson(setupStrings, commonStrings)

export const translations = {
  zh: {
    ...shared.zh,
    ...inlineZh,
  },
  en: {
    ...shared.en,
    ...inlineEn,
  },
} as const

export type TranslationKey = InlineKey | SharedKey
