import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useToast } from '@/app/shell/ToastOutlet'
import { useChatSocket } from '@/domains/chat/store/useChatSocket'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import { useDeviceRecoveryStore } from '@/domains/control/store/useDeviceRecoveryStore'
import { useI18n } from '@/i18n'
import { useAuthStore } from '@/shared/lib/authStore'
import { StatusPill } from '@/shared/ui'
import { currentMembershipRole, type MembershipRole } from '@/shared/api/evoClient'
import { maskPhone } from '@/shared/lib/phone'

function roleColor(role: MembershipRole | null): string {
    if (role === 'owner') return '#d97706'
    if (role === 'admin') return '#2563eb'
    return '#6b7a8d'
}

interface AppHeaderProps {
    onOpenSystemActions?: () => void
}

export default function AppHeader({ onOpenSystemActions }: AppHeaderProps) {
    const navigate = useNavigate()
    const { connected } = useChatSocket()
    const toast = useToast((state) => state.add)
    const networkInfo = useHardwareStore((state) => state.networkInfo)
    const fetchNetworkInfo = useHardwareStore((state) => state.fetchNetworkInfo)
    const restarting = useDeviceRecoveryStore((state) => state.restarting)
    const restartDashboard = useDeviceRecoveryStore((state) => state.restartDashboard)
    const { t, locale, setLocale } = useI18n()
    const { user, isLoggedIn, isGuest, isChecking } = useAuthStore()
    const [systemPopoverOpen, setSystemPopoverOpen] = useState(false)
    const role = currentMembershipRole(user)
    const hasPendingInvites = user?.memberships.some((membership) => membership.status === 'invited') ?? false

    useEffect(() => {
        void fetchNetworkInfo()
    }, [fetchNetworkInfo])

    const avatarInitial = user
        ? (user.nickname ? user.nickname.slice(0, 1).toUpperCase() : user.phone.slice(0, 3))
        : '?'

    async function handleRestartDashboard() {
        try {
            await restartDashboard()
        } catch (error) {
            toast(error instanceof Error ? error.message : t('recoveryRestartFailed'), 'e')
        }
    }

    function handleSystemStatusClick() {
        setSystemPopoverOpen((open) => {
            if (!open) onOpenSystemActions?.()
            return !open
        })
    }

    return (
        <header className="app-topbar">
            <div className="app-topbar__connection">
                <button
                    type="button"
                    className="app-topbar__status-button"
                    onClick={handleSystemStatusClick}
                    aria-label={connected ? t('connected') : t('disconnected')}
                    aria-expanded={systemPopoverOpen}
                >
                    <StatusPill active={connected}>
                        {connected ? t('connected') : t('disconnected')}
                    </StatusPill>
                </button>
                {networkInfo && (
                    <div className="app-topbar__network">
                        {networkInfo.lan_ip}:{networkInfo.port}
                    </div>
                )}
                {systemPopoverOpen && (
                    <>
                        <button
                            type="button"
                            className="app-system-popover__backdrop"
                            onClick={() => setSystemPopoverOpen(false)}
                            aria-label="Close dashboard actions"
                        />
                        <aside className="app-system-popover" aria-label="Dashboard actions">
                            <button
                                type="button"
                                className="app-system-popover__restart"
                                onClick={() => { void handleRestartDashboard() }}
                                disabled={restarting}
                            >
                                {restarting ? t('recoveryRestarting') : t('recoveryRestartDashboard')}
                            </button>
                        </aside>
                    </>
                )}
            </div>
            <div className="app-topbar__actions">
                {!isChecking && (
                    isLoggedIn && user && !isGuest ? (
                        <button
                            type="button"
                            className="header-user-badge"
                            title={maskPhone(user.phone)}
                            aria-label={t('accountSettingsTab')}
                            onClick={() => navigate('/settings/account')}
                        >
                            <div
                                className="header-user-badge__avatar"
                                style={{ background: `linear-gradient(180deg, ${roleColor(role)}cc, ${roleColor(role)})` }}
                            >
                                {avatarInitial}
                            </div>
                            <span className="header-user-badge__phone">{maskPhone(user.phone)}</span>
                            {hasPendingInvites && <span className="header-user-badge__notice" aria-hidden="true" />}
                        </button>
                    ) : (
                        <Link to="/login" className="header-login-btn">
                            {t('authLoginPrompt')}
                        </Link>
                    )
                )}

                <button
                    type="button"
                    onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
                    className="app-topbar__locale"
                >
                    {locale === 'zh' ? 'EN' : 'ZH'}
                </button>
            </div>
        </header>
    )
}
