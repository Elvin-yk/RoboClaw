/**
 * 认证状态管理（Zustand store）
 *
 * 设计原则：
 * - 主应用默认进入本地匿名会话，云端账号只作为可选能力
 * - token 只保存在浏览器 localStorage，本地后端不保存账号数据
 * - 网络不可达或 token 失效时 cloudAvailable=false，但本地 dashboard 继续可用
 */

import { create } from 'zustand'
import { evoApi, type UserInfo } from '@/shared/api/evoClient'

const ACCESS_KEY = 'evo_access_token'
const REFRESH_KEY = 'evo_refresh_token'

const LOCAL_GUEST_USER: UserInfo = {
    id: 'local-guest',
    phone: 'local',
    nickname: 'Local',
    status: 'active',
    has_password: false,
    created_at: 'local',
    memberships: [{
        id: 'local-guest-membership',
        org_id: 'local-organization',
        role_code: 'owner',
        status: 'active',
        invited_by_user_id: null,
        invited_by_user: null,
        organization: {
            id: 'local-organization',
            name: 'Local Workspace',
            status: 'active',
        },
    }],
    current_membership: {
        id: 'local-guest-membership',
        org_id: 'local-organization',
        role_code: 'owner',
        status: 'active',
        invited_by_user_id: null,
        invited_by_user: null,
        organization: {
            id: 'local-organization',
            name: 'Local Workspace',
            status: 'active',
        },
    },
}

interface AuthState {
    user: UserInfo | null
    isLoggedIn: boolean
    /** true 表示未绑定云端账号的本地匿名会话 */
    isGuest: boolean
    /** 应用启动时正在异步验证 token，期间为 true */
    isChecking: boolean
    /** 云端后端是否可达（网络层面）*/
    cloudAvailable: boolean

    /** 应用启动时调用一次，异步验证本地 token */
    initialize: () => Promise<void>
    /** 登录成功后，将 token 写入 localStorage */
    setTokens: (access: string, refresh: string) => void
    /** 登录成功后，设置用户信息 */
    setUser: (user: UserInfo) => void
    /** 退出登录 */
    logout: () => void
}

function activateLocalGuest(set: (state: Partial<AuthState>) => void, cloudAvailable: boolean) {
    set({
        user: LOCAL_GUEST_USER,
        isLoggedIn: true,
        isGuest: true,
        isChecking: false,
        cloudAvailable,
    })
}

export const useAuthStore = create<AuthState>((set) => ({
    user: LOCAL_GUEST_USER,
    isLoggedIn: true,
    isGuest: true,
    isChecking: true,
    cloudAvailable: false,

    initialize: async () => {
        const accessToken = localStorage.getItem(ACCESS_KEY)

        if (!accessToken) {
            activateLocalGuest(set, false)
            return
        }

        try {
            const user = await evoApi.getMe()
            set({ user, isLoggedIn: true, isGuest: false, isChecking: false, cloudAvailable: true })
        } catch (err: unknown) {
            // access_token 失效，尝试 refresh
            const refreshToken = localStorage.getItem(REFRESH_KEY)
            if (refreshToken) {
                try {
                    const tokens = await evoApi.refresh(refreshToken)
                    localStorage.setItem(ACCESS_KEY, tokens.access_token)
                    localStorage.setItem(REFRESH_KEY, tokens.refresh_token)
                    const user = await evoApi.getMe()
                    set({ user, isLoggedIn: true, isGuest: false, isChecking: false, cloudAvailable: true })
                    return
                } catch {
                    localStorage.removeItem(ACCESS_KEY)
                    localStorage.removeItem(REFRESH_KEY)
                }
            }

            // TypeError 通常是网络不通（fetch failed），其他是 401/403 等
            const isNetworkError = err instanceof TypeError
            activateLocalGuest(set, !isNetworkError)
        }
    },

    setTokens: (access, refresh) => {
        localStorage.setItem(ACCESS_KEY, access)
        localStorage.setItem(REFRESH_KEY, refresh)
    },

    setUser: (user) => {
        set({ user, isLoggedIn: true, isGuest: false, cloudAvailable: true })
    },

    logout: () => {
        localStorage.removeItem(ACCESS_KEY)
        localStorage.removeItem(REFRESH_KEY)
        activateLocalGuest(set, true)
    },
}))
