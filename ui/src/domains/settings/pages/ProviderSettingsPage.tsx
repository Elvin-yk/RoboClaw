import { useEffect, useMemo, useState } from 'react'
import SettingsPageFrame from '@/domains/settings/components/SettingsPageFrame'
import { useI18n } from '@/i18n'
import {
  fetchProviderStatus,
  saveProviderConfig,
  type ProviderOption,
} from '@/domains/provider/api/providerApi'

const UI_PROVIDERS = [
  'anthropic', 'openai', 'deepseek', 'dashscope', 'gemini',
  'zhipu', 'moonshot', 'minimax',
  'openrouter', 'aihubmix', 'siliconflow', 'volcengine',
  'ollama', 'vllm',
  'custom',
]

type ProviderGroupKey = 'standard' | 'gateway' | 'local' | 'custom'

const GATEWAY_PROVIDER_NAMES = new Set(['openrouter', 'aihubmix', 'siliconflow', 'volcengine'])

function providerCategory(p: ProviderOption): ProviderGroupKey {
  if (p.name === 'custom') return 'custom'
  if (p.local) return 'local'
  if (GATEWAY_PROVIDER_NAMES.has(p.name)) return 'gateway'
  return 'standard'
}

function needsApiKey(p: ProviderOption): boolean {
  const category = providerCategory(p)
  return category === 'standard' || category === 'gateway' || category === 'custom'
}

function needsBaseUrl(p: ProviderOption): boolean {
  const category = providerCategory(p)
  return category === 'gateway' || category === 'local' || category === 'custom'
}

