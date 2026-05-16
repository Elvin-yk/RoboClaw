import { asRecord, numberValue, textValue } from '@/domains/data/lib/analysisPayload'
import type { DatasetPackage } from '@/domains/data/model/types'

export type MarketCategory = 'all' | 'priced' | 'owned' | 'free' | `robot:${string}`
export type MarketSort = 'recommended' | 'newest' | 'price_asc' | 'scale_desc'

export interface MarketPackageListing {
  id: string
  packageItem: DatasetPackage
  title: string
  description: string
  robotType: string
  task: string
  priceCredit: number | null
  hasAccess: boolean
  status: string
  storage: string
  updatedAt: string
}

const MARKET_VISIBLE_STATUSES = ['listed', 'published', 'active', 'on_sale']
const MARKET_APPLICATION_STATUSES = [
  'applied',
  'pending',
  'reviewing',
  'approved',
  ...MARKET_VISIBLE_STATUSES,
]

export function packageMarketListing(packageItem: DatasetPackage): MarketPackageListing | null {
  const { listing, packageRecord, summary, status } = packageMarketPayload(packageItem)
  const priceCredit = numberValue(listing.price_credit ?? listing.price_credits ?? packageRecord.price_credit)
  const hasAccessValue = listing.has_access ?? listing.owned ?? packageRecord.has_access
  const hasAccess = hasAccessValue === true || hasAccessValue === 'true'
  const storage = textValue(
    listing.storage_url
      ?? listing.oss_url
      ?? listing.download_url
      ?? packageRecord.market_storage_url
      ?? summary.oss_url,
  )
  const hasExplicitListing = isMarketVisibleStatus(status)
    || priceCredit !== null
    || hasAccessValue !== undefined
    || storage.length > 0
  if (!hasExplicitListing) return null
  const task = textValue(listing.task ?? listing.task_description ?? summary.task_description ?? packageItem.stats.task_description)
  const title = textValue(listing.title ?? listing.name) || task || packageItem.label || packageItem.id
  const description = textValue(listing.description) || task || packageItem.path
  return {
    id: textValue(listing.id) || packageItem.id,
    packageItem,
    title,
    description,
    robotType: textValue(listing.robot_type) || packageItem.stats.robot_type,
    task,
    priceCredit,
    hasAccess,
    status,
    storage,
    updatedAt: textValue(listing.updated_at) || packageItem.updated_at,
  }
}

export function isMarketPackageListing(
  value: MarketPackageListing | null | undefined,
): value is MarketPackageListing {
  return Boolean(value)
}

export function isPurchasableListing(listing: MarketPackageListing): boolean {
  return !listing.hasAccess && listing.priceCredit !== null
}

export function isMarketApplicationSubmitted(packageItem: DatasetPackage): boolean {
  return MARKET_APPLICATION_STATUSES.includes(packageMarketPayload(packageItem).status)
}

export function matchesMarketCategory(listing: MarketPackageListing, category: MarketCategory): boolean {
  if (category === 'all') return true
  if (category === 'priced') return isPurchasableListing(listing)
  if (category === 'owned') return listing.hasAccess
  if (category === 'free') return listing.priceCredit === 0
  if (category.startsWith('robot:')) return listing.robotType === category.slice('robot:'.length)
  return true
}

function isMarketVisibleStatus(status: string): boolean {
  return MARKET_VISIBLE_STATUSES.includes(status)
}

function packageMarketPayload(packageItem: DatasetPackage) {
  const packageRecord = packageItem as unknown as Record<string, unknown>
  const summary = asRecord(packageItem.evaluation_summary)
  const listing = asRecord(packageItem.market_listing)
  const status = textValue(listing.status ?? packageRecord.market_status).toLowerCase()
  return { listing, packageRecord, summary, status }
}
