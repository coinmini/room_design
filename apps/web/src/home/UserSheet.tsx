import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

export type UserSheetStats = {
  projectCount?: number
  assetCount?: number
  modelLabel?: string
  modelReady?: boolean
  /** 通知未读数，用于红点 */
  notifyUnread?: number
}

type Props = {
  open: boolean
  onClose: () => void
  displayName?: string
  stats?: UserSheetStats
  onOpenAbout?: () => void
  onOpenNotify?: () => void
}

const DISPLAY_NAME_KEY = 'room_design_display_name'
const THEME_KEY = 'room_design_ui_theme'
const UUID_KEY = 'room_design_local_uuid'
const CREDITS_KEY = 'room_design_credits_demo'

function ensureLocalUuid(): string {
  try {
    const existing = localStorage.getItem(UUID_KEY)
    if (existing) return existing
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().replaceAll('-', '').slice(0, 16)
        : `loc${Date.now().toString(36)}`
    localStorage.setItem(UUID_KEY, id)
    return id
  } catch {
    return 'local-user'
  }
}

function maskPhone(name: string): string {
  // 本地无手机号：用固定示意或把名称做成类似掩码展示
  const digits = name.replace(/\D/g, '')
  if (digits.length >= 7) {
    return `${digits.slice(0, 3)}****${digits.slice(-4)}`
  }
  return '158****1686'
}

type ThemeMode = 'light' | 'dark'

/**
 * 用户账户面板 — 对齐风暴/参考图：头像信息、VIP、积分、存储、菜单列表
 */
