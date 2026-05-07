import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import SettingsPageFrame from '@/domains/settings/components/SettingsPageFrame'
import { useAuthStore } from '@/shared/lib/authStore'
import {
    currentMembershipRole,
    evoApi,
    membershipRoleLabel,
    type MembershipInfo,
    type MembershipInvitationStatus,
} from '@/shared/api/evoClient'
import { maskPhone } from '@/shared/lib/phone'
import { useI18n } from '@/i18n'

// ─── SVG Icons ────────────────────────────────────────────────────────────────

function PhoneIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function LockIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
    )
}

function OrganizationExitIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 21h18" />
            <path d="M5 21V7l8-4v18" />
            <path d="M19 21V11l-6-4" />
            <path d="M9 13h.01" />
        </svg>
    )
}

function ChevronDownIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function ChevronUpIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="18 15 12 9 6 15" />
        </svg>
    )
}

function RefreshIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
    )
}

function Spinner() {
    return (
        <svg className="animate-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" />
        </svg>
    )
}

function PencilIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
    )
}

// ─── Countdown hook ───────────────────────────────────────────────────────────

function useCountdown() {
    const [countdown, setCountdown] = useState(0)
    const timer = useRef<ReturnType<typeof setInterval> | null>(null)
    const start = (seconds = 60) => {
        setCountdown(seconds)
        if (timer.current) clearInterval(timer.current)
        timer.current = setInterval(() => {
            setCountdown((c) => {
                if (c <= 1) { clearInterval(timer.current!); return 0 }
                return c - 1
            })
        }, 1000)
    }
    useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])
    return { countdown, start }
}

// ─── Shared input style ───────────────────────────────────────────────────────

const inputCls =
    'w-full rounded-xl border border-[color:var(--bd)] bg-[color:var(--bg)] px-4 py-2.5 text-sm text-[color:var(--tx)] placeholder-[color:var(--tx2)] outline-none transition focus:border-[color:var(--ac)] focus:ring-2 focus:ring-[rgba(47,111,228,0.15)] disabled:opacity-50'

const btnPrimaryCls =
    'flex items-center justify-center gap-2 rounded-xl bg-[color:var(--ac)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50'

const btnSecCls =
    'flex items-center justify-center gap-2 rounded-xl border border-[color:var(--bd)] px-4 py-2.5 text-sm text-[color:var(--tx2)] transition hover:border-[color:var(--ac)] hover:text-[color:var(--ac)] disabled:opacity-50'

// ─── CaptchaRow ───────────────────────────────────────────────────────────────

function CaptchaRow({
    captchaImg,
    captchaText,
    onChange,
    onRefresh,
    disabled,
}: {
    captchaImg: string
    captchaText: string
    onChange: (v: string) => void
    onRefresh: () => void
    disabled?: boolean
}) {
    return (
        <div className="flex gap-2 items-center">
            <input
                type="text"
                maxLength={6}
                value={captchaText}
                onChange={(e) => onChange(e.target.value.toUpperCase())}
                placeholder="图形验证码"
                disabled={disabled}
                className={`${inputCls} flex-1 font-mono tracking-widest`}
            />
            <button
                type="button"
                onClick={onRefresh}
                disabled={disabled}
                className="h-[42px] min-w-[100px] rounded-xl border border-[color:var(--bd)] bg-[color:var(--bg)] overflow-hidden flex items-center justify-center cursor-pointer hover:border-[color:var(--ac)] transition"
                title="点击刷新验证码"
            >
                {captchaImg
                    ? <img
                        src={captchaImg.startsWith('data:') ? captchaImg : `data:image/png;base64,${captchaImg}`}
                        alt="captcha"
                        className="h-full w-auto block"
                    />
                    : <RefreshIcon />
                }
            </button>
        </div>
    )
}

// ─── Msg banner ───────────────────────────────────────────────────────────────

function MsgBanner({ msg }: { msg: string }) {
    if (!msg) return null
    const isError = !msg.startsWith('✓')
    return (
        <div className={`rounded-xl px-4 py-2.5 text-sm ${isError ? 'bg-[rgba(220,53,69,0.08)] text-[#dc3545]' : 'bg-[rgba(34,197,94,0.1)] text-[#16a34a]'}`}>
            {msg}
        </div>
    )
}

