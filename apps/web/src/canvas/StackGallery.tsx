import { useEffect, useMemo, useRef, useState } from 'react'
import { assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import { isVariantApproved, normalizeStage, stageLabel } from './types'
import './theme.css'

/**
 * 一屏最多 4 张（2×2），图片尽量大。
 * 02 布局 2 张 / 03–04/06–07 约 4 张 / 05 分空间多张分页滑动。
 */
export const GALLERY_MAX_PER_PAGE = 4
export const GALLERY_COLS = 2
export const GALLERY_ROWS = 2

export type StackGalleryState = {
  stackKey: string
  items: CanvasGraphNode[]
  title?: string
}

type Props = {
  gallery: StackGalleryState
  onClose: () => void
  onSelect: (node: CanvasGraphNode) => void
}

/** 固定 2 列（2×2 一页最多 4 张） */
export function galleryGridColumns(_count: number): number {
  return GALLERY_COLS
}

export function galleryPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / GALLERY_MAX_PER_PAGE))
}

/**
 * 堆叠全屏图库：默认每屏 4 张（2×2）尽量放大；超出分页 / 滚轮翻页。
 */
export default function StackGallery({ gallery, onClose, onSelect }: Props) {
  const items = gallery.items
  const total = items.length
  const pages = galleryPageCount(total)
  const [page, setPage] = useState(0)
  const scrollerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setPage(0)
  }, [gallery.stackKey])

  const pageIndex = Math.min(page, pages - 1)
  const pageItems = useMemo(() => {
    const start = pageIndex * GALLERY_MAX_PER_PAGE
    return items.slice(start, start + GALLERY_MAX_PER_PAGE)
  }, [items, pageIndex])

  /** 固定 4 槽，保证一页内每格尺寸一致 */
  const slots = useMemo(() => {
    const list: Array<CanvasGraphNode | null> = [...pageItems]
    while (list.length < GALLERY_MAX_PER_PAGE) list.push(null)
    return list
  }, [pageItems])

  const stage = items[0] ? normalizeStage(items[0]) : 'other'
  const title =
    gallery.title || `${stageLabel(stage)} · ${total} 张`

  const goPage = (next: number) => {
    setPage(Math.max(0, Math.min(pages - 1, next)))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        goPage(pageIndex - 1)
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        event.preventDefault()
        goPage(pageIndex + 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, pageIndex, pages])

  // 滚轮 / 触控板：纵向滑动翻页（05 等多图）
  useEffect(() => {
    const el = scrollerRef.current
    if (!el || pages <= 1) return
    let acc = 0
    let locked = false
    const onWheel = (event: WheelEvent) => {
      // 主要响应纵向滑动
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX)
        ? event.deltaY
        : event.deltaX
      if (Math.abs(delta) < 4) return
      event.preventDefault()
      if (locked) return
      acc += delta
      if (Math.abs(acc) < 48) return
      const dir = acc > 0 ? 1 : -1
      acc = 0
      locked = true
      goPage(pageIndex + dir)
      window.setTimeout(() => {
        locked = false
      }, 320)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, pages])

  const rangeStart = pageIndex * GALLERY_MAX_PER_PAGE + 1
  const rangeEnd = Math.min(total, (pageIndex + 1) * GALLERY_MAX_PER_PAGE)

  return (
    <div
      className="canvas-stack-gallery"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <header className="canvas-stack-gallery-bar">
        <div className="canvas-stack-gallery-bar-inner">
          <button
            type="button"
            className="canvas-btn canvas-stack-gallery-btn"
            onClick={onClose}
          >
            ← 返回
          </button>
          <span className="canvas-pill canvas-stack-gallery-meta">
            {stageLabel(stage)} · {total} 张
            {pages > 1
              ? ` · ${rangeStart}–${rangeEnd}`
              : ` · 每屏 ${GALLERY_MAX_PER_PAGE}`}
          </span>
          <strong className="canvas-stack-gallery-title" title={title}>
            {title}
          </strong>
          <span className="canvas-stack-gallery-spacer" />
          {pages > 1 ? (
            <div className="canvas-stack-gallery-pager">
              <button
                type="button"
                className="canvas-btn canvas-stack-gallery-btn"
                disabled={pageIndex <= 0}
                onClick={() => goPage(pageIndex - 1)}
                title="上一页（滚轮也可）"
              >
                ‹
              </button>
              <span className="canvas-stack-gallery-page-num">
                {pageIndex + 1}/{pages}
              </span>
              <button
                type="button"
                className="canvas-btn canvas-stack-gallery-btn"
                disabled={pageIndex >= pages - 1}
                onClick={() => goPage(pageIndex + 1)}
                title="下一页（滚轮也可）"
              >
                ›
              </button>
            </div>
          ) : null}
          <button
            type="button"
            className="canvas-btn canvas-btn-primary canvas-stack-gallery-btn"
            onClick={onClose}
          >
            完成
          </button>
        </div>
      </header>

      <div
        ref={scrollerRef}
        className="canvas-stack-gallery-grid is-page-4"
        style={{
          gridTemplateColumns: `repeat(${GALLERY_COLS}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${GALLERY_ROWS}, minmax(0, 1fr))`,
        }}
      >
        {slots.map((item, index) => {
          if (!item) {
            return (
              <div
                key={`empty-${index}`}
                className="canvas-stack-gallery-cell is-empty"
                aria-hidden
              />
            )
          }
          const src = assetUrl(item.url || item.thumbnailUrl || undefined)
          const globalIndex = pageIndex * GALLERY_MAX_PER_PAGE + index
          const name = (
            item.label ||
            item.variantId ||
            `方案 ${globalIndex + 1}`
          ).replaceAll('_', ' ')
          const approved = isVariantApproved(item)
          return (
            <button
              key={item.id}
              type="button"
              className={`canvas-stack-gallery-cell${
                approved ? ' is-approved' : ''
              }`}
              onClick={() => onSelect(item)}
              title={`${name} · 点击打开详情`}
            >
              <div className="canvas-stack-gallery-frame">
                {src ? (
                  <img src={src} alt={name} draggable={false} />
                ) : (
                  <span className="canvas-muted">无预览</span>
                )}
                {/* 标题叠在图底，避免独立边框卡片显得拥挤 */}
                <div className="canvas-stack-gallery-caption">
                  <span className="canvas-stack-gallery-index">
                    {globalIndex + 1}/{total}
                  </span>
                  <span className="canvas-stack-gallery-name">{name}</span>
                  {approved ? (
                    <span className="canvas-stack-gallery-badge">已批准</span>
                  ) : null}
                </div>
              </div>
            </button>
          )
        })}
      </div>

      {pages > 1 ? (
        <div className="canvas-stack-gallery-dots" aria-hidden>
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              className={`canvas-stack-gallery-dot${
                i === pageIndex ? ' is-active' : ''
              }`}
              onClick={() => goPage(i)}
              title={`第 ${i + 1} 页`}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