export default function UserSheet({
  open,
  onClose,
  displayName: nameProp,
  stats,
  onOpenAbout,
  onOpenNotify,
}: Props) {
  const navigate = useNavigate()
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const raw = localStorage.getItem(THEME_KEY)
    return raw === 'light' ? 'light' : 'dark'
  })
  const [toast, setToast] = useState('')
  const [uuid] = useState(() => ensureLocalUuid())
  /** 贴在右上胶囊整行（含 PS 插件）下方，避免遮挡 */
  const [anchorPos, setAnchorPos] = useState({ top: 96, right: 18 })

  const displayName =
    nameProp || localStorage.getItem(DISPLAY_NAME_KEY) || '设计师'
  const phoneLabel = maskPhone(displayName)

  const credits = useMemo(() => {
    try {
      const raw = localStorage.getItem(CREDITS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as {
          total?: number
          member?: number
          recharge?: number
          model?: number
          free?: number
        }
        return {
          total: Number(parsed.total) || 20,
          member: Number(parsed.member) || 0,
          recharge: Number(parsed.recharge) || 0,
          model: Number(parsed.model) || 0,
          free: Number(parsed.free) || 20,
        }
      }
    } catch {
      /* ignore */
    }
    return { total: 20, member: 0, recharge: 0, model: 0, free: 20 }
  }, [open])

  const storageUsed = 0
  const storageTotal = 3
  const vipExpiredDays = 20
  const notifyUnread = stats?.notifyUnread ?? 0

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.classList.add('fb-user-sheet-open')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
      document.body.classList.remove('fb-user-sheet-open')
    }
  }, [open, onClose])

  /** 定位到 .fb-top-chips（用户头像 + PS插件一行）正下方 */
  useEffect(() => {
    if (!open) return
    const place = () => {
      const chips = document.querySelector(
        '.fb-top-chips, .fb-assets-toolbar-chips',
      ) as HTMLElement | null
      if (!chips) {
        setAnchorPos({ top: 96, right: 18 })
        return
      }
      const rect = chips.getBoundingClientRect()
      const gap = 10
      setAnchorPos({
        top: Math.round(rect.bottom + gap),
        right: Math.max(12, Math.round(window.innerWidth - rect.right)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(''), 1600)
    return () => window.clearTimeout(t)
  }, [toast])

  if (!open) return null

  const flash = (msg: string) => setToast(msg)

  const copyUuid = async () => {
    // navigator.clipboard 同样只在 secure context 存在；用 IP + 明文 HTTP
    // 访问时它是 undefined，需要退回 execCommand。
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(uuid)
        flash('UUID 已复制')
        return
      }
      const area = document.createElement('textarea')
      area.value = uuid
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(area)
      flash(ok ? 'UUID 已复制' : '复制失败，请手动选择')
    } catch {
      flash('复制失败')
    }
  }

  const setThemeMode = (mode: ThemeMode) => {
    setTheme(mode)
    try {
      localStorage.setItem(THEME_KEY, mode)
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.uiTheme = mode
    flash(mode === 'dark' ? '已切换深色模式' : '已切换浅色模式')
  }

  const goAssets = () => {
    onClose()
    navigate('/assets')
  }

  return (
    <div className="fb-user-sheet-root" role="presentation" onClick={onClose}>
      <div
        className="fb-user-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="账户菜单"
        style={{
          top: anchorPos.top,
          right: anchorPos.right,
          maxHeight: `min(calc(100vh - ${anchorPos.top + 16}px), 720px)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 顶部：头像 + 手机号 + UUID / Access key + 创建团队 */}
        <section className="fb-acct-profile">
          <div className="fb-acct-profile-left">
            <div className="fb-acct-avatar" aria-hidden>
              <span className="fb-acct-avatar-face">◡</span>
            </div>
            <div className="fb-acct-profile-meta">
              <div className="fb-acct-phone">{phoneLabel}</div>
              <div className="fb-acct-ids">
                <button
                  type="button"
                  className="fb-acct-id-btn"
                  onClick={() => void copyUuid()}
                  title="复制 UUID"
                >
                  UUID
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <rect x="9" y="9" width="11" height="11" rx="2" />
                    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                  </svg>
                </button>
                <span className="fb-acct-id-sep">|</span>
                <button
                  type="button"
                  className="fb-acct-id-btn"
                  onClick={() => flash('Access key（本地演示）')}
                >
                  Access key
                  <span aria-hidden>›</span>
                </button>
              </div>
            </div>
          </div>
          <button
            type="button"
            className="fb-acct-team-btn"
            onClick={() => flash('创建团队（即将开放）')}
          >
            <span aria-hidden>+</span> 创建团队
          </button>
        </section>

        {/* VIP 过期条 */}
        <section className="fb-acct-vip">
          <span className="fb-acct-vip-text">
            高级版VIP已过期{vipExpiredDays}天
          </span>
          <button
            type="button"
            className="fb-acct-vip-cta"
            onClick={() => flash('开通会员（本地演示）')}
          >
            开通会员
          </button>
        </section>

        {/* 积分 */}
        <section className="fb-acct-card fb-acct-credits">
          <div className="fb-acct-credits-top">
            <button
              type="button"
              className="fb-acct-credits-balance"
              onClick={() => flash('积分明细（本地演示）')}
            >
              积分余额{' '}
              <em>{credits.total}</em> 点
              <span aria-hidden>›</span>
            </button>
            <div className="fb-acct-credits-actions">
              <button type="button" onClick={() => flash('充值（本地演示）')}>
                充值
              </button>
              <span className="fb-acct-dot-sep">|</span>
              <button
                type="button"
                onClick={() => flash('设置消耗顺序（本地演示）')}
              >
                设置消耗顺序
              </button>
            </div>
          </div>
          <div className="fb-acct-credits-breakdown">
            <span>会员订阅积分 {credits.member} 点</span>
            <span className="fb-acct-pipe">|</span>
            <span>通用充值积分 {credits.recharge} 点</span>
          </div>
          <div className="fb-acct-credits-breakdown">
            <span>模型卡积分 {credits.model} 点</span>
            <span className="fb-acct-pipe">|</span>
            <span>免费积分 {credits.free} 点</span>
          </div>
        </section>

        {/* 存储空间 */}
        <section className="fb-acct-card fb-acct-storage">
          <div className="fb-acct-storage-row">
            <div>
              <div className="fb-acct-storage-label">存储空间</div>
              <div className="fb-acct-storage-value">
                <strong>{storageUsed}G</strong>
                <span>/{storageTotal}G</span>
              </div>
            </div>
            <button
              type="button"
              className="fb-acct-storage-manage"
              onClick={goAssets}
            >
              管理资产
            </button>
          </div>
        </section>

        {/* 菜单列表 */}
        <nav className="fb-acct-menu" aria-label="账户菜单">
          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => {
              onClose()
              onOpenAbout?.()
            }}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5.5 19.5c1.2-3.2 3.5-4.8 6.5-4.8s5.3 1.6 6.5 4.8" />
              </svg>
            </span>
            <span>个人中心</span>
          </button>

          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => flash('订阅与开发票（本地演示）')}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 4h12v16l-2-1.2L14 20l-2-1.2L10 20l-2-1.2L6 20V4Z" />
                <path d="M9 9h6M9 13h4" />
              </svg>
            </span>
            <span>订阅与开发票</span>
          </button>

          <div className="fb-acct-menu-item fb-acct-menu-item--static">
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3a9 9 0 0 0 0 18" fill="currentColor" opacity="0.25" />
              </svg>
            </span>
            <span>模式切换</span>
            <div
              className="fb-acct-theme-toggle"
              role="group"
              aria-label="模式切换"
            >
              <button
                type="button"
                className={theme === 'light' ? 'is-active' : ''}
                aria-label="浅色"
                aria-pressed={theme === 'light'}
                onClick={() => setThemeMode('light')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </svg>
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'is-active' : ''}
                aria-label="深色"
                aria-pressed={theme === 'dark'}
                onClick={() => setThemeMode('dark')}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.5 14.5A8 8 0 0 1 9.5 3.5 8.5 8.5 0 1 0 20.5 14.5Z" />
                </svg>
              </button>
            </div>
          </div>

          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => flash('AI 水印设置（本地演示）')}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="8" r="3.5" />
                <path d="M5.5 19.5c1.2-3.2 3.5-4.8 6.5-4.8s5.3 1.6 6.5 4.8" />
                <path d="M16 6.5 18 4.5" />
              </svg>
            </span>
            <span>AI 水印设置</span>
          </button>

          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => flash('CLI & Skill（本地演示）')}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="m8 8-4 4 4 4M12 16h6" />
              </svg>
            </span>
            <span>CLI &amp; Skill</span>
          </button>

          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => {
              onClose()
              onOpenNotify?.()
            }}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5 2 6H4c.5-1 2-2.5 2-6Z" />
                <path d="M10 19a2 2 0 0 0 4 0" />
              </svg>
            </span>
            <span>通知</span>
            {notifyUnread > 0 ? (
              <span className="fb-acct-badge" aria-label={`${notifyUnread} 条未读`}>
                {notifyUnread > 99 ? '99+' : notifyUnread}
              </span>
            ) : null}
          </button>

          <button
            type="button"
            className="fb-acct-menu-item"
            onClick={() => flash('本地工作台无需登录')}
          >
            <span className="fb-acct-menu-icon" aria-hidden>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M10 7H7a3 3 0 0 0-3 3v7a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-7a3 3 0 0 0-3-3h-3" />
                <path d="M12 15V3M9 6l3-3 3 3" />
              </svg>
            </span>
            <span>退出登录</span>
          </button>
        </nav>

        {toast ? (
          <div className="fb-acct-toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>
    </div>
  )
}