// ─── ChangePhonePanel ─────────────────────────────────────────────────────────

function ChangePhonePanel({ onSuccess }: { onSuccess: () => void }) {
    const { t } = useI18n()
    const [newPhone, setNewPhone] = useState('')
    const [captchaId, setCaptchaId] = useState('')
    const [captchaImg, setCaptchaImg] = useState('')
    const [captchaText, setCaptchaText] = useState('')
    const [smsCode, setSmsCode] = useState('')
    const [step, setStep] = useState<'form' | 'sms'>('form')
    const [loading, setLoading] = useState(false)
    const [msg, setMsg] = useState('')
    const { countdown, start: startCountdown } = useCountdown()

    const fetchCaptcha = async () => {
        try {
            const res = await evoApi.getCaptcha()
            setCaptchaId(res.captcha_id)
            setCaptchaImg(res.image_base64)
            setCaptchaText('')
        } catch { /* 静默失败 */ }
    }

    useEffect(() => { void fetchCaptcha() }, [])

    const handleSendSms = async () => {
        setMsg('')
        if (!newPhone || newPhone.length !== 11) { setMsg(t('authPhoneError')); return }
        if (!captchaText) { setMsg(t('authCaptchaRequired')); return }
        setLoading(true)
        try {
            await evoApi.sendSmsWithScene(newPhone, captchaId, captchaText, 'change_phone')
            setStep('sms')
            startCountdown()
        } catch (e: unknown) {
            setMsg((e as Error).message || t('authSendFailed'))
            void fetchCaptcha()
        } finally {
            setLoading(false)
        }
    }

    const handleConfirm = async () => {
        setMsg('')
        if (!smsCode || smsCode.length !== 6) { setMsg(t('authSmsCodeError')); return }
        setLoading(true)
        try {
            await evoApi.changePhone(newPhone, smsCode)
            setMsg(`✓ ${t('accountPhoneChanged')}`)
            setTimeout(() => onSuccess(), 2000)
        } catch (e: unknown) {
            setMsg((e as Error).message || t('authLoginFailed'))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="space-y-4 pt-1">
            <MsgBanner msg={msg} />
            {step === 'form' ? (
                <>
                    <div>
                        <label className="acc-label">{t('accountNewPhone')}</label>
                        <input
                            type="tel"
                            maxLength={11}
                            value={newPhone}
                            onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, ''))}
                            placeholder={t('accountNewPhonePlaceholder')}
                            disabled={loading}
                            className={inputCls}
                        />
                    </div>
                    <div>
                        <label className="acc-label">{t('authCaptchaPlaceholder')}</label>
                        <CaptchaRow captchaImg={captchaImg} captchaText={captchaText} onChange={setCaptchaText} onRefresh={fetchCaptcha} disabled={loading} />
                    </div>
                    <button onClick={() => void handleSendSms()} disabled={loading} className={`${btnPrimaryCls} w-full`}>
                        {loading && <Spinner />}{t('accountSendSmsBtn')}
                    </button>
                </>
            ) : (
                <>
                    <p className="text-sm text-[color:var(--tx2)]">
                        {t('accountSmsCodeSentTo')}{' '}
                        <span className="font-semibold text-[color:var(--tx)]">{newPhone.slice(0, 3)}****{newPhone.slice(7)}</span>
                    </p>
                    <input
                        type="text"
                        maxLength={6}
                        value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
                        placeholder={t('authSmsCodePlaceholder')}
                        autoFocus
                        disabled={loading}
                        className={`${inputCls} font-mono tracking-widest`}
                    />
                    <div className="flex gap-3">
                        <button onClick={() => void handleConfirm()} disabled={loading} className={`${btnPrimaryCls} flex-1`}>
                            {loading && <Spinner />}{t('accountConfirmChangePhone')}
                        </button>
                        {countdown > 0
                            ? <span className="flex items-center px-4 text-sm text-[color:var(--tx2)] border border-[color:var(--bd)] rounded-xl">{countdown}s</span>
                            : <button onClick={() => { setStep('form'); void fetchCaptcha() }} className={btnSecCls}>{t('accountResendCode')}</button>
                        }
                    </div>
                </>
            )}
        </div>
    )
}

// ─── ResetPasswordPanel ───────────────────────────────────────────────────────

