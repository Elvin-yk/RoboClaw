import { useEffect, useMemo, useState } from 'react'
import { buildDatasetQualityView, datasetTaskDescription, qualityStatusLabelKey } from '@/domains/data/model/datasetQuality'
import type { Dataset } from '@/domains/data/model/types'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useAuthStore } from '@/shared/lib/authStore'
import { evoApi, type CreditAccount } from '@/shared/api/evoClient'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'

type MarketSort = 'recommended' | 'newest' | 'price_asc' | 'scale_desc'
type MarketCategory = 'all' | 'priced' | 'owned' | 'free' | string

export default function DataMarketPage() {
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const { datasets, error, load } = useDataLibraryStore()
  const [creditAccounts, setCreditAccounts] = useState<CreditAccount[]>([])
  const [selectedDataAccountId, setSelectedDataAccountId] = useState('')
  const [creditMessage, setCreditMessage] = useState('')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [pendingDatasetId, setPendingDatasetId] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<MarketCategory>('all')
  const [sort, setSort] = useState<MarketSort>('recommended')
  const [demandList, setDemandList] = useState<string[]>([])

  const dataAccounts = useMemo(
    () => creditAccounts.filter((account) => account.account_type === 'data'),
    [creditAccounts],
  )
  const selectedAccount = dataAccounts.find((account) => account.id === selectedDataAccountId) || dataAccounts[0] || null
  const marketDatasets = useMemo(() => datasets.filter(isMarketDataset), [datasets])
  const categories = useMemo(() => buildMarketCategories(marketDatasets, t), [marketDatasets, t])
  const visibleDatasets = useMemo(() => {
    const queryText = query.trim().toLowerCase()
    return marketDatasets
      .filter((dataset) => matchesCategory(dataset, category))
      .filter((dataset) => matchesMarketQuery(dataset, queryText))
      .sort((left, right) => compareMarketDatasets(left, right, sort))
  }, [category, marketDatasets, query, sort])
  const demandDatasets = demandList
    .map((datasetId) => marketDatasets.find((dataset) => dataset.id === datasetId))
    .filter(isDataset)
  const demandTotalCredit = demandDatasets.reduce((total, dataset) => total + (dataset.price_credit ?? 0), 0)
  const purchasableCount = marketDatasets.filter((dataset) => isPurchasableDataset(dataset)).length
  const ownedCount = marketDatasets.filter((dataset) => dataset.has_access === true).length
  const totalEpisodes = marketDatasets.reduce((total, dataset) => total + dataset.stats.total_episodes, 0)

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!user) return
    void loadDataCreditAccounts()
  }, [user])

  useEffect(() => {
    if (selectedDataAccountId || dataAccounts.length === 0) return
    const personalAccount = dataAccounts.find((account) => !account.org_id)
    setSelectedDataAccountId((personalAccount || dataAccounts[0]).id)
  }, [dataAccounts, selectedDataAccountId])

  async function loadDataCreditAccounts() {
    try {
      const accounts = await evoApi.listCreditAccounts()
      setCreditAccounts(accounts)
      setCreditMessage('')
    } catch (error) {
      setCreditMessage(error instanceof Error ? error.message : t('dataMarketCreditLoadFailed'))
    }
  }

  async function purchaseDataset(dataset: Dataset) {
    if (!selectedAccount) {
      setPurchaseMessage(t('dataMarketSelectAccount'))
      return
    }
    if (!isPurchasableDataset(dataset)) return
    setPendingDatasetId(dataset.id)
    setPurchaseMessage('')
    try {
      await evoApi.purchaseDataset(dataset.id, selectedAccount.id)
      setPurchaseMessage(t('dataMarketPurchaseSuccess'))
      setDemandList((current) => current.filter((datasetId) => datasetId !== dataset.id))
      await Promise.all([load(), loadDataCreditAccounts()])
    } catch (error) {
      setPurchaseMessage(error instanceof Error ? error.message : t('dataMarketPurchaseFailed'))
    } finally {
      setPendingDatasetId('')
    }
  }

  async function purchaseDemandList() {
    const purchasableDemand = demandDatasets.filter(isPurchasableDataset)
    for (const dataset of purchasableDemand) {
      await purchaseDataset(dataset)
    }
  }

  function toggleDemandItem(dataset: Dataset) {
    setDemandList((current) => (
      current.includes(dataset.id)
        ? current.filter((datasetId) => datasetId !== dataset.id)
        : [...current, dataset.id]
    ))
  }

  return (
    <section className="data-page data-market-page">
      {error && <div className="data-alert">{error}</div>}
      {creditMessage && <div className="data-alert">{creditMessage}</div>}
      {purchaseMessage && <div className="data-alert">{purchaseMessage}</div>}

      <div className="data-market-shell">
        <section className="data-panel data-market-overview">
          <div className="data-market-overview__copy">
            <span>{t('dataMarketEyebrow')}</span>
            <h1>{t('dataMarketTitle')}</h1>
            <p>{t('dataMarketDesc')}</p>
          </div>
          <div className="data-market-credit-panel">
            <span>{t('dataMarketCreditAccount')}</span>
            <select
              value={selectedAccount?.id || ''}
              onChange={(event) => setSelectedDataAccountId(event.target.value)}
            >
              {dataAccounts.length > 0 ? dataAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.org_id ? t('dataMarketOrgAccount') : t('dataMarketPersonalAccount')} · {account.available_balance}
                </option>
              )) : (
                <option value="">{t('dataMarketNoAccount')}</option>
              )}
            </select>
            <strong>{selectedAccount ? selectedAccount.available_balance : '-'}</strong>
            <em>{selectedAccount ? t('dataMarketCreditHeld', { count: selectedAccount.held_balance }) : t('dataMarketCreditUnavailable')}</em>
          </div>
        </section>

        <section className="data-market-stats">
          <MarketStat label={t('dataMarketSkuCount')} value={String(marketDatasets.length)} />
          <MarketStat label={t('dataMarketPurchasable')} value={String(purchasableCount)} />
          <MarketStat label={t('dataMarketOwned')} value={String(ownedCount)} />
          <MarketStat label={t('dataMarketTotalEpisodes')} value={String(totalEpisodes)} />
        </section>

        <div className="data-market-layout">
          <main className="data-market-main">
            <section className="data-panel data-market-controls">
              <div className="data-market-search">
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('dataMarketSearchPlaceholder')}
                />
                <select value={sort} onChange={(event) => setSort(event.target.value as MarketSort)}>
                  <option value="recommended">{t('dataMarketSortRecommended')}</option>
                  <option value="newest">{t('dataMarketSortNewest')}</option>
                  <option value="price_asc">{t('dataMarketSortPriceAsc')}</option>
                  <option value="scale_desc">{t('dataMarketSortScaleDesc')}</option>
                </select>
              </div>
              <div className="data-market-categories">
                {categories.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={cn('data-market-category', category === item.value && 'is-active')}
                    onClick={() => setCategory(item.value)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="data-market-grid" aria-label={t('dataMarketListing')}>
              {visibleDatasets.map((dataset) => (
                <MarketDatasetCard
                  key={dataset.id}
                  dataset={dataset}
                  inDemandList={demandList.includes(dataset.id)}
                  selectedAccount={selectedAccount}
                  pending={pendingDatasetId === dataset.id}
                  onToggleDemand={() => toggleDemandItem(dataset)}
                  onPurchase={() => void purchaseDataset(dataset)}
                />
              ))}
              {!visibleDatasets.length && (
                <div className="data-panel data-market-empty">
                  <strong>{t('dataMarketEmptyTitle')}</strong>
                  <span>{t('dataMarketEmptyDesc')}</span>
                </div>
              )}
            </section>
          </main>

          <aside className="data-market-side">
            <section className="data-panel data-market-demand">
              <div className="data-market-side__title">
                <h2>{t('dataMarketDemandList')}</h2>
                <span>{t('dataMarketDemandCount', { count: demandDatasets.length })}</span>
              </div>
              <div className="data-market-demand__items">
                {demandDatasets.map((dataset) => (
                  <button key={dataset.id} type="button" onClick={() => toggleDemandItem(dataset)}>
                    <span>{datasetTaskDescription(dataset) || dataset.label}</span>
                    <strong>{formatDatasetPrice(dataset, t)}</strong>
                  </button>
                ))}
                {!demandDatasets.length && <p>{t('dataMarketDemandEmpty')}</p>}
              </div>
              <div className="data-market-demand__total">
                <span>{t('dataMarketDemandTotal')}</span>
                <strong>{demandTotalCredit}</strong>
              </div>
              <button
                type="button"
                className="data-market-buy-button"
                disabled={!selectedAccount || demandDatasets.filter(isPurchasableDataset).length === 0 || Boolean(pendingDatasetId)}
                onClick={() => void purchaseDemandList()}
              >
                {pendingDatasetId ? t('dataMarketPurchasing') : t('dataMarketBuyDemand')}
              </button>
            </section>

            <section className="data-panel data-market-signal">
              <div className="data-market-side__title">
                <h2>{t('dataMarketDemandSignal')}</h2>
              </div>
              <ul>
                <li>{t('dataMarketSignalQuality')}</li>
                <li>{t('dataMarketSignalRobot')}</li>
                <li>{t('dataMarketSignalLicense')}</li>
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </section>
  )
}

function MarketStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="data-panel data-market-stat">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function MarketDatasetCard({
  dataset,
  inDemandList,
  selectedAccount,
  pending,
  onToggleDemand,
  onPurchase,
}: {
  dataset: Dataset
  inDemandList: boolean
  selectedAccount: CreditAccount | null
  pending: boolean
  onToggleDemand: () => void
  onPurchase: () => void
}) {
  const { t } = useI18n()
  const task = datasetTaskDescription(dataset) || dataset.label
  const quality = buildDatasetQualityView(dataset)
  const purchaseDisabled = pending || dataset.has_access === true || !isPurchasableDataset(dataset) || !selectedAccount
  return (
    <article className="data-market-card">
      <div className="data-market-card__visual">
        <span>{dataset.stats.robot_type || t('dataManageRobotUnknown')}</span>
        <strong>{dataset.stats.total_episodes}</strong>
      </div>
      <div className="data-market-card__body">
        <div className="data-market-card__head">
          <h2>{task}</h2>
          <span className={cn('data-market-access', dataset.has_access && 'is-owned')}>
            {dataset.has_access
              ? t('dataMarketOwnedBadge')
              : isPurchasableDataset(dataset) ? t('dataMarketForSaleBadge') : t('dataMarketPendingBadge')}
          </span>
        </div>
        <p>{dataset.id}</p>
        <div className="data-market-card__tags">
          <span>{dataset.stats.robot_type || t('dataManageRobotUnknown')}</span>
          <span>{t(qualityStatusLabelKey(quality.autoCleanStatus))}</span>
          <span>{t(qualityStatusLabelKey(quality.manualReviewStatus))}</span>
        </div>
        <div className="data-market-card__metrics">
          <span>{t('dataManageEpisodes')}: {dataset.stats.total_episodes}</span>
          <span>{t('dataManageFrames')}: {dataset.stats.total_frames}</span>
          <span>FPS: {dataset.stats.fps || 0}</span>
        </div>
      </div>
      <div className="data-market-card__footer">
        <div className="data-market-price">
          <span>{t('dataMarketPrice')}</span>
          <strong>{formatDatasetPrice(dataset, t)}</strong>
        </div>
        <div className="data-market-card__actions">
          <button type="button" className="data-market-secondary-button" onClick={onToggleDemand}>
            {inDemandList ? t('dataMarketRemoveDemand') : t('dataMarketAddDemand')}
          </button>
          <button type="button" className="data-market-primary-button" disabled={purchaseDisabled} onClick={onPurchase}>
            {dataset.has_access ? t('dataMarketOwnedAction') : pending ? t('dataMarketPurchasing') : t('dataMarketBuyNow')}
          </button>
        </div>
      </div>
    </article>
  )
}

