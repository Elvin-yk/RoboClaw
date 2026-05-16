import { useEffect, useMemo, useState } from 'react'
import {
  isMarketPackageListing,
  isPurchasableListing,
  matchesMarketCategory,
  packageMarketListing,
  type MarketCategory,
  type MarketPackageListing,
  type MarketSort,
} from '@/domains/data/model/marketListing'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useAuthStore } from '@/shared/lib/authStore'
import { evoApi, type CreditAccount } from '@/shared/api/evoClient'
import { useI18n, type TranslationKey } from '@/i18n'
import { cn } from '@/shared/lib/cn'

export default function DataMarketPage() {
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const { packages, error, loadPackages } = useDataLibraryStore()
  const [creditAccounts, setCreditAccounts] = useState<CreditAccount[]>([])
  const [selectedDataAccountId, setSelectedDataAccountId] = useState('')
  const [creditMessage, setCreditMessage] = useState('')
  const [purchaseMessage, setPurchaseMessage] = useState('')
  const [pendingListingId, setPendingListingId] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<MarketCategory>('all')
  const [sort, setSort] = useState<MarketSort>('recommended')
  const [demandList, setDemandList] = useState<string[]>([])

  const dataAccounts = useMemo(
    () => creditAccounts.filter((account) => account.account_type === 'data'),
    [creditAccounts],
  )
  const selectedAccount = dataAccounts.find((account) => account.id === selectedDataAccountId) || dataAccounts[0] || null
  const marketListings = useMemo(() => packages.map(packageMarketListing).filter(isMarketPackageListing), [packages])
  const marketListingsById = useMemo(
    () => new Map(marketListings.map((listing) => [listing.id, listing])),
    [marketListings],
  )
  const categories = useMemo(() => buildMarketCategories(marketListings, t), [marketListings, t])
  const visibleListings = useMemo(() => {
    const queryText = query.trim().toLowerCase()
    return marketListings
      .filter((listing) => matchesMarketCategory(listing, category))
      .filter((listing) => matchesMarketQuery(listing, queryText))
      .sort((left, right) => compareMarketListings(left, right, sort))
  }, [category, marketListings, query, sort])
  const demandListings = useMemo(
    () => demandList.map((listingId) => marketListingsById.get(listingId)).filter(isMarketPackageListing),
    [demandList, marketListingsById],
  )
  const purchasableDemandListings = demandListings.filter(isPurchasableListing)
  const demandTotalCredit = demandListings.reduce((total, listing) => total + (listing.priceCredit ?? 0), 0)
  const purchasableCount = marketListings.filter((listing) => isPurchasableListing(listing)).length
  const ownedCount = marketListings.filter((listing) => listing.hasAccess).length
  const totalEpisodes = marketListings.reduce((total, listing) => total + listing.packageItem.stats.total_episodes, 0)

  useEffect(() => {
    void loadPackages()
  }, [loadPackages])

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

  async function refreshMarketData() {
    await Promise.all([loadPackages(), loadDataCreditAccounts()])
  }

  async function purchaseMarketListing(listing: MarketPackageListing, accountId: string) {
    await evoApi.purchaseDataset(listing.id, accountId)
  }

  async function completePurchasedListings(listingIds: string[]) {
    const purchasedIds = new Set(listingIds)
    setDemandList((current) => current.filter((listingId) => !purchasedIds.has(listingId)))
    await refreshMarketData()
  }

  async function purchaseListing(listing: MarketPackageListing) {
    if (!selectedAccount) {
      setPurchaseMessage(t('dataMarketSelectAccount'))
      return
    }
    if (!isPurchasableListing(listing)) return
    setPendingListingId(listing.id)
    setPurchaseMessage('')
    try {
      await purchaseMarketListing(listing, selectedAccount.id)
      setPurchaseMessage(t('dataMarketPurchaseSuccess'))
      await completePurchasedListings([listing.id])
    } catch (error) {
      setPurchaseMessage(error instanceof Error ? error.message : t('dataMarketPurchaseFailed'))
    } finally {
      setPendingListingId('')
    }
  }

  async function purchaseDemandList() {
    if (!selectedAccount) {
      setPurchaseMessage(t('dataMarketSelectAccount'))
      return
    }
    if (!purchasableDemandListings.length) return
    const purchasedListingIds: string[] = []
    setPurchaseMessage('')
    try {
      for (const listing of purchasableDemandListings) {
        setPendingListingId(listing.id)
        await purchaseMarketListing(listing, selectedAccount.id)
        purchasedListingIds.push(listing.id)
      }
      setPurchaseMessage(t('dataMarketPurchaseSuccess'))
    } catch (error) {
      setPurchaseMessage(error instanceof Error ? error.message : t('dataMarketPurchaseFailed'))
    }
    try {
      if (purchasedListingIds.length) await completePurchasedListings(purchasedListingIds)
    } catch (error) {
      setPurchaseMessage(error instanceof Error ? error.message : t('dataMarketPurchaseFailed'))
    } finally {
      setPendingListingId('')
    }
  }

  function toggleDemandItem(listing: MarketPackageListing) {
    setDemandList((current) => (
      current.includes(listing.id)
        ? current.filter((listingId) => listingId !== listing.id)
        : [...current, listing.id]
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
          <MarketStat label={t('dataMarketSkuCount')} value={String(marketListings.length)} />
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
              {visibleListings.map((listing) => (
                <MarketPackageCard
                  key={listing.id}
                  listing={listing}
                  inDemandList={demandList.includes(listing.id)}
                  selectedAccount={selectedAccount}
                  pending={pendingListingId === listing.id}
                  onToggleDemand={() => toggleDemandItem(listing)}
                  onPurchase={() => void purchaseListing(listing)}
                />
              ))}
              {!visibleListings.length && (
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
                <span>{t('dataMarketDemandCount', { count: demandListings.length })}</span>
              </div>
              <div className="data-market-demand__items">
                {demandListings.map((listing) => (
                  <button key={listing.id} type="button" onClick={() => toggleDemandItem(listing)}>
                    <span>{listing.title}</span>
                    <strong>{formatListingPrice(listing, t)}</strong>
                  </button>
                ))}
                {!demandListings.length && <p>{t('dataMarketDemandEmpty')}</p>}
              </div>
              <div className="data-market-demand__total">
                <span>{t('dataMarketDemandTotal')}</span>
                <strong>{demandTotalCredit}</strong>
              </div>
              <button
                type="button"
                className="data-market-buy-button"
                disabled={!selectedAccount || purchasableDemandListings.length === 0 || Boolean(pendingListingId)}
                onClick={() => void purchaseDemandList()}
              >
                {pendingListingId ? t('dataMarketPurchasing') : t('dataMarketBuyDemand')}
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

function MarketPackageCard({
  listing,
  inDemandList,
  selectedAccount,
  pending,
  onToggleDemand,
  onPurchase,
}: {
  listing: MarketPackageListing
  inDemandList: boolean
  selectedAccount: CreditAccount | null
  pending: boolean
  onToggleDemand: () => void
  onPurchase: () => void
}) {
  const { t } = useI18n()
  const purchaseDisabled = pending || listing.hasAccess || !isPurchasableListing(listing) || !selectedAccount
  return (
    <article className="data-market-card">
      <div className="data-market-card__visual">
        <span>{listing.robotType || t('dataManageRobotUnknown')}</span>
        <strong>{listing.packageItem.stats.total_episodes}</strong>
      </div>
      <div className="data-market-card__body">
        <div className="data-market-card__head">
          <h2>{listing.title}</h2>
          <span className={cn('data-market-access', listing.hasAccess && 'is-owned')}>
            {listing.hasAccess
              ? t('dataMarketOwnedBadge')
              : isPurchasableListing(listing) ? t('dataMarketForSaleBadge') : t('dataMarketPendingBadge')}
          </span>
        </div>
        <p>{listing.description || listing.packageItem.id}</p>
        <div className="data-market-card__tags">
          <span>{listing.robotType || t('dataManageRobotUnknown')}</span>
          <span>{t('dataMarketPackageId')}: {listing.packageItem.id}</span>
          {listing.storage && <span>{t('dataMarketStorage')}: {listing.storage}</span>}
        </div>
        <div className="data-market-card__metrics">
          <span>{t('dataManageEpisodes')}: {listing.packageItem.stats.total_episodes}</span>
          <span>{t('dataManageFrames')}: {listing.packageItem.stats.total_frames}</span>
          <span>FPS: {listing.packageItem.stats.fps || 0}</span>
        </div>
      </div>
      <div className="data-market-card__footer">
        <div className="data-market-price">
          <span>{t('dataMarketPrice')}</span>
          <strong>{formatListingPrice(listing, t)}</strong>
        </div>
        <div className="data-market-card__actions">
          <button type="button" className="data-market-secondary-button" onClick={onToggleDemand}>
            {inDemandList ? t('dataMarketRemoveDemand') : t('dataMarketAddDemand')}
          </button>
          <button type="button" className="data-market-primary-button" disabled={purchaseDisabled} onClick={onPurchase}>
            {listing.hasAccess ? t('dataMarketOwnedAction') : pending ? t('dataMarketPurchasing') : t('dataMarketBuyNow')}
          </button>
        </div>
      </div>
    </article>
  )
}

function buildMarketCategories(
  listings: MarketPackageListing[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): Array<{ value: MarketCategory; label: string }> {
  const robotTypes = [...new Set(listings.map((listing) => listing.robotType).filter(Boolean))].slice(0, 5)
  return [
    { value: 'all', label: t('dataMarketCategoryAll') },
    { value: 'priced', label: t('dataMarketCategoryPriced') },
    { value: 'owned', label: t('dataMarketCategoryOwned') },
    { value: 'free', label: t('dataMarketCategoryFree') },
    ...robotTypes.map((robotType) => ({ value: `robot:${robotType}` as MarketCategory, label: robotType })),
  ]
}

function matchesMarketQuery(listing: MarketPackageListing, query: string): boolean {
  if (!query) return true
  const text = [
    listing.id,
    listing.packageItem.id,
    listing.title,
    listing.description,
    listing.robotType,
    listing.task,
    listing.storage,
  ].join(' ').toLowerCase()
  return text.includes(query)
}

function compareMarketListings(left: MarketPackageListing, right: MarketPackageListing, sort: MarketSort): number {
  if (sort === 'newest') return right.updatedAt.localeCompare(left.updatedAt)
  if (sort === 'price_asc') return (left.priceCredit ?? Number.POSITIVE_INFINITY) - (right.priceCredit ?? Number.POSITIVE_INFINITY)
  if (sort === 'scale_desc') return right.packageItem.stats.total_episodes - left.packageItem.stats.total_episodes
  return Number(right.hasAccess) - Number(left.hasAccess) || right.updatedAt.localeCompare(left.updatedAt)
}

function formatListingPrice(
  listing: MarketPackageListing,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (listing.priceCredit === null) return t('dataMarketPriceTbd')
  if (listing.priceCredit === 0) return t('dataMarketFree')
  return `${listing.priceCredit} ${t('dataMarketCreditUnit')}`
}
