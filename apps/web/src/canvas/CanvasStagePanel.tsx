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
  /** 风格方案：勾选的 variant id */
  onSubmitStyles?: (variantIds: string[]) => void
  /** 色调方案：勾选的 variant id */
  onSubmitTones?: (variantIds: string[]) => void
  /** 轴侧方案：勾选的 variant id */
  onSubmitAxonometrics?: (variantIds: string[]) => void
  onSubmitLocalEdit: (markFile: File, editPrompt: string) => void
}

const MARK_COLOR = '#FF3B30'

function defaultSelectedIds(panel: StagePanelRequest): string[] {
  if (panel.kind === 'space_select') return panel.rooms.map((r) => r.id)
  if (
    panel.kind === 'style_select' ||
    panel.kind === 'tone_select' ||
    panel.kind === 'axonometric_select'
  ) {
    return panel.options.map((o) => o.id)
  }
  return []
}

export default function CanvasStagePanel({
  panel,
  busy,
  designPrompt,
  onDesignPromptChange,
  onCancel,
  onSubmitUpload,
  onSubmitSpaces,
  onSubmitStyles,
  onSubmitTones,
  onSubmitAxonometrics,
  onSubmitLocalEdit,
}: Props) {
  const [file, setFile] = useState<File | null>(null)
  /** 空 = 后端自动识别尺寸，不传 plan_width/depth_mm */
  const [widthMm, setWidthMm] = useState('')
  const [depthMm, setDepthMm] = useState('')
  const [selected, setSelected] = useState<string[]>(() =>
    defaultSelectedIds(panel),
  )
  const [editPrompt, setEditPrompt] = useState('')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const imageRef = useRef<HTMLImageElement | null>(null)

  // 面板类型/内容切换时重置勾选（默认全选）
  useEffect(() => {
    setSelected(defaultSelectedIds(panel))
  }, [panel])

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

  const selectOptions =
    panel.kind === 'space_select'
      ? panel.rooms.map((r) => ({ id: r.id, name: r.name, sub: r.id }))
      : panel.kind === 'style_select' ||
          panel.kind === 'tone_select' ||
          panel.kind === 'axonometric_select'
        ? panel.options.map((o) => ({ id: o.id, name: o.name, sub: o.id }))
        : []
  const allSelectIds = selectOptions.map((o) => o.id)
  const allSelected =
    allSelectIds.length > 0 &&
    allSelectIds.every((id) => selected.includes(id))
  const isMultiSelectPanel =
    panel.kind === 'space_select' ||
    panel.kind === 'style_select' ||
    panel.kind === 'tone_select' ||
    panel.kind === 'axonometric_select'
  /** 选择面板统一紧凑胶囊，不拉成大框 */
  const isChipSelect = isMultiSelectPanel

  const selectCopy =
    panel.kind === 'tone_select'
      ? {
          kicker: '引用 06 风格 · 生成 07 色调',
          title: '选择要生成的色调方案',
          desc: '勾选需要生成的色调。默认 3 种全选，可只生成其中 1～2 种。',
          unit: '种色调',
          placeholder: '光感、时段、冷暖倾向…',
          submit: (n: number) => `生成 ${n} 种色调`,
        }
      : panel.kind === 'style_select'
        ? {
            kicker: '引用 05 分空间 · 生成 06 风格',
            title: '选择要生成的风格方案',
            desc: '勾选需要生成的风格。默认 3 种全选，可只生成其中 1～2 种。',
            unit: '种风格',
            placeholder: '材质偏好、软装方向、色调氛围…',
            submit: (n: number) => `生成 ${n} 种风格`,
          }
        : panel.kind === 'axonometric_select'
          ? {
              kicker: '引用 03 彩平 · 生成 04 轴侧',
              title: '选择要生成的轴侧方案',
              desc: '勾选需要生成的轴侧角度。默认 3 种全选，可只生成其中 1～2 种。',
              unit: '种轴侧',
              placeholder: '日景、夜景、观察角度…',
              submit: (n: number) => `生成 ${n} 种轴侧`,
            }
          : {
              kicker: '引用上游 · 生成 05 分空间',
              title: '选择要生成的分空间',
              desc: '勾选需要出效果图的房间。默认全选，可按需只生成客厅、主卧等特定空间。',
              unit: '个空间',
              placeholder: '现代原木、暖光、简洁收纳…',
              submit: (n: number) => `生成 ${n} 个空间`,
            }

  return (
    <div
      className="canvas-theme canvas-stage-overlay"
      onClick={onCancel}
    >
      <div
        className={`canvas-card canvas-stage-dialog${
          isMultiSelectPanel ? ' is-space-select is-chip-select' : ''
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {panel.kind === 'upload_floorplan' ? (
          <>
            <h3 style={{ margin: '0 0 8px' }}>01 上传户型图</h3>
            <p className="canvas-secondary" style={{ marginTop: 0, fontSize: 13 }}>
              上传平面图开始识别；尺寸默认自动识别，完成后可在节点上「生成布局」。
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
                面宽 mm（可选）
                <input
                  type="number"
                  min={0}
                  placeholder="自动"
                  value={widthMm}
                  onChange={(e) => setWidthMm(e.target.value)}
                  style={inputStyle}
                />
              </label>
              <label className="canvas-secondary" style={{ fontSize: 12 }}>
                进深 mm（可选）
                <input
                  type="number"
                  min={0}
                  placeholder="自动"
                  value={depthMm}
                  onChange={(e) => setDepthMm(e.target.value)}
                  style={inputStyle}
                />
              </label>
            </div>
            <p className="canvas-muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
              留空则由后端按图纸标注 / 门洞家具尺度自动推算
            </p>
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
                onClick={() => {
                  if (!file) return
                  const w = Number(widthMm)
                  const d = Number(depthMm)
                  onSubmitUpload(
                    file,
                    Number.isFinite(w) && w > 0 ? w : undefined,
                    Number.isFinite(d) && d > 0 ? d : undefined,
                  )
                }}
              >
                {busy ? '识别中…' : '开始识别'}
              </button>
            </div>
          </>
        ) : null}

        {isMultiSelectPanel ? (
          <div className="canvas-space-select">
            <header className="canvas-space-select-header">
              <div>
                <div className="canvas-space-select-kicker">
                  {selectCopy.kicker}
                </div>
                <h3>{selectCopy.title}</h3>
                <p>{selectCopy.desc}</p>
              </div>
              <div className="canvas-space-select-count">
                <strong>{selected.length}</strong>
                <span>/ {selectOptions.length}</span>
              </div>
            </header>

            <div className="canvas-space-select-toolbar">
              <button
                type="button"
                className="canvas-btn"
                disabled={busy || allSelected}
                onClick={() => setSelected(allSelectIds)}
              >
                全选
              </button>
              <button
                type="button"
                className="canvas-btn"
                disabled={busy || selected.length === 0}
                onClick={() => setSelected([])}
              >
                清空
              </button>
              <span className="canvas-space-select-hint">
                已选 {selected.length} {selectCopy.unit}
              </span>
            </div>

            <div
              className={`canvas-space-select-grid${
                isChipSelect ? ' is-chip-compact' : ''
              }`}
              role="list"
            >
              {selectOptions.map((item) => {
                const checked = selected.includes(item.id)
                return (
                  <label
                    key={item.id}
                    className={`canvas-space-room${checked ? ' is-checked' : ''}`}
                    role="listitem"
                    title={
                      item.sub && item.sub !== item.name
                        ? `${item.name}（${item.sub}）`
                        : item.name
                    }
                  >
                    <input
                      type="checkbox"
                      className="canvas-space-room-check"
                      checked={checked}
                      disabled={busy}
                      onChange={() =>
                        setSelected((current) =>
                          checked
                            ? current.filter((id) => id !== item.id)
                            : [...current, item.id],
                        )
                      }
                    />
                    <span className="canvas-space-room-box" aria-hidden>
                      {checked ? '✓' : ''}
                    </span>
                    <span className="canvas-space-room-text">
                      <span className="canvas-space-room-name">{item.name}</span>
                    </span>
                  </label>
                )
              })}
            </div>

            <label className="canvas-space-select-prompt">
              <span>设计意向（可选）</span>
              <textarea
                value={designPrompt}
                onChange={(e) => onDesignPromptChange(e.target.value)}
                rows={1}
                placeholder={selectCopy.placeholder}
              />
            </label>

            <div className="canvas-space-select-footer">
              <button type="button" className="canvas-btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button
                type="button"
                className="canvas-btn canvas-btn-primary"
                disabled={!selected.length || busy}
                onClick={() => {
                  if (panel.kind === 'style_select') {
                    onSubmitStyles?.(selected)
                  } else if (panel.kind === 'tone_select') {
                    onSubmitTones?.(selected)
                  } else if (panel.kind === 'axonometric_select') {
                    onSubmitAxonometrics?.(selected)
                  } else {
                    onSubmitSpaces(selected)
                  }
                }}
              >
                {busy ? '生成中…' : selectCopy.submit(selected.length)}
              </button>
            </div>
          </div>
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
