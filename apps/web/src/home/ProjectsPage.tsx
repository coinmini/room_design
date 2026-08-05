import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router-dom'
import { apiFetch, assetUrl } from '../api'
import AboutSheet from './AboutSheet'
import FbDock from './FbDock'
import NotifySheet, { countUnreadNotices } from './NotifySheet'
import UserSheet from './UserSheet'
import './home.css'

type MenuAnchor = {
  projectId: string
  top: number
  left: number
  openUp: boolean
}

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
  thumbnailUrl?: string | null
}

const CHIP_ACTIONS = [
  { label: 'PS插件', tone: 'orange' },
  { label: '创作者挑战赛', tone: 'purple' },
  { label: '加入合伙人', tone: 'cyan' },
  { label: '邀请有礼', tone: 'peach' },
]

function formatUpdateDate(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `更新于 ${y}-${m}-${day}`
}

export default function ProjectsPage() {
  const navigate = useNavigate()
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [assets, setAssets] = useState<SceneAsset[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pendingDelete, setPendingDelete] = useState<Project[] | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<MenuAnchor | null>(null)
  const [renameProject, setRenameProject] = useState<Project | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [notice, setNotice] = useState('')
  const [aboutOpen, setAboutOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [notifyUnread, setNotifyUnread] = useState(() => countUnreadNotices())
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem('room_design_display_name') || '设计师',
  )

  const menuProject = menuAnchor
    ? projects.find((p) => p.id === menuAnchor.projectId) ?? null
    : null

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0
      const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0
      return tb - ta
    })
  }, [projects])

  const allSelected =
    sortedProjects.length > 0 && selected.size === sortedProjects.length

  const coverOf = (project: Project) =>
    project.coverUrl ||
    assets.find((a) => a.projectId === project.id)?.thumbnailUrl ||
    null

  const coverSrc = (path?: string | null) => {
    if (!path) return ''
    if (path.startsWith('/cases/') || path.startsWith('/assets/')) return path
    return assetUrl(path)
  }

  const refresh = async () => {
    try {
      const [projectsResp, assetsResp] = await Promise.all([
        apiFetch('/v1/projects'),
        apiFetch('/v1/assets?limit=100'),
      ])
      if (projectsResp.ok) {
        setProjects((await projectsResp.json()) as Project[])
      }
      if (assetsResp.ok) {
        setAssets((await assetsResp.json()) as SceneAsset[])
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const closeMenu = () => setMenuAnchor(null)

  const openMenuFor = (projectId: string, button: HTMLElement) => {
    const rect = button.getBoundingClientRect()
    const menuHeight = 180
    const menuWidth = 160
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < menuHeight + 12
    const top = openUp
      ? Math.max(8, rect.top - menuHeight - 6)
      : rect.bottom + 6
    const left = Math.min(
      Math.max(8, rect.right - menuWidth),
      window.innerWidth - menuWidth - 8,
    )
    setMenuAnchor({ projectId, top, left, openUp })
  }

  useEffect(() => {
    if (!menuAnchor) return
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (menuRef.current && target && !menuRef.current.contains(target)) {
        // 点击触发按钮本身由按钮 toggle 处理
        const el = target as HTMLElement
        if (el.closest?.('.fb-lib-more')) return
        closeMenu()
      }
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    const onScroll = () => closeMenu()
    window.addEventListener('mousedown', onPointer)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('mousedown', onPointer)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [menuAnchor])

  useEffect(() => {
    if (!pendingDelete && !renameProject) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        setPendingDelete(null)
        setRenameProject(null)
      }
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [pendingDelete, renameProject, busy])

  const openProject = (project: Project) => {
    localStorage.setItem('room_design_canvas_project_id', project.id)
    navigate(`/projects/${project.id}/canvas`)
  }

  const createProject = async () => {
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch('/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名项目' }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: string
        } | null
        throw new Error(payload?.detail ?? `创建失败：${response.status}`)
      }
      const project = (await response.json()) as Project
      openProject(project)
    } catch (value) {
      setError(value instanceof Error ? value.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleSelect = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(sortedProjects.map((p) => p.id)))
  }

  const requestDeleteSelected = () => {
    const list = sortedProjects.filter((p) => selected.has(p.id))
    if (list.length === 0) return
    closeMenu()
    setPendingDelete(list)
  }

  const requestDeleteOne = (project: Project) => {
    closeMenu()
    setPendingDelete([project])
  }

  const startRename = (project: Project) => {
    closeMenu()
    setRenameProject(project)
    setRenameValue(project.name)
    setError('')
  }

  const confirmRename = async () => {
    if (!renameProject || busy) return
    const nextName = renameValue.trim()
    if (!nextName) {
      setError('项目名称不能为空')
      return
    }
    if (nextName === renameProject.name) {
      setRenameProject(null)
      return
    }
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(
        `/v1/projects/${encodeURIComponent(renameProject.id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nextName }),
        },
      )
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: string | Array<{ msg?: string }>
        } | null
        const detail = payload?.detail
        const message =
          typeof detail === 'string'
            ? detail
            : Array.isArray(detail)
              ? detail.map((d) => d.msg).filter(Boolean).join('；')
              : `重命名失败：${response.status}`
        throw new Error(message || `重命名失败：${response.status}`)
      }
      const updated = (await response.json()) as Project
      setProjects((current) =>
        current.map((p) => (p.id === updated.id ? { ...p, ...updated } : p)),
      )
      setRenameProject(null)
    } catch (value) {
      setError(value instanceof Error ? value.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete?.length || busy) return
    setBusy(true)
    setError('')
    try {
      const failed: string[] = []
      for (const project of pendingDelete) {
        const response = await apiFetch(
          `/v1/projects/${encodeURIComponent(project.id)}`,
          { method: 'DELETE' },
        )
        if (!response.ok && response.status !== 204) {
          failed.push(project.name)
          continue
        }
        const stored = localStorage.getItem('room_design_canvas_project_id')
        if (stored === project.id) {
          localStorage.removeItem('room_design_canvas_project_id')
        }
      }
      const deletedIds = new Set(
        pendingDelete
          .filter((p) => !failed.includes(p.name))
          .map((p) => p.id),
      )
      setProjects((current) => current.filter((p) => !deletedIds.has(p.id)))
      setSelected((current) => {
        const next = new Set(current)
        deletedIds.forEach((id) => next.delete(id))
        return next
      })
      setPendingDelete(null)
      if (failed.length) {
        setError(`部分删除失败：${failed.join('、')}`)
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : '删除失败')
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  const showFolderStub = () => {
    closeMenu()
    setNotice('文件夹功能即将上线')
    window.setTimeout(() => setNotice(''), 2200)
  }

  const deleteLabel =
    pendingDelete && pendingDelete.length > 1
      ? `删除 ${pendingDelete.length} 个项目`
      : '删除项目'

  return (
    <div className="fb-home fb-projects-page">
      <div className="fb-sky-milky" aria-hidden />

      <FbDock
        active="projects"
        createDisabled={busy}
        onCreate={() => void createProject()}
        onNotifyClick={() => setNotifyOpen(true)}
        onAppsClick={() => setAboutOpen(true)}
        notifyCount={notifyUnread}
      />

      <div className="fb-top-chips">
        <button
          type="button"
          className="fb-user-chip"
          aria-label="打开个人中心"
          onClick={() => setUserOpen(true)}
        >
          <span className="fb-user-avatar" aria-hidden>
            {displayName.slice(0, 1)}
          </span>
          <div className="fb-user-meta">
            <strong>本地用户</strong>
            <span>免费</span>
          </div>
        </button>
        {CHIP_ACTIONS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`fb-action-chip fb-action-chip--${chip.tone}`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <main className="fb-projects-main">
        <header className="fb-projects-toolbar">
          <div className="fb-projects-title">
            <span className="fb-projects-folder-icon" aria-hidden>
              📁
            </span>
            <h1>全部项目</h1>
            <span className="fb-projects-count">{sortedProjects.length}</span>
          </div>
          <div className="fb-projects-actions">
            {selected.size > 0 ? (
              <button
                type="button"
                className="fb-projects-action fb-projects-action--danger"
                disabled={busy}
                onClick={requestDeleteSelected}
              >
                删除 ({selected.size})
              </button>
            ) : null}
            <button
              type="button"
              className={`fb-projects-action${allSelected ? ' is-on' : ''}`}
              disabled={sortedProjects.length === 0 || busy}
              onClick={toggleSelectAll}
            >
              {allSelected ? '✓ 取消全选' : '全选'}
            </button>
            <button
              type="button"
              className="fb-projects-action"
              disabled={busy}
              onClick={showFolderStub}
            >
              新建文件夹
            </button>
            <button
              type="button"
              className="fb-projects-action fb-projects-action--primary"
              disabled={busy}
              onClick={() => void createProject()}
            >
              ＋ 新建项目
            </button>
          </div>
        </header>

        {error ? <div className="fb-error fb-projects-error">{error}</div> : null}
        {notice ? <div className="fb-gen-status fb-projects-notice">{notice}</div> : null}

        {sortedProjects.length === 0 ? (
          <div className="fb-projects-empty">
            <p>还没有项目</p>
            <button
              type="button"
              className="fb-projects-action fb-projects-action--primary"
              disabled={busy}
              onClick={() => void createProject()}
            >
              新建第一个项目
            </button>
          </div>
        ) : (
          <div className="fb-projects-grid">
            {sortedProjects.map((project) => {
              const cover = coverOf(project)
              const isSelected = selected.has(project.id)
              const menuOpen = menuAnchor?.projectId === project.id
              return (
                <article
                  key={project.id}
                  className={`fb-lib-card${isSelected ? ' is-selected' : ''}${
                    menuOpen ? ' is-menu-open' : ''
                  }`}
                >
                  <button
                    type="button"
                    className={`fb-lib-check${isSelected ? ' is-on' : ''}`}
                    title={isSelected ? '取消选择' : '选择'}
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      toggleSelect(project.id)
                    }}
                  >
                    {isSelected ? '✓' : ''}
                  </button>
                  <Link
                    to={`/projects/${project.id}/canvas`}
                    className="fb-lib-card-link"
                    onClick={() =>
                      localStorage.setItem(
                        'room_design_canvas_project_id',
                        project.id,
                      )
                    }
                  >
                    <div className="fb-lib-thumb">
                      {cover ? (
                        <img src={coverSrc(cover)} alt="" />
                      ) : (
                        <div className="fb-lib-thumb-empty">无封面</div>
                      )}
                    </div>
                  </Link>
                  <div className="fb-lib-meta">
                    <div className="fb-lib-meta-row">
                      <strong title={project.name}>{project.name}</strong>
                      <div className="fb-lib-menu-wrap">
                        <button
                          type="button"
                          className="fb-lib-more"
                          title="更多操作"
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          disabled={busy}
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            const button = event.currentTarget
                            if (menuOpen) {
                              closeMenu()
                            } else {
                              openMenuFor(project.id, button)
                            }
                          }}
                        >
                          ···
                        </button>
                      </div>
                    </div>
                    <span>
                      {formatUpdateDate(project.updatedAt || project.createdAt)}
                    </span>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </main>

      {menuAnchor && menuProject
        ? createPortal(
            <div
              ref={menuRef}
              className={`fb-lib-menu fb-lib-menu--portal${
                menuAnchor.openUp ? ' is-up' : ''
              }`}
              role="menu"
              style={{
                top: menuAnchor.top,
                left: menuAnchor.left,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="fb-lib-menu-item"
                onClick={() => openProject(menuProject)}
              >
                <span className="fb-lib-menu-icon" aria-hidden>
                  ›
                </span>
                打开编辑
              </button>
              <button
                type="button"
                role="menuitem"
                className="fb-lib-menu-item"
                onClick={() => startRename(menuProject)}
              >
                <span className="fb-lib-menu-icon" aria-hidden>
                  ✎
                </span>
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="fb-lib-menu-item"
                onClick={showFolderStub}
              >
                <span className="fb-lib-menu-icon" aria-hidden>
                  →
                </span>
                移动到
              </button>
              <div className="fb-lib-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="fb-lib-menu-item fb-lib-menu-item--danger"
                onClick={() => requestDeleteOne(menuProject)}
              >
                <span className="fb-lib-menu-icon" aria-hidden>
                  🗑
                </span>
                删除
              </button>
            </div>,
            document.body,
          )
        : null}

      {renameProject ? (
        <div
          className="fb-modal-root"
          role="presentation"
          onClick={() => !busy && setRenameProject(null)}
        >
          <div
            className="fb-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-rename-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="fb-rename-title">重命名项目</h2>
            <p>修改项目显示名称</p>
            <input
              className="fb-modal-input"
              value={renameValue}
              autoFocus
              maxLength={120}
              disabled={busy}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmRename()
              }}
            />
            <div className="fb-modal-actions">
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--ghost"
                disabled={busy}
                onClick={() => setRenameProject(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--primary"
                disabled={busy || !renameValue.trim()}
                onClick={() => void confirmRename()}
              >
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <AboutSheet open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <UserSheet
        open={userOpen}
        onClose={() => {
          setUserOpen(false)
          setDisplayName(
            localStorage.getItem('room_design_display_name') || '设计师',
          )
        }}
        displayName={displayName}
        stats={{
          projectCount: projects.length,
          assetCount: assets.length,
          notifyUnread,
        }}
        onOpenAbout={() => setAboutOpen(true)}
        onOpenNotify={() => setNotifyOpen(true)}
      />
      <NotifySheet
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        onUnreadChange={setNotifyUnread}
      />

      {pendingDelete ? (
        <div
          className="fb-modal-root"
          role="presentation"
          onClick={() => !busy && setPendingDelete(null)}
        >
          <div
            className="fb-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-projects-delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fb-modal-icon" aria-hidden>
              🗑
            </div>
            <h2 id="fb-projects-delete-title">{deleteLabel}</h2>
            <p>
              {pendingDelete.length === 1 ? (
                <>
                  确定删除项目「
                  <strong>{pendingDelete[0].name}</strong>
                  」？
                </>
              ) : (
                <>
                  确定删除选中的 <strong>{pendingDelete.length}</strong>{' '}
                  个项目？
                </>
              )}
              <br />
              画布记录将移除，生成图片资产会保留在库中。
            </p>
            <div className="fb-modal-actions">
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--ghost"
                disabled={busy}
                onClick={() => setPendingDelete(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--danger"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
