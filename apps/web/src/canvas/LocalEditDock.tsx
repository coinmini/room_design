import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch, assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import './theme.css'

/** 纯红，满足后端 red>150 且 R-G/R-B>60 的提取阈值 */
const MARK_COLOR = '#FF2D1A'

export type LocalEditSession = {
  node: CanvasGraphNode
  sourceUrl: string
  spaceId: string
  assetId: string
  versionId: string
}

type Props = {
  session: LocalEditSession
  busy?: boolean
  onBack: () => void
  onSubmit: (markFile: File, editPrompt: string) => void
}

/**
 * 经 XHR 拉成 blob URL，避免 <img crossOrigin> 在 5173↔8000 下偶发失败，
 * 且 blob: 同源可安全 drawImage / toBlob。
 */
async function loadImageViaApi(pathOrUrl: string): Promise<{
  img: HTMLImageElement
  objectUrl: string
}> {
  const absolute = assetUrl(pathOrUrl)
  const separator = absolute.includes('?') ? '&' : '?'
  const response = await apiFetch(
    `${absolute}${separator}local_edit=${Date.now()}`,
    { cache: 'no-store' },
  )
  if (!response.ok) {
    throw new Error(`读取源图失败：HTTP ${response.status}`)
  }
  const blob = await response.blob()
  if (!blob.size) throw new Error('源图为空')
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('源图解码失败'))
      el.src = objectUrl
    })
    return { img, objectUrl }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

/**
 * 08 局部修改专注坞：对齐 01 结构编辑体验。
 * 左侧上下文 + 主区大画布红笔标注 + 修改说明，不使用居中小弹层。
 */
