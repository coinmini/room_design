import { Link } from 'react-router-dom'

type DockKey =
  | 'home'
  | 'projects'
  | 'assets'
  | 'explore'
  | 'notify'
  | 'learn'
  | 'apps'

type DockItem = {
  key: DockKey
  title: string
  to?: string
  active?: boolean
}

const DOCK_ORDER: DockItem[] = [
  { key: 'home', title: '首页', to: '/' },
  { key: 'projects', title: '项目', to: '/projects' },
  { key: 'assets', title: '资产', to: '/workspace?module=assets' },
  { key: 'explore', title: '探索' },
  { key: 'notify', title: '通知' },
  { key: 'learn', title: '学堂' },
  { key: 'apps', title: '应用', to: '/workspace' },
]

/** 与 fengbaoch 左侧栏一致的描边图标（24 viewBox） */
function DockIcon({ name }: { name: DockKey }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  }

  switch (name) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M4.5 10.5 12 4l7.5 6.5" />
          <path d="M7 10.5V19a1 1 0 0 0 1 1h3.2v-4.2h1.6V20H16a1 1 0 0 0 1-1v-8.5" />
        </svg>
      )
    case 'projects':
      return (
        <svg {...common}>
          <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H9l1.4 1.6H18.5A1.5 1.5 0 0 1 20 10.1v7.4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
        </svg>
      )
    case 'assets':
      return (
        <svg {...common}>
          <rect x="4" y="5.5" width="16" height="13" rx="2.2" />
          <circle cx="9" cy="10.2" r="1.35" />
          <path d="m7.2 16.2 3.1-3.4 2.4 2.5 2.3-2.7 3.1 3.6" />
        </svg>
      )
    case 'explore':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M3.8 12h16.4" />
          <path d="M12 4c2.1 2.4 3.2 4.9 3.2 8s-1.1 5.6-3.2 8c-2.1-2.4-3.2-4.9-3.2-8s1.1-5.6 3.2-8Z" />
        </svg>
      )
    case 'notify':
      return (
        <svg {...common}>
          <path d="M7.2 16.5h9.6" />
          <path d="M8 16.5V11a4 4 0 0 1 8 0v5.5" />
          <path d="M6 16.5h12l-.7 1.1a1.6 1.6 0 0 1-1.4.8H8.1a1.6 1.6 0 0 1-1.4-.8L6 16.5Z" />
          <path d="M10.6 18.8a1.5 1.5 0 0 0 2.8 0" />
        </svg>
      )
    case 'learn':
      return (
        <svg {...common}>
          <path d="M3.5 9.2 12 5.5l8.5 3.7-8.5 3.7L3.5 9.2Z" />
          <path d="M7 11.2v4.2c0 .7 2.2 2.4 5 2.4s5-1.7 5-2.4v-4.2" />
          <path d="M20.5 9.5v6.2" />
        </svg>
      )
    case 'apps':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="6" height="6" rx="1.2" />
          <rect x="13.5" y="4.5" width="6" height="6" rx="1.2" />
          <rect x="4.5" y="13.5" width="6" height="6" rx="1.2" />
          <rect x="13.5" y="13.5" width="6" height="6" rx="1.2" />
        </svg>
      )
    default:
      return null
  }
}

type FbDockProps = {
  active?: DockKey
  onCreate?: () => void
  createDisabled?: boolean
}

/**
 * 首页 / 项目库共用左侧导航：上方独立 + 按钮 + 胶囊图标栏
 * 视觉对齐 fengbaoch 左侧 dock（描边图标 + 细分割线）
 */
export default function FbDock({
  active = 'home',
  onCreate,
  createDisabled,
}: FbDockProps) {
  const items = DOCK_ORDER.map((item) => ({
    ...item,
    active: item.key === active,
  }))

  return (
    <aside className="fb-dock" aria-label="主导航">
      <button
        type="button"
        className="fb-dock-plus"
        title="新建项目"
        disabled={createDisabled}
        onClick={onCreate}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          aria-hidden
        >
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>

      <div className="fb-dock-rail">
        {items.map((item) => {
          const showDividerBefore = item.key === 'notify'
          return (
            <div key={item.key} className="fb-dock-slot">
              {showDividerBefore ? (
                <div className="fb-dock-divider" aria-hidden />
              ) : null}
              {item.to ? (
                <Link
                  to={item.to}
                  className={`fb-dock-item${item.active ? ' is-active' : ''}`}
                  title={item.title}
                  aria-label={item.title}
                  aria-current={item.active ? 'page' : undefined}
                >
                  <DockIcon name={item.key} />
                </Link>
              ) : (
                <button
                  type="button"
                  className={`fb-dock-item${item.active ? ' is-active' : ''}`}
                  title={item.title}
                  aria-label={item.title}
                >
                  <DockIcon name={item.key} />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