function buildMarketCategories(
  datasets: Dataset[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): Array<{ value: MarketCategory; label: string }> {
  const robotTypes = [...new Set(datasets.map((dataset) => dataset.stats.robot_type).filter(Boolean))].slice(0, 5)
  return [
    { value: 'all', label: t('dataMarketCategoryAll') },
    { value: 'priced', label: t('dataMarketCategoryPriced') },
    { value: 'owned', label: t('dataMarketCategoryOwned') },
    { value: 'free', label: t('dataMarketCategoryFree') },
    ...robotTypes.map((robotType) => ({ value: `robot:${robotType}`, label: robotType })),
  ]
}

function isMarketDataset(dataset: Dataset): boolean {
  return dataset.price_credit !== undefined
    || dataset.has_access !== undefined
    || dataset.lifecycle_stage === 'clean'
    || dataset.source === 'remote'
}

function isPurchasableDataset(dataset: Dataset): boolean {
  return dataset.has_access !== true
    && dataset.price_credit !== null
    && dataset.price_credit !== undefined
}

function matchesCategory(dataset: Dataset, category: MarketCategory): boolean {
  if (category === 'all') return true
  if (category === 'priced') return isPurchasableDataset(dataset)
  if (category === 'owned') return dataset.has_access === true
  if (category === 'free') return dataset.price_credit === 0
  if (category.startsWith('robot:')) return dataset.stats.robot_type === category.slice('robot:'.length)
  return true
}

function matchesMarketQuery(dataset: Dataset, query: string): boolean {
  if (!query) return true
  const text = [
    dataset.id,
    dataset.label,
    dataset.name,
    dataset.path,
    dataset.stats.robot_type,
    datasetTaskDescription(dataset),
  ].join(' ').toLowerCase()
  return text.includes(query)
}

function compareMarketDatasets(left: Dataset, right: Dataset, sort: MarketSort): number {
  if (sort === 'newest') return right.updated_at.localeCompare(left.updated_at)
  if (sort === 'price_asc') return (left.price_credit ?? Number.POSITIVE_INFINITY) - (right.price_credit ?? Number.POSITIVE_INFINITY)
  if (sort === 'scale_desc') return right.stats.total_episodes - left.stats.total_episodes
  const leftAccessRank = left.has_access ? 1 : 0
  const rightAccessRank = right.has_access ? 1 : 0
  return rightAccessRank - leftAccessRank || right.updated_at.localeCompare(left.updated_at)
}

function formatDatasetPrice(
  dataset: Dataset,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (dataset.price_credit === undefined || dataset.price_credit === null) return t('dataMarketPriceTbd')
  if (dataset.price_credit === 0) return t('dataMarketFree')
  return `${dataset.price_credit} ${t('dataMarketCreditUnit')}`
}

function isDataset(value: Dataset | undefined): value is Dataset {
  return Boolean(value)
}
