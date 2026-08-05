import { useMemo, useState } from 'react'
import { assetUrl } from '../api'
import type { CanvasGraphNode } from './types'
import './theme.css'

const LAYOUT_MODELS = [
  { id: 'default', label: '默认' },
  { id: 'quality', label: '高质量' },
  { id: 'fast', label: '快速' },
] as const

const SHARED_STYLES = [
  { id: 'modern_warm', label: '现代暖调' },
  { id: 'modern_minimal', label: '现代极简' },
  { id: 'natural_wood', label: '自然原木' },
  { id: 'quiet_luxury', label: '静奢暖灰' },
  { id: 'nordic', label: '北欧清新' },
  { id: 'japanese', label: '日式原木' },
] as const

const COLOR_STYLES = [
  { id: 'soft_neutral', label: '柔和中性' },
  { id: 'warm_wood', label: '暖木自然' },
  { id: 'cool_gray', label: '冷灰现代' },
  { id: 'quiet_luxury', label: '静奢暖灰' },
  { id: 'nordic_light', label: '北欧浅色' },
  { id: 'japanese_calm', label: '日式静谧' },
] as const

export type GenerateDialogMode =
  | 'layout'
  | 'color_plan'
  | 'axonometric'
  | 'space_render'
  | 'style_scheme'
  | 'tone_scheme'

type Props = {
  node: CanvasGraphNode
  mode?: GenerateDialogMode
  busy?: boolean
  initialPrompt?: string
  onCancel: () => void
  onSubmit: (payload: {
    designPrompt: string
    modelId: string
    styleId: string
  }) => void
}

const MODE_COPY: Record<
  GenerateDialogMode,
  {
    aria: string
    kicker: string
    title: string
    chips: string[]
    placeholder: string
    styleLabel: string
    styles: ReadonlyArray<{ id: string; label: string }>
    countLabel: string
    refFallback: string
  }
> = {
  layout: {
    aria: '生成平面图',
    kicker: '引用 01 结构 · 生成 02 布局',
    title: '生成平面图',
    chips: ['+ 参考', '结构图', '平面布局'],
    placeholder:
      '描述你想要的平面布局，例如：三室两厅、动线顺畅、客餐厅一体、收纳充足…',
    styleLabel: '布局样式',
    styles: SHARED_STYLES,
    countLabel: '2 方案',
    refFallback: '结构识别',
  },
  color_plan: {
    aria: '生成彩平图',
    kicker: '引用 02 布局 · 生成 03 彩平',
    title: '生成彩平图',
    chips: ['+ 参考', '布局图', '彩平着色'],
    placeholder:
      '描述彩平风格与材质意向，例如：浅木地板、暖白墙面、客餐厅一体、柔和自然光…',
    styleLabel: '彩平风格',
    styles: COLOR_STYLES,
    countLabel: '4 方案',
    refFallback: '平面布局',
  },
  axonometric: {
    aria: '生成轴侧图',
    kicker: '引用 03 彩平 · 生成 04 轴侧',
    title: '生成轴侧图',
    chips: ['+ 参考', '彩平图', '轴侧透视'],
    placeholder:
      '描述轴侧观察角度与氛围，例如：45° 鸟瞰、暖光日景、完整家具陈设…',
    styleLabel: '轴侧风格',
    styles: SHARED_STYLES,
    countLabel: '3 方案',
    refFallback: '彩平图',
  },
  space_render: {
    aria: '生成分空间效果',
    kicker: '引用上游 · 生成 05 分空间',
    title: '生成分空间',
    chips: ['+ 参考', '上游图', '分空间'],
    placeholder:
      '描述分空间效果图意向，例如：客厅主视角、落地窗采光、温馨居家氛围…',
    styleLabel: '空间风格',
    styles: SHARED_STYLES,
    countLabel: '按房间',
    refFallback: '上游方案',
  },
  style_scheme: {
    aria: '生成风格方案',
    kicker: '引用 05 分空间 · 生成 06 风格',
    title: '生成风格方案',
    chips: ['+ 参考', '分空间', '风格方案'],
    placeholder:
      '描述风格方向，例如：现代极简、原木自然、静奢暖灰、软装材质偏好…',
    styleLabel: '风格方向',
    styles: SHARED_STYLES,
    countLabel: '3 方案',
    refFallback: '分空间',
  },
  tone_scheme: {
    aria: '生成色调方案',
    kicker: '引用 06 风格 · 生成 07 色调',
    title: '生成色调方案',
    chips: ['+ 参考', '风格图', '色调方案'],
    placeholder:
      '描述色调与光感，例如：暖金日景、冷灰夜景、低饱和中性、窗边侧光…',
    styleLabel: '色调方向',
    styles: COLOR_STYLES,
    countLabel: '3 方案',
    refFallback: '风格方案',
  },
}

