import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import App from './App'
import HomePage from './home/HomePage'
import ProjectCanvasPage from './home/ProjectCanvasPage'
import ProjectsPage from './home/ProjectsPage'
import './home/home.css'

/** 兼容 workspace?module=&assetId= 深链，同步传给 App（避免 useEffect 晚于 useState）。 */
function WorkspaceBridge() {
  const [params] = useSearchParams()
  const module = params.get('module')
  const assetId = params.get('assetId')
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
        <Route path="/workspace/*" element={<WorkspaceBridge />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
