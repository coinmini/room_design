import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import App from './App'
import AssetsPage from './home/AssetsPage'
import HomePage from './home/HomePage'
import ProjectCanvasPage from './home/ProjectCanvasPage'
import ProjectsPage from './home/ProjectsPage'
import './home/home.css'

/** 兼容 workspace?module=&assetId=；资产模块改走独立深色全页（无旧侧栏）。 */
function WorkspaceBridge() {
  const [params] = useSearchParams()
  const module = params.get('module')
  const assetId = params.get('assetId')
  if (module === 'assets') {
    const qs = assetId
      ? `?assetId=${encodeURIComponent(assetId)}`
      : ''
    return <Navigate to={`/assets${qs}`} replace />
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
