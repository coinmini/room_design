import { createPortal } from 'react-dom'
import type { CanvasGraphNode } from './types'
import type { SpawnTarget } from './spawnDerive'
import './theme.css'

export type SpawnMenuState = {
  x: number
  y: number
  node: CanvasGraphNode
  options: SpawnTarget[]
}

type Props = {
  menu: SpawnMenuState
  onClose: () => void
  onPick: (node: CanvasGraphNode, action: string) => void
}

/** 拖把线多项派生：引用该节点生成 */
export default function SpawnMenu({ menu, onClose, onPick }: Props) {
  return createPortal(
    <>
      <div
        className="canvas-spawn-menu-backdrop"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 10000,
          background: 'transparent',
        }}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="canvas-theme canvas-spawn-menu"
        style={{ left: menu.x, top: menu.y }}
        role="menu"
        aria-label="引用该节点生成"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="canvas-spawn-menu-title">引用该节点生成</div>
        {menu.options.map((opt) => (
          <button
            key={opt.action}
            type="button"
            role="menuitem"
            className="canvas-spawn-menu-item"
            onClick={() => {
              onClose()
              onPick(menu.node, opt.action)
            }}
          >
            <span className="canvas-spawn-menu-item-icon" aria-hidden>
              {opt.action === 'generate_axonometric' ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M12 3 3 8.5v7L12 21l9-5.5v-7L12 3Z" />
                  <path d="M12 12 3 8.5M12 12l9-3.5M12 12v9" />
                </svg>
              ) : opt.action === 'generate_space_render' ? (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <rect x="3" y="4" width="18" height="14" rx="2" />
                  <path d="M3 14h18M8 18v2M16 18v2" />
                </svg>
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                >
                  <path d="M12 5v14M5 12h14" />
                </svg>
              )}
            </span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}
