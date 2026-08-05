import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch, assetUrl } from '../api'
import '../canvas/theme.css'

type Project = {
  id: string
  name: string
  designPrompt?: string | null
  coverUrl?: string | null
  updatedAt?: string | null
  createdAt?: string
}

type SceneAsset = {
  id: string
  projectId?: string | null
  title: string
  thumbnailUrl?: string | null
  createdAt: string
}

type Health = {
  status?: string
  version?: string
  imageProvider?: string
  imageModel?: string
  model?: string
  provider?: string
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
}

export default function HomePage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [assets, setAssets] = useState<SceneAsset[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const modelPill = useMemo(() => {
    if (!health) return '模型加载中…'
    return (
      health.imageModel ||
      health.model ||
      health.imageProvider ||
      health.provider ||
      `API v${health.version ?? '?'}`
    )
  }, [health])

  const refresh = async () => {
    try {
      const [projectsResp, assetsResp, healthResp] = await Promise.all([
        apiFetch('/v1/projects'),
        apiFetch('/v1/assets?limit=24'),
        apiFetch('/health'),
      ])
      if (projectsResp.ok) {
        setProjects((await projectsResp.json()) as Project[])
      }
      if (assetsResp.ok) {
        setAssets((await assetsResp.json()) as SceneAsset[])
      }
      if (healthResp.ok) {
        setHealth((await healthResp.json()) as Health)
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const createProject = async (name?: string, designPrompt?: string) => {
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch('/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name?.trim() || `新项目 ${new Date().toLocaleString()}`,
          designPrompt: designPrompt?.trim() || undefined,
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: string
        } | null
        throw new Error(payload?.detail ?? `创建失败：${response.status}`)
      }
      const project = (await response.json()) as Project
      localStorage.setItem('room_design_canvas_project_id', project.id)
      navigate(`/projects/${project.id}/canvas`)
    } catch (value) {
      setError(value instanceof Error ? value.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const recentProjects = [...projects]
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0
      const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0
      return tb - ta
    })
    .slice(0, 12)

  return (
    <div className="canvas-theme home-page">
      <aside className="home-rail">
        <Link to="/" className="home-rail-brand" title="首页">
          RD
        </Link>
        <Link to="/" className="home-rail-item active" title="首页">
          ⌂
        </Link>
        <Link to="/workspace" className="home-rail-item" title="工作台">
          ▦
        </Link>
        <Link to="/workspace?module=canvas" className="home-rail-item" title="画布">
          ⧉
        </Link>
        <Link to="/workspace?module=assets" className="home-rail-item" title="资产">
          ▤
        </Link>
      </aside>

      <main className="home-main">
        <header className="home-hero">
          <div className="canvas-pill">{modelPill}</div>
          <h1>
            {greeting()}，开始今天的设计
          </h1>
          <p className="canvas-secondary">
            描述空间与风格意向，创建项目并进入无限画布；也可从最近项目继续。
          </p>
          <form
            className="home-prompt-box canvas-card"
            onSubmit={(event) => {
              event.preventDefault()
              void createProject(undefined, prompt)
            }}
          >
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：三室两厅现代原木风，客厅要大落地窗与暖色灯光…"
              rows={3}
            />
            <div className="home-prompt-actions">
              <span className="canvas-muted">接入 design_prompt · 本地项目</span>
              <button
                type="submit"
                className="canvas-btn canvas-btn-primary"
                disabled={busy}
              >
                {busy ? '创建中…' : '新建项目并打开画布'}
              </button>
            </div>
          </form>
          {error ? (
            <div className="notice notice-error" style={{ marginTop: 12 }}>
              {error}
            </div>
          ) : null}
        </header>

        <section className="home-section">
          <div className="home-section-head">
            <h2>最近项目</h2>
            <button
              type="button"
              className="canvas-btn"
              onClick={() => void createProject('未命名项目')}
              disabled={busy}
            >
              + 新建空白项目
            </button>
          </div>
          <div className="home-project-row">
            <button
              type="button"
              className="home-project-card canvas-card home-new-card"
              onClick={() => void createProject('未命名项目')}
              disabled={busy}
            >
              <strong>+</strong>
              <span>新建项目</span>
            </button>
            {recentProjects.map((project) => {
              const cover =
                project.coverUrl ||
                assets.find((asset) => asset.projectId === project.id)
                  ?.thumbnailUrl
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}/canvas`}
                  className="home-project-card canvas-card"
                  onClick={() =>
                    localStorage.setItem(
                      'room_design_canvas_project_id',
                      project.id,
                    )
                  }
                >
                  <div className="home-project-thumb">
                    {cover ? (
                      <img src={assetUrl(cover)} alt="" />
                    ) : (
                      <span className="canvas-muted">无封面</span>
                    )}
                  </div>
                  <div className="home-project-meta">
                    <strong>{project.name}</strong>
                    <span className="canvas-muted">
                      {(project.updatedAt || project.createdAt || '').slice(0, 10)}
                    </span>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <h2>我的资产</h2>
            <span className="canvas-muted">用你自己的生成结果代替精选案例墙</span>
          </div>
          <div className="home-asset-grid">
            {assets.length === 0 ? (
              <div className="canvas-muted">还没有资产，先去工作流生成方案吧。</div>
            ) : (
              assets.map((asset) => (
                <article key={asset.id} className="canvas-card home-asset-card">
                  <div className="home-asset-thumb">
                    {asset.thumbnailUrl ? (
                      <img src={assetUrl(asset.thumbnailUrl)} alt={asset.title} />
                    ) : (
                      <span className="canvas-muted">无图</span>
                    )}
                  </div>
                  <div className="home-asset-meta">
                    <strong title={asset.title}>{asset.title}</strong>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  )
}
