/**
 * EvoMind 云端后端 API 客户端
 *
 * 所有用户认证均通过本地 RoboClaw 后端代理访问 ECS 上的 evo-data 后端。
 * 账号数据源由云端后端负责，当前生产账号后端连接 RDS evo_data.users。
 * 浏览器 token 保存在 localStorage，本地后端只转发当前请求。
 *
 * 配置：在 ui/.env 或 ui/.env.local 中设置
 *   VITE_EVO_API_URL=/api/evo
 */

const EVO_API = (import.meta.env.VITE_EVO_API_URL as string | undefined) ?? '/api/evo'

const ACCESS_KEY = 'evo_access_token'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CaptchaResponse {
    captcha_id: string
    image_base64: string
}

export interface TokenResponse {
    access_token: string
    refresh_token: string
    token_type: string
}

export interface UserInfo {
    id: string
    phone: string
    nickname: string | null
    status: 'active' | 'disabled'
    memberships: MembershipInfo[]
    current_membership: MembershipInfo | null
    has_password: boolean
    created_at: string
}

export type MembershipRole = 'owner' | 'admin' | 'member'
export type InviteRole = 'admin' | 'member'
export type MembershipStatus = 'active' | 'invited' | 'disabled'
export type MembershipInvitationStatus = Extract<MembershipStatus, 'active' | 'disabled'>

export const INVITE_ROLES: readonly InviteRole[] = ['admin', 'member']
export const MEMBERSHIP_ROLE_LABELS: Record<MembershipRole, string> = {
    owner: 'Owner',
    admin: 'Admin',
    member: 'Member',
}

export interface OrganizationInfo {
    id: string
    name: string
    status: 'active' | 'disabled'
}

export interface MembershipInviterInfo {
    id: string
    phone: string
    nickname: string | null
}

export interface MembershipInfo {
    id: string
    org_id: string
    role_code: MembershipRole
    status: MembershipStatus
    invited_by_user_id: string | null
    invited_by_user: MembershipInviterInfo | null
    organization: OrganizationInfo
}

export interface OrganizationMember {
    id: string
    user_id: string
    phone: string
    nickname: string | null
    role_code: MembershipRole
    status: MembershipStatus
    joined_at: string | null
}

export interface CurrentOrganization {
    id: string
    name: string
    role_code: MembershipRole
    members: OrganizationMember[]
}

export function currentMembershipRole(user: UserInfo | null): MembershipRole | null {
    return user?.current_membership?.role_code ?? null
}

export function membershipRoleLabel(role: MembershipRole): string {
    return MEMBERSHIP_ROLE_LABELS[role]
}

export function isInviteRole(value: string): value is InviteRole {
    return (INVITE_ROLES as readonly string[]).includes(value)
}

function hasActiveOrganizationRole(user: UserInfo | null, roles: readonly MembershipRole[]): boolean {
    const membership = user?.current_membership
    return membership?.status === 'active'
        && membership.organization.status === 'active'
        && roles.includes(membership.role_code)
}

export function canManageCollection(user: UserInfo | null): boolean {
    return hasActiveOrganizationRole(user, ['owner', 'admin'])
}

export function canManageOrganization(user: UserInfo | null): boolean {
    return hasActiveOrganizationRole(user, ['owner'])
}

export function canManageOrganizationMembers(user: UserInfo | null): boolean {
    return hasActiveOrganizationRole(user, ['owner', 'admin'])
}

// ─── Core request ─────────────────────────────────────────────────────────────

async function evoRequest<T>(
    path: string,
    options: RequestInit = {},
    withAuth = false,
): Promise<T> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(options.headers as Record<string, string>),
    }

    if (withAuth) {
        const token = localStorage.getItem(ACCESS_KEY)
        if (token) headers['Authorization'] = `Bearer ${token}`
    }

    const res = await fetch(`${EVO_API}${path}`, { ...options, headers })

    if (!res.ok) {
        let detail = `HTTP ${res.status}`
        try {
            const body = await res.json()
            detail = body.detail || detail
        } catch (_) { /* ignore */ }
        throw new Error(detail)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
}

