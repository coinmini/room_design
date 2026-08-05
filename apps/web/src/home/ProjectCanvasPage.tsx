import { Link, useParams } from 'react-router-dom'
import { ProjectCanvas } from '../canvas'
import './home.css'

export default function ProjectCanvasPage() {
  const { projectId = '' } = useParams()
  return (
    <div className="canvas-theme" style={{ minHeight: '100vh', display: 'grid', gridTemplateRows: '52px 1fr' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 16px',
          borderBottom: '1px solid var(--canvas-border)',
          background: 'var(--canvas-bg-elevated)',
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Link to="/" className="canvas-btn">
            ← 首页
          </Link>
          <span className="canvas-pill">项目 {projectId.slice(0, 12)}</span>
        </div>
        <Link to="/workspace?module=workflow" className="canvas-btn">
          打开向导
        </Link>
      </header>
      <div style={{ minHeight: 0 }}>
        {projectId ? <ProjectCanvas projectId={projectId} /> : null}
      </div>
    </div>
  )
}
