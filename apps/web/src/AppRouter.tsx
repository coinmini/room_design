import { useEffect, useState, type ReactNode } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useSearchParams,
} from 'react-router-dom'
import App from './App'
import {
  clearAuthSession,
  fetchAuthStatus,
  getAuthToken,
  getAuthUsername,
} from './auth'
import AssetsPage from './home/AssetsPage'
import HomePage from './home/HomePage'
import ProjectCanvasPage from './home/ProjectCanvasPage'
import ProjectsPage from './home/ProjectsPage'
import LoginPage from './LoginPage'
import './home/home.css'

/**
 * 兼容旧 /workspace 深链。
 * - assets → 独立资产页
 * - 其余默认导向首页（画布主路径）；legacy 向导仅 VITE_SHOW_LEGACY_TOOLS=true 时保留
 */
function WorkspaceBridge() {
  const [params] = useSearchParams()
  const module = params.get('module')
  const assetId = params.get('assetId')
  const showLegacy = import.meta.env.VITE_SHOW_LEGACY_TOOLS === 'true'
  if (module === 'assets') {
    const qs = assetId
      ? `?assetId=${encodeURIComponent(assetId)}`
      : ''
    return <Navigate to={`/assets${qs}`} replace />
  }
  if (!showLegacy) {
    return <Navigate to="/" replace />
  }
  return (
    <App
      initialModule={module}
      initialAssetId={assetId}
    />
  )
}

function AuthGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [needLogin, setNeedLogin] = useState(false)
  const [username, setUsername] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const status = await fetchAuthStatus()
      if (cancelled) return
      if (!status.enabled) {
        setNeedLogin(false)
        setUsername(null)
        setReady(true)
        return
      }
      const token = getAuthToken()
      if (!token || !status.username) {
        // status 带 token 时若 username 为空说明 token 失效
        if (token && !status.username) clearAuthSession()
        setNeedLogin(true)
        setUsername(null)
      } else {
        setNeedLogin(false)
        setUsername(status.username || getAuthUsername())
      }
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!ready) {
    return (
      <div className="fb-login-page">
        <div className="fb-login-card" style={{ textAlign: 'center' }}>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.6)' }}>正在检查登录状态…</p>
        </div>
      </div>
    )
  }

  if (needLogin) {
    return (
      <LoginPage
        onSuccess={(name) => {
          setUsername(name)
          setNeedLogin(false)
        }}
      />
    )
  }

  return (
    <>
      {username ? (
        <div className="fb-auth-bar" title="已登录测试账号">
          <span>{username}</span>
          <button
            type="button"
            onClick={() => {
              clearAuthSession()
              setNeedLogin(true)
              setUsername(null)
            }}
          >
            退出
          </button>
        </div>
      ) : null}
      {children}
    </>
  )
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route
            path="/projects/:projectId/canvas"
            element={<ProjectCanvasPage />}
          />
          <Route path="/assets" element={<AssetsPage />} />
          <Route path="/workspace/*" element={<WorkspaceBridge />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthGate>
    </BrowserRouter>
  )
}
