import { useEffect, useMemo, useState } from 'react'
import * as QRCode from 'qrcode'
import { evoApi, type CreditAccount, type CreditAccountType, type PaymentOrder, type PaymentProvider, type RechargePackage } from '@/shared/api/evoClient'
import { useAuthStore } from '@/shared/lib/authStore'

const ACCOUNT_LABELS: Record<CreditAccountType, string> = {
  data: '数据积分',
  training: '训练积分',
}

const PROVIDERS: Array<{ id: PaymentProvider; label: string }> = [
  { id: 'wechat', label: '微信' },
  { id: 'alipay', label: '支付宝' },
]

export default function CreditsPage() {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn)
  const [accounts, setAccounts] = useState<CreditAccount[]>([])
  const [packages, setPackages] = useState<RechargePackage[]>([])
  const [accountType, setAccountType] = useState<CreditAccountType>('data')
  const [selectedAccountId, setSelectedAccountId] = useState('')
  const [selectedPackageId, setSelectedPackageId] = useState('')
  const [provider, setProvider] = useState<PaymentProvider>('wechat')
  const [order, setOrder] = useState<PaymentOrder | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  const visibleAccounts = useMemo(
    () => accounts.filter((account) => account.account_type === accountType),
    [accounts, accountType],
  )

  const selectedAccount = visibleAccounts.find((account) => account.id === selectedAccountId) || visibleAccounts[0]
  const selectedPackage = packages.find((item) => item.id === selectedPackageId) || packages[0]

  useEffect(() => {
    if (!isLoggedIn) return
    void loadAccounts()
  }, [isLoggedIn])

  useEffect(() => {
    if (!isLoggedIn) return
    void loadPackages(accountType)
  }, [accountType, isLoggedIn])

  useEffect(() => {
    if (!selectedAccount && visibleAccounts.length > 0) {
      setSelectedAccountId(visibleAccounts[0].id)
    }
  }, [selectedAccount, visibleAccounts])

  useEffect(() => {
    if (!selectedPackage && packages.length > 0) {
      setSelectedPackageId(packages[0].id)
    }
  }, [packages, selectedPackage])

  useEffect(() => {
    if (!order || order.status !== 'created') return
    const timer = window.setInterval(async () => {
      const next = await evoApi.getPaymentOrder(order.id)
      setOrder(next)
      if (next.status === 'paid') {
        window.clearInterval(timer)
        setMessage('充值到账')
        await loadAccounts()
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [order])

  useEffect(() => {
    if (!order?.qr_code_url) {
      setQrDataUrl('')
      return
    }
    void QRCode.toDataURL(order.qr_code_url, { margin: 1, width: 220 }).then(setQrDataUrl)
  }, [order?.qr_code_url])

  async function loadAccounts() {
    const next = await evoApi.listCreditAccounts()
    setAccounts(next)
  }

  async function loadPackages(type: CreditAccountType) {
    const next = await evoApi.listRechargePackages(type)
    setPackages(next)
    setSelectedPackageId(next[0]?.id || '')
  }

  async function createOrder() {
    if (!selectedAccount || !selectedPackage) return
    setLoading(true)
    setMessage('')
    try {
      const next = await evoApi.createPaymentOrder(selectedAccount.id, selectedPackage.id, provider)
      setOrder(next)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建订单失败')
    } finally {
      setLoading(false)
    }
  }

  if (!isLoggedIn) {
    return <div className="p-6 text-sm text-tx3">请先登陆</div>
  }

  return (
    <div className="page-enter flex h-full flex-col overflow-y-auto">
      <div className="border-b border-bd/50 bg-sf px-6 py-4">
        <h2 className="text-xl font-bold tracking-tight">积分账户</h2>
      </div>

      <div className="grid gap-6 p-6 xl:grid-cols-[minmax(0,1fr)_420px]">
        <section className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {accounts.map((account) => (
              <div key={account.id} className="rounded-xl border border-bd bg-sf p-5 shadow-card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-tx">{ACCOUNT_LABELS[account.account_type]}</div>
                    <div className="mt-1 text-xs text-tx3">{account.org_id ? '组织账户' : '个人账户'}</div>
                  </div>
                  <div className="rounded-full border border-bd bg-bg px-3 py-1 text-xs text-tx2">{account.status}</div>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs text-tx3">可用</div>
                    <div className="mt-1 text-2xl font-semibold text-tx">{account.available_balance}</div>
                  </div>
                  <div>
                    <div className="text-xs text-tx3">冻结</div>
                    <div className="mt-1 text-2xl font-semibold text-tx">{account.held_balance}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className="rounded-xl border border-bd bg-sf p-5 shadow-card">
          <h3 className="text-sm font-bold uppercase tracking-wide text-tx">充值</h3>
          <div className="mt-4 space-y-4">
            <label className="flex flex-col gap-1.5 text-sm text-tx3">
              积分类型
              <select
                value={accountType}
                onChange={(event) => {
                  setAccountType(event.target.value as CreditAccountType)
                  setOrder(null)
                }}
                className="h-10 rounded-lg border border-bd bg-bg px-3 text-tx"
              >
                <option value="data">数据积分</option>
                <option value="training">训练积分</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-tx3">
              账户
              <select
                value={selectedAccount?.id || ''}
                onChange={(event) => setSelectedAccountId(event.target.value)}
                className="h-10 rounded-lg border border-bd bg-bg px-3 text-tx"
              >
                {visibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.org_id ? '组织账户' : '个人账户'} · 可用 {account.available_balance}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              {packages.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setSelectedPackageId(item.id)}
                  className={`h-12 rounded-lg border text-sm font-semibold transition ${selectedPackage?.id === item.id ? 'border-ac bg-ac text-white' : 'border-bd bg-bg text-tx hover:border-ac/60'}`}
                >
                  ¥{(item.fiat_amount / 100).toFixed(0)} / {item.credit_amount} 分
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {PROVIDERS.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => setProvider(item.id)}
                  className={`h-10 rounded-lg border text-sm font-semibold transition ${provider === item.id ? 'border-ac bg-ac/10 text-ac' : 'border-bd bg-bg text-tx2 hover:border-ac/60'}`}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={loading || !selectedAccount || !selectedPackage}
              onClick={() => { void createOrder() }}
              className="h-11 w-full rounded-lg bg-ac text-sm font-semibold text-white transition hover:bg-ac2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? '创建中...' : '创建支付订单'}
            </button>

            {order && (
              <div className="rounded-lg border border-bd bg-bg p-4">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-semibold text-tx">订单状态</span>
                  <span className="text-tx2">{order.status}</span>
                </div>
                {order.qr_code_url && (
                  <>
                    {qrDataUrl && (
                      <div className="mt-3 flex justify-center rounded-md border border-bd/70 bg-white p-3">
                        <img src={qrDataUrl} alt="支付二维码" className="h-[220px] w-[220px]" />
                      </div>
                    )}
                    <div className="mt-3 break-all rounded-md border border-bd/70 bg-sf p-3 font-mono text-xs leading-5 text-tx2">
                      {order.qr_code_url}
                    </div>
                  </>
                )}
                <div className="mt-2 text-xs text-tx3">
                  使用 {provider === 'wechat' ? '微信' : '支付宝'} 扫码支付后，本页会自动轮询到账状态。
                </div>
              </div>
            )}

            {message && <div className="rounded-lg border border-bd bg-bg px-3 py-2 text-sm text-tx2">{message}</div>}
          </div>
        </aside>
      </div>
    </div>
  )
}
