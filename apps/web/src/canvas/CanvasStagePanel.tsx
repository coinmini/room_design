import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { assetUrl } from '../api'
import type { StagePanelRequest } from '../workflow/canvasRunner'
import './theme.css'

type Props = {
  panel: StagePanelRequest
  busy?: boolean
  designPrompt: string
  onDesignPromptChange: (value: string) => void
  onCancel: () => void
  onSubmitUpload: (file: File, planWidthMm?: number, planDepthMm?: number) => void
  onSubmitSpaces: (spaceIds: string[]) => void
  onSubmitLocalEdit: (markFile: File, editPrompt: string) => void
}

const MARK_COLOR = '#FF3B30'

export default function CanvasStagePanel({
  panel,
  busy,
  designPrompt,
  onDesignPromptChange,
  onCancel,
  onSubmitUpload,
  onSubmitSpaces,
  onSubmitLocalEdit,
}: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [widthMm, setWidthMm] = useState(8150)
  const [depthMm, setDepthMm] = useState(6060)
  const [selected, setSelected] = useState<string[]>(
    panel.kind === 'space_select' ? panel.rooms.map((r) => r.id) : [],
  )
  const [editPrompt, setEditPrompt] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const imageRef = useRef<HTMLImageElement | null>(null)

  useEffect(() => {
    if (panel.kind !== 'local_edit') return
    const canvas = canvasRef.current
    if (!canvas) return
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imageRef.current = img
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
    }
    img.src = assetUrl(panel.sourceUrl)
  }, [panel])

  const paintAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const rect = canvas.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * canvas.width
    const y = ((event.clientY - rect.top) / rect.height) * canvas.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.strokeStyle = MARK_COLOR
    ctx.fillStyle = MARK_COLOR
    ctx.lineWidth = Math.max(8, canvas.width * 0.012)
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
  }

  const finishStroke = () => {
    drawing.current = false
  }

  const clearMarks = () => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0)
  }

  const composeMarkFile = async (): Promise<File | null> => {
    const canvas = canvasRef.current
    const img = imageRef.current
    if (!canvas || !img) return null
    // 导出：仅红笔层 = 当前画布与原图差分不直接做，改为整图画布（后端用红阈提取）
    // 为匹配后端「标记图」，画一张透明底 + 红笔：重绘一次只红
    // 简化：直接用当前 canvas（含底图+红笔），后端 diff 提取红区
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!blob) return null
    return new File([blob], 'mark.png', { type: 'image/png' })
  }

  return (
    <div
      className="canvas-theme"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,0,0,.55)',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
      onClick={onCancel}
    >
      <div
        className="canvas-card"
        style={{
          width: 'min(720px, 100%)',
          maxHeight: '90vh',
          overflow: 'auto',
          padding: 20,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {panel.kind === 'upload_floorplan' ? (
          <>
            <h3 style={{ margin: '0 0 8px' }}>01 上传户型图</h3>
            <p className="canvas-secondary" style={{ marginTop: 0, fontSize: 13 }}>
              上传平面图开始识别；完成后可在节点上「生成布局」。
            </p>
            <label className="canvas-btn" style={{ width: '100%', height: 44 }}>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? file.name : '选择户型图 PNG / JPG'}
            </label>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 10,
                marginTop: 12,
              }}
            >
              <label className="canvas-secondary" style={{ fontSize: 12 }}>
                面宽 mm
                <input
                  type="number"
                  value={widthMm}
                  onChange={(e) => setWidthMm(Number(e.target.value))}
                  style={inputStyle}
                />
              </label>
              <label className="canvas-secondary" style={{ fontSize: 12 }}>
                进深 mm
                <input
                  type="number"
                  value={depthMm}
                  onChange={(e) => setDepthMm(Number(e.target.value))}
                  style={inputStyle}
                />
              </label>
            </div>
            <label className="canvas-secondary" style={{ fontSize: 12, display: 'block', marginTop: 10 }}>
              设计意向（可选）
              <textarea
                value={designPrompt}
                onChange={(e) => onDesignPromptChange(e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
                placeholder="现代原木、暖光…"
              />
            </label>
            <div style={footerStyle}>
              <button type="button" className="canvas-btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="canvas-btn canvas-btn-primary"
                disabled={!file || busy}
                onClick={() => file && onSubmitUpload(file, widthMm, depthMm)}
              >
                {busy ? '识别中…' : '开始识别'}
              </button>
            </div>
          </>
        ) : null}

        {panel.kind === 'space_select' ? (
          <>
            <h3 style={{ margin: '0 0 8px' }}>05 选择分空间</h3>
            <p className="canvas-secondary" style={{ marginTop: 0, fontSize: 13 }}>
              勾选要出效果图的房间（默认全选）。
            </p>
            <div style={{ display: 'grid', gap: 8 }}>
              {panel.rooms.map((room) => {
                const checked = selected.includes(room.id)
                return (
                  <label
                    key={room.id}
                    className="canvas-card"
                    style={{
                      padding: '10px 12px',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      cursor: 'pointer',
                      borderColor: checked
                        ? 'var(--canvas-primary-border)'
                        : 'var(--canvas-border)',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelected((current) =>
                          checked
                            ? current.filter((id) => id !== room.id)
                            : [...current, room.id],
                        )
                      }
                    />
                    <span>
                      {room.name}
                      <span className="canvas-muted" style={{ marginLeft: 8 }}>
                        {room.id}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
            <label className="canvas-secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
              设计意向（可选）
              <textarea
                value={designPrompt}
                onChange={(e) => onDesignPromptChange(e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
            </label>
            <div style={footerStyle}>
              <button type="button" className="canvas-btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="canvas-btn canvas-btn-primary"
                disabled={!selected.length || busy}
                onClick={() => onSubmitSpaces(selected)}
              >
                {busy ? '生成中…' : `生成 ${selected.length} 个空间`}
              </button>
            </div>
          </>
        ) : null}

        {panel.kind === 'local_edit' ? (
          <>
            <h3 style={{ margin: '0 0 8px' }}>08 局部修改</h3>
            <p className="canvas-secondary" style={{ marginTop: 0, fontSize: 13 }}>
              用<strong style={{ color: MARK_COLOR }}>红色笔</strong>
              圈出要改的区域（闭合红圈），并填写修改说明。不是点选分割。
            </p>
            <div
              style={{
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid var(--canvas-border)',
                background: '#000',
              }}
            >
              <canvas
                ref={canvasRef}
                style={{ width: '100%', display: 'block', cursor: 'crosshair', touchAction: 'none' }}
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
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" className="canvas-btn" onClick={clearMarks}>
                清除标注
              </button>
            </div>
            <label className="canvas-secondary" style={{ fontSize: 12, display: 'block', marginTop: 12 }}>
              修改说明
              <textarea
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
                placeholder="例如：把红圈内的单椅换成浅色布艺休闲椅"
              />
            </label>
            <div style={footerStyle}>
              <button type="button" className="canvas-btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="canvas-btn canvas-btn-primary"
                disabled={!editPrompt.trim() || busy}
                onClick={async () => {
                  const mark = await composeMarkFile()
                  if (!mark) return
                  onSubmitLocalEdit(mark, editPrompt.trim())
                }}
              >
                {busy ? '生成中…' : '提交局部修改'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}

const inputStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid var(--canvas-border)',
  background: 'var(--canvas-bg)',
  color: 'var(--canvas-text)',
  font: 'inherit',
}

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 16,
}
