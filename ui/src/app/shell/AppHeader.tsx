import { useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useChatSocket } from '@/domains/chat/store/useChatSocket'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import { useI18n } from '@/i18n'
import { useAuthStore } from '@/shared/lib/authStore'
import { StatusPill } from '@/shared/ui'

/** 手机号脱敏：138****8888 */
function maskPhone(phone: string): string {
    if (phone.length !== 11) return phone
    return `${phone.slice(0, 3)}****${phone.slice(7)}`
}

/** 用户等级徽标颜色 */
function levelColor(level: string): string {
    if (level === 'admin') return '#d97706'
    if (level === 'contributor') return '#2f6fe4'
    return '#6b7a8d'
}

export default function AppHeader() {
    const navigate = useNavigate()
    const { connected } = useChatSocket()
    const networkInfo = useHardwareStore((state) => state.networkInfo)
    const fetchNetworkInfo = useHardwareStore((state) => state.fetchNetworkInfo)
    const { t, locale, setLocale } = useI18n()
    const { user, isLoggedIn, isChecking, logout } = useAuthStore()

    useEffect(() => {
        void fetchNetworkInfo()
    }, [fetchNetworkInfo])

    /** 用户头像首字母（昵称优先，否则取手机号前3位）*/
    const avatarInitial = user
        ? (user.nickname ? user.nickname.slice(0, 1).toUpperCase() : user.phone.slice(0, 3))
        : '?'

    function handleLogout() {
        logout()
        navigate('/login', { replace: true })
    }

    return (
        <header className="app-topbar">
            <div className="app-topbar__connection">
                <StatusPill active={connected}>
                    {connected ? t('connected') : t('disconnected')}
                </StatusPill>
                {networkInfo && (
                    <div className="app-topbar__network">
                        {networkInfo.lan_ip}:{networkInfo.port}
                    </div>
                )}
            </div>
            <div className="app-topbar__actions">
                {!isChecking && (
                    isLoggedIn && user ? (
                        <>
                            <div className="header-user-badge" title={maskPhone(user.phone)}>
                                <div
                                    className="header-user-badge__avatar"
                                    style={{ background: `linear-gradient(180deg, ${levelColor(user.level)}cc, ${levelColor(user.level)})` }}
                                >
                                    {avatarInitial}
                                </div>
                                <span className="header-user-badge__phone">{maskPhone(user.phone)}</span>
                            </div>
                            <button
                                type="button"
                                onClick={handleLogout}
                                className="header-logout-btn"
                                title={t('authLogout')}
                            >
                                <span className="header-logout-btn__icon" aria-hidden="true">
                                    <svg
                                        width="17"
                                        height="17"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="1.9"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                    >
                                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                                        <polyline points="16 17 21 12 16 7" />
                                        <line x1="21" y1="12" x2="9" y2="12" />
                                    </svg>
                                </span>
                                <span className="header-logout-btn__label">{t('authLogout')}</span>
                            </button>
                        </>
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
                    {locale === 'zh' ? 'EN' : '中文'}
                </button>
            </div>
        </header>
    )
}