export default function LocalEditDock({
  session,
  busy,
  onBack,
  onSubmit,
}: Props) {
  const { node, sourceUrl, spaceId } = session
  const title = (
    node.label ||
    node.variantId ||
    node.title ||
    '色调方案'
  ).replaceAll('_', ' ')

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const objectUrlRef = useRef<string | null>(null)
  const drawing = useRef(false)
  const [editPrompt, setEditPrompt] = useState('')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  )
  const [loadError, setLoadError] = useState('')
  const [hasMarks, setHasMarks] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')

  const displayUrl = previewUrl || assetUrl(sourceUrl)

  const paintBase = useCallback(() => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadState('loading')
    setLoadError('')
    setHasMarks(false)
    imageRef.current = null
    setPreviewUrl('')

    void (async () => {
      try {
        const { img, objectUrl } = await loadImageViaApi(sourceUrl)
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = objectUrl
        imageRef.current = img
        setPreviewUrl(objectUrl)

        const canvas = canvasRef.current
        if (!canvas) {
          setLoadState('error')
          setLoadError('画布未就绪，请关闭后重试')
          return
        }
        canvas.width = img.naturalWidth || img.width
        canvas.height = img.naturalHeight || img.height
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          setLoadState('error')
          setLoadError('无法初始化画布')
          return
        }
        ctx.drawImage(img, 0, 0)
        setLoadState('ready')
      } catch (error) {
        if (cancelled) return
        setLoadState('error')
        setLoadError(
          error instanceof Error
            ? error.message
            : '源图加载失败，请检查图片是否存在',
        )
      }
    })()

    return () => {
      cancelled = true
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
    }
  }, [sourceUrl])

  const paintAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img || loadState !== 'ready') return
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.strokeStyle = MARK_COLOR
    ctx.fillStyle = MARK_COLOR
    // 稍粗：圈选闭合后更容易被形态学闭运算填满整块物体
    ctx.lineWidth = Math.max(14, canvas.width * 0.016)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (!drawing.current) {
      ctx.beginPath()
      ctx.moveTo(x, y)
      drawing.current = true
    } else {
      ctx.lineTo(x, y)
      ctx.stroke()
    }
    setHasMarks(true)
  }

  const finishStroke = () => {
    drawing.current = false
  }

  const clearMarks = () => {
    paintBase()
    setHasMarks(false)
  }

  const composeMarkFile = async (): Promise<File | null> => {
    const canvas = canvasRef.current
    if (!canvas || loadState !== 'ready') return null
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!blob) return null
    return new File([blob], 'mark.png', { type: 'image/png' })
  }

  const handleSubmit = async () => {
    const prompt = editPrompt.trim()
    if (!prompt) return
    if (!hasMarks) {
      setLoadError('请先用红色笔圈出要改的物体（尽量闭合一圈）')
      return
    }
    const mark = await composeMarkFile()
    if (!mark) {
      setLoadError('无法导出标注图，请重试')
      return
    }
    onSubmit(mark, prompt)
  }

  return (
    <div className="canvas-structure-dock canvas-local-edit-dock">
      <aside className="canvas-structure-rail">
        <div className="canvas-structure-rail-title">画布上下文</div>
        <div
          className="canvas-pill"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          阶段 08 · 局部修改
        </div>
        <p className="canvas-secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
          用<span style={{ color: MARK_COLOR, fontWeight: 700 }}>红色笔</span>
          <strong>完整圈住</strong>要改的物体（尽量闭合），修改说明需与圈选物体一致。
          例如圈住茶几就写「茶几改成深灰色」。
        </p>
        {displayUrl ? (
          <img className="canvas-structure-thumb" src={displayUrl} alt="" />
        ) : null}
        <div className="canvas-layout-detail-meta">
          <div>
            <span className="canvas-muted">来源方案</span>
            <strong>{title}</strong>
          </div>
          {spaceId ? (
            <div>
              <span className="canvas-muted">空间</span>
              <code>{spaceId}</code>
            </div>
          ) : null}
          <div>
            <span className="canvas-muted">标注</span>
            <strong style={{ color: hasMarks ? 'var(--canvas-primary)' : undefined }}>
              {hasMarks ? '已绘制' : '尚未绘制'}
            </strong>
          </div>
        </div>
        <button
          type="button"
          className="canvas-btn"
          style={{ width: '100%' }}
          onClick={onBack}
          disabled={busy}
        >
          ← 返回图谱
        </button>
        <p className="canvas-muted" style={{ fontSize: 11 }}>
          Esc 也可返回
        </p>
      </aside>

      <div className="canvas-local-edit-main">
        <header className="canvas-layout-detail-header canvas-oneline-header">
          <div className="canvas-oneline-header-left">
            <span className="canvas-oneline-kicker">08 / LOCAL EDIT</span>
            <h2 className="canvas-oneline-title" title={title}>
              {title}
            </h2>
          </div>
          <div className="canvas-oneline-header-actions">
            <button
              type="button"
              className="canvas-btn canvas-topbar-btn"
              onClick={clearMarks}
              disabled={busy || loadState !== 'ready'}
            >
              清除标注
            </button>
            <button
              type="button"
              className="canvas-btn canvas-btn-primary canvas-topbar-btn"
              disabled={
                busy ||
                loadState !== 'ready' ||
                !editPrompt.trim() ||
                !hasMarks
              }
              title={
                !hasMarks
                  ? '请先用红笔圈出要改的物体'
                  : !editPrompt.trim()
                    ? '请填写修改说明'
                    : undefined
              }
              onClick={() => void handleSubmit()}
            >
              {busy ? '提交中…' : '提交局部修改'}
            </button>
          </div>
        </header>

        <div className="canvas-local-edit-stage">
          {loadState === 'loading' ? (
            <div className="canvas-layout-detail-empty">正在载入源图…</div>
          ) : null}
          {loadState === 'error' ? (
            <div className="canvas-layout-detail-empty">
              {loadError || '源图加载失败'}
              <div style={{ marginTop: 8, fontSize: 11, opacity: 0.7 }}>
                {assetUrl(sourceUrl)}
              </div>
              <button
                type="button"
                className="canvas-btn"
                style={{ marginTop: 12 }}
                onClick={() => {
                  // 触发 effect 重载：改 key 较重，这里直接重跑 load
                  setLoadState('loading')
                  setLoadError('')
                  void loadImageViaApi(sourceUrl)
                    .then(({ img, objectUrl }) => {
                      if (objectUrlRef.current) {
                        URL.revokeObjectURL(objectUrlRef.current)
                      }
                      objectUrlRef.current = objectUrl
                      imageRef.current = img
                      setPreviewUrl(objectUrl)
                      const canvas = canvasRef.current
                      if (!canvas) throw new Error('画布未就绪')
                      canvas.width = img.naturalWidth || img.width
                      canvas.height = img.naturalHeight || img.height
                      const ctx = canvas.getContext('2d')
                      if (!ctx) throw new Error('无法初始化画布')
                      ctx.drawImage(img, 0, 0)
                      setLoadState('ready')
                    })
                    .catch((error) => {
                      setLoadState('error')
                      setLoadError(
                        error instanceof Error
                          ? error.message
                          : '源图加载失败',
                      )
                    })
                }}
              >
                重试加载
              </button>
            </div>
          ) : null}
          <canvas
            ref={canvasRef}
            className="canvas-local-edit-canvas"
            style={{
              display: loadState === 'ready' ? 'block' : 'none',
            }}
            onPointerDown={(e) => {
              drawing.current = false
              paintAt(e)
              e.currentTarget.setPointerCapture(e.pointerId)
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return
              paintAt(e)
            }}
            onPointerUp={finishStroke}
            onPointerCancel={finishStroke}
          />
        </div>

        <footer className="canvas-local-edit-footer">
          <label className="canvas-local-edit-prompt">
            <span>修改说明（必填）</span>
            <textarea
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              rows={2}
              disabled={busy}
              placeholder="例如：把红圈内的茶几改成深胡桃色 / 雾霾蓝金属质感"
            />
          </label>
          <p className="canvas-secondary" style={{ fontSize: 12, margin: 0 }}>
            提示：说明写具体颜色/材质；圈选与文字要对同一物体。提交后返回图谱生成结果。
          </p>
        </footer>
      </div>
    </div>
  )
}