function ResetPasswordPanel({ phone, hasPassword, onSuccess }: { phone: string; hasPassword: boolean; onSuccess: () => void }) {
    const { t } = useI18n()
    const [captchaId, setCaptchaId] = useState('')
    const [captchaImg, setCaptchaImg] = useState('')
    const [captchaText, setCaptchaText] = useState('')
    const [smsCode, setSmsCode] = useState('')
    const [newPassword, setNewPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [step, setStep] = useState<'form' | 'sms'>('form')
    const [loading, setLoading] = useState(false)
    const [msg, setMsg] = useState('')
    const { countdown, start: startCountdown } = useCountdown()

    const fetchCaptcha = async () => {
        try {
            const res = await evoApi.getCaptcha()
            setCaptchaId(res.captcha_id)
            setCaptchaImg(res.image_base64)
            setCaptchaText('')
        } catch { /* 静默失败 */ }
    }

    useEffect(() => { void fetchCaptcha() }, [])

    const handleSendSms = async () => {
        setMsg('')
        if (!captchaText) { setMsg(t('authCaptchaRequired')); return }
        if (!newPassword || newPassword.length < 8) { setMsg(t('accountPasswordTooShort')); return }
        if (newPassword !== confirmPassword) { setMsg(t('accountPasswordMismatch')); return }
        setLoading(true)
        try {
            await evoApi.sendSmsWithScene(phone, captchaId, captchaText, 'reset_password')
            setStep('sms')
            startCountdown()
        } catch (e: unknown) {
            setMsg((e as Error).message || t('authSendFailed'))
            void fetchCaptcha()
        } finally {
            setLoading(false)
        }
    }

    const handleConfirm = async () => {
        setMsg('')
        if (!smsCode || smsCode.length !== 6) { setMsg(t('authSmsCodeError')); return }
        setLoading(true)
        try {
            await evoApi.resetPassword(phone, smsCode, newPassword)
            setMsg(`✓ ${t('accountPasswordSet')}`)
            setTimeout(() => onSuccess(), 2000)
        } catch (e: unknown) {
            setMsg((e as Error).message || t('authLoginFailed'))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="space-y-4 pt-1">
            <MsgBanner msg={msg} />
            {step === 'form' ? (
                <>
                    <div>
                        <label className="acc-label">{t('accountNewPassword')}</label>
                        <input
                            type="password"
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder={t('accountNewPasswordPlaceholder')}
                            disabled={loading}
                            className={inputCls}
                        />
                    </div>
                    <div>
                        <label className="acc-label">{t('accountConfirmPassword')}</label>
                        <input
                            type="password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder={t('accountConfirmPasswordPlaceholder')}
                            disabled={loading}
                            className={inputCls}
                        />
                    </div>
                    <div>
                        <label className="acc-label">{t('authCaptchaPlaceholder')}</label>
                        <CaptchaRow captchaImg={captchaImg} captchaText={captchaText} onChange={setCaptchaText} onRefresh={fetchCaptcha} disabled={loading} />
                    </div>
                    <p className="text-xs text-[color:var(--tx2)]">
                        验证码将发送至 {maskPhone(phone)}
                    </p>
                    <button onClick={() => void handleSendSms()} disabled={loading} className={`${btnPrimaryCls} w-full`}>
                        {loading && <Spinner />}{t('accountSendSmsBtn')}
                    </button>
                </>
            ) : (
                <>
                    <p className="text-sm text-[color:var(--tx2)]">
                        {t('accountSmsCodeSentTo')}{' '}
                        <span className="font-semibold text-[color:var(--tx)]">{maskPhone(phone)}</span>
                    </p>
                    <input
                        type="text"
                        maxLength={6}
                        value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value.replace(/\D/g, ''))}
                        placeholder={t('authSmsCodePlaceholder')}
                        autoFocus
                        disabled={loading}
                        className={`${inputCls} font-mono tracking-widest`}
                    />
                    <div className="flex gap-3">
                        <button onClick={() => void handleConfirm()} disabled={loading} className={`${btnPrimaryCls} flex-1`}>
                            {loading && <Spinner />}{t('accountConfirmSetPassword')}
                        </button>
                        {countdown > 0
                            ? <span className="flex items-center px-4 text-sm text-[color:var(--tx2)] border border-[color:var(--bd)] rounded-xl">{countdown}s</span>
                            : <button onClick={() => { setStep('form'); void fetchCaptcha() }} className={btnSecCls}>{t('accountResendCode')}</button>
                        }
                    </div>
                </>
            )}

            {/* 密码设置提示 */}
            {!hasPassword && step === 'form' && (
                <p className="text-xs text-[color:var(--tx2)] border-t border-[color:var(--bd)] pt-3">
                    💡 设置登录密码后，您可以使用手机号 + 密码的方式快速登录，无需每次接收短信验证码。
                </p>
            )}
        </div>
    )
}

