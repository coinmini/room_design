import { useParams } from 'react-router-dom'
import { ProjectCanvas } from '../canvas'
import './home.css'

/**
 * 画布页：不再单独占一行外壳导航，顶栏由 ProjectCanvas 单行统一承载。
 */
export default function ProjectCanvasPage() {
  const { projectId = '' } = useParams()
  return (
    <div className="canvas-theme project-canvas-page">
      {projectId ? (
        <ProjectCanvas projectId={projectId} showAppChrome />
      ) : null}
    </div>
  )
}