export default function ProviderSettingsPage() {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderOption[]>([])
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [activeModel, setActiveModel] = useState('')
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [openProviderGroup, setOpenProviderGroup] = useState<ProviderGroupKey | null>('standard')

  useEffect(() => {
    let cancelled = false

    async function loadProvider() {
      try {
        const payload = await fetchProviderStatus()
        if (cancelled) return
        const uiProviders = payload.providers.filter((provider) => UI_PROVIDERS.includes(provider.name))
        setProviders(uiProviders)
        setActiveProvider(payload.active_provider)
        setActiveModel(payload.default_model)

        const initial = uiProviders.find((provider) => provider.name === payload.active_provider)
          ?? uiProviders.find((provider) => provider.name === 'custom')
          ?? null
        setSelectedProvider(initial?.name ?? null)
        setOpenProviderGroup(initial ? providerCategory(initial) : null)
        setApiBase(initial?.api_base || '')
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Failed to load settings.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadProvider()
    return () => { cancelled = true }
  }, [])

  function handleSelectProvider(provider: ProviderOption) {
    setSelectedProvider(provider.name)
    setOpenProviderGroup(providerCategory(provider))
    setError('')
    setNotice('')
    setApiKey('')
    setApiBase(provider.api_base || '')
  }

  async function handleSave(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    setNotice('')

    try {
      const payload = await saveProviderConfig({
        provider: selectedProvider || 'custom',
        api_key: apiKey,
        api_base: apiBase,
      })
      const uiProviders = payload.providers.filter((provider) => UI_PROVIDERS.includes(provider.name))
      setProviders(uiProviders)
      setActiveProvider(payload.active_provider)
      setActiveModel(payload.default_model)
      setNotice(t('saveSuccess'))
      setApiKey('')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save settings.')
    } finally {
      setSaving(false)
    }
  }

  const selected = providers.find((provider) => provider.name === selectedProvider) || null

  const groups = useMemo(() => ([
    { key: 'standard' as const, title: t('providerGroupStandard') },
    { key: 'gateway' as const, title: t('providerGroupGateway') },
    { key: 'local' as const, title: t('providerGroupLocal') },
    { key: 'custom' as const, title: t('providerGroupCustom') },
  ]).map((group) => ({
    ...group,
    items: providers.filter((provider) => providerCategory(provider) === group.key),
  })).filter((group) => group.items.length > 0), [providers, t])

  return (
    <SettingsPageFrame>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-bd/30 bg-white p-5 shadow-card">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm font-semibold text-tx">{t('currentProvider')}</div>
              <span className="rounded-full bg-ac/10 px-3 py-1 text-sm font-semibold text-ac">
                {providers.find((provider) => provider.name === activeProvider)?.label || t('providerNotConfigured')}
              </span>
              <span className="text-sm text-tx3">
                {activeModel || t('settingsNoModel')}
              </span>
            </div>
          </section>

          {loading && (
            <section className="rounded-2xl border border-bd/30 bg-white p-5 text-sm text-tx3 shadow-card">
              {t('loading')}
            </section>
          )}

          {!loading && (
            <section className="rounded-2xl border border-bd/30 bg-sf p-5 shadow-card">
              <div className="space-y-3">
                {groups.map((group) => {
                  const expanded = openProviderGroup === group.key
                  return (
                    <div key={group.key} className="rounded-2xl border border-bd/30 bg-white">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
                        onClick={() => setOpenProviderGroup(expanded ? null : group.key)}
                      >
                        <span className="text-sm font-bold text-tx">{group.title}</span>
                        <span className="text-xs font-semibold text-tx3">{group.items.length}</span>
                      </button>

                      {expanded && (
                        <div className="grid gap-2 border-t border-bd/30 p-3 sm:grid-cols-2 xl:grid-cols-3">
                          {group.items.map((provider) => {
                            const isSelected = provider.name === selectedProvider
                            const isActive = provider.name === activeProvider
                            return (
                              <button
                                key={provider.name}
                                type="button"
                                onClick={() => handleSelectProvider(provider)}
                                className={`rounded-xl border px-4 py-3 text-left transition-all ${
                                  isSelected
                                    ? 'border-ac bg-ac/10 text-ac shadow-glow-ac'
                                    : 'border-bd/30 bg-sf text-tx hover:border-ac/30'
                                }`}
                              >
                                <div className="break-words text-sm font-semibold">{provider.label}</div>
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs">
                                  {provider.configured && (
                                    <span className="rounded-full bg-gn/10 px-2 py-0.5 font-medium text-gn">
                                      {t('saved')}
                                    </span>
                                  )}
                                  {isActive && (
                                    <span className="rounded-full bg-ac/10 px-2 py-0.5 font-medium text-ac">
                                      {t('inUse')}
                                    </span>
                                  )}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        <div>
          {selected && (
            <form onSubmit={handleSave} className="rounded-2xl border border-bd/30 bg-sf p-5 shadow-card xl:sticky xl:top-6">
              <div className="border-b border-bd/30 pb-4">
                <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-tx3">
                  {t('configuring')}
                </div>
                <h3 className="mt-2 text-xl font-semibold text-tx">{selected.label}</h3>
                {selected.configured && selected.masked_api_key && (
                  <div className="mt-2 font-mono text-xs text-tx2">{selected.masked_api_key}</div>
                )}
              </div>

              <div className="mt-5 space-y-4">
                {error && (
                  <div className="rounded-xl border border-rd/30 border-l-4 border-l-rd bg-rd/5 p-3 text-sm text-rd">
                    {error}
                  </div>
                )}
                {notice && (
                  <div className="rounded-xl border border-gn/30 border-l-4 border-l-gn bg-gn/5 p-3 text-sm text-gn">
                    {notice}
                  </div>
                )}

                {needsBaseUrl(selected) && (
                  <label className="block">
                    <div className="mb-1.5 text-xs font-medium text-tx2">Base URL</div>
                    <input
                      value={apiBase}
                      onChange={(e) => setApiBase(e.target.value)}
                      className="w-full rounded-xl border border-bd bg-white px-3 py-2.5 text-sm text-tx outline-none transition-all focus:border-ac focus:shadow-glow-ac"
                      placeholder={t('baseUrlPlaceholder')}
                    />
                  </label>
                )}

                {needsApiKey(selected) && (
                  <label className="block">
                    <div className="mb-1.5 text-xs font-medium text-tx2">API Key</div>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="w-full rounded-xl border border-bd bg-white px-3 py-2.5 text-sm text-tx outline-none transition-all focus:border-ac focus:shadow-glow-ac"
                      placeholder={t('apiKeyPlaceholder')}
                    />
                  </label>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="submit"
                    disabled={saving}
                    className="rounded-full bg-gn px-5 py-2.5 text-sm font-semibold text-white shadow-glow-gn transition-all hover:bg-gn/90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving ? t('saving') : t('saveSettings')}
                  </button>
                  <span className="text-xs text-tx3">{t('saveRedirectHint')}</span>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </SettingsPageFrame>
  )
}
