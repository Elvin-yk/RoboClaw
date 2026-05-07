import { Link, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useChatSocket } from '@/domains/chat/store/useChatSocket'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import { useI18n } from '@/i18n'
import { cn } from '@/shared/lib/cn'
import ChatPanel from '@/domains/chat/components/ChatPanel'
import AppHeader from '@/app/shell/AppHeader'
import ToastContainer from '@/app/shell/ToastOutlet'
import { useAuthStore } from '@/shared/lib/authStore'
import { canManageCollection } from '@/shared/api/evoClient'

const NAV_ICONS: Record<string, JSX.Element> = {
  '/collection': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="M16 10l5-3v10l-5-3" />
      <circle cx="9.5" cy="12" r="2.2" fill="currentColor" stroke="none" />
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
  '/data': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  '/data/qc': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18" />
      <path d="M8 6v12" />
      <path d="M16 6v12" />
      <path d="M5 18h14" />
    </svg>
  ),
  '/data/analysis': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M7 15l3-3 3 2 4-6" />
      <circle cx="17" cy="8" r="1.5" />
    </svg>
  ),
  '/data/annotation': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h14" />
    </svg>
  ),
  '/data/manage': (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v18" />
      <path d="M5 8h14" />
      <path d="M5 16h14" />
      <path d="M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
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

type NavGroupId = 'collection' | 'data' | 'settings'

const NAV_GROUP_ROOTS: Record<NavGroupId, string> = {
  collection: '/collection',
  data: '/data',
  settings: '/settings',
}

function createExpandedGroups(pathname: string): Record<NavGroupId, boolean> {
  return {
    collection: pathname.startsWith(NAV_GROUP_ROOTS.collection),
    data: pathname.startsWith(NAV_GROUP_ROOTS.data),
    settings: pathname.startsWith(NAV_GROUP_ROOTS.settings),
  }
}

function activeNavGroupId(pathname: string): NavGroupId | null {
  return (Object.entries(NAV_GROUP_ROOTS) as Array<[NavGroupId, string]>)
    .find(([, rootPath]) => pathname.startsWith(rootPath))?.[0] ?? null
}

function isLeafNavActive(pathname: string, itemPath: string): boolean {
  return pathname === itemPath
}

interface NavGroup {
  id: NavGroupId
  rootPath: string
  collapsedPath: string
  iconPath: string
  label: string
  children: NavItem[]
}

export default function AppShell() {
  const location = useLocation()
  const { connect, disconnect, connected, messages } = useChatSocket()
  const fetchHardwareStatus = useHardwareStore((state) => state.fetchHardwareStatus)
  const { t } = useI18n()
  const user = useAuthStore((state) => state.user)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [compactNav, setCompactNav] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches
  ))
  const [openCompactGroup, setOpenCompactGroup] = useState<NavGroupId | null>(null)
  const [expandedGroups, setExpandedGroups] = useState(() => createExpandedGroups(location.pathname))
  const [chatWidgetVisible, setChatWidgetVisible] = useState(false)

  useEffect(() => {
    connect()
    return () => disconnect()
  }, [connect, disconnect])

  useEffect(() => {
    void fetchHardwareStatus()
  }, [fetchHardwareStatus])

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)')
    const updateCompactNav = () => setCompactNav(query.matches)
    updateCompactNav()
    query.addEventListener('change', updateCompactNav)
    return () => query.removeEventListener('change', updateCompactNav)
  }, [])

  useEffect(() => {
    if (compactNav) {
      setSidebarCollapsed(false)
    }
  }, [compactNav])

  useEffect(() => {
    if (compactNav) {
      setOpenCompactGroup(null)
      return
    }
    const activeGroupId = activeNavGroupId(location.pathname)
    if (!activeGroupId) return
    setExpandedGroups((current) => (
      current[activeGroupId] ? current : { ...current, [activeGroupId]: true }
    ))
  }, [compactNav, location.pathname])

  const navItemsBeforeData: NavItem[] = []
  const navItemsBeforeSettings: NavItem[] = [
    { path: '/training', label: t('trainingCenter') },
  ]
  const navItemsAfterSettings: NavItem[] = [
    { path: '/logs', label: t('logs') },
  ]
  const canPublishTasks = canManageCollection(user)
  const collectionChildren = [
    ...(canPublishTasks ? [{ path: '/collection/publish', label: t('collectionManageNav') }] : []),
    { path: '/collection/control', label: t('collectionControlNav') },
  ]
  const dataChildren = [
    { path: '/data', label: t('dataOverviewNav') },
    { path: '/data/qc', label: t('dataQcNav') },
    { path: '/data/analysis', label: t('dataAnalysisNav') },
    { path: '/data/annotation', label: t('dataAnnotationNav') },
    { path: '/data/manage', label: t('dataManageNav') },
  ]
  const settingsChildren = [
    { path: '/settings/hardware', label: t('settingsHardware') },
    { path: '/settings/provider', label: t('settingsProvider') },
    { path: '/settings/hub', label: t('hfConfig') },
    { path: '/settings/account', label: t('accountSettingsTab') },
  ]
  const navGroups: Record<NavGroupId, NavGroup> = {
    collection: {
      id: 'collection',
      rootPath: '/collection',
      collapsedPath: '/collection/control',
      iconPath: '/collection',
      label: t('collectionCenterNav'),
      children: collectionChildren,
    },
    data: {
      id: 'data',
      rootPath: '/data',
      collapsedPath: '/data',
      iconPath: '/data',
      label: t('dataCenter'),
      children: dataChildren,
    },
    settings: {
      id: 'settings',
      rootPath: '/settings',
      collapsedPath: '/settings/hardware',
      iconPath: '/settings',
      label: t('settings'),
      children: settingsChildren,
    },
  }

  function isNavGroupExpanded(group: NavGroupId): boolean {
    if (compactNav) {
      return openCompactGroup === group
    }
    return expandedGroups[group]
  }

  function toggleNavGroup(group: NavGroupId) {
    if (compactNav) {
      setOpenCompactGroup((current) => (current === group ? null : group))
      return
    }
    setExpandedGroups((current) => ({ ...current, [group]: !current[group] }))
  }

  function closeCompactNavGroup() {
    if (compactNav) {
      setOpenCompactGroup(null)
    }
  }

  const sidebarToggle = (
    <button
      type="button"
      onClick={() => setSidebarCollapsed((value) => !value)}
      className="app-sidebar__toggle"
      aria-label={compactNav
        ? sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'
        : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {compactNav ? (
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transition: 'transform 0.2s ease', transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }}
        >
          <polyline points="7 14 12 9 17 14" />
          <polyline points="7 20 12 15 17 20" />
        </svg>
      ) : (
        <svg
          width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ transition: 'transform 0.2s ease', transform: sidebarCollapsed ? 'rotate(180deg)' : 'none' }}
        >
          <polyline points="11 17 6 12 11 7" />
          <polyline points="18 17 13 12 18 7" />
        </svg>
      )}
    </button>
  )

  const renderNavItem = (item: NavItem) => {
    const active = isLeafNavActive(location.pathname, item.path)
    return (
      <Link
        key={item.path}
        to={item.path}
        onClick={closeCompactNavGroup}
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

  const renderNavGroup = (group: NavGroup) => {
    const active = location.pathname.startsWith(group.rootPath)
    const expanded = isNavGroupExpanded(group.id)

    if (sidebarCollapsed) {
      return (
        <Link
          key={group.id}
          to={group.collapsedPath}
          className={cn('app-sidebar__link', active && 'app-sidebar__link--active')}
          title={group.label}
        >
          <span className="app-sidebar__link-icon">
            {NAV_ICONS[group.iconPath]}
          </span>
        </Link>
      )
    }

    return (
      <div key={group.id} className="app-sidebar__group">
        <button
          type="button"
          className={cn(
            'app-sidebar__link',
            'app-sidebar__group-trigger',
            active && 'app-sidebar__link--active',
          )}
          onClick={() => toggleNavGroup(group.id)}
          aria-expanded={expanded}
        >
          <span className="app-sidebar__link-icon">
            {NAV_ICONS[group.iconPath]}
          </span>
          <span className="app-sidebar__link-label">{group.label}</span>
          <span
            className={cn(
              'app-sidebar__caret',
              expanded && 'app-sidebar__caret--expanded',
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

        {expanded && (
          <div className="app-sidebar__children">
            {group.children.map((child) => {
              const childActive = isLeafNavActive(location.pathname, child.path)
              return (
                <Link
                  key={child.path}
                  to={child.path}
                  onClick={closeCompactNavGroup}
                  className={cn(
                    'app-sidebar__child-link',
                    childActive && 'app-sidebar__child-link--active',
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
    )
  }

  return (
    <div className="app-shell">
      <aside
        className={cn(
          'app-sidebar',
          sidebarCollapsed && 'app-sidebar--collapsed',
          compactNav && openCompactGroup && 'app-sidebar--popover-open',
        )}
      >
        <div className="app-sidebar__header">
          {sidebarCollapsed && !compactNav ? (
            sidebarToggle
          ) : (
            <>
              <div className="app-sidebar__brand-row">
                <Link to="/collection/control" className="app-sidebar__brand">
                  RoboClaw
                </Link>
                {!compactNav && sidebarToggle}
              </div>
            </>
          )}
        </div>

        <nav className="app-sidebar__nav">
          {renderNavGroup(navGroups.collection)}

          {navItemsBeforeData.map(renderNavItem)}

          {renderNavGroup(navGroups.data)}

          {navItemsBeforeSettings.map(renderNavItem)}

          {renderNavGroup(navGroups.settings)}

          {navItemsAfterSettings.map(renderNavItem)}
        </nav>
      </aside>

      <div className="app-shell__main">
        <AppHeader />
        <main className="app-shell__content">
          <Outlet />
        </main>

        <div className={cn('chat-widget', chatWidgetVisible && 'chat-widget--open')}>
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
