import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import App from './App'
import AssetsPage from './home/AssetsPage'
import HomePage from './home/HomePage'
import ProjectCanvasPage from './home/ProjectCanvasPage'
import ProjectsPage from './home/ProjectsPage'
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

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId/canvas" element={<ProjectCanvasPage />} />
        <Route path="/assets" element={<AssetsPage />} />
        <Route path="/workspace/*" element={<WorkspaceBridge />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
