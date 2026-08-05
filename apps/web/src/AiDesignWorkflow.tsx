import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import {
  apiFetch,
  assetUrl,
  createAxonometricRenders,
  createColorPlanRenders,
  createLocalEditRender,
  createSpaceRenders,
  createStyleSchemeRenders,
  createToneSchemeRenders,
  cancelJob,
  pollJob,
  retryJob,
  type Job,
} from './api'
import { BatchProgress, expectedBatchCount } from './BatchProgress'
import AiLayoutStage, { type ApprovedLayoutSelection } from './AiLayoutStage'
import FloorplanModule, {
  type FloorplanStage01Approval,
  type SemanticLayout,
} from './FloorplanModule'
import WorkflowAssetPicker, {
  type WorkflowResumeBundle,
} from './WorkflowAssetPicker'
import {
  approveVariantIdempotent,
  setBaselineFromOutput,
  type VisualBaseline as ActionVisualBaseline,
} from './workflow/actions'

type GenerationStage =
  | 'color_plan'
  | 'axonometric'
  | 'space_render'
  | 'style'
  | 'tone'
  | 'local_edit'
type WorkflowActiveStage = 'annotation' | 'layout' | GenerationStage

type WorkflowStage = {
  id: string
  number: string
  title: string
  state: 'available' | 'planned'
}

type SelectOption = {
  id: string
  title: string
  description: string
}

type SpaceOption = {
  id: string
  label: string
  type?: string
}

type RenderOutput = {
  key: string
  url: string
  label: string
  hint: string
  workflowStage: string
  variantId?: string
  spaceId?: string
  // B4：重试合并时来源任务的资产 ID（审批必须落到原任务的资产上）
  assetId?: string
}

type BatchFailure = {
  id: string
  variantId?: string
  spaceId?: string
  error: string
}

type VisualBaseline = {
  stage: 'space_render' | 'style' | 'tone'
  file: File
  url: string
  assetId: string
  approvedVersionId: string
  variantId: string
  label: string
  spaceId: string
}

const workflowStages: WorkflowStage[] = [
  { id: 'annotation', number: '01', title: '功能区标注', state: 'available' },
  { id: 'layout', number: '02', title: '平面布局', state: 'available' },
  { id: 'color_plan', number: '03', title: '彩平方案', state: 'available' },
  { id: 'axonometric', number: '04', title: '轴侧方案', state: 'available' },
  { id: 'space_render', number: '05', title: '空间效果', state: 'available' },
  { id: 'style', number: '06', title: '风格方案', state: 'available' },
  { id: 'tone', number: '07', title: '色调方案', state: 'available' },
  { id: 'local_edit', number: '08', title: '局部修改', state: 'available' },
]

function isGenerationStage(stage: WorkflowActiveStage): stage is GenerationStage {
  return [
    'color_plan',
    'axonometric',
    'space_render',
    'style',
    'tone',
    'local_edit',
  ].includes(stage)
}

function semanticForApprovedLayout(
  value: string,
  selection: ApprovedLayoutSelection,
): string {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const canonical =
      parsed.semanticLayout && typeof parsed.semanticLayout === 'object'
        ? (parsed.semanticLayout as Record<string, unknown>)
        : parsed.semantic_layout && typeof parsed.semantic_layout === 'object'
          ? (parsed.semantic_layout as Record<string, unknown>)
          : parsed
    return JSON.stringify(
      {
        ...canonical,
        furniture: [],
        validation: {
          ...(canonical.validation && typeof canonical.validation === 'object'
            ? (canonical.validation as Record<string, unknown>)
            : {}),
          status: 'human_confirmed',
          humanConfirmed: true,
          furnitureAuthority: 'approved_layout_image',
          approvedLayoutId: selection.layoutId,
          approvedLayoutAssetId: selection.assetId,
        },
      },
      null,
      2,
    )
  } catch {
    return value
  }
}

const colorPlanOptions: SelectOption[] = [
  {
    id: 'simple_2d',
    title: '简洁彩平',
    description: '清晰表达房间、家具与绿化关系',
  },
  {
    id: 'topdown_3d',
    title: '照片级 3D 俯视',
    description: '写实灯光与软装的正交俯视表现',
  },
  {
    id: 'watercolor',
    title: '水彩手绘',
    description: '适合概念沟通的轻质感表达',
  },
  {
    id: 'material_realistic',
    title: '写实材质彩平',
    description: '突出地面、墙面和家具材质',
  },
]

const axonometricOptions: SelectOption[] = [
  {
    id: 'isometric_day',
    title: '日景轴侧',
    description: '自然日光下的等轴测剖切视图',
  },
  {
    id: 'isometric_night',
    title: '夜景轴侧',
    description: '室内灯光开启的夜间氛围图',
  },
  {
    id: 'alternate_angle',
    title: '另一观察角度',
    description: '在保持布局的前提下切换观察方向',
  },
]

const styleSchemeOptions: SelectOption[] = [
  {
    id: 'modern_minimal',
    title: '现代极简',
    description: '黑白灰画廊感，哑光黑金属，无木色无装饰',
  },
  {
    id: 'natural_wood',
    title: '日式原木',
    description: '浅橡木、棉麻与纸灯，明亮温润的 Japandi',
  },
  {
    id: 'midcentury_vintage',
    title: '中古复古',
    description: '深胡桃木、焦糖皮革与橄榄绿撞色，浓郁厚重',
  },
  {
    id: 'french_luxury',
    title: '法式轻奢',
    description: '奶油墙板线脚、大理石与黄铜，精致典雅',
  },
]

const toneSchemeOptions: SelectOption[] = [
  {
    id: 'warm_gold_day',
    title: '暖金日景',
    description: '自然日光与暖金反射，呈现舒适明亮的白天氛围',
  },
  {
    id: 'neutral_dusk',
    title: '中性暮色',
    description: '平衡自然余晖和室内灯光，色彩克制稳定',
  },
  {
    id: 'cool_blue_night',
    title: '冷蓝夜景',
    description: '冷蓝环境光与暖色灯具对比，形成夜间层次',
  },
]

const derivativeVariantLabels = new Map(
  [...styleSchemeOptions, ...toneSchemeOptions].map((option) => [
    option.id,
    option.title,
  ]),
)

const stageTitles: Record<GenerationStage, string> = {
  color_plan: '03 彩平方案',
  axonometric: '04 轴侧方案',
  space_render: '05 分空间效果图',
  style: '06 同空间风格方案',
  tone: '07 同空间色调方案',
  local_edit: '08 局部修改',
}

const workflowStageLabels: Record<string, string> = {
  color_plan: 'STAGE 03 · COLOR PLAN',
  axonometric: 'STAGE 04 · AXONOMETRIC',
  space_render: 'STAGE 05 · SPACE RENDER',
  style: 'STAGE 06 · STYLE SCHEME',
  style_scheme: 'STAGE 06 · STYLE SCHEME',
  tone: 'STAGE 07 · TONE SCHEME',
  tone_scheme: 'STAGE 07 · TONE SCHEME',
  local_edit: 'STAGE 08 · LOCAL EDIT',
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  return '任务执行失败'
}

function apiError(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item) {
          return String(item.msg)
        }
        return String(item)
      })
      .join('；')
  }
  return `请求失败：${status}`
}

function imageFileExtension(blob: Blob): string {
  if (blob.type.includes('jpeg')) return 'jpg'
  if (blob.type.includes('webp')) return 'webp'
  return 'png'
}