/**
 * 拖把线 / 生成按钮共用：引用上游节点生成下游方案
 * 视觉对齐风暴「引用节点生成」浮层：参考图 + 提示词 + 模型/样式 + 提交。
 */
export default function GenerateLayoutDialog({
  node,
  mode = 'layout',
  busy,
  initialPrompt = '',
  onCancel,
  onSubmit,
}: Props) {
  const copy = MODE_COPY[mode]
  const styles = copy.styles
  const [prompt, setPrompt] = useState(initialPrompt)
  const [modelId, setModelId] = useState<string>(LAYOUT_MODELS[0].id)
  const [styleId, setStyleId] = useState<string>(styles[0].id)

  const refUrl = useMemo(
    () => assetUrl(node.thumbnailUrl || node.url || undefined),
    [node.thumbnailUrl, node.url],
  )
  const title = (
    node.label ||
    node.variantId ||
    node.title ||
    copy.refFallback
  ).replaceAll('_', ' ')

  const canSubmit = !busy

  return (
    <div className="canvas-theme canvas-stage-overlay" onClick={onCancel}>
      <div
        className="canvas-card canvas-gen-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={copy.aria}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="canvas-gen-dialog-head">
          <div>
            <div className="canvas-gen-kicker">{copy.kicker}</div>
            <h3>{copy.title}</h3>
          </div>
          <button
            type="button"
            className="canvas-btn canvas-gen-icon-btn"
            title="关闭"
            aria-label="关闭"
            onClick={onCancel}
            disabled={busy}
          >
            ✕
          </button>
        </header>

        <div className="canvas-gen-chips" role="toolbar" aria-label="快捷标签">
          {copy.chips.map((chip) => (
            <span key={chip} className="canvas-gen-chip is-static">
              {chip}
            </span>
          ))}
        </div>

        <div className="canvas-gen-body">
          <div className="canvas-gen-ref">
            {refUrl ? (
              <img src={refUrl} alt={`参考 · ${title}`} draggable={false} />
            ) : (
              <div className="canvas-gen-ref-empty">无预览</div>
            )}
            <span className="canvas-gen-ref-badge">1</span>
            <span className="canvas-gen-ref-cap">参考 · {title}</span>
          </div>

          <textarea
            className="canvas-gen-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder={copy.placeholder}
            disabled={busy}
          />
        </div>

        <div className="canvas-gen-section">
          <span className="canvas-gen-label">生图模型</span>
          <div className="canvas-gen-pills" role="group" aria-label="生图模型">
            {LAYOUT_MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`canvas-gen-pill${modelId === m.id ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setModelId(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="canvas-gen-section">
          <span className="canvas-gen-label">{copy.styleLabel}</span>
          <div
            className="canvas-gen-pills"
            role="group"
            aria-label={copy.styleLabel}
          >
            {styles.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`canvas-gen-pill${styleId === s.id ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => setStyleId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <footer className="canvas-gen-footer">
          <div className="canvas-gen-meta">
            <span>
              {LAYOUT_MODELS.find((m) => m.id === modelId)?.label}
            </span>
            <span>·</span>
            <span>
              {styles.find((s) => s.id === styleId)?.label || styleId}
            </span>
            <span>·</span>
            <span>{copy.countLabel}</span>
          </div>
          <div className="canvas-gen-actions">
            <button
              type="button"
              className="canvas-btn"
              onClick={onCancel}
              disabled={busy}
            >
              取消
            </button>
            <button
              type="button"
              className="canvas-gen-submit"
              title="提交生成"
              aria-label="提交生成"
              disabled={!canSubmit}
              onClick={() =>
                onSubmit({
                  designPrompt: prompt.trim(),
                  modelId,
                  styleId,
                })
              }
            >
              {busy ? (
                '…'
              ) : (
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}

/** 把模型/样式写入 design_prompt，后端仅消费 design_prompt */
export function composeLayoutDesignPrompt(input: {
  designPrompt: string
  modelId: string
  styleId: string
  mode?: GenerateDialogMode
}): string {
  const mode = input.mode ?? 'layout'
  const styleList = MODE_COPY[mode].styles
  const style =
    styleList.find((s) => s.id === input.styleId)?.label || input.styleId
  const model =
    LAYOUT_MODELS.find((m) => m.id === input.modelId)?.label || input.modelId
  const parts = [
    input.designPrompt.trim(),
    style ? `风格：${style}` : '',
    model && model !== '默认' ? `模型偏好：${model}` : '',
  ].filter(Boolean)
  return parts.join('；')
}
