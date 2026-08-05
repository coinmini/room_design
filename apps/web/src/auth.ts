/**
 * 公网演示登录：token 存 sessionStorage，关闭标签即失效。
 * 本地未启用鉴权时 status.enabled=false，直接放行。
 */

import { API_BASE } from './api'

const TOKEN_KEY = 'room_design_auth_token'
const USER_KEY = 'room_design_auth_user'
const EXPIRES_KEY = 'room_design_auth_expires'

export type AuthStatus = {
  enabled: boolean
  username: string | null
}

export type LoginResult = {
  token: string
  username: string
  expiresAt: number
  tokenType: string
}

export function getAuthToken(): string | null {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY)
    const expRaw = sessionStorage.getItem(EXPIRES_KEY)
    if (!token) return null
    if (expRaw) {
      const exp = Number(expRaw)
      if (Number.isFinite(exp) && exp * 1000 < Date.now()) {
        clearAuthSession()
        return null
      }
    }
    return token
  } catch {
    return null
  }
}

export function getAuthUsername(): string | null {
  try {
    return sessionStorage.getItem(USER_KEY)
  } catch {
    return null
  }
}

export function setAuthSession(result: LoginResult): void {
  sessionStorage.setItem(TOKEN_KEY, result.token)
  sessionStorage.setItem(USER_KEY, result.username)
  sessionStorage.setItem(EXPIRES_KEY, String(result.expiresAt))
}

export function clearAuthSession(): void {
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(USER_KEY)
    sessionStorage.removeItem(EXPIRES_KEY)
  } catch {
    /* private mode */
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  try {
    const token = getAuthToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    // 直接 fetch status，避免 apiFetch 对 401 递归
    const response = await fetch(`${API_BASE}/v1/auth/status`, {
      headers,
      cache: 'no-store',
    })
    if (!response.ok) {
      return { enabled: false, username: null }
    }
    const body = (await response.json()) as {
      enabled?: boolean
      username?: string | null
    }
    return {
      enabled: Boolean(body.enabled),
      username: body.username ?? null,
    }
  } catch {
    // 后端不可达时不挡页面（显示业务错误）
    return { enabled: false, username: null }
  }
}

export async function loginRequest(
  username: string,
  password: string,
): Promise<LoginResult> {
  const response = await fetch(`${API_BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const payload = (await response.json().catch(() => null)) as {
    detail?: unknown
    token?: string
    username?: string
    expiresAt?: number
    tokenType?: string
  } | null
  if (!response.ok) {
    const detail = payload?.detail
    const message =
      typeof detail === 'string'
        ? detail
        : `登录失败：${response.status}`
    throw new Error(message)
  }
  if (!payload?.token || !payload.username || !payload.expiresAt) {
    throw new Error('登录响应无效')
  }
  return {
    token: payload.token,
    username: payload.username,
    expiresAt: payload.expiresAt,
    tokenType: payload.tokenType || 'Bearer',
  }
}