// ─── Auth API ─────────────────────────────────────────────────────────────────

export const evoApi = {
    /** 获取图形验证码 */
    getCaptcha: (): Promise<CaptchaResponse> =>
        evoRequest('/auth/captcha'),

    /** 发送短信验证码（登录场景）*/
    sendSms: (phone: string, captchaId: string, captchaText: string): Promise<void> =>
        evoRequest('/auth/send_sms', {
            method: 'POST',
            body: JSON.stringify({ phone, captcha_id: captchaId, captcha_text: captchaText, scene: 'login' }),
        }),

    /** 发送短信验证码（指定场景：login / change_phone / reset_password）*/
    sendSmsWithScene: (
        phone: string,
        captchaId: string,
        captchaText: string,
        scene: 'login' | 'change_phone' | 'reset_password',
    ): Promise<void> =>
        evoRequest('/auth/send_sms', {
            method: 'POST',
            body: JSON.stringify({ phone, captcha_id: captchaId, captcha_text: captchaText, scene }),
        }),

    /** 更换绑定手机号（需要 access_token + 新号码 + 短信验证码）*/
    changePhone: (newPhone: string, smsCode: string): Promise<void> =>
        evoRequest('/auth/change-phone', {
            method: 'POST',
            body: JSON.stringify({ new_phone: newPhone, sms_code: smsCode }),
        }, true),

    /** 重置/设置登录密码（手机号 + 短信验证码 + 新密码）*/
    resetPassword: (phone: string, smsCode: string, newPassword: string): Promise<void> =>
        evoRequest('/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ phone, sms_code: smsCode, new_password: newPassword }),
        }),

    /** 手机号 + 短信验证码登录（无账号则自动注册）*/
    login: (phone: string, smsCode: string): Promise<TokenResponse> =>
        evoRequest('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ phone, sms_code: smsCode }),
        }),

    /** 手机号 + 密码 + 图形验证码登录 */
    loginWithPassword: (
        phone: string,
        password: string,
        captchaId: string,
        captchaText: string,
    ): Promise<TokenResponse> =>
        evoRequest('/auth/login/password', {
            method: 'POST',
            body: JSON.stringify({ phone, password, captcha_id: captchaId, captcha_text: captchaText }),
        }),

    /** 用 refresh_token 换新 token 对 */
    refresh: (refreshToken: string): Promise<TokenResponse> =>
        evoRequest('/auth/refresh', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: refreshToken }),
        }),

    /** 获取当前登录用户信息（需要 access_token）*/
    getMe: (): Promise<UserInfo> =>
        evoRequest('/auth/me', {}, true),

    /** 修改昵称 */
    updateNickname: (nickname: string): Promise<UserInfo> =>
        evoRequest('/auth/me/nickname', {
            method: 'PATCH',
            body: JSON.stringify({ nickname }),
        }, true),

    getCurrentOrganization: (): Promise<CurrentOrganization> =>
        evoRequest('/organizations/current', {}, true),

    upsertOrganizationMember: (phone: string, roleCode: InviteRole): Promise<OrganizationMember> =>
        evoRequest('/organizations/current/members', {
            method: 'POST',
            body: JSON.stringify({ phone, role_code: roleCode }),
        }, true),

    updateOrganizationMember: (
        membershipId: string,
        payload: { role_code?: InviteRole; status?: MembershipStatus },
    ): Promise<OrganizationMember> =>
        evoRequest(`/organizations/current/members/${membershipId}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        }, true),

    respondMembershipInvitation: (
        membershipId: string,
        status: MembershipInvitationStatus,
    ): Promise<OrganizationMember> =>
        evoRequest(`/organizations/memberships/${membershipId}/response`, {
            method: 'PATCH',
            body: JSON.stringify({ status }),
        }, true),
}
