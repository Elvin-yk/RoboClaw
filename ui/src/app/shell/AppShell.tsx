import { Link, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useChatSocket } from '@/domains/chat/store/useChatSocket'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import { useRecoveryStore } from '@/domains/recovery/store/useRecoveryStore'
import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import ChatPanel from '@/domains/chat/components/ChatPanel'
import AppHeader from '@/app/shell/AppHeader'
import ToastContainer from '@/app/shell/ToastOutlet'
import { useAuthStore } from '@/shared/lib/authStore'

const NAV_ICONS: Record<string, JSX.Element> = {
  '/collection': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  ),
  '/collection/publish': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  ),
  '/collection/control': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  '/training': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l3-4 3 2 4-7" />
      <path d="M17 6h3v3" />
    </svg>
  ),
  '/collection/recovery': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  '/curation': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  '/curation/text-alignment': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h14" />
    </svg>
  ),
  '/curation/data-overview': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h18v18H3z" />
      <path d="M7 15l3-3 2 2 5-5" />
      <path d="M7 7h.01" />
    </svg>
  ),
  '/settings': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  ),
  '/logs': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  ),
}

interface NavItem {
  path: string
  label: string
  badge?: number
}

export default function AppShell() {
  const location = useLocation()
  const { connect, disconnect, connected, messages } = useChatSocket()
  const fetchHardwareStatus = useHardwareStore((state) => state.fetchHardwareStatus)
  const recoveryFaults = useRecoveryStore((state) => state.faults)
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [collectionExpanded, setCollectionExpanded] = useState(
    location.pathname.startsWith('/collection'),
  )
  const [pipelineExpanded, setPipelineExpanded] = useState(location.pathname.startsWith('/curation'))
  const [chatWidgetVisible, setChatWidgetVisible] = useState(true)

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  useEffect(() => {
    void fetchHardwareStatus()
  }, [fetchHardwareStatus])

  useEffect(() => {
    if (
      location.pathname.startsWith('/collection')
    ) {
      setCollectionExpanded(true)
    }
    if (location.pathname.startsWith('/curation')) {
      setPipelineExpanded(true)
    }
  }, [location.pathname])

  const navItemsBeforePipeline: NavItem[] = []
  const navItemsAfterPipeline: NavItem[] = [
    { path: '/training', label: t('trainingCenter') },
    { path: '/settings', label: t('settings') },
    { path: '/logs', label: t('logs') },
  ]
  const collectionChildren = [
    ...(user?.level === 'admin' ? [{ path: '/collection/publish', label: '任务发布' }] : []),
    { path: '/collection/control', label: '控制平台' },
    { path: '/collection/recovery', label: '修复平台', badge: recoveryFaults.length || undefined },
  ]
  const collectionActive = location.pathname.startsWith('/collection')
  const pipelineChildren = [
    { path: '/curation/datasets', label: t('datasetReader') },
    { path: '/curation/quality', label: t('qualityWorkbench') },
    { path: '/curation/text-alignment', label: t('textAlignment') },
    { path: '/curation/data-overview', label: t('dataOverview') },
    { path: '/curation/review', label: t('humanReview') },
  ]
  const pipelineActive = location.pathname.startsWith('/curation')

  const renderNavItem = (item: NavItem) => {
    const active =
      location.pathname === item.path
      || location.pathname.startsWith(`${item.path}/`)
    return (
      <Link
        key={item.path}
        to={item.path}
        className={cn('app-sidebar__link', active && 'app-sidebar__link--active')}
        title={sidebarCollapsed ? item.label : undefined}
      >
        <span className="app-sidebar__link-icon">
          {NAV_ICONS[item.path]}
        </span>
        {!sidebarCollapsed && <span className="app-sidebar__link-label">{item.label}</span>}
        {!sidebarCollapsed && item.badge && (
          <span className={cn(
            'ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-bold',
            active ? 'bg-white/20 text-white' : 'bg-rd/10 text-rd',
          )}
          >
            {item.badge}
          </span>
        )}
      </Link>
    )
  }

  return (
    <div className="app-shell">
      <aside className={cn('app-sidebar', sidebarCollapsed && 'app-sidebar--collapsed')}>
        <div className="app-sidebar__header">
          <button
            type="button"
            onClick={() => setSidebarCollapsed((value) => !value)}
            className="app-sidebar__toggle"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg
              width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transition: 'transform 0.2s ease', transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }}
            >
              <polyline points="11 17 6 12 11 7" />
              <polyline points="18 17 13 12 18 7" />
            </svg>
          </button>
        </div>

        <nav className="app-sidebar__nav">
          {sidebarCollapsed ? (
            <Link
              to="/collection/control"
              className={cn('app-sidebar__link', collectionActive && 'app-sidebar__link--active')}
              title="采集中心"
            >
              <span className="app-sidebar__link-icon">
                {NAV_ICONS['/collection']}
              </span>
            </Link>
          ) : (
            <div className="app-sidebar__group">
              <button
                type="button"
                className={cn(
                  'app-sidebar__link',
                  'app-sidebar__group-trigger',
                  collectionActive && 'app-sidebar__link--active',
                )}
                onClick={() => setCollectionExpanded((value) => !value)}
                aria-expanded={collectionExpanded}
              >
                <span className="app-sidebar__link-icon">
                  {NAV_ICONS['/collection']}
                </span>
                <span className="app-sidebar__link-label">采集中心</span>
                <span
                  className={cn(
                    'app-sidebar__caret',
                    collectionExpanded && 'app-sidebar__caret--expanded',
                  )}
                  aria-hidden="true"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </button>

              {collectionExpanded && (
                <div className="app-sidebar__children">
                  {collectionChildren.map((child) => {
                    const active =
                      location.pathname === child.path
                      || location.pathname.startsWith(`${child.path}/`)
                    return (
                      <Link
                        key={child.path}
                        to={child.path}
                        className={cn(
                          'app-sidebar__child-link',
                          active && 'app-sidebar__child-link--active',
                        )}
                      >
                        <span className="app-sidebar__child-dot" aria-hidden="true" />
                        <span className="app-sidebar__child-label">{child.label}</span>
                        {child.badge && (
                          <span className="ml-auto rounded-full bg-rd/10 px-1.5 py-0.5 text-[11px] font-bold text-rd">
                            {child.badge}
                          </span>
                        )}
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {navItemsBeforePipeline.map(renderNavItem)}

          {sidebarCollapsed ? (
            <Link
              to="/curation"
              className={cn('app-sidebar__link', pipelineActive && 'app-sidebar__link--active')}
              title={t('pipelineNav')}
            >
              <span className="app-sidebar__link-icon">
                {NAV_ICONS['/curation']}
              </span>
            </Link>
          ) : (
            <div className="app-sidebar__group">
              <button
                type="button"
                className={cn(
                  'app-sidebar__link',
                  'app-sidebar__group-trigger',
                  pipelineActive && 'app-sidebar__link--active',
                )}
                onClick={() => setPipelineExpanded((value) => !value)}
                aria-expanded={pipelineExpanded}
              >
                <span className="app-sidebar__link-icon">
                  {NAV_ICONS['/curation']}
                </span>
                <span className="app-sidebar__link-label">{t('pipelineNav')}</span>
                <span
                  className={cn(
                    'app-sidebar__caret',
                    pipelineExpanded && 'app-sidebar__caret--expanded',
                  )}
                  aria-hidden="true"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </button>

              {pipelineExpanded && (
                <div className="app-sidebar__children">
                  {pipelineChildren.map((child) => {
                    const active =
                      location.pathname === child.path
                      || location.pathname.startsWith(`${child.path}/`)
                    return (
                      <Link
                        key={child.path}
                        to={child.path}
                        className={cn(
                          'app-sidebar__child-link',
                          active && 'app-sidebar__child-link--active',
                        )}
                      >
                        <span className="app-sidebar__child-dot" aria-hidden="true" />
                        <span className="app-sidebar__child-label">{child.label}</span>
                      </Link>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {navItemsAfterPipeline.map(renderNavItem)}
        </nav>
      </aside>

      <div className="app-shell__main">
        <AppHeader />
        <main className="app-shell__content">
          <Outlet />
        </main>

        <div className="chat-widget">
          {chatWidgetVisible ? (
            <ChatPanel variant="widget" onClose={() => setChatWidgetVisible(false)} />
          ) : (
            <button
              type="button"
              className="chat-widget__trigger"
              onClick={() => setChatWidgetVisible(true)}
              aria-label="Open RoboClaw AI chat"
            >
              <span className={cn('chat-widget__dot', connected && 'chat-widget__dot--live')} aria-hidden="true" />
              <span className="chat-widget__label">AI</span>
              {messages.length > 0 && (
                <span className="chat-widget__count" aria-label={`${messages.length} chat messages`}>
                  {messages.length}
                </span>
              )}
            </button>
          )}
        </div>

        <ToastContainer />
      </div>
    </div>
  )
}
