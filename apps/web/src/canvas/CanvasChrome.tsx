import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '../api'
import { zoomPercent } from './layoutMath'

type Props = {
  projectId: string
  projectName?: string
  zoom: number
  busy?: boolean
  showMinimap: boolean
  snapToGrid: boolean
  hideEdges: boolean
  onToggleMinimap: () => void
  onToggleSnap: () => void
  onToggleHideEdges: () => void
  onOrganize: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onFitView: () => void
  onUploadFloorplan: () => void
  onOpenAssets: () => void
  onNotice?: (msg: string) => void
}

function Icon({
  children,
  size = 18,
}: {
  children: ReactNode
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

/**
 * 画布图谱模式 chrome（对齐风暴工作区参考）：
 * - 左上：项目菜单
 * - 左下：视图工具
 * - 底中：+ 添加 / 快捷工具
 * 不复用首页 FbDock。
 */
export default function CanvasChrome({
  projectId,
  projectName,
  zoom,
  busy,
  showMinimap,
  snapToGrid,
  hideEdges,
  onToggleMinimap,
  onToggleSnap,
  onToggleHideEdges,
  onOrganize,
  onZoomIn,
  onZoomOut,
  onFitView,
  onUploadFloorplan,
  onOpenAssets,
  onNotice,
}: Props) {
  const navigate = useNavigate()
  const [projectMenu, setProjectMenu] = useState(false)
  const [addMenu, setAddMenu] = useState(false)
  const [zoomMenu, setZoomMenu] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const projectMenuRef = useRef<HTMLDivElement | null>(null)
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const zoomMenuRef = useRef<HTMLDivElement | null>(null)

  const displayName = (projectName || '未命名工作区').trim() || '未命名工作区'

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const t = event.target as Node
      if (projectMenuRef.current && !projectMenuRef.current.contains(t)) {
        setProjectMenu(false)
      }
      if (addMenuRef.current && !addMenuRef.current.contains(t)) {
        setAddMenu(false)
      }
      if (zoomMenuRef.current && !zoomMenuRef.current.contains(t)) {
        setZoomMenu(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const createProject = async () => {
    setProjectMenu(false)
    try {
      const response = await apiFetch('/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '未命名项目' }),
      })
      if (!response.ok) throw new Error(`创建失败：${response.status}`)
      const created = (await response.json()) as { id: string }
      navigate(`/projects/${created.id}/canvas`)
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : '创建项目失败')
    }
  }

  const deleteProject = async () => {
    if (deleting) return
    if (!window.confirm(`确定删除项目「${displayName}」？此操作不可恢复。`)) {
      return
    }
    setDeleting(true)
    setProjectMenu(false)
    try {
      const response = await apiFetch(
        `/v1/projects/${encodeURIComponent(projectId)}`,
        { method: 'DELETE' },
      )
      if (!response.ok && response.status !== 204) {
        throw new Error(`删除失败：${response.status}`)
      }
      const stored = localStorage.getItem('room_design_canvas_project_id')
      if (stored === projectId) {
        localStorage.removeItem('room_design_canvas_project_id')
      }
      navigate('/projects')
    } catch (e) {
      onNotice?.(e instanceof Error ? e.message : '删除项目失败')
    } finally {
      setDeleting(false)
    }
  }

  const stub = (label: string) => {
    setAddMenu(false)
    onNotice?.(`${label} · 即将支持`)
  }

  return (
    <>
      {/* 左上：项目菜单 */}
      <div className="cw-project-menu" ref={projectMenuRef}>
        <button
          type="button"
          className="cw-project-trigger"
          onClick={() => {
            setProjectMenu((v) => !v)
            setAddMenu(false)
            setZoomMenu(false)
          }}
          title={displayName}
        >
          <span className="cw-project-logo" aria-hidden>
            <Icon size={16}>
              <rect x="4" y="4" width="16" height="16" rx="4" />
              <path d="M8 12h8M12 8v8" />
            </Icon>
          </span>
          <span className="cw-project-name">{displayName}</span>
          <span className="cw-project-chevron" aria-hidden>
            ▾
          </span>
        </button>
        <span className="cw-canvas-chip" title="当前画布">
          画布 1 ▾
        </span>
        {projectMenu ? (
          <div className="cw-menu-panel cw-project-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenu(false)
                navigate('/')
              }}
            >
              回到主页
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenu(false)
                navigate('/projects')
              }}
            >
              全部项目
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy || deleting}
              onClick={() => void createProject()}
            >
              创建新项目
            </button>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              disabled={busy || deleting}
              onClick={() => void deleteProject()}
            >
              删除项目
            </button>
          </div>
        ) : null}
      </div>

      {/* 左下：视图工具 */}
      <div className="cw-bottom-left" role="toolbar" aria-label="画布视图">
        <button
          type="button"
          className="cw-icon-btn"
          title="资产管理"
          aria-label="资产管理"
          onClick={onOpenAssets}
        >
          <Icon>
            <rect x="3" y="4" width="7" height="16" rx="1.5" />
            <rect x="12" y="4" width="9" height="7" rx="1.5" />
            <rect x="12" y="13" width="9" height="7" rx="1.5" />
          </Icon>
        </button>
        <button
          type="button"
          className="cw-icon-btn"
          title="整理画布"
          aria-label="整理画布"
          onClick={onOrganize}
        >
          <Icon>
            <path d="M4 6h16M4 12h10M4 18h13" />
            <path d="m15 10 3 2-3 2" />
          </Icon>
        </button>
        <button
          type="button"
          className={`cw-icon-btn${showMinimap ? ' is-active' : ''}`}
          title="画布小地图"
          aria-label="画布小地图"
          onClick={onToggleMinimap}
        >
          <Icon>
            <rect x="4" y="5" width="16" height="14" rx="2" />
            <path d="M8 15l3-3.5 2.5 2.5L16.5 10 20 14" />
          </Icon>
        </button>
        <button
          type="button"
          className={`cw-icon-btn${hideEdges ? ' is-active' : ''}`}
          title="隐藏节点连线"
          aria-label="隐藏节点连线"
          onClick={onToggleHideEdges}
        >
          <Icon>
            <circle cx="6.5" cy="12" r="2.2" />
            <circle cx="17.5" cy="12" r="2.2" />
            <path d="M8.7 12h6.6" strokeDasharray={hideEdges ? '2 2' : undefined} />
            {hideEdges ? <path d="m4 6 16 12" /> : null}
          </Icon>
        </button>
        <button
          type="button"
          className={`cw-icon-btn${snapToGrid ? ' is-active' : ''}`}
          title="网格吸附"
          aria-label="网格吸附"
          onClick={onToggleSnap}
        >
          <Icon>
            <path d="M4 4h4v4H4zM10 4h4v4h-4zM16 4h4v4h-4zM4 10h4v4H4zM10 10h4v4h-4zM16 10h4v4h-4zM4 16h4v4H4zM10 16h4v4h-4zM16 16h4v4h-4z" />
          </Icon>
        </button>
        <div className="cw-zoom-wrap" ref={zoomMenuRef}>
          <button
            type="button"
            className={`cw-icon-btn cw-zoom-btn${zoomMenu ? ' is-active' : ''}`}
            title="缩放选项"
            aria-label="缩放选项"
            onClick={() => {
              setZoomMenu((v) => !v)
              setAddMenu(false)
              setProjectMenu(false)
            }}
          >
            <span className="cw-zoom-label">{zoomPercent(zoom)}%</span>
          </button>
          {zoomMenu ? (
            <div className="cw-menu-panel cw-zoom-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { onZoomIn(); }}>
                放大
              </button>
              <button type="button" role="menuitem" onClick={() => { onZoomOut(); }}>
                缩小
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onFitView()
                  setZoomMenu(false)
                }}
              >
                适应画布
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {/* 底中：+ 与快捷工具 */}
      <div className="cw-bottom-center" ref={addMenuRef}>
        {addMenu ? (
          <div className="cw-menu-panel cw-add-menu" role="menu">
            <div className="cw-menu-section-label">添加节点</div>
            <button type="button" role="menuitem" onClick={() => stub('文本节点')}>
              <Icon size={16}>
                <path d="M4 7h16M9 7v12M15 7v12" />
              </Icon>
              文本
            </button>
            <button type="button" role="menuitem" onClick={() => stub('图片节点')}>
              <Icon size={16}>
                <rect x="4" y="5" width="16" height="14" rx="2" />
                <circle cx="9" cy="10" r="1.3" />
                <path d="m7 16 3.2-3.5 2.4 2.4 2.2-2.6L17 16" />
              </Icon>
              图片
            </button>
            <button type="button" role="menuitem" onClick={() => stub('视频节点')}>
              <Icon size={16}>
                <rect x="3.5" y="6" width="12" height="12" rx="2" />
                <path d="m15.5 10 5-2.5v9L15.5 14" />
              </Icon>
              视频
            </button>
            <button type="button" role="menuitem" onClick={() => stub('音频')}>
              <Icon size={16}>
                <path d="M4 10v4M8 7v10M12 5v14M16 8v8M20 10v4" />
              </Icon>
              音频
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAddMenu(false)
                onOpenAssets()
              }}
            >
              <Icon size={16}>
                <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7H9l1.4 1.6H18.5A1.5 1.5 0 0 1 20 10.1v7.4a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z" />
              </Icon>
              素材库
            </button>
            <div className="cw-menu-section-label">添加资源</div>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setAddMenu(false)
                onUploadFloorplan()
              }}
            >
              <Icon size={16}>
                <path d="M12 16V5M8 9l4-4 4 4" />
                <path d="M5 18h14" />
              </Icon>
              上传
            </button>
            <button type="button" role="menuitem" onClick={() => stub('从生成历史选择')}>
              <Icon size={16}>
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v5l3 2" />
              </Icon>
              从生成历史选择
            </button>
          </div>
        ) : null}

        <div className="cw-center-bar" role="toolbar" aria-label="画布工具">
          <button
            type="button"
            className={`cw-icon-btn cw-add-btn${addMenu ? ' is-active' : ''}`}
            title={addMenu ? '关闭' : '添加节点'}
            aria-label={addMenu ? '关闭添加菜单' : '添加节点'}
            onClick={() => {
              setAddMenu((v) => !v)
              setProjectMenu(false)
              setZoomMenu(false)
            }}
          >
            {addMenu ? (
              <Icon>
                <path d="M6 6l12 12M18 6 6 18" />
              </Icon>
            ) : (
              <Icon>
                <path d="M12 5v14M5 12h14" />
              </Icon>
            )}
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="移动"
            aria-label="移动"
            onClick={() => onNotice?.('移动：在空白处拖拽平移画布')}
          >
            {/* 三角光标样式（对齐参考工具条） */}
            <Icon>
              <path d="M5 3.5 18.5 12 11 13.8 8.2 20.5 5 3.5Z" />
            </Icon>
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="打开工具箱"
            aria-label="打开工具箱"
            onClick={() => stub('工具箱')}
          >
            <Icon>
              <path d="M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8Z" />
              <path d="M9 8V6a3 3 0 0 1 6 0v2" />
            </Icon>
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="素材库"
            aria-label="素材库"
            onClick={() => {
              setAddMenu(false)
              onOpenAssets()
            }}
          >
            <Icon>
              <path d="M12 3 4 7.5 12 12l8-4.5L12 3Z" />
              <path d="M4 12.5 12 17l8-4.5" />
              <path d="M4 16.5 12 21l8-4.5" />
            </Icon>
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="角色库"
            aria-label="角色库"
            onClick={() => stub('角色库')}
          >
            <Icon>
              <circle cx="12" cy="8" r="3.5" />
              <path d="M5.5 19a6.5 6.5 0 0 1 13 0" />
            </Icon>
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="历史记录"
            aria-label="历史记录"
            onClick={() => stub('历史记录')}
          >
            <Icon>
              <circle cx="12" cy="12" r="8" />
              <path d="M12 8v5l3 2" />
            </Icon>
          </button>
          <span className="cw-bar-divider" aria-hidden />
          <button
            type="button"
            className="cw-icon-btn"
            title="快捷键"
            aria-label="快捷键"
            onClick={() =>
              onNotice?.('快捷键：滚轮缩放 · 拖空白平移 · 右键菜单 · Esc 返回')
            }
          >
            <Icon>
              <rect x="3" y="7" width="18" height="11" rx="2" />
              <path d="M7 11h.01M12 11h.01M17 11h.01M9.5 15h5" />
            </Icon>
          </button>
          <button
            type="button"
            className="cw-icon-btn"
            title="教程"
            aria-label="教程"
            onClick={() => navigate('/')}
          >
            <Icon>
              <circle cx="12" cy="12" r="9" />
              <path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.6 1-1.6 2.3" />
              <path d="M12 17h.01" />
            </Icon>
          </button>
        </div>
      </div>
    </>
  )
}