// ─── NameRow ──────────────────────────────────────────────────────────────────

function NicknameRow({ user }: { user: { nickname: string | null } }) {
    const { t } = useI18n()
    const { setUser, user: storeUser } = useAuthStore()
    const [editing, setEditing] = useState(false)
    const [value, setValue] = useState(user.nickname || '')
    const [saving, setSaving] = useState(false)
    const [msg, setMsg] = useState('')

    const handleSave = async () => {
        setSaving(true); setMsg('')
        try {
            const updated = await evoApi.updateNickname(value)
            if (storeUser) setUser({ ...storeUser, nickname: updated.nickname })
            setMsg(t('accountNicknameSaved'))
            setEditing(false)
            setTimeout(() => setMsg(''), 3000)
        } catch (e: unknown) {
            setMsg('❌ ' + ((e as Error).message || '保存失败'))
        } finally {
            setSaving(false)
        }
    }

    const handleCancel = () => {
        setEditing(false)
        setValue(storeUser?.nickname || '')
        setMsg('')
    }

    return (
        <div className="border-t border-[color:var(--bd)]/50 first:border-t-0">
            <button
                type="button"
                onClick={() => {
                    setEditing((next) => {
                        const open = !next
                        if (open) setValue(storeUser?.nickname || '')
                        setMsg('')
                        return open
                    })
                }}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-[color:var(--bg2)] transition text-left"
            >
                <div className="flex items-center gap-3 text-[color:var(--tx2)]">
                    <PencilIcon />
                    <span className="text-sm font-medium text-[color:var(--tx)]">{t('accountNicknameEdit')}</span>
                </div>
                <span className="text-[color:var(--tx2)]">{editing ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
            </button>

            {editing && (
                <div className="px-5 pb-5 space-y-2">
                    <input
                        type="text"
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        maxLength={20}
                        placeholder={t('accountNicknamePlaceholder')}
                        autoFocus
                        className={inputCls}
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => void handleSave()}
                            disabled={saving}
                            className={`${btnPrimaryCls} py-2 px-3 text-xs`}
                        >
                            {saving && <Spinner />}{t('accountNicknameSave')}
                        </button>
                        <button
                            type="button"
                            onClick={handleCancel}
                            className={`${btnSecCls} py-2 px-3 text-xs`}
                        >
                            {t('accountNicknameCancel')}
                        </button>
                    </div>
                    {msg && (
                        <p className={`text-xs ${msg.startsWith('✓') ? 'text-[color:var(--gn)]' : 'text-[#dc3545]'}`}>
                            {msg}
                        </p>
                    )}
                </div>
            )}
            {msg && !editing && (
                <p className={`px-5 pb-4 text-xs ${msg.startsWith('✓') ? 'text-[color:var(--gn)]' : 'text-[#dc3545]'}`}>
                    {msg}
                </p>
            )}
        </div>
    )
}

// ─── ExpandableRow ────────────────────────────────────────────────────────────

