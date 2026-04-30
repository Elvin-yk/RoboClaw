import { create } from 'zustand'
import { translations, type TranslationKey } from './translations'

export type Locale = 'zh' | 'en'
export type { TranslationKey } from './translations'

interface I18nStore {
    locale: Locale
    setLocale: (locale: Locale) => void
    t: (key: TranslationKey, vars?: Record<string, string | number>) => string
}

export const useI18n = create<I18nStore>((set, get) => ({
    locale: 'zh',
    setLocale: (locale) => set({ locale }),
    t: (key, vars) => {
        const locale = get().locale
        const table = translations[locale] as Record<string, string>
        const raw = table[key] || key
        if (!vars) return raw
        return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? k))
    },
}))
