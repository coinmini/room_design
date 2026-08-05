import { useEffect } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import App from './App'
import HomePage from './home/HomePage'
import ProjectCanvasPage from './home/ProjectCanvasPage'
import './home/home.css'

/** 兼容 workspace?module= 深链，把 query 写入 sessionStorage 供 App 读取。 */
function WorkspaceBridge() {
  const [params] = useSearchParams()
  useEffect(() => {
    const module = params.get('module')
    if (module) sessionStorage.setItem('room_design_workspace_module', module)
  }, [params])
  return <App />
}

export default function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/projects/:projectId/canvas" element={<ProjectCanvasPage />} />
        <Route path="/workspace/*" element={<WorkspaceBridge />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