function ExpandableRow({
    icon,
    label,
    isOpen,
    onToggle,
    children,
}: {
    icon: React.ReactNode
    label: string
    isOpen: boolean
    onToggle: () => void
    children: React.ReactNode
}) {
    return (
        <div className="border-t border-[color:var(--bd)]/50 first:border-t-0">
            <button
                type="button"
                onClick={onToggle}
                className="w-full flex items-center justify-between px-5 py-4 hover:bg-[color:var(--bg2)] transition text-left"
            >
                <div className="flex items-center gap-3 text-[color:var(--tx2)]">
                    {icon}
                    <span className="text-sm font-medium text-[color:var(--tx)]">{label}</span>
                </div>
                <span className="text-[color:var(--tx2)]">{isOpen ? <ChevronUpIcon /> : <ChevronDownIcon />}</span>
            </button>
            {isOpen && (
                <div className="px-5 pb-5">
                    {children}
                </div>
            )}
        </div>
    )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AccountSettingsPage() {
    const { t } = useI18n()
    const navigate = useNavigate()
    const { user, logout, setUser } = useAuthStore()

    type Panel = 'change_phone' | 'reset_password'
    type InviteResult = { kind: 'success' | 'error'; text: string }
    const [openPanel, setOpenPanel] = useState<Panel | null>(null)
    const [inviteActionId, setInviteActionId] = useState<string | null>(null)
    const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)

    const togglePanel = (panel: Panel) => {
        setOpenPanel((prev) => (prev === panel ? null : panel))
    }

    const membershipRole = currentMembershipRole(user)
    const activeMembership = user?.current_membership?.status === 'active' ? user.current_membership : null
    const pendingInvites = user?.memberships.filter((membership) => membership.status === 'invited') ?? []
    const displayMembership = activeMembership ?? pendingInvites[0] ?? null
    const displayRole = displayMembership?.role_code ?? membershipRole
    const roleLabel = displayRole ? membershipRoleLabel(displayRole) : t('settingsNotConfigured')
    const accountNickname = user?.nickname?.trim()
    const accountName = accountNickname || '未设置姓名'
    const avatarInitial = accountNickname
        ? accountNickname.slice(0, 1).toUpperCase()
        : user?.phone.slice(0, 3) ?? '?'
    const organizationName = displayMembership?.organization.name ?? '未加入组织'

    const roleColor = displayRole === 'owner'
        ? 'rgba(234,179,8,0.15)'
        : displayRole === 'admin'
            ? 'rgba(47,111,228,0.14)'
            : 'rgba(100,116,139,0.12)'

    const roleTextColor = displayRole === 'owner'
        ? '#b45309'
        : displayRole === 'admin'
            ? 'var(--ac)'
            : 'var(--tx2)'

    const inviterLabel = (membership: MembershipInfo) => {
        const inviter = membership.invited_by_user
        if (!inviter) return '组织管理员'
        return inviter.nickname?.trim() || maskPhone(inviter.phone)
    }

    const handleMembershipResponse = async (
        membership: MembershipInfo,
        status: MembershipInvitationStatus,
        successText: string,
    ) => {
        setInviteActionId(membership.id)
        setInviteResult(null)
        try {
            await evoApi.respondMembershipInvitation(membership.id, status)
            const updated = await evoApi.getMe()
            setUser(updated)
            setInviteResult({ kind: 'success', text: successText })
        } catch (err) {
            setInviteResult({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        } finally {
            setInviteActionId(null)
        }
    }

    if (!user) {
        return (
            <SettingsPageFrame>
                <div className="glass-panel px-6 py-10 text-center">
                    <p className="text-sm text-[color:var(--tx2)] mb-4">{t('accountNotLoggedIn')}</p>
                    <button
                        onClick={() => navigate('/login')}
                        className={btnPrimaryCls}
                        style={{ display: 'inline-flex' }}
                    >
                        {t('authLoginPrompt')}
                    </button>
                </div>
            </SettingsPageFrame>
        )
    }

    const handlePanelSuccess = (panel: Panel) => {
        setOpenPanel(null)
        if (panel === 'change_phone') {
            // 更换手机号后退出并跳转登录
            setTimeout(() => {
                logout()
                navigate('/login')
            }, 2500)
        }
    }

    return (
        <SettingsPageFrame>
            <div className="max-w-xl mx-auto space-y-6">
                {pendingInvites.length > 0 && (
                    <div className="glass-panel px-5 py-4 space-y-4 border border-[rgba(245,158,11,0.28)]">
                        <div>
                            <p className="text-sm font-semibold text-[color:var(--tx)]">待处理组织邀请</p>
                            <p className="mt-1 text-xs text-[color:var(--tx2)]">
                                同意后会加入对应组织，拒绝后该邀请会被关闭。若已在其他组织，需要先退出当前组织。
                            </p>
                        </div>
                        <div className="space-y-3">
                            {pendingInvites.map((membership) => (
                                <div
                                    key={membership.id}
                                    className="rounded-2xl border border-[color:var(--bd)] bg-[color:var(--bg)] px-4 py-3"
                                >
                                    <p className="text-sm font-medium text-[color:var(--tx)]">
                                        {inviterLabel(membership)} 邀请你加入 {membership.organization.name}
                                    </p>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            className={`${btnPrimaryCls} px-3 py-2 text-xs`}
                                            disabled={inviteActionId !== null}
                                            onClick={() => void handleMembershipResponse(membership, 'active', '已加入组织')}
                                        >
                                            {inviteActionId === membership.id && <Spinner />}同意
                                        </button>
                                        <button
                                            type="button"
                                            className={`${btnSecCls} px-3 py-2 text-xs`}
                                            disabled={inviteActionId !== null}
                                            onClick={() => void handleMembershipResponse(membership, 'disabled', '已拒绝邀请')}
                                        >
                                            拒绝
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                        {inviteResult && (
                            <p className={`text-xs ${inviteResult.kind === 'success' ? 'text-[color:var(--gn)]' : 'text-[#dc3545]'}`}>
                                {inviteResult.text}
                            </p>
                        )}
                    </div>
                )}

                {/* 用户信息卡 */}
                <div className="glass-panel px-6 py-5">
                    <div className="flex items-start gap-4">
                        <div
                            className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold select-none shrink-0"
                            style={{ background: roleColor, color: roleTextColor }}
                        >
                            {avatarInitial}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="text-lg font-semibold text-[color:var(--tx)] truncate">{accountName}</p>
                                    <p className="mt-1 text-sm font-medium text-[color:var(--tx2)]">{maskPhone(user.phone)}</p>
                                </div>
                                <div className="shrink-0 flex flex-col items-end gap-1.5">
                                    <span className="max-w-[190px] truncate text-sm font-semibold text-[color:var(--tx)]">
                                        {organizationName}
                                    </span>
                                    <span
                                        className="text-xs px-2 py-0.5 rounded-full font-medium"
                                        style={{ background: roleColor, color: roleTextColor }}
                                    >
                                        {roleLabel}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* 操作面板 */}
                <div className="glass-panel overflow-hidden divide-y divide-[color:var(--bd)]/50">
                    {/* 绑定手机 - 只读展示 */}
                    <div className="px-5 py-4 flex items-center gap-3">
                        <span className="text-[color:var(--tx2)]"><PhoneIcon /></span>
                        <div className="flex-1 min-w-0">
                            <p className="text-xs text-[color:var(--tx2)]">{t('accountPhone')}</p>
                            <p className="text-sm font-medium text-[color:var(--tx)] mt-0.5">{maskPhone(user.phone)}</p>
                        </div>
                    </div>

                    {/* 姓名 */}
                    <NicknameRow user={user} />

                    {/* 更换手机号 */}
                    <ExpandableRow
                        icon={<PhoneIcon />}
                        label={t('accountChangePhone')}
                        isOpen={openPanel === 'change_phone'}
                        onToggle={() => togglePanel('change_phone')}
                    >
                        <ChangePhonePanel onSuccess={() => handlePanelSuccess('change_phone')} />
                    </ExpandableRow>

                    {/* 重置/设置密码 */}
                    <ExpandableRow
                        icon={<LockIcon />}
                        label={user.has_password ? t('accountResetPassword') : t('accountSetPassword')}
                        isOpen={openPanel === 'reset_password'}
                        onToggle={() => togglePanel('reset_password')}
                    >
                        <ResetPasswordPanel
                            phone={user.phone}
                            hasPassword={user.has_password}
                            onSuccess={() => handlePanelSuccess('reset_password')}
                        />
                    </ExpandableRow>

                    {activeMembership && (
                        <div className="border-t border-[color:var(--bd)]/50">
                            <button
                                type="button"
                                className="w-full flex items-center justify-between px-5 py-4 text-left transition hover:bg-[rgba(220,53,69,0.06)] disabled:opacity-50"
                                disabled={inviteActionId !== null}
                                onClick={() => void handleMembershipResponse(activeMembership, 'disabled', '已退出当前组织')}
                            >
                                <div className="flex items-center gap-3 text-[#dc3545]">
                                    {inviteActionId === activeMembership.id ? <Spinner /> : <OrganizationExitIcon />}
                                    <span className="text-sm font-medium">退出当前组织</span>
                                </div>
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </SettingsPageFrame>
    )
}