async function workflowAssetImageFile(
  url: string | null | undefined,
  name: string,
): Promise<File> {
  if (!url) throw new Error(`资产缺少${name}图片，无法恢复工作流。`)
  // The same artifact is normally already visible as an <img> thumbnail in
  // the picker. Chromium may otherwise reuse that no-CORS image-cache entry
  // for this XHR and report a network error before a request reaches the API.
  // A cache-busting query forces a fresh CORS-enabled response whose bytes can
  // safely be wrapped as the File required by the multipart workflow APIs.
  const separator = url.includes('?') ? '&' : '?'
  const response = await apiFetch(
    `${url}${separator}workflow_restore=${Date.now()}`,
    { cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`读取${name}图片失败：${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error(`${name}图片为空，无法恢复工作流。`)
  return new File([blob], `${name}.${imageFileExtension(blob)}`, {
    type: blob.type || 'image/png',
  })
}

function useFilePreview(file: File | null) {
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : ''), [file])

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview)
    }
  }, [preview])

  return preview
}

type AnnotatorPoint = { x: number; y: number }

type AnnotatorStroke = {
  size: number
  points: AnnotatorPoint[]
}

type LocalEditAnnotatorHandle = {
  hasMarks: () => boolean
  composeMarkFile: () => Promise<File | null>
  clear: () => void
}

const ANNOTATION_MARK_COLOR = '#FF3B30'
const ANNOTATION_BRUSHES = [
  { id: 's', label: '细', ratio: 0.016 },
  { id: 'm', label: '中', ratio: 0.032 },
  { id: 'l', label: '粗', ratio: 0.06 },
] as const

/**
 * Canvas tool for stage 08: paint red marks over the approved tone image to
 * tell the AI which regions to edit. Strokes are stored in original-image
 * pixel coordinates so the composed mark file matches the source resolution.
 */
const LocalEditAnnotator = forwardRef<
  LocalEditAnnotatorHandle,
  { imageUrl: string; onDirtyChange: (dirty: boolean) => void }
>(function LocalEditAnnotator({ imageUrl, onDirtyChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const strokesRef = useRef<AnnotatorStroke[]>([])
  const draftRef = useRef<AnnotatorStroke | null>(null)
  const drawingRef = useRef(false)
  const [imageReady, setImageReady] = useState(false)
  const [strokeCount, setStrokeCount] = useState(0)
  const [brush, setBrush] = useState<(typeof ANNOTATION_BRUSHES)[number]['id']>('m')

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const context = canvas.getContext('2d')
    if (!context) return
    const toDisplay = canvas.width / image.naturalWidth
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    context.strokeStyle = ANNOTATION_MARK_COLOR
    context.fillStyle = ANNOTATION_MARK_COLOR
    context.lineCap = 'round'
    context.lineJoin = 'round'
    const paint = (stroke: AnnotatorStroke) => {
      if (!stroke.points.length) return
      const first = stroke.points[0]
      if (stroke.points.length === 1) {
        context.beginPath()
        context.arc(
          first.x * toDisplay,
          first.y * toDisplay,
          (stroke.size * toDisplay) / 2,
          0,
          Math.PI * 2,
        )
        context.fill()
        return
      }
      context.lineWidth = Math.max(2, stroke.size * toDisplay)
      context.beginPath()
      context.moveTo(first.x * toDisplay, first.y * toDisplay)
      stroke.points.slice(1).forEach((point) => {
        context.lineTo(point.x * toDisplay, point.y * toDisplay)
      })
      context.stroke()
    }
    strokesRef.current.forEach(paint)
    if (draftRef.current) paint(draftRef.current)
  }, [])

  useEffect(() => {
    setImageReady(false)
    strokesRef.current = []
    draftRef.current = null
    setStrokeCount(0)
    onDirtyChange(false)
    const image = new Image()
    image.onload = () => {
      imageRef.current = image
      const canvas = canvasRef.current
      if (canvas) {
        canvas.width = 960
        canvas.height = Math.round(
          (960 * image.naturalHeight) / Math.max(1, image.naturalWidth),
        )
        redraw()
      }
      setImageReady(true)
    }
    image.src = imageUrl
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl])

  useEffect(() => {
    redraw()
  }, [strokeCount, redraw])

  const brushSize = () => {
    const image = imageRef.current
    if (!image) return 32
    const preset =
      ANNOTATION_BRUSHES.find((item) => item.id === brush) ?? ANNOTATION_BRUSHES[1]
    return Math.max(6, Math.round(image.naturalWidth * preset.ratio))
  }

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const image = imageRef.current!
    const bounds = canvas.getBoundingClientRect()
    const scale = image.naturalWidth / bounds.width
    return {
      x: Math.min(Math.max(0, (event.clientX - bounds.left) * scale), image.naturalWidth),
      y: Math.min(Math.max(0, (event.clientY - bounds.top) * scale), image.naturalHeight),
    }
  }

  const finishStroke = () => {
    drawingRef.current = false
    const draft = draftRef.current
    draftRef.current = null
    if (draft && draft.points.length) {
      strokesRef.current = [...strokesRef.current, draft]
      setStrokeCount(strokesRef.current.length)
      onDirtyChange(true)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!imageReady) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drawingRef.current = true
    draftRef.current = { size: brushSize(), points: [pointFromEvent(event)] }
    redraw()
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !draftRef.current) return
    draftRef.current.points.push(pointFromEvent(event))
    redraw()
  }

  const undoStroke = () => {
    strokesRef.current = strokesRef.current.slice(0, -1)
    setStrokeCount(strokesRef.current.length)
    onDirtyChange(strokesRef.current.length > 0)
  }

  const clearStrokes = useCallback(() => {
    strokesRef.current = []
    draftRef.current = null
    setStrokeCount(0)
    onDirtyChange(false)
    redraw()
  }, [onDirtyChange, redraw])

  const composeMarkFile = useCallback(async (): Promise<File | null> => {
    const image = imageRef.current
    if (!image || !strokesRef.current.length) return null
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0)
    context.strokeStyle = ANNOTATION_MARK_COLOR
    context.fillStyle = ANNOTATION_MARK_COLOR
    context.lineCap = 'round'
    context.lineJoin = 'round'
    strokesRef.current.forEach((stroke) => {
      const first = stroke.points[0]
      if (!first) return
      if (stroke.points.length === 1) {
        context.beginPath()
        context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2)
        context.fill()
        return
      }
      context.lineWidth = stroke.size
      context.beginPath()
      context.moveTo(first.x, first.y)
      stroke.points.slice(1).forEach((point) => context.lineTo(point.x, point.y))
      context.stroke()
    })
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    )
    if (!blob) return null
    return new File([blob], 'local-edit-marks.png', { type: 'image/png' })
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      hasMarks: () => strokesRef.current.length > 0,
      composeMarkFile,
      clear: clearStrokes,
    }),
    [composeMarkFile, clearStrokes],
  )

  return (
    <div className="workflow-annotator">
      <div className="workflow-annotator-toolbar">
        <span className="annotator-label">标记画笔</span>
        {ANNOTATION_BRUSHES.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`annotator-brush ${brush === item.id ? 'active' : ''}`}
            onClick={() => setBrush(item.id)}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          className="annotator-action"
          disabled={!strokeCount}
          onClick={undoStroke}
        >
          撤销一笔
        </button>
        <button
          type="button"
          className="annotator-action"
          disabled={!strokeCount}
          onClick={clearStrokes}
        >
          清除标记
        </button>
        <span className="annotator-count">
          {strokeCount ? `已标记 ${strokeCount} 笔` : '尚未标记'}
        </span>
      </div>
      <div className="workflow-annotator-stage">
        <canvas
          ref={canvasRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          onPointerLeave={finishStroke}
        />
      </div>
    </div>
  )
})

function parseSemanticRooms(value: string): SpaceOption[] {
  if (!value.trim()) return []
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const root =
      parsed.semanticLayout && typeof parsed.semanticLayout === 'object'
        ? (parsed.semanticLayout as Record<string, unknown>)
        : parsed
    if (!Array.isArray(root.rooms)) return []
    return root.rooms.flatMap((room, index) => {
      if (!room || typeof room !== 'object') return []
      const record = room as Record<string, unknown>
      const id = String(record.id ?? `room_${index + 1}`)
      const label = String(
        record.name ??
          record.label ??
          record.displayName ??
          record.roomType ??
          record.type ??
          `空间 ${index + 1}`,
      )
      return [{ id, label, type: String(record.roomType ?? record.type ?? '') }]
    })
  } catch {
    return []
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function collectRenderOutputs(
  result: Record<string, unknown> | null,
  stage: GenerationStage,
): RenderOutput[] {
  if (!result) return []
  const outputs: RenderOutput[] = []
  const seen = new Set<string>()
  const rootWorkflowStage =
    typeof result.workflowStage === 'string' ? result.workflowStage : stage

  const visit = (value: unknown, fallbackLabel: string, key: string) => {
    if (typeof value === 'string') {
      const isUrl = /^(https?:\/\/|data:image\/|\/)/.test(value.trim())
      if (!isUrl || seen.has(value)) return
      seen.add(value)
      outputs.push({
        key,
        url: value,
        label: fallbackLabel,
        hint: workflowStageLabels[rootWorkflowStage] ?? rootWorkflowStage,
        workflowStage: rootWorkflowStage,
      })
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        visit(item, `${fallbackLabel} ${index + 1}`, `${key}-${index}`),
      )
      return
    }
    const record = recordValue(value)
    if (!Object.keys(record).length) return
    if (
      record.status === 'failed' ||
      typeof record.errorMessage === 'string' ||
      typeof record.error === 'string'
    ) {
      return
    }
    const urlKeys = [
      'url',
      'imageUrl',
      'outputUrl',
      'previewUrl',
      'finalImageUrl',
      'thumbnailUrl',
    ]
    const url = urlKeys
      .map((urlKey) => record[urlKey])
      .find((candidate): candidate is string =>
        Boolean(typeof candidate === 'string' && candidate.trim()),
      )
    if (url) {
      const rawLabel = String(
        record.label ??
          record.title ??
          record.spaceName ??
          record.variantLabel ??
          record.styleId ??
          record.toneId ??
          record.variantId ??
          record.variant ??
          record.style ??
          fallbackLabel,
      )
      const label =
        derivativeVariantLabels.get(rawLabel) ??
        derivativeVariantLabels.get(
          rawLabel.replace(/^style_/, '').replace(/^tone_/, ''),
        ) ??
        rawLabel
      const outputStage = String(record.workflowStage ?? rootWorkflowStage)
      if (!seen.has(url)) {
        seen.add(url)
        outputs.push({
          key,
          url,
          label,
          hint: workflowStageLabels[outputStage] ?? outputStage,
          workflowStage: outputStage,
          variantId:
            typeof record.variantId === 'string' ? record.variantId : undefined,
          spaceId: typeof record.spaceId === 'string' ? record.spaceId : undefined,
          assetId:
            typeof record.originAssetId === 'string'
              ? record.originAssetId
              : undefined,
        })
      }
      return
    }
    Object.entries(record).forEach(([nestedKey, nested]) =>
      visit(nested, nestedKey.replaceAll('_', ' '), `${key}-${nestedKey}`),
    )
  }

  const candidateKeys = [
    'outputs',
    'renders',
    'images',
    'variants',
    'outputUrls',
    'renderUrls',
    'deliverables',
  ]
  candidateKeys.forEach((key) => visit(result[key], stageTitles[stage], key))
  if (!outputs.length) visit(result, stageTitles[stage], 'result')
  return outputs
}

function batchFailures(
  result: Record<string, unknown> | null,
  stage: GenerationStage,
): BatchFailure[] {
  if (!result || !Array.isArray(result.outputs)) return []
  return result.outputs.flatMap((value, index) => {
    const record = recordValue(value)
    const isFailure =
      record.status === 'failed' ||
      typeof record.errorMessage === 'string' ||
      typeof record.error === 'string'
    if (!isFailure) return []
    const variantId =
      typeof record.variantId === 'string' ? record.variantId : undefined
    const spaceId = typeof record.spaceId === 'string' ? record.spaceId : undefined
    const id =
      stage === 'space_render'
        ? (spaceId ?? variantId?.replace(/^space_/, '') ?? `space_${index + 1}`)
        : (variantId ?? `variant_${index + 1}`)
    return [
      {
        id,
        variantId,
        spaceId,
        error: String(
          record.errorMessage ?? record.error ?? record.errorCode ?? '生成失败',
        ),
      },
    ]
  })
}

function BatchNotice({
  result,
  stage,
  onRetry,
  busy = false,
}: {
  result: Record<string, unknown> | null
  stage: GenerationStage
  onRetry?: (ids: string[]) => void
  busy?: boolean
}) {
  if (!result) return null
  const failures = batchFailures(result, stage)
  const failedCount =
    typeof result.failedCount === 'number' ? result.failedCount : failures.length
  const batchStatus =
    typeof result.batchStatus === 'string' ? result.batchStatus : undefined

  if (batchStatus === 'complete' && failedCount === 0) {
    return (
      <div className="workflow-batch-notice is-complete">
        <strong>✓ 本批次全部生成完成</strong>
        <span>所有结果均已返回，仍需人工核对后进入下一阶段。</span>
      </div>
    )
  }
  if (!failedCount && !['partial', 'failed'].includes(batchStatus ?? '')) {
    return null
  }
  return (
    <div className="workflow-batch-notice is-warning">
      <div>
        <strong>
          {batchStatus === 'failed' ? '本批次全部失败' : '本批次部分完成'}
        </strong>
        <span>{failedCount} 项未生成成功，已成功的图片仍会保留。</span>
      </div>
      {failures.length > 0 && (
        <ul>
          {failures.map((failure) => (
            <li key={`${failure.id}-${failure.error}`}>
              <code>{failure.spaceId ?? failure.variantId ?? failure.id}</code>
              <span>{failure.error}</span>
            </li>
          ))}
        </ul>
      )}
      {onRetry && failures.length > 0 && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onRetry(failures.map((item) => item.id))}
        >
          仅重试失败项
        </button>
      )}
    </div>
  )
}

function toggleSelection(
  value: string,
  selected: string[],
  setSelected: (next: string[]) => void,
) {
  setSelected(
    selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value],
  )
}

function withoutStageJobs(
  jobs: Partial<Record<GenerationStage, Job>>,
  stages: GenerationStage[],
) {
  const next = { ...jobs }
  stages.forEach((stage) => delete next[stage])
  return next
}

function withoutStageErrors(
  errors: Partial<Record<GenerationStage, string>>,
  stages: GenerationStage[],
) {
  const next = { ...errors }
  stages.forEach((stage) => delete next[stage])
  return next
}

// B4：「仅重试失败项」产生的新任务只含重跑变体；把上一批已成功的输出
// 按 variantId 合并回来，避免画廊里 3 张已成功的图凭空消失且无法批准。
// 合并进来的输出带 originAssetId，审批时必须落到原任务的资产上。
function mergeRetryResult(previousJob: Job | undefined, nextJob: Job): Job {
  const previousResult = previousJob?.result ?? null
  const nextResult = nextJob.result ?? null
  if (!previousResult || !nextResult) return nextJob
  const previousOutputs = Array.isArray(previousResult.outputs)
    ? previousResult.outputs
    : []
  const nextOutputs = Array.isArray(nextResult.outputs) ? nextResult.outputs : []
  if (!previousOutputs.length) return nextJob
  const nextVariantIds = new Set(
    nextOutputs.map((item) => String(recordValue(item).variantId ?? '')),
  )
  const previousAssetId =
    typeof previousResult.assetId === 'string' ? previousResult.assetId : undefined
  const carried = previousOutputs
    .map(recordValue)
    .filter(
      (item) =>
        item.status === 'succeeded' &&
        !nextVariantIds.has(String(item.variantId ?? '')),
    )
    .map((item) => ({ ...item, originAssetId: previousAssetId }))
  if (!carried.length) return nextJob
  const mergedOutputs = [...carried, ...nextOutputs]
  const succeededCount = mergedOutputs.filter(
    (item) => recordValue(item).status === 'succeeded',
  ).length
  const failedCount = mergedOutputs.filter(
    (item) => recordValue(item).status === 'failed',
  ).length
  return {
    ...nextJob,
    result: {
      ...nextResult,
      outputs: mergedOutputs,
      count: mergedOutputs.length,
      succeededCount,
      failedCount,
      batchStatus: failedCount
        ? succeededCount
          ? 'partial'
          : 'failed'
        : nextResult.batchStatus === 'running'
          ? 'running'
          : 'complete',
      mergedFromRetry: true,
    },
  }
}

function JobState({ job, busy }: { job: Job | null; busy: boolean }) {
  if (!job && !busy) return null
  const state = job?.status ?? 'QUEUED'
  return (
    <span className={`workflow-job-state is-${state.toLowerCase()}`}>
      <i />
      {busy && state === 'QUEUED' ? '任务已提交' : state}
    </span>
  )
}

const stageDurationEstimates: Partial<Record<GenerationStage, string>> = {
  color_plan: '通常需要 2-4 分钟',
  axonometric: '通常需要 2-3 分钟',
  space_render: '通常需要 3-6 分钟',
  style: '通常需要 2-3 分钟',
  tone: '通常需要 2-3 分钟',
  local_edit: '通常需要 1-2 分钟',
}

function ResultGallery({
  job,
  stage,
  busy,
  onApproveOutput,
  onSelectBaseline,
  onRetryFailures,
  onRetryJob,
  approvingVariantId,
  approvedVariantId,
  selectingBaselineKey,
  selectedBaselineKey,
  baselineActionLabel = '设为后续基准',
}: {
  job: Job | null
  stage: GenerationStage
  busy: boolean
  onApproveOutput?: (output: RenderOutput) => void
  onSelectBaseline?: (output: RenderOutput) => void
  onRetryFailures?: (ids: string[]) => void
  onRetryJob?: () => void
  approvingVariantId?: string
  approvedVariantId?: string
  selectingBaselineKey?: string
  selectedBaselineKey?: string
  baselineActionLabel?: string
}) {
  const result = job?.result ?? null
  const outputs = collectRenderOutputs(result, stage)
  // 批次仍在运行时只允许预览，不允许审批/设基准（部分结果尚无最终 assetId）
  const batchFinalized = job?.status === 'SUCCEEDED'
  const batchNotice = (
    <BatchNotice
      result={result}
      stage={stage}
      onRetry={onRetryFailures}
      busy={busy}
    />
  )

  if (!job) {
    return (
      <>
        {batchNotice}
        <div className="workflow-empty-result">
          <span>{workflowStages.find((item) => item.id === stage)?.number}</span>
          <h3>等待生成{stageTitles[stage].slice(3)}</h3>
          <p>结果会按当前阶段归档，可以在“我的资产”中继续浏览历史版本。</p>
        </div>
      </>
    )
  }

  if (busy && !outputs.length) {
    return (
      <>
        {batchNotice}
        <BatchProgress job={job} estimate={stageDurationEstimates[stage]} />
        <div className="workflow-empty-result is-running">
          <span>AI</span>
          <h3>正在生成多个方案</h3>
          <p>任务仍在后台执行，每张图完成就会立即显示在这里。</p>
        </div>
      </>
    )
  }

  if (!outputs.length && ['FAILED', 'CANCELED'].includes(job.status)) {
    const workerLost = job.errorCode === 'WORKER_LOST'
    return (
      <>
        {batchNotice}
        <div className="workflow-empty-result is-failed">
          <span>!</span>
          <h3>
            {workerLost
              ? '服务重启，任务被中断'
              : job.status === 'FAILED'
                ? '本次生成失败'
                : '本次任务已取消'}
          </h3>
          <p>{job.errorMessage ?? '请检查输入与服务状态后重新生成。'}</p>
          {workerLost && onRetryJob && (
            <button type="button" disabled={busy} onClick={onRetryJob}>
              {busy ? '正在重试…' : '一键重试'}
            </button>
          )}
        </div>
      </>
    )
  }

  if (!outputs.length && ['QUEUED', 'RUNNING'].includes(job.status)) {
    return (
      <>
        {batchNotice}
        <BatchProgress job={job} estimate={stageDurationEstimates[stage]} />
        <div className="workflow-empty-result is-running">
          <span>AI</span>
          <h3>后台任务仍在执行</h3>
          <p>页面等待可能已经结束，但任务没有被取消，可以继续等待同一任务。</p>
        </div>
      </>
    )
  }

  if (!outputs.length) {
    return (
      <>
        {batchNotice}
        <div className="workflow-empty-result">
          <span>✓</span>
          <h3>任务已经完成并归档</h3>
          <p>接口未返回可直接预览的图片字段，请到“我的资产”查看本次记录。</p>
        </div>
      </>
    )
  }

  return (
    <>
      {batchNotice}
      <BatchProgress
        job={job}
        doneCount={outputs.length}
        estimate={stageDurationEstimates[stage]}
        hint="先出图的会立即显示，全部完成后才能审批或设为基准。"
      />
      {job?.status === 'FAILED' && job.errorCode === 'WORKER_LOST' && onRetryJob && (
        <div className="workflow-empty-result is-failed" style={{ padding: '12px 16px', marginBottom: 12 }}>
          <p>服务重启导致任务中断，以下仅是中断前已生成的部分结果，不能审批；建议重试整批。</p>
          <button type="button" disabled={busy} onClick={onRetryJob}>
            {busy ? '正在重试…' : '一键重试'}
          </button>
        </div>
      )}
      <div className="workflow-result-grid">
        {outputs.map((output) => (
        <article className="workflow-result-card" key={`${output.key}-${output.url}`}>
          <div>
            <span>{output.hint}</span>
            <strong>{output.label}</strong>
          </div>
          <img src={assetUrl(output.url)} alt={output.label} />
          <footer>
            <span>{output.workflowStage.replaceAll('_', ' ')}</span>
            <div>
              {onApproveOutput && batchFinalized && (
                <button
                  type="button"
                  disabled={Boolean(approvingVariantId)}
                  onClick={() => onApproveOutput(output)}
                >
                  {approvingVariantId === output.variantId
                      ? '正在审批…'
                      : approvedVariantId === output.variantId
                        ? '✓ 已批准为基准'
                        : '设为批准彩平'}
                </button>
              )}
              {onSelectBaseline && output.variantId && batchFinalized && (
                <button
                  type="button"
                  disabled={Boolean(selectingBaselineKey)}
                  onClick={() => onSelectBaseline(output)}
                >
                  {selectingBaselineKey === `${stage}:${output.variantId}`
                    ? '正在设置…'
                    : selectedBaselineKey === `${stage}:${output.variantId}`
                      ? '✓ 已设为基准'
                      : baselineActionLabel}
                </button>
              )}
              <a href={assetUrl(output.url)} target="_blank" rel="noreferrer" download>
                打开原图
              </a>
            </div>
          </footer>
        </article>
        ))}
        {job && ['QUEUED', 'RUNNING'].includes(job.status) &&
          Array.from({
            length: Math.max(0, expectedBatchCount(job) - outputs.length),
          }).map((_, index) => (
            <article
              className="workflow-result-card is-skeleton"
              key={`skeleton-${index}`}
            >
              <div>
                <span>AI</span>
                <strong>方案生成中…</strong>
              </div>
              <div className="workflow-skeleton-image" />
              <footer>
                <span>等待图片返回</span>
              </footer>
            </article>
          ))}
      </div>
    </>
  )
}

export default function AiDesignWorkflow() {
  const [activeStage, setActiveStage] =
    useState<WorkflowActiveStage>('annotation')
  const [structureSourceImage, setStructureSourceImage] =
    useState<File | null>(null)
  const [stageOneRevision, setStageOneRevision] = useState(0)
  const [stageOneApproved, setStageOneApproved] = useState(false)
  const [stageOneApproval, setStageOneApproval] =
    useState<FloorplanStage01Approval | null>(null)
  const [stageOneSemanticLayout, setStageOneSemanticLayout] = useState('')
  const [stageOneWidthMm, setStageOneWidthMm] = useState(8150)
  const [stageOneDepthMm, setStageOneDepthMm] = useState(6060)
  const [layoutImage, setLayoutImage] = useState<File | null>(null)
  const [layoutApproved, setLayoutApproved] = useState(false)
  const [approvedColorPlanImage, setApprovedColorPlanImage] =
    useState<File | null>(null)
  const [styleReferences, setStyleReferences] = useState<File[]>([])
  const [semanticLayout, setSemanticLayout] = useState('')
  const [projectId, setProjectId] = useState('')
  const [layoutParentAssetId, setLayoutParentAssetId] = useState('')
  const [approvedColorPlanAssetId, setApprovedColorPlanAssetId] = useState('')
  const [approvedLayoutVersionId, setApprovedLayoutVersionId] = useState('')
  const [designPrompt, setDesignPrompt] = useState('')
  const [viewPreset, setViewPreset] = useState('eye_level_wide')
  const [semanticError, setSemanticError] = useState('')
  const [colorVariants, setColorVariants] = useState(
    colorPlanOptions.map((option) => option.id),
  )
  const [axonometricVariants, setAxonometricVariants] = useState(
    axonometricOptions.map((option) => option.id),
  )
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<string[]>([])
  const [styleVariants, setStyleVariants] = useState(
    styleSchemeOptions.slice(0, 3).map((option) => option.id),
  )
  const [toneVariants, setToneVariants] = useState(
    toneSchemeOptions.map((option) => option.id),
  )
  const [spaceBaseline, setSpaceBaseline] = useState<VisualBaseline | null>(null)
  const [styleBaseline, setStyleBaseline] = useState<VisualBaseline | null>(null)
  const [toneBaseline, setToneBaseline] = useState<VisualBaseline | null>(null)
  const localEditAnnotatorRef = useRef<LocalEditAnnotatorHandle | null>(null)
  /** W3-2：AbortController 按 jobId 管理（替代单一 ref，修并发 finally 误清） */
  const pollAbortMapRef = useRef<Map<string, AbortController>>(new Map())
  const [annotationDirty, setAnnotationDirty] = useState(false)
  const [localEditPrompt, setLocalEditPrompt] = useState('')
  /** W3-2：保留 stage→Job 供向导 UI；同时 busyJobIds 支持多任务 */
  const [jobs, setJobs] = useState<Partial<Record<GenerationStage, Job>>>({})
  const [jobByNodeId, setJobByNodeId] = useState<Map<string, Job>>(() => new Map())
  const [errors, setErrors] = useState<Partial<Record<GenerationStage, string>>>(
    {},
  )
  const [busyJobIds, setBusyJobIds] = useState<Set<string>>(() => new Set())
  const [busyStage, setBusyStage] = useState<GenerationStage | null>(null)
  // 暴露给调试 / 后续画布并发接线，避免 noUnusedLocals
  void jobByNodeId
  void busyJobIds
  const [approvingVariantId, setApprovingVariantId] = useState('')
  const [approvedVariantId, setApprovedVariantId] = useState('')
  const [approvalNotice, setApprovalNotice] = useState('')
  const [selectingBaselineKey, setSelectingBaselineKey] = useState('')

  const activeGenerationStage = isGenerationStage(activeStage)
    ? activeStage
    : null
  const layoutPreview = useFilePreview(layoutImage)
  const colorPlanPreview = useFilePreview(approvedColorPlanImage)
  const spaceBaselinePreview = useFilePreview(spaceBaseline?.file ?? null)
  const styleBaselinePreview = useFilePreview(styleBaseline?.file ?? null)
  const toneBaselinePreview = useFilePreview(toneBaseline?.file ?? null)
  const downstreamSourceBaseline =
    activeGenerationStage === 'style'
      ? spaceBaseline
      : activeGenerationStage === 'tone'
        ? styleBaseline
        : activeGenerationStage === 'local_edit'
          ? toneBaseline
          : null
  const downstreamSourcePreview =
    activeGenerationStage === 'style'
      ? spaceBaselinePreview
      : activeGenerationStage === 'tone'
        ? styleBaselinePreview
        : activeGenerationStage === 'local_edit'
          ? toneBaselinePreview
          : ''
  const semanticSpaces = useMemo(
    () => parseSemanticRooms(semanticLayout),
    [semanticLayout],
  )
  const spaceOptions = semanticSpaces
  const activeJob = activeGenerationStage
    ? (jobs[activeGenerationStage] ?? null)
    : null
  const hasSpaceRenderOutputs =
    collectRenderOutputs(jobs.space_render?.result ?? null, 'space_render').length > 0

  useEffect(() => {
    if (!semanticSpaces.length) {
      setSelectedSpaceIds([])
      return
    }
    setSelectedSpaceIds((current) => {
      const validIds = new Set(semanticSpaces.map((space) => space.id))
      const stillValid = current.filter((id) => validIds.has(id))
      return stillValid.length
        ? stillValid
        : semanticSpaces.map((space) => space.id)
    })
  }, [semanticSpaces])

  const invalidateFromSourceChange = (clearLayoutLineage = false) => {
    setApprovedColorPlanImage(null)
    setApprovedColorPlanAssetId('')
    setApprovedVariantId('')
    setApprovalNotice('')
    setSpaceBaseline(null)
    setStyleBaseline(null)
    setToneBaseline(null)
    localEditAnnotatorRef.current?.clear()
    setLocalEditPrompt('')
    setSelectingBaselineKey('')
    setJobs({})
    setErrors({})
    if (clearLayoutLineage) {
      setLayoutParentAssetId('')
      setApprovedLayoutVersionId('')
    }
  }

  const replaceApprovedColorPlan = (file: File | null) => {
    setApprovedColorPlanImage(file)
    setApprovedColorPlanAssetId('')
    setApprovedVariantId('')
    setApprovalNotice(
      file ? '已载入人工批准彩平图；下游任务将以该文件为视觉基准。' : '',
    )
    setSpaceBaseline(null)
    setStyleBaseline(null)
    setToneBaseline(null)
    localEditAnnotatorRef.current?.clear()
    setJobs((current) =>
      current.color_plan ? { color_plan: current.color_plan } : {},
    )
    setErrors((current) => ({ color_plan: current.color_plan ?? '' }))
  }

  const acceptStageOne = (approval: FloorplanStage01Approval) => {
    const confirmedSemantic: SemanticLayout = approval.semanticLayout
    invalidateFromSourceChange(true)
    setStructureSourceImage(approval.approvedLayoutImage)
    setStageOneRevision((current) => current + 1)
    setStageOneWidthMm(approval.planWidthMm)
    setStageOneDepthMm(approval.planDepthMm)
    setStageOneApproved(true)
    setStageOneApproval(approval)
    const serializedSemantic = JSON.stringify(confirmedSemantic, null, 2)
    setStageOneSemanticLayout(serializedSemantic)
    setSemanticLayout(serializedSemantic)
    setSemanticError('')
    setLayoutImage(null)
    setLayoutApproved(false)
    setActiveStage('layout')
  }

  const invalidateStageOne = () => {
    if (!stageOneApproved) return
    invalidateFromSourceChange(true)
    setStageOneApproved(false)
    setStageOneApproval(null)
    setStructureSourceImage(null)
    setStageOneSemanticLayout('')
    setSemanticLayout('')
    setSemanticError('')
    setStageOneRevision((current) => current + 1)
    setLayoutImage(null)
    setLayoutApproved(false)
  }

  const invalidateStageTwo = () => {
    if (!layoutApproved) return
    invalidateFromSourceChange(true)
    setLayoutImage(null)
    setLayoutApproved(false)
    setSemanticLayout(stageOneSemanticLayout)
    setSemanticError('')
  }

  const acceptStageTwo = (selection: ApprovedLayoutSelection) => {
    invalidateFromSourceChange(true)
    setLayoutImage(selection.file)
    setLayoutApproved(true)
    setLayoutParentAssetId(selection.assetId)
    setApprovedLayoutVersionId(selection.versionId)
    setSemanticLayout(semanticForApprovedLayout(stageOneSemanticLayout, selection))
    setSemanticError('')
    setActiveStage('color_plan')
  }

  const restoreRequiredAsset = async (bundle: WorkflowResumeBundle) => {
    if (!activeGenerationStage) return
    const serializedSemantic = JSON.stringify(bundle.semanticLayout, null, 2)
    const restoredSpaces = parseSemanticRooms(serializedSemantic)
    if (!restoredSpaces.length) {
      throw new Error('所选资产没有 rooms 非空的 SemanticLayout。')
    }
    if (
      bundle.approvalStatus !== 'approved' ||
      !bundle.approvedVersionId ||
      !bundle.approvedVariantId
    ) {
      throw new Error('所选资产没有完整的人工审批版本，不能作为下游素材。')
    }

    if (activeGenerationStage === 'color_plan') {
      const layoutFile = await workflowAssetImageFile(
        bundle.approvedOutputUrl || bundle.approvedLayoutImageUrl,
        '已批准平面布局',
      )
      invalidateFromSourceChange(true)
      setLayoutImage(layoutFile)
      setLayoutApproved(true)
      setLayoutParentAssetId(bundle.assetId)
      setApprovedLayoutVersionId(bundle.approvedVersionId)
      setStageOneSemanticLayout(serializedSemantic)
      setSemanticLayout(serializedSemantic)
      setProjectId(bundle.projectId ?? '')
      setSemanticError('')
      setApprovalNotice(
        `已从“我的资产”恢复阶段 02 布局 ${bundle.assetId.slice(-8)}；可直接继续生成彩平。`,
      )
      return
    }

    if (
      activeGenerationStage === 'axonometric' ||
      activeGenerationStage === 'space_render'
    ) {
      const [colorPlanFile, layoutFile] = await Promise.all([
        workflowAssetImageFile(bundle.approvedOutputUrl, '已批准彩平'),
        workflowAssetImageFile(
          bundle.approvedLayoutImageUrl,
          '已批准平面布局',
        ),
      ])
      invalidateFromSourceChange(true)
      setLayoutImage(layoutFile)
      setLayoutApproved(true)
      setLayoutParentAssetId(
        bundle.approvedLayoutAssetId ?? bundle.parentAssetId ?? '',
      )
      setApprovedLayoutVersionId(bundle.approvedLayoutVersionId ?? '')
      setApprovedColorPlanImage(colorPlanFile)
      setApprovedColorPlanAssetId(bundle.assetId)
      setApprovedVariantId(bundle.approvedVariantId)
      setSemanticLayout(serializedSemantic)
      setProjectId(bundle.projectId ?? '')
      setSemanticError('')
      setApprovalNotice(
        `已从“我的资产”恢复阶段 03 彩平 ${bundle.assetId.slice(-8)}；布局、SemanticLayout 与审批谱系已一并载入。`,
      )
      return
    }

    if (!bundle.spaceId) {
      throw new Error('所选资产缺少 spaceId，不能恢复同空间派生工作流。')
    }
    const sourceFile = await workflowAssetImageFile(
      bundle.approvedOutputUrl,
      '已批准空间基准',
    )
    const sourceStage =
      activeGenerationStage === 'style'
        ? 'space_render'
        : activeGenerationStage === 'tone'
          ? 'style'
          : 'tone'
    const baseline: VisualBaseline = {
      stage: sourceStage,
      file: sourceFile,
      url: bundle.approvedOutputUrl,
      assetId: bundle.assetId,
      approvedVersionId: bundle.approvedVersionId,
      variantId: bundle.approvedVariantId,
      label:
        bundle.spaceName ||
        derivativeVariantLabels.get(bundle.approvedVariantId) ||
        bundle.approvedVariantId.replaceAll('_', ' '),
      spaceId: bundle.spaceId,
    }

    setSemanticLayout(serializedSemantic)
    setProjectId(bundle.projectId ?? '')
    setSemanticError('')
    setJobs({})
    setErrors({})
    setApprovedColorPlanImage(null)
    setApprovedColorPlanAssetId('')
    setApprovedVariantId('')
    setSpaceBaseline(null)
    setStyleBaseline(null)
    setToneBaseline(null)
    localEditAnnotatorRef.current?.clear()
    setLocalEditPrompt('')
    if (activeGenerationStage === 'style') {
      setSpaceBaseline(baseline)
      setStyleBaseline(null)
      setToneBaseline(null)
    } else if (activeGenerationStage === 'tone') {
      setStyleBaseline(baseline)
      setToneBaseline(null)
    } else {
      setToneBaseline(baseline)
    }
    setApprovalNotice(
      `已从“我的资产”恢复${bundle.spaceName ?? bundle.spaceId}的阶段 ${activeGenerationStage === 'style' ? '05' : activeGenerationStage === 'tone' ? '06' : '07'} 基准；可从当前阶段继续。`,
    )
  }

  const readSemanticFile = async (file: File | null) => {
    if (!file) return
    try {
      const value = await file.text()
      const parsed = JSON.parse(value)
      invalidateFromSourceChange()
      setSemanticLayout(JSON.stringify(parsed, null, 2))
      setSemanticError('')
    } catch {
      setSemanticError('所选文件不是有效的 JSON，请检查后重新上传。')
    }
  }

  const normalizedSemanticLayout = () => {
    if (!semanticLayout.trim()) {
      setSemanticError('SemanticLayout 为必填项，请上传或粘贴包含 rooms 的 JSON。')
      return null
    }
    try {
      const parsed = JSON.parse(semanticLayout) as Record<string, unknown>
      const canonical =
        parsed.semanticLayout && typeof parsed.semanticLayout === 'object'
          ? (parsed.semanticLayout as Record<string, unknown>)
          : parsed.semantic_layout && typeof parsed.semantic_layout === 'object'
            ? (parsed.semantic_layout as Record<string, unknown>)
            : parsed
      if (!Array.isArray(canonical.rooms) || canonical.rooms.length === 0) {
        setSemanticError('SemanticLayout.rooms 不能为空，不能使用空结构生成。')
        return null
      }
      setSemanticError('')
      return JSON.stringify(canonical)
    } catch {
      setSemanticError('Semantic JSON 格式不正确，请修正后再生成。')
      return null
    }
  }

  const commonForm = (stage: GenerationStage) => {
    const normalized = normalizedSemanticLayout()
    if (!normalized) return null

    if (['style', 'tone', 'local_edit'].includes(stage)) {
      const baseline =
        stage === 'style'
          ? spaceBaseline
          : stage === 'tone'
            ? styleBaseline
            : toneBaseline
      if (!baseline) return null
      const form = new FormData()
      form.append('source_space_image', baseline.file)
      form.append('source_approved', 'true')
      form.append('semantic_layout', normalized)
      form.append('space_id', baseline.spaceId)
      form.append('asset_parent_id', baseline.assetId)
      form.append('source_space_version_id', baseline.approvedVersionId)
      if (projectId.trim()) form.append('project_id', projectId.trim())
      if (stage !== 'local_edit' && designPrompt.trim()) {
        form.append('design_prompt', designPrompt.trim())
      }
      if (stage === 'style') {
        styleReferences.forEach((file) => form.append('style_references', file))
      }
      return form
    }

    if (!layoutImage || !layoutApproved) return null
    const form = new FormData()
    form.append('approved_layout_image', layoutImage)
    form.append('layout_approved', 'true')
    form.append('semantic_layout', normalized)
    styleReferences.forEach((file) => form.append('style_references', file))
    if (projectId.trim()) form.append('project_id', projectId.trim())
    const parentAssetId =
      stage === 'color_plan'
        ? layoutParentAssetId.trim()
        : approvedColorPlanAssetId.trim()
    if (parentAssetId) form.append('asset_parent_id', parentAssetId)
    if (approvedLayoutVersionId.trim()) {
      form.append('approved_layout_version_id', approvedLayoutVersionId.trim())
    }
    if (designPrompt.trim()) form.append('design_prompt', designPrompt.trim())
    return form
  }

  const run = async (
    stage: GenerationStage,
    request: Promise<Response>,
    options?: { mergePrevious?: boolean },
  ) => {
    // W3-2：busy 以 jobId 集合为准；stage 槽仅用于向导单栏 UI
    setBusyStage(stage)
    setErrors((current) => ({ ...current, [stage]: '' }))
    const previousJob = options?.mergePrevious ? jobs[stage] : undefined
    const present = (nextJob: Job) =>
      options?.mergePrevious ? mergeRetryResult(previousJob, nextJob) : nextJob
    const abort = new AbortController()
    let trackedJobId: string | null = null
    try {
      const response = await request
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: unknown
        } | null
        throw new Error(apiError(payload?.detail, response.status))
      }
      const created = (await response.json()) as Job
      trackedJobId = created.id
      pollAbortMapRef.current.set(created.id, abort)
      setBusyJobIds((current) => new Set(current).add(created.id))
      setJobs((current) => ({ ...current, [stage]: present(created) }))
      setJobByNodeId((current) => {
        const next = new Map(current)
        next.set(`${created.id}:_batch`, present(created))
        return next
      })
      const completed = await pollJob(
        created.id,
        (nextJob) => {
          setJobs((current) => ({ ...current, [stage]: present(nextJob) }))
          setJobByNodeId((current) => {
            const next = new Map(current)
            next.set(`${created.id}:_batch`, present(nextJob))
            return next
          })
        },
        undefined,
        abort.signal,
      )
      setJobs((current) => ({ ...current, [stage]: present(completed) }))
      setJobByNodeId((current) => {
        const next = new Map(current)
        next.set(`${created.id}:_batch`, present(completed))
        return next
      })
      if (completed.status === 'FAILED') {
        setErrors((current) => ({
          ...current,
          [stage]: completed.errorMessage ?? 'AI 生成任务失败',
        }))
      }
    } catch (value) {
      const intentionalAbort =
        abort.signal.aborted &&
        value instanceof DOMException &&
        value.name === 'AbortError'
      if (!intentionalAbort) {
        setErrors((current) => ({ ...current, [stage]: errorMessage(value) }))
      }
    } finally {
      // W3-2：只清理本 job 的 abort/busy，避免并发 finally 误清其他任务
      if (trackedJobId) {
        const current = pollAbortMapRef.current.get(trackedJobId)
        if (current === abort) pollAbortMapRef.current.delete(trackedJobId)
        setBusyJobIds((prev) => {
          const next = new Set(prev)
          next.delete(trackedJobId!)
          return next
        })
      }
      setBusyStage((current) => (current === stage ? null : current))
    }
  }

  // B3：取消当前正在生成的阶段任务；服务端保留取消前已生成的部分结果
  const cancelActiveJob = async () => {
    const stage = busyStage
    const currentJob = stage ? jobs[stage] : undefined
    if (!stage || !currentJob) return
    try {
      const response = await cancelJob(currentJob.id)
      if (response.ok) {
        const canceled = (await response.json()) as Job
        setJobs((current) => ({ ...current, [stage]: canceled }))
      }
    } catch {
      // 取消请求失败也要停止本地等待，避免界面卡死
    }
    pollAbortMapRef.current.get(currentJob.id)?.abort()
  }

  const resumeWaiting = async (stage: GenerationStage) => {
    const currentJob = jobs[stage]
    if (!currentJob || !['QUEUED', 'RUNNING'].includes(currentJob.status)) return
    setBusyStage(stage)
    setBusyJobIds((current) => new Set(current).add(currentJob.id))
    setErrors((current) => ({ ...current, [stage]: '' }))
    const abort = new AbortController()
    pollAbortMapRef.current.set(currentJob.id, abort)
    try {
      const completed = await pollJob(
        currentJob.id,
        (nextJob) => setJobs((current) => ({ ...current, [stage]: nextJob })),
        undefined,
        abort.signal,
      )
      setJobs((current) => ({ ...current, [stage]: completed }))
      if (completed.status === 'FAILED') {
        setErrors((current) => ({
          ...current,
          [stage]: completed.errorMessage ?? 'AI 生成任务失败',
        }))
      }
    } catch (value) {
      setErrors((current) => ({ ...current, [stage]: errorMessage(value) }))
    } finally {
      pollAbortMapRef.current.delete(currentJob.id)
      setBusyJobIds((prev) => {
        const next = new Set(prev)
        next.delete(currentJob.id)
        return next
      })
      setBusyStage((current) => (current === stage ? null : current))
    }
  }

  const submitStage = async (retryIds?: string[]) => {
    // W3-2：允许其他 stage 并行；仅阻止同一 active stage 重入
    if (!isGenerationStage(activeStage)) return
    if (busyStage === activeStage) return
    const form = commonForm(activeStage)
    if (!form) return
    const runOptions = retryIds?.length ? { mergePrevious: true } : undefined
    if (activeStage === 'color_plan') {
      form.append('variants', (retryIds ?? colorVariants).join(','))
      await run(activeStage, createColorPlanRenders(form), runOptions)
      return
    }
    if (activeStage === 'style') {
      form.append(
        'variants',
        (retryIds ?? styleVariants)
          .map((value) => value.replace(/^style_/, ''))
          .join(','),
      )
      await run(activeStage, createStyleSchemeRenders(form), runOptions)
      return
    }
    if (activeStage === 'tone') {
      form.append(
        'variants',
        (retryIds ?? toneVariants)
          .map((value) => value.replace(/^tone_/, ''))
          .join(','),
      )
      await run(activeStage, createToneSchemeRenders(form), runOptions)
      return
    }
    if (activeStage === 'local_edit') {
      const markFile =
        (await localEditAnnotatorRef.current?.composeMarkFile()) ?? null
      if (!markFile || !localEditPrompt.trim()) return
      form.append('mark_image', markFile)
      form.append('edit_prompt', localEditPrompt.trim())
      await run(activeStage, createLocalEditRender(form))
      return
    }
    if (!approvedColorPlanImage) return
    form.append('approved_color_plan_image', approvedColorPlanImage)
    if (activeStage === 'axonometric') {
      form.append('variants', (retryIds ?? axonometricVariants).join(','))
      await run(activeStage, createAxonometricRenders(form), runOptions)
      return
    }
    form.append('selected_space_ids', (retryIds ?? selectedSpaceIds).join(','))
    form.append('view_preset', viewPreset)
    await run(activeStage, createSpaceRenders(form), runOptions)
  }

  const approveGeneratedColorPlan = async (output: RenderOutput) => {
    const result = jobs.color_plan?.result
    // B4：重试合并视图里，来自上一批的输出必须审批到原任务的资产上
    const resultAssetId =
      output.assetId ??
      (result && typeof result.assetId === 'string' ? result.assetId : '')
    if (!resultAssetId) {
      setErrors((current) => ({
        ...current,
        color_plan:
          '当前任务结果没有 assetId，无法持久化审批。请先刷新资产记录或重新生成，不能仅凭浏览器临时状态进入下一阶段。',
      }))
      return
    }
    if (!output.variantId) {
      setErrors((current) => ({
        ...current,
        color_plan: '当前图片缺少 variantId，无法记录具体批准版本。',
      }))
      return
    }
    setApprovingVariantId(output.variantId)
    setApprovalNotice('')
    try {
      // Make sure the selected image is readable before persisting approval so
      // the server and the visible workflow cannot split into different states.
      // 用带缓存穿透的下载，避免 <img> 的 no-CORS 缓存条目被 XHR 复用而失败。
      const file = await workflowAssetImageFile(output.url, 'approved-color-plan')
      let approval = {} as Record<string, unknown>
      let reusedPersistedApproval = false
      const existingResponse = await apiFetch(
        `/v1/assets/${encodeURIComponent(resultAssetId)}`,
        { cache: 'no-store' },
      )
      if (existingResponse.ok) {
        const existingAsset = recordValue(await existingResponse.json())
        const existingMetadata = recordValue(existingAsset.metadata)
        const existingDeliverables = recordValue(existingAsset.deliverables)
        const existingVariantId = String(
          existingMetadata.approvedVariantId ??
            existingDeliverables.approvedVariantId ??
            '',
        )
        if (
          existingMetadata.approvalStatus === 'approved' &&
          existingVariantId === output.variantId
        ) {
          approval = existingAsset
          reusedPersistedApproval = true
        }
      }
      if (!reusedPersistedApproval) {
        // W3-1：审批走纯函数模块（显式 assetId/variantId，不依赖 activeStage）
        const approved = await approveVariantIdempotent({
          assetId: resultAssetId,
          variantId: output.variantId,
          comment: '阶段 03 彩平图已由用户批准为阶段 04～05 的视觉基准。',
        })
        approval = approved.raw
        reusedPersistedApproval = approved.reused
      }
      const approvedAsset = recordValue(approval.asset)
      const approvedAssetId = String(
        approval.assetId ?? approval.id ?? approvedAsset.id ?? resultAssetId,
      )
      setApprovedColorPlanImage(file)
      setApprovedColorPlanAssetId(approvedAssetId)
      setApprovedVariantId(output.variantId)
      setApprovalNotice(
        `${reusedPersistedApproval ? '已恢复批准状态' : '已批准'} ${
          output.variantId
        }，阶段 04～05 将继承资产 ${approvedAssetId.slice(-8)}。`,
      )
      // W3-3：批准不再清掉其他阶段 job
      setErrors((current) => ({ ...current, color_plan: '' }))
    } catch (value) {
      setErrors((current) => ({
        ...current,
        color_plan: `彩平审批或复用失败：${errorMessage(value)}`,
      }))
    } finally {
      setApprovingVariantId('')
    }
  }

  const selectApprovedBaseline = async (
    stage: 'space_render' | 'style' | 'tone',
    output: RenderOutput,
  ) => {
    const result = jobs[stage]?.result
    // B4：重试合并视图里，来自上一批的输出必须审批到原任务的资产上
    const resultAssetId =
      output.assetId ??
      (result && typeof result.assetId === 'string' ? result.assetId : '')
    if (!resultAssetId || !output.variantId) {
      setErrors((current) => ({
        ...current,
        [stage]: '当前图片缺少可审批的资产或变体 ID，请重新生成后再选择。',
      }))
      return
    }
    const inheritedSpaceId =
      stage === 'space_render'
        ? output.spaceId
        : stage === 'style'
          ? spaceBaseline?.spaceId
          : styleBaseline?.spaceId
    if (!inheritedSpaceId) {
      setErrors((current) => ({
        ...current,
        [stage]: '当前图片缺少 spaceId，无法建立同一空间的后续方案谱系。',
      }))
      return
    }

    const selectionKey = `${stage}:${output.variantId}`
    setSelectingBaselineKey(selectionKey)
    setErrors((current) => ({ ...current, [stage]: '' }))
    try {
      // 复用带缓存穿透的下载：避免 Chromium 把 <img> 的 no-CORS 缓存条目
      // 复用给 XHR，导致请求未到服务器就报“无法连接本地 API”。
      const file = await workflowAssetImageFile(
        output.url,
        `${stage}-${inheritedSpaceId}-${output.variantId}`,
      )
      // W3-1/W3-3：设基准纯函数；不删下游 job、不自动跳阶段
      const baseline: ActionVisualBaseline = await setBaselineFromOutput({
        assetId: resultAssetId,
        variantId: output.variantId,
        url: output.url,
        spaceId: inheritedSpaceId,
        stage,
        label: output.label,
        file,
        comment: `阶段 ${stage === 'space_render' ? '05' : stage === 'style' ? '06' : '07'} 已由用户批准为下一阶段视觉基准。`,
      })
      if (stage === 'space_render') {
        setSpaceBaseline(baseline)
      } else if (stage === 'style') {
        setStyleBaseline(baseline)
      } else {
        setToneBaseline(baseline)
      }
      setApprovalNotice(
        `已设基准「${output.label}」（空间 ${inheritedSpaceId}）。下游任务保留，可手动切换阶段继续。`,
      )
    } catch (value) {
      setErrors((current) => ({
        ...current,
        [stage]: `设置后续基准失败：${errorMessage(value)}`,
      }))
    } finally {
      setSelectingBaselineKey('')
    }
  }

  const stageSelectionCount =
    !activeGenerationStage
      ? 0
      : activeGenerationStage === 'color_plan'
        ? colorVariants.length
        : activeGenerationStage === 'axonometric'
          ? axonometricVariants.length
          : activeGenerationStage === 'space_render'
            ? selectedSpaceIds.length
            : activeGenerationStage === 'style'
              ? styleVariants.length
              : activeGenerationStage === 'tone'
                ? toneVariants.length
                : annotationDirty && localEditPrompt.trim()
                  ? 1
                  : 0
  const requiredDownstreamBaseline =
    activeGenerationStage === 'style'
      ? spaceBaseline
      : activeGenerationStage === 'tone'
        ? styleBaseline
        : activeGenerationStage === 'local_edit'
          ? toneBaseline
          : null
  const isDownstreamStage = Boolean(
    activeGenerationStage &&
      ['style', 'tone', 'local_edit'].includes(activeGenerationStage),
  )
  const canSubmit = Boolean(
    activeGenerationStage &&
      semanticSpaces.length > 0 &&
      (isDownstreamStage
        ? requiredDownstreamBaseline
        : layoutImage &&
          layoutApproved &&
          (activeGenerationStage === 'color_plan' || approvedColorPlanImage)) &&
      stageSelectionCount &&
      busyStage === null &&
      !semanticError,
  )
  const canResume = Boolean(
    activeJob &&
      ['QUEUED', 'RUNNING'].includes(activeJob.status) &&
      busyStage === null,
  )
  const selectedRequiredAssetId =
    activeGenerationStage === 'color_plan'
      ? layoutParentAssetId
      : activeGenerationStage === 'axonometric' ||
          activeGenerationStage === 'space_render'
        ? approvedColorPlanAssetId
        : activeGenerationStage === 'style'
          ? spaceBaseline?.assetId
          : activeGenerationStage === 'tone'
            ? styleBaseline?.assetId
            : activeGenerationStage === 'local_edit'
              ? toneBaseline?.assetId
              : ''

  return (
    <div className="page ai-workflow-page">
      <header className="module-header">
        <div>
          <span className="eyebrow">PROJECT WORKFLOW · AI NATIVE</span>
          <h1>AI 设计工作流</h1>
          <p>
            在一个工作台内完成标注、布局、彩平、轴侧、空间效果、风格、色调与局部修改；每一步都继承人工批准的同项目版本。
          </p>
        </div>
        <JobState job={activeJob} busy={busyStage === activeStage} />
      </header>

      <section className="workflow-stage-strip" aria-label="设计工作流阶段">
        {workflowStages.map((stage) => {
          const isOperational = stage.state !== 'planned'
          const stageStatus =
            stage.id === 'annotation'
              ? stageOneApproved
                ? '功能区已批准'
                : structureSourceImage
                  ? '待重新批准'
                  : '可执行'
              : stage.id === 'layout'
                ? layoutApproved
                  ? '布局已批准'
                  : stageOneApproved
                    ? '可生成'
                    : '等待阶段 01'
                : stage.id === 'color_plan'
                  ? layoutApproved
                    ? stage.id === activeStage
                      ? '当前编辑'
                      : '可生成'
                    : '等待阶段 02'
                : stage.id === 'axonometric' || stage.id === 'space_render'
                    ? approvedColorPlanImage
                      ? stage.id === activeStage
                        ? '当前编辑'
                        : '可生成'
                      : '等待阶段 03'
                : stage.id === 'style'
                  ? spaceBaseline
                    ? stage.id === activeStage
                      ? '当前编辑'
                      : '可生成'
                    : hasSpaceRenderOutputs
                      ? '请在 05 选择基准'
                      : '等待阶段 05'
                  : stage.id === 'tone'
                    ? styleBaseline
                      ? stage.id === activeStage
                        ? '当前编辑'
                        : '可生成'
                      : '等待阶段 06 批准'
                    : stage.id === 'local_edit'
                      ? toneBaseline
                        ? stage.id === activeStage
                          ? '当前编辑'
                          : '可修改'
                        : '等待阶段 07 批准'
                      : stage.id === activeStage
                        ? '当前编辑'
                        : '可生成'
          return (
            <button
              key={stage.id}
              type="button"
              className={`${stage.id === activeStage ? 'active' : ''} is-${stage.state}`}
              disabled={!isOperational}
              onClick={() =>
                isOperational && setActiveStage(stage.id as WorkflowActiveStage)
              }
            >
              <span>{stage.number}</span>
              <strong>{stage.title}</strong>
              <small>{stageStatus}</small>
            </button>
          )
        })}
      </section>

      <section
        className="workflow-integrated-stage"
        hidden={activeStage !== 'annotation'}
      >
        <div className="workflow-integrated-heading">
          <div>
            <span>STAGE 01 · FUNCTION ANNOTATION</span>
            <h2>功能区标注与结构确认</h2>
            <p>
              上传一次原始平面图，识别并校正房间、墙体、门窗与家具；批准后自动带入阶段 02。
            </p>
          </div>
          <strong>{stageOneApproved ? '已批准' : '待确认'}</strong>
        </div>
        <FloorplanModule
          presentation="workflow-stage-01"
          onApproved={acceptStageOne}
          onApprovalInvalidated={invalidateStageOne}
        />
      </section>

      <section
        className="workflow-integrated-stage"
        hidden={activeStage !== 'layout'}
      >
        <AiLayoutStage
          key={stageOneRevision}
          sourceImage={structureSourceImage}
          semanticLayout={stageOneSemanticLayout}
          defaultWidthMm={stageOneWidthMm}
          defaultDepthMm={stageOneDepthMm}
          projectId={projectId}
          stageOneApproval={stageOneApproval}
          onApproved={acceptStageTwo}
          onApprovalInvalidated={invalidateStageTwo}
        />
      </section>

      {activeGenerationStage && (
      <div className="ai-workflow-shell">
        <aside className="workflow-source-panel">
          <div className="workflow-panel-heading">
            <span>SHARED SOURCE</span>
            <h2>已批准设计基准</h2>
            <p>结构输入贯穿阶段 03～08；每个后续阶段只使用上一阶段人工批准的同空间图片。</p>
          </div>

          <WorkflowAssetPicker
            key={activeGenerationStage}
            stage={activeGenerationStage}
            selectedAssetId={selectedRequiredAssetId}
            onSelect={restoreRequiredAsset}
          />

          <label className="workflow-file-card">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                invalidateFromSourceChange(true)
                setLayoutImage(event.target.files?.[0] ?? null)
                setLayoutApproved(false)
              }}
            />
            {layoutPreview ? (
              <img src={layoutPreview} alt="已批准平面布局预览" />
            ) : (
              <span className="workflow-file-placeholder">02</span>
            )}
            <div>
              <strong>{layoutImage?.name ?? '上传已批准平面布局'}</strong>
              <small>必填 · JPG / PNG / WEBP</small>
            </div>
          </label>

          <label className="workflow-approval-check">
            <input
              type="checkbox"
              checked={layoutApproved}
              onChange={(event) => {
                const nextApproved = event.target.checked
                if (!nextApproved) invalidateFromSourceChange()
                setLayoutApproved(nextApproved)
              }}
            />
            <span>
              <strong>该布局已由人工批准</strong>
              <small>确认房间、墙体、门窗和家具关系可进入下游生成</small>
            </span>
          </label>

          <div className="workflow-semantic-field">
            <div>
              <strong>SemanticLayout</strong>
              <label className="workflow-json-upload">
                读取 JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) =>
                    void readSemanticFile(event.target.files?.[0] ?? null)
                  }
                />
              </label>
            </div>
            <textarea
              value={semanticLayout}
              spellCheck={false}
              placeholder={'必填：粘贴已确认的 SemanticLayout JSON\n{\n  "rooms": [...]\n}'}
              onChange={(event) => {
                invalidateFromSourceChange()
                setSemanticLayout(event.target.value)
                setSemanticError('')
              }}
            />
            {semanticError && <p className="workflow-field-error">{semanticError}</p>}
            {!semanticError && semanticSpaces.length > 0 && (
              <p className="workflow-field-success">
                已识别 {semanticSpaces.length} 个可生成空间
              </p>
            )}
          </div>

          {!['tone', 'local_edit'].includes(activeGenerationStage) && (
          <label className="workflow-reference-upload">
            <span>风格参考图</span>
            <strong>
              {styleReferences.length
                ? `已选择 ${styleReferences.length} 张`
                : '可选上传参考图 · 最多 7 张'}
            </strong>
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => {
                if (activeGenerationStage === 'style') {
                  // Stage 06 references change only the style branch. The
                  // approved Stage 05 space remains the geometry authority.
                  setStyleBaseline(null)
                  setToneBaseline(null)
                  localEditAnnotatorRef.current?.clear()
                  setLocalEditPrompt('')
                  setApprovalNotice('')
                  setJobs((current) =>
                    withoutStageJobs(current, ['style', 'tone', 'local_edit']),
                  )
                  setErrors((current) =>
                    withoutStageErrors(current, ['style', 'tone', 'local_edit']),
                  )
                } else {
                  invalidateFromSourceChange()
                }
                setStyleReferences(
                  Array.from(event.target.files ?? []).slice(0, 7),
                )
              }}
            />
          </label>
          )}

          <details className="workflow-lineage-fields">
            <summary>项目与版本谱系（可选）</summary>
            <label>
              项目 ID
              <input
                value={projectId}
                onChange={(event) => {
                  invalidateFromSourceChange()
                  setProjectId(event.target.value)
                }}
                placeholder="project_id"
              />
            </label>
            <label>
              阶段 02 布局资产 ID
              <input
                value={layoutParentAssetId}
                onChange={(event) => {
                  invalidateFromSourceChange()
                  setLayoutParentAssetId(event.target.value)
                }}
                placeholder="可选：layout / floorplan asset_id"
              />
            </label>
            <label>
              阶段 03 已批准彩平资产 ID
              <input
                value={approvedColorPlanAssetId}
                onChange={(event) => {
                  setApprovedColorPlanAssetId(event.target.value)
                  setJobs((current) =>
                    current.color_plan ? { color_plan: current.color_plan } : {},
                  )
                }}
                placeholder="批准彩平后自动回填，也可手动填写"
              />
            </label>
            <label>
              已批准布局版本 ID
              <input
                value={approvedLayoutVersionId}
                onChange={(event) => {
                  invalidateFromSourceChange()
                  setApprovedLayoutVersionId(event.target.value)
                }}
                placeholder="approved_layout_version_id"
              />
            </label>
          </details>

          {['axonometric', 'space_render'].includes(activeGenerationStage) && (
            <label className="workflow-file-card is-compact">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) =>
                  replaceApprovedColorPlan(event.target.files?.[0] ?? null)
                }
              />
              {colorPlanPreview ? (
                <img src={colorPlanPreview} alt="已批准彩平图预览" />
              ) : (
                <span className="workflow-file-placeholder">03</span>
              )}
              <div>
                <strong>{approvedColorPlanImage?.name ?? '上传已批准彩平图'}</strong>
                <small>必填 · 阶段 04～05 的视觉基准</small>
              </div>
            </label>
          )}

          {['style', 'tone', 'local_edit'].includes(activeGenerationStage) && (
            <div
              className={`workflow-downstream-baseline ${downstreamSourceBaseline ? 'is-ready' : ''}`}
            >
              {downstreamSourceBaseline && downstreamSourcePreview ? (
                <img
                  src={downstreamSourcePreview}
                  alt={`${downstreamSourceBaseline.label}基准预览`}
                />
              ) : (
                <span>{activeGenerationStage === 'style' ? '05' : activeGenerationStage === 'tone' ? '06' : '07'}</span>
              )}
              <div>
                <small>APPROVED SOURCE</small>
                <strong>
                  {downstreamSourceBaseline?.label ??
                    `尚未批准阶段 ${activeGenerationStage === 'style' ? '05' : activeGenerationStage === 'tone' ? '06' : '07'} 基准图`}
                </strong>
                <p>
                  {downstreamSourceBaseline
                    ? `空间 ${downstreamSourceBaseline.spaceId} · ${downstreamSourceBaseline.variantId}`
                    : '请返回上一阶段，在目标图片下点击“设为后续基准”。'}
                </p>
                {!downstreamSourceBaseline && (
                  <button
                    type="button"
                    onClick={() =>
                      setActiveStage(
                        activeGenerationStage === 'style'
                          ? 'space_render'
                          : activeGenerationStage === 'tone'
                            ? 'style'
                            : 'tone',
                      )
                    }
                  >
                    返回选择基准
                  </button>
                )}
              </div>
            </div>
          )}

          {approvalNotice && (
            <div className="workflow-approval-notice">{approvalNotice}</div>
          )}

          <div className="workflow-source-status">
            <span className={layoutImage ? 'done' : ''}>
              {layoutImage ? '✓' : '1'} 平面布局
            </span>
            <span className={semanticLayout.trim() ? 'done' : ''}>
              {semanticLayout.trim() ? '✓' : '2'} 语义结构
            </span>
            <span className={styleReferences.length ? 'done' : ''}>
              {styleReferences.length ? '✓' : '3'} 风格参考
            </span>
          </div>
        </aside>

        <section className="workflow-generation-panel">
          <div className="workflow-generation-heading">
            <div>
              <span>{workflowStageLabels[activeGenerationStage]}</span>
              <h2>{stageTitles[activeGenerationStage]}</h2>
              <p>
                {activeGenerationStage === 'color_plan'
                  ? '一次选择多种表现方式，批量生成同一布局的彩平候选。'
                  : activeGenerationStage === 'axonometric'
                    ? '在同一设计基准上生成日景、夜景与另一观察角度。'
                    : activeGenerationStage === 'space_render'
                      ? '从语义房间列表选择多个空间，批量生成同一设计语言的室内效果图。'
                      : activeGenerationStage === 'style'
                        ? '锁定阶段 05 的空间、构图与物体，只改变室内设计风格。'
                        : activeGenerationStage === 'tone'
                          ? '锁定已批准风格方案，只改变光线时段与整体色调。'
                          : '在基准图上用红色画笔圈出要修改的区域（圈住的内部会一起重绘），其余画面保持不变。'}
              </p>
            </div>
            <span className="workflow-selection-count">
              已选 {stageSelectionCount} 项
            </span>
          </div>

          {activeGenerationStage === 'color_plan' && (
            <div className="workflow-option-grid">
              {colorPlanOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={colorVariants.includes(option.id) ? 'selected' : ''}
                  onClick={() =>
                    toggleSelection(option.id, colorVariants, setColorVariants)
                  }
                >
                  <i>{colorVariants.includes(option.id) ? '✓' : '+'}</i>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          )}

          {activeGenerationStage === 'axonometric' && (
            <div className="workflow-option-grid is-three">
              {axonometricOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={
                    axonometricVariants.includes(option.id) ? 'selected' : ''
                  }
                  onClick={() =>
                    toggleSelection(
                      option.id,
                      axonometricVariants,
                      setAxonometricVariants,
                    )
                  }
                >
                  <i>{axonometricVariants.includes(option.id) ? '✓' : '+'}</i>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          )}

          {activeGenerationStage === 'space_render' && (
            <div className="workflow-space-picker">
              <div>
                <strong>
                  {semanticSpaces.length
                    ? '来自 SemanticLayout 的空间'
                    : '请先提供包含 rooms 的 SemanticLayout'}
                </strong>
                <button
                  type="button"
                  onClick={() => setSelectedSpaceIds(spaceOptions.map((space) => space.id))}
                >
                  全选
                </button>
              </div>
              <div className="workflow-space-grid">
                {spaceOptions.map((space) => (
                  <button
                    type="button"
                    key={space.id}
                    className={selectedSpaceIds.includes(space.id) ? 'selected' : ''}
                    onClick={() =>
                      toggleSelection(
                        space.id,
                        selectedSpaceIds,
                        setSelectedSpaceIds,
                      )
                    }
                  >
                    <span>{selectedSpaceIds.includes(space.id) ? '✓' : '+'}</span>
                    <strong>{space.label}</strong>
                    <small>{space.id}</small>
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeGenerationStage === 'style' && (
            <div className="workflow-option-grid">
              {styleSchemeOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={styleVariants.includes(option.id) ? 'selected' : ''}
                  onClick={() =>
                    toggleSelection(option.id, styleVariants, setStyleVariants)
                  }
                >
                  <i>{styleVariants.includes(option.id) ? '✓' : '+'}</i>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          )}

          {activeGenerationStage === 'tone' && (
            <div className="workflow-option-grid is-three">
              {toneSchemeOptions.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={toneVariants.includes(option.id) ? 'selected' : ''}
                  onClick={() =>
                    toggleSelection(option.id, toneVariants, setToneVariants)
                  }
                >
                  <i>{toneVariants.includes(option.id) ? '✓' : '+'}</i>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </button>
              ))}
            </div>
          )}

          {activeGenerationStage === 'local_edit' && (
            <div className="workflow-local-edit-form">
              <div className="workflow-mask-guide">
                <div aria-hidden="true">
                  <span />
                </div>
                <p>
                  <strong>标记规则</strong>
                  用红色画笔圈出或涂满要修改的区域（闭合圈的内部会一起重绘），其余画面保持不变；标记随图发送给
                  AI，无需上传蒙版。
                </p>
              </div>
              {toneBaselinePreview ? (
                <LocalEditAnnotator
                  ref={localEditAnnotatorRef}
                  imageUrl={toneBaselinePreview}
                  onDirtyChange={(dirty) => {
                    setAnnotationDirty(dirty)
                    setJobs((current) => withoutStageJobs(current, ['local_edit']))
                    setErrors((current) => ({ ...current, local_edit: '' }))
                  }}
                />
              ) : (
                <p className="workflow-annotator-empty">
                  请先在阶段 07 批准一张色调基准图，再在此处用画笔标记需要修改的区域。
                </p>
              )}
              <label>
                <span>局部修改指令</span>
                <textarea
                  value={localEditPrompt}
                  maxLength={1000}
                  onChange={(event) => {
                    setLocalEditPrompt(event.target.value)
                    setErrors((current) => ({ ...current, local_edit: '' }))
                  }}
                  placeholder="例如：把标记处的单人沙发替换为浅棕色皮革休闲椅，保持相机、墙面、地面和其他家具不变"
                />
              </label>
            </div>
          )}

          {activeGenerationStage !== 'local_edit' && (
          <div className="workflow-generation-controls">
            <label>
              <span>设计补充要求（可选）</span>
              <textarea
                value={designPrompt}
                maxLength={1000}
                onChange={(event) => setDesignPrompt(event.target.value)}
                placeholder="例如：浅橡木、米白布艺、自然日光、减少装饰品"
              />
            </label>
            {activeGenerationStage === 'space_render' && (
              <label>
                <span>空间机位</span>
                <select
                  value={viewPreset}
                  onChange={(event) => setViewPreset(event.target.value)}
                >
                  <option value="eye_level_wide">平视广角</option>
                  <option value="corner_wide">角落广角</option>
                  <option value="straight_on">正向平视</option>
                </select>
              </label>
            )}
          </div>
          )}

          <div className="workflow-submit-row">
            <button
              type="button"
              className="primary-button"
              disabled={!canSubmit}
              onClick={() => void submitStage()}
            >
              {busyStage === activeGenerationStage
                ? 'AI 正在批量生成…'
                : `生成 ${stageSelectionCount} 个${stageTitles[activeGenerationStage].slice(3)}`}
            </button>
            {busyStage === activeGenerationStage && activeJob && (
              <button
                type="button"
                className="workflow-resume-button"
                onClick={() => void cancelActiveJob()}
              >
                取消生成（保留已出图）
              </button>
            )}
            {canResume && (
              <button
                type="button"
                className="workflow-resume-button"
                onClick={() => void resumeWaiting(activeGenerationStage)}
              >
                继续等待当前任务
              </button>
            )}
            {!isDownstreamStage && !layoutImage && (
              <p>请先上传阶段 02 已批准的平面布局图。</p>
            )}
            {!isDownstreamStage && layoutImage && !layoutApproved && (
              <p>请勾选“该布局已由人工批准”。</p>
            )}
            {semanticSpaces.length === 0 && (
              <p>请提供 rooms 非空的 SemanticLayout。</p>
            )}
            {['axonometric', 'space_render'].includes(activeGenerationStage) &&
              !approvedColorPlanImage && (
              <p>阶段 04～05 必须上传已批准彩平图。</p>
            )}
            {isDownstreamStage && !requiredDownstreamBaseline && (
              <p>
                请先在阶段 {activeGenerationStage === 'style' ? '05' : activeGenerationStage === 'tone' ? '06' : '07'} 选择并批准一张基准图。
              </p>
            )}
            {activeGenerationStage === 'local_edit' && !annotationDirty && (
              <p>请在基准图上用红色画笔标记需要修改的区域。</p>
            )}
            {activeGenerationStage === 'local_edit' && !localEditPrompt.trim() && (
              <p>请填写明确的局部修改指令。</p>
            )}
            {!stageSelectionCount && activeGenerationStage !== 'local_edit' && (
              <p>请至少选择一个生成项。</p>
            )}
            {errors[activeGenerationStage] && (
              <p className="workflow-submit-error">{errors[activeGenerationStage]}</p>
            )}
          </div>

          <ResultGallery
            job={activeJob}
            stage={activeGenerationStage}
            busy={busyStage === activeGenerationStage}
            onApproveOutput={
              activeGenerationStage === 'color_plan'
                ? (output) => void approveGeneratedColorPlan(output)
                : undefined
            }
            onSelectBaseline={
              ['space_render', 'style', 'tone'].includes(activeGenerationStage)
                ? (output) =>
                    void selectApprovedBaseline(
                      activeGenerationStage as 'space_render' | 'style' | 'tone',
                      output,
                    )
                : undefined
            }
            selectingBaselineKey={selectingBaselineKey}
            selectedBaselineKey={
              activeGenerationStage === 'space_render' && spaceBaseline
                ? `space_render:${spaceBaseline.variantId}`
                : activeGenerationStage === 'style' && styleBaseline
                  ? `style:${styleBaseline.variantId}`
                  : activeGenerationStage === 'tone' && toneBaseline
                    ? `tone:${toneBaseline.variantId}`
                    : ''
            }
            baselineActionLabel={
              activeGenerationStage === 'space_render'
                ? '设为风格基准'
                : activeGenerationStage === 'style'
                  ? '批准并进入色调'
                  : '批准并进入局部修改'
            }
            onRetryFailures={(ids) => void submitStage(ids)}
            onRetryJob={() => {
              const currentJob = jobs[activeGenerationStage]
              if (currentJob) {
                void run(activeGenerationStage, retryJob(currentJob.id))
              }
            }}
            approvingVariantId={approvingVariantId}
            approvedVariantId={approvedVariantId}
          />
        </section>
      </div>
      )}

      <div className="notice workflow-concept-notice">
        当前为纯 AI 概念设计流程。阶段 06～07 锁定批准空间图的机位与构图，阶段 08 只重绘红色标记区域并硬恢复其余像素；所有结果仍需人工核对，不作为施工交付依据。
      </div>
    </div>
  )
}
