import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { apiFetch, assetUrl, pollJob, type Job } from './api'
import { BatchProgress } from './BatchProgress'

type EditorMode = 'review' | 'draw-wall' | 'select-room'
type RenderQuality = 'preview' | 'base' | 'final'
type GenerationMode = 'ai_direct' | 'structured_3d'

type Point = {
  x: number
  y: number
}

type PixelBounds = Point & {
  width: number
  height: number
}

type FloorplanWall = {
  id: string
  orientation: 'horizontal' | 'vertical'
  x1: number
  y1: number
  x2: number
  y2: number
  thicknessPx: number
  confidence: number
  source: 'auto' | 'manual' | 'semantic'
  enabled: boolean
}

type SemanticPoint = {
  xMm: number
  yMm: number
}

type SemanticRect = {
  xMm: number
  yMm: number
  widthMm: number
  depthMm: number
}

type SemanticRoom = {
  id: string
  type: string
  name: string
  rect: SemanticRect
  polygon: SemanticPoint[]
  confidence?: number
}

type SemanticWall = {
  id: string
  kind?: 'exterior' | 'interior' | string
  start: SemanticPoint
  end: SemanticPoint
  thicknessMm?: number
  confidence?: number
  source?: string
}

type SemanticOpening = {
  id: string
  type: 'door' | 'window' | string
  wallAxis?: 'horizontal' | 'vertical'
  segment: {
    start: SemanticPoint
    end: SemanticPoint
  }
  widthMm?: number
  roomIds?: string[]
  confidence?: number
}

type SemanticFurniture = {
  id: string
  type: string
  center: SemanticPoint
  size: {
    widthMm: number
    depthMm: number
    heightMm?: number
  }
  rotationDeg?: number
  roomId?: string
  confidence?: number
}

export type SemanticLayout = {
  version: '0.4' | '0.5'
  profileId?: string
  sourceSha256?: string
  source?: {
    provider?: string
    model?: string
    promptVersion?: string
  }
  validation?: Record<string, unknown>
  plan: {
    widthMm: number
    depthMm: number
    ceilingHeightMm?: number
  }
  rooms: SemanticRoom[]
  walls: SemanticWall[]
  openings: SemanticOpening[]
  furniture: SemanticFurniture[]
  confidence?: number
  warnings?: string[]
}

export type FloorplanApprovalInvalidationReason =
  | 'source_changed'
  | 'dimension_changed'
  | 'semantic_edited'
  | 'walls_edited'
  | 'analysis_reset'

export type FloorplanStage01Approval = {
  approvedLayoutImage: File
  approvedLayoutImageUrl: string
  semanticLayout: SemanticLayout
  planWidthMm: number
  planDepthMm: number
  analysisJobId: string
  approvedLayoutVersionId: string
  sourceSha256?: string
  detectedBounds: PixelBounds
  approvedAt: string
}

export type FloorplanModuleProps = {
  presentation?: 'standalone' | 'workflow-stage-01'
  onApproved?: (approval: FloorplanStage01Approval) => void
  onApprovalInvalidated?: (
    reason: FloorplanApprovalInvalidationReason,
  ) => void
}

type SelectedSemanticEntity = {
  kind: 'room' | 'opening' | 'furniture'
  id: string
}

type FurnitureNumericField =
  | {
      group: 'center'
      key: keyof SemanticPoint
      label: string
      min: number
      max: number
    }
  | {
      group: 'size'
      key: 'widthMm' | 'depthMm' | 'heightMm'
      label: string
      min: number
      max: number
    }

const ROOM_TYPE_OPTIONS = [
  ['living_room', '客厅'],
  ['dining_room', '餐厅'],
  ['living_dining', '客餐厅'],
  ['bedroom', '卧室'],
  ['kitchen', '厨房'],
  ['bathroom', '卫生间'],
  ['balcony', '阳台'],
  ['entrance', '玄关'],
  ['corridor', '走廊'],
  ['study', '书房'],
  ['laundry', '家政间'],
  ['storage', '储藏室'],
  ['closet', '衣帽间'],
  ['other', '其他'],
] as const

const FURNITURE_TYPE_OPTIONS = [
  'bed',
  'nightstand',
  'wardrobe',
  'desk',
  'chair',
  'sofa',
  'sectional_sofa',
  'coffee_table',
  'tv_console',
  'dining_table',
  'dining_chair',
  'kitchen_cabinet',
  'sink_cabinet',
  'cooktop_cabinet',
  'refrigerator',
  'bathtub',
  'shower',
  'toilet',
  'vanity',
  'washing_machine',
  'shelf',
  'other',
] as const

type FloorplanAnalysis = {
  schemaVersion: '0.2' | '0.3' | '0.4' | '0.5'
  sourceImageUrl: string
  overlayPreviewUrl: string
  imageWidth: number
  imageHeight: number
  planWidthMm: number
  planDepthMm: number
  scaleX: number
  scaleY: number
  detectedBounds: PixelBounds
  wallCandidates: Array<Omit<FloorplanWall, 'enabled'>>
  semanticLayout?: SemanticLayout | null
  quality: {
    candidateCount: number
    orthogonalRatio: number
    scaleDeltaRatio: number
    scaleWarning: boolean
    recognitionMode?: string
    provider?: string
    model?: string
    cacheHit?: boolean
    confidence?: number
    dimensionSource?: string
    dimensionConfidence?: number
    dimensionEvidence?: string[]
    warnings?: string[]
    visionConfigured?: boolean
    semanticProfileId?: string | null
    roomCount?: number
    openingCount?: number
    furnitureCount?: number
    requiresUserConfirmation: boolean
  }
}

type FloorplanScene = {
  provider: string
  renderType: string
  layoutMode?: string
  generationMode?: GenerationMode
  semanticProfileId?: string | null
  topDownUrl: string
  roomPreviewUrl: string
  dollhouseUrl?: string
  effectUrl: string
  baseRenderUrl?: string
  finalRenderUrl?: string
  controlImages?: {
    edgeUrl?: string
    depthUrl?: string
    normalUrl?: string
    semanticUrl?: string
  }
  enhancement?: {
    provider: string
    modelRevision: string
    notice: string
    requested: boolean
    seed?: number
    mode?: string
    controlImage?: string | null
    controlModel?: string | null
    rejectedProvider?: string | null
  }
  renderInfo?: {
    quality: RenderQuality
    width: number
    height: number
    samples: number
    enhancementProvider: string
    durationMs: number
  }
  room: {
    name: string
    widthMm: number
    depthMm: number
  }
  structureCheck: {
    passed: boolean
    wallCount: number
    scaleConsistent: boolean
    roomInsideBounds: boolean
    cameraInsideRoom: boolean
    furnitureIsSuggestion: boolean
    semanticLayoutValidated?: boolean
    semanticProfileId?: string | null
    roomCount?: number
    openingCount?: number
    furnitureCount?: number
    outputSizeMatches?: boolean
    edgeRetention?: number
    layoutDriftScore?: number
    wallsPreserved?: boolean
    validationErrors?: string[]
    validationWarnings?: string[]
    requiresUserConfirmation: boolean
  }
}

type FloorplanEnhancementCapability = {
  configured?: boolean
  reachable?: boolean | null
  provider?: string
  mode?: string
  controlNetReady?: boolean | null
  detail?: string
}

type FloorplanVisionCapability = {
  configured?: boolean
  provider?: string
  model?: string
  detail?: string
}

type ApiCompatibility = {
  state: 'checking' | 'ready' | 'outdated' | 'offline'
  version?: string
  aiConfigured?: boolean
  visionConfigured?: boolean
  floorplanVision?: FloorplanVisionCapability
  floorplanEnhancement?: FloorplanEnhancementCapability
}

type EnhancementCapabilityView = {
  tone: 'connected' | 'warning' | 'fallback'
  label: string
  detail: string
}

const SEMANTIC_WARNING_LABELS: Record<string, string> = {
  wall_topology_not_closed: '复杂户型墙线未完全闭合，已按房间边界继续建模，请复核',
  opening_not_on_wall: '门窗已自动吸附最近墙线，请复核位置',
  invalid_furniture_placement: '部分家具跨越所属房间边界，请复核摆位',
  furniture_wall_collision: '部分家具与墙体相交，请复核摆位',
  furniture_overlap: '部分家具发生重叠，请复核摆位',
  door_clearance_blocked: '部分家具占用开门范围，请复核摆位',
}

function describeEnhancementCapability(
  compatibility: ApiCompatibility,
): EnhancementCapabilityView {
  const capability = compatibility.floorplanEnhancement
  const configured = capability?.configured ?? compatibility.aiConfigured ?? false
  const provider = capability?.provider?.toLowerCase() ?? ''
  const mode = capability?.mode?.toLowerCase() ?? ''
  const isComfyUi = provider.includes('comfy') || mode.includes('comfy')

  if (configured && capability?.reachable === false) {
    return {
      tone: 'warning',
      label: '增强服务已配置，但当前不可达',
      detail:
        capability.detail ??
        '最终结果将使用本地结构保真回退；请检查增强服务地址和进程状态。',
    }
  }

  if (configured && capability?.reachable === true && isComfyUi) {
    if (capability.controlNetReady === false) {
      return {
        tone: 'warning',
        label: 'ComfyUI 已连接 · ControlNet 待安装',
        detail:
          capability.detail ??
          '当前仅可执行 SDXL img2img，安装 ControlNet 模型后可启用边缘和深度结构约束。',
      }
    }
    return {
      tone: 'connected',
      label: 'ComfyUI 已连接',
      detail:
        capability.detail ??
        '受控增强服务可用，将使用结构控制图生成最终效果。',
    }
  }

  if (configured && capability?.reachable === true) {
    if (capability.controlNetReady === false) {
      return {
        tone: 'warning',
        label: '仅 SDXL img2img · ControlNet 待安装',
        detail:
          capability.detail ??
          '增强服务已连接，但结构控制模型尚未就绪；当前结果可能退回基础图。',
      }
    }
    return {
      tone: 'connected',
      label: '受控增强服务已连接',
      detail: capability.detail ?? '本地写实增强能力已就绪。',
    }
  }

  if (configured) {
    return {
      tone: 'warning',
      label: '增强服务已配置 · 等待检测',
      detail:
        capability?.detail ??
        '后端尚未返回连通性结果；失败时会自动使用本地结构保真回退。',
    }
  }

  return {
    tone: 'fallback',
    label: '本地结构保真回退',
    detail:
      capability?.detail ??
      '未配置外部增强服务，最终图沿用通过结构校验的 Blender 基础渲染。',
  }
}

function supportsFloorplanApi(version: string) {
  const [major = 0, minor = 0] = version
    .split('.')
    .slice(0, 2)
    .map((value) => Number(value))
  return major > 0 || (major === 0 && minor >= 5)
}

async function detectApiCompatibility(): Promise<ApiCompatibility> {
  try {
    const response = await apiFetch('/health')
    if (!response.ok) throw new Error(`API ${response.status}`)
    const health = (await response.json()) as {
      version?: string
      floorplanAiConfigured?: boolean
      floorplanVisionConfigured?: boolean
      floorplanVision?: FloorplanVisionCapability
      floorplanEnhancement?: FloorplanEnhancementCapability
    }
    const version = health.version ?? 'unknown'
    return {
      state: supportsFloorplanApi(version) ? 'ready' : 'outdated',
      version,
      aiConfigured: health.floorplanAiConfigured ?? false,
      visionConfigured:
        health.floorplanVisionConfigured ??
        health.floorplanVision?.configured ??
        false,
      floorplanVision: health.floorplanVision,
      floorplanEnhancement: health.floorplanEnhancement,
    }
  } catch {
    return { state: 'offline' }
  }
}

function useFloorplanJob() {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const waitForCompletion = async (jobId: string) => {
    const completed = await pollJob(jobId, setJob)
    setJob(completed)
    if (completed.status === 'FAILED') {
      throw new Error(completed.errorMessage ?? '任务执行失败')
    }
    return completed
  }

  const run = async (request: Promise<Response>) => {
    setBusy(true)
    setError('')
    try {
      const response = await request
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('API 未加载 V0.5 视觉语义户型路由，请停止旧服务并重新启动后端')
        }
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `请求失败：${response.status}`)
      }
      const created = (await response.json()) as Job
      setJob(created)
      return await waitForCompletion(created.id)
    } catch (value) {
      const message = value instanceof Error ? value.message : '未知错误'
      setError(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  const resume = async () => {
    if (!job) return null
    setBusy(true)
    setError('')
    try {
      return await waitForCompletion(job.id)
    } catch (value) {
      const message = value instanceof Error ? value.message : '未知错误'
      setError(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  return { job, busy, error, run, resume }
}

function roomFromBounds(bounds: PixelBounds): PixelBounds {
  return {
    x: Math.round(bounds.x + bounds.width * 0.05),
    y: Math.round(bounds.y + bounds.height * 0.48),
    width: Math.round(bounds.width * 0.78),
    height: Math.round(bounds.height * 0.47),
  }
}

function cloneSemanticLayout(layout: SemanticLayout): SemanticLayout {
  return JSON.parse(JSON.stringify(layout)) as SemanticLayout
}

function semanticRoomBounds(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout | null | undefined = analysis.semanticLayout,
): PixelBounds {
  const rooms = layout?.rooms ?? []
  const preferredRoom =
    rooms.find((room) =>
      ['living_dining', 'living_room', 'living'].includes(room.type),
    ) ?? rooms[0]
  if (!preferredRoom) return roomFromBounds(analysis.detectedBounds)
  const plan = layout?.plan
  if (!plan?.widthMm || !plan.depthMm) {
    return roomFromBounds(analysis.detectedBounds)
  }
  const x =
    analysis.detectedBounds.x +
    (preferredRoom.rect.xMm / plan.widthMm) * analysis.detectedBounds.width
  const y =
    analysis.detectedBounds.y +
    (preferredRoom.rect.yMm / plan.depthMm) * analysis.detectedBounds.height
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.max(
      1,
      Math.round(
        (preferredRoom.rect.widthMm / plan.widthMm) *
          analysis.detectedBounds.width,
      ),
    ),
    height: Math.max(
      1,
      Math.round(
        (preferredRoom.rect.depthMm / plan.depthMm) *
          analysis.detectedBounds.height,
      ),
    ),
  }
}

function semanticPointToPixel(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout,
  point: SemanticPoint,
): Point {
  const plan = layout.plan
  if (!plan?.widthMm || !plan.depthMm) return { x: 0, y: 0 }
  return {
    x:
      analysis.detectedBounds.x +
      (point.xMm / plan.widthMm) * analysis.detectedBounds.width,
    y:
      analysis.detectedBounds.y +
      (point.yMm / plan.depthMm) * analysis.detectedBounds.height,
  }
}

function pixelPointToSemantic(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout,
  point: Point,
): SemanticPoint {
  const { detectedBounds: bounds } = analysis
  return {
    xMm: Math.round(
      Math.max(
        0,
        Math.min(
          layout.plan.widthMm,
          ((point.x - bounds.x) / bounds.width) * layout.plan.widthMm,
        ),
      ),
    ),
    yMm: Math.round(
      Math.max(
        0,
        Math.min(
          layout.plan.depthMm,
          ((point.y - bounds.y) / bounds.height) * layout.plan.depthMm,
        ),
      ),
    ),
  }
}

function semanticRoomPolygon(room: SemanticRoom): SemanticPoint[] {
  if (room.polygon.length >= 3) return room.polygon
  const { xMm, yMm, widthMm, depthMm } = room.rect
  return [
    { xMm, yMm },
    { xMm: xMm + widthMm, yMm },
    { xMm: xMm + widthMm, yMm: yMm + depthMm },
    { xMm, yMm: yMm + depthMm },
  ]
}

function semanticRectFromPolygon(polygon: SemanticPoint[]): SemanticRect {
  const xValues = polygon.map((point) => point.xMm)
  const yValues = polygon.map((point) => point.yMm)
  const minX = Math.min(...xValues)
  const maxX = Math.max(...xValues)
  const minY = Math.min(...yValues)
  const maxY = Math.max(...yValues)
  return {
    xMm: minX,
    yMm: minY,
    widthMm: Math.max(1, maxX - minX),
    depthMm: Math.max(1, maxY - minY),
  }
}

// 需求 1：选中房间后，在结构图上标注 P1~Pn 角点坐标与每条边的长度（mm）
function SelectedRoomGeometryOverlay({
  analysis,
  draft,
  room,
}: {
  analysis: FloorplanAnalysis
  draft: SemanticLayout
  room: SemanticRoom
}) {
  const polygon = semanticRoomPolygon(room)
  const pixels = polygon.map((point) =>
    semanticPointToPixel(analysis, draft, point),
  )
  // 多边形质心：边长标注沿外法线偏移，避免被边线本身压住
  const centroid = pixels.reduce(
    (acc, pixel) => ({ x: acc.x + pixel.x / pixels.length, y: acc.y + pixel.y / pixels.length }),
    { x: 0, y: 0 },
  )
  return (
    <g className="semantic-room-geometry">
      {polygon.map((point, index) => {
        const pixel = pixels[index]
        const nextPoint = polygon[(index + 1) % polygon.length]
        const nextPixel = pixels[(index + 1) % pixels.length]
        const lengthMm = Math.round(
          Math.hypot(nextPoint.xMm - point.xMm, nextPoint.yMm - point.yMm),
        )
        const midX = (pixel.x + nextPixel.x) / 2
        const midY = (pixel.y + nextPixel.y) / 2
        const edgeDx = nextPixel.x - pixel.x
        const edgeDy = nextPixel.y - pixel.y
        const edgeLen = Math.hypot(edgeDx, edgeDy) || 1
        // 单位法线，取朝向质心外侧的方向
        let normalX = -edgeDy / edgeLen
        let normalY = edgeDx / edgeLen
        if ((midX - centroid.x) * normalX + (midY - centroid.y) * normalY < 0) {
          normalX = -normalX
          normalY = -normalY
        }
        const labelOffset = 14
        return (
          <g key={`${room.id}-vertex-${index + 1}`}>
            <text
              className="semantic-edge-label"
              x={midX + normalX * labelOffset}
              y={midY + normalY * labelOffset}
            >
              {lengthMm}
            </text>
            <circle
              className="semantic-vertex-dot"
              cx={pixel.x}
              cy={pixel.y}
              r={5}
            />
            <text
              className="semantic-vertex-label"
              x={pixel.x}
              y={pixel.y - 10}
            >
              {`P${index + 1} (${point.xMm}, ${point.yMm})`}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  fallback = min,
) {
  if (!Number.isFinite(value)) return fallback
  return Math.round(Math.max(min, Math.min(max, value)))
}

function normalizeSemanticOpening(opening: SemanticOpening): SemanticOpening {
  const xDistance = Math.abs(
    opening.segment.end.xMm - opening.segment.start.xMm,
  )
  const yDistance = Math.abs(
    opening.segment.end.yMm - opening.segment.start.yMm,
  )
  const wallAxis = xDistance >= yDistance ? 'horizontal' : 'vertical'
  return {
    ...opening,
    wallAxis,
    widthMm: Math.max(1, wallAxis === 'horizontal' ? xDistance : yDistance),
  }
}

function semanticWallToEditor(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout,
  wall: SemanticWall,
): FloorplanWall {
  const start = semanticPointToPixel(analysis, layout, wall.start)
  const end = semanticPointToPixel(analysis, layout, wall.end)
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
  const pxPerMm = horizontal
    ? analysis.detectedBounds.height / layout.plan.depthMm
    : analysis.detectedBounds.width / layout.plan.widthMm
  return {
    id: wall.id,
    orientation: horizontal ? 'horizontal' : 'vertical',
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    thicknessPx: Math.max(3, Math.round((wall.thicknessMm ?? 100) * pxPerMm)),
    confidence: wall.confidence ?? layout.confidence ?? 1,
    source: 'semantic',
    enabled: true,
  }
}

function buildEditorWalls(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout | null,
): FloorplanWall[] {
  const candidates: FloorplanWall[] = analysis.wallCandidates.map(
    (wall, index) => ({
      ...wall,
      enabled:
        wall.source === 'semantic' || wall.confidence >= 0.62 || index < 12,
    }),
  )
  if (!layout) return candidates

  const candidateIds = new Set(candidates.map((wall) => wall.id))
  return [
    ...candidates,
    ...layout.walls
      .filter((wall) => !candidateIds.has(wall.id))
      .map((wall) => semanticWallToEditor(analysis, layout, wall)),
  ]
}

function editorWallsToSemantic(
  analysis: FloorplanAnalysis,
  layout: SemanticLayout,
  editorWalls: FloorplanWall[],
  defaultThicknessMm: number,
): SemanticWall[] {
  const originalWalls = new Map(
    (analysis.semanticLayout?.walls ?? []).map((wall) => [wall.id, wall]),
  )
  return editorWalls
    .filter((wall) => wall.enabled)
    .map((wall) => {
      const original = originalWalls.get(wall.id)
      return {
        ...original,
        id: wall.id,
        kind: original?.kind ?? 'interior',
        start: pixelPointToSemantic(analysis, layout, {
          x: wall.x1,
          y: wall.y1,
        }),
        end: pixelPointToSemantic(analysis, layout, {
          x: wall.x2,
          y: wall.y2,
        }),
        thicknessMm: original?.thicknessMm ?? defaultThicknessMm,
        confidence: original?.confidence ?? wall.confidence,
        source: original?.source ?? wall.source,
      }
    })
}

function isLowConfidence(
  confidence: number | undefined,
  fallback: number | undefined,
) {
  return (confidence ?? fallback ?? 1) < 0.9
}

function floorplanPoint(
  event: ReactPointerEvent<SVGSVGElement>,
  width: number,
  height: number,
): Point {
  const matrix = event.currentTarget.getScreenCTM()
  if (matrix) {
    const screenPoint = event.currentTarget.createSVGPoint()
    screenPoint.x = event.clientX
    screenPoint.y = event.clientY
    const localPoint = screenPoint.matrixTransform(matrix.inverse())
    return {
      x: Math.max(0, Math.min(width, localPoint.x)),
      y: Math.max(0, Math.min(height, localPoint.y)),
    }
  }

  const bounds = event.currentTarget.getBoundingClientRect()
  return {
    x: Math.max(
      0,
      Math.min(width, ((event.clientX - bounds.left) / bounds.width) * width),
    ),
    y: Math.max(
      0,
      Math.min(height, ((event.clientY - bounds.top) / bounds.height) * height),
    ),
  }
}

function integerInRange(value: number, min: number, max: number) {
  return Number.isInteger(value) && value >= min && value <= max
}

function clampPoint(point: Point, bounds: PixelBounds): Point {
  return {
    x: Math.max(bounds.x, Math.min(bounds.x + bounds.width, point.x)),
    y: Math.max(bounds.y, Math.min(bounds.y + bounds.height, point.y)),
  }
}

function JobBadge({ job }: { job: Job | null }) {
  if (!job) return null
  return (
    <span className={`status status-${job.status.toLowerCase()}`}>
      <i />
      {job.status}
    </span>
  )
}

export default function FloorplanModule({
  presentation = 'standalone',
  onApproved,
  onApprovalInvalidated,
}: FloorplanModuleProps = {}) {
  const isWorkflowStage01 = presentation === 'workflow-stage-01'
  const runner = useFloorplanJob()
  const [apiCompatibility, setApiCompatibility] = useState<ApiCompatibility>({
    state: 'checking',
  })
  const [file, setFile] = useState<File | null>(null)
  const [planWidth, setPlanWidth] = useState(0)
  const [planDepth, setPlanDepth] = useState(0)
  const [ceilingHeight, setCeilingHeight] = useState(2800)
  const [wallThickness, setWallThickness] = useState(100)
  const [roomName, setRoomName] = useState('客餐厅')
  const [style, setStyle] = useState('modern_warm_v1')
  const [camera, setCamera] = useState('corner_02')
  const [layoutPreset, setLayoutPreset] = useState('auto')
  const [generationMode, setGenerationMode] =
    useState<GenerationMode>('ai_direct')
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('final')
  const [designPrompt, setDesignPrompt] = useState('')
  const [enhancementStrength, setEnhancementStrength] = useState(0.62)
  const [analysis, setAnalysis] = useState<FloorplanAnalysis | null>(null)
  const [semanticDraft, setSemanticDraft] = useState<SemanticLayout | null>(null)
  const [semanticReviewConfirmed, setSemanticReviewConfirmed] = useState(false)
  const [selectedSemanticEntity, setSelectedSemanticEntity] =
    useState<SelectedSemanticEntity | null>(null)
  const [entityPopover, setEntityPopover] = useState<{
    kind: SelectedSemanticEntity['kind']
    id: string
    x: number
    y: number
  } | null>(null)
  const floorplanStageRef = useRef<HTMLDivElement | null>(null)
  const [scene, setScene] = useState<FloorplanScene | null>(null)
  const [walls, setWalls] = useState<FloorplanWall[]>([])
  const [roomSelection, setRoomSelection] = useState<PixelBounds | null>(null)
  const [mode, setMode] = useState<EditorMode>('review')
  const [dragStart, setDragStart] = useState<Point | null>(null)
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null)
  const manualCounter = useRef(1)
  const manualEntityCounter = useRef(1)
  const approvalEmittedRef = useRef(false)
  const resultsRef = useRef<HTMLElement | null>(null)
  const semanticEditorRef = useRef<HTMLDetailsElement | null>(null)
  const [stage01ApprovalSubmitted, setStage01ApprovalSubmitted] =
    useState(false)

  const invalidateStage01Approval = useCallback(
    (reason: FloorplanApprovalInvalidationReason) => {
      if (!approvalEmittedRef.current) return
      approvalEmittedRef.current = false
      setStage01ApprovalSubmitted(false)
      onApprovalInvalidated?.(reason)
    },
    [onApprovalInvalidated],
  )

  const checkApiCompatibility = useCallback(async () => {
    setApiCompatibility({ state: 'checking' })
    setApiCompatibility(await detectApiCompatibility())
  }, [])

  useEffect(() => {
    let active = true
    void detectApiCompatibility().then((status) => {
      if (active) setApiCompatibility(status)
    })
    return () => {
      active = false
    }
  }, [])

  const planDimensionsValid =
    integerInRange(planWidth, 2400, 30000) &&
    integerInRange(planDepth, 2400, 30000)
  const planDimensionsSubmittable =
    (planWidth === 0 || integerInRange(planWidth, 2400, 30000)) &&
    (planDepth === 0 || integerInRange(planDepth, 2400, 30000))
  const sceneDimensionsValid =
    integerInRange(ceilingHeight, 2200, 4500) &&
    integerInRange(wallThickness, 60, 500)
  const visionReady =
    apiCompatibility.state === 'ready' &&
    apiCompatibility.visionConfigured === true
  const semanticScaleMatches = Boolean(
    analysis &&
      semanticDraft &&
      analysis.planWidthMm === planWidth &&
      analysis.planDepthMm === planDepth &&
      semanticDraft.plan.widthMm === planWidth &&
      semanticDraft.plan.depthMm === planDepth,
  )
  const canAnalyze = Boolean(
    file && visionReady && planDimensionsSubmittable && !runner.busy,
  )
  const clearRecognizedPlan = (
    reason: FloorplanApprovalInvalidationReason = 'analysis_reset',
  ) => {
    invalidateStage01Approval(reason)
    setAnalysis(null)
    setSemanticDraft(null)
    setSemanticReviewConfirmed(false)
    setSelectedSemanticEntity(null)
    setWalls([])
    setRoomSelection(null)
    setScene(null)
    setMode('review')
    setDragStart(null)
    setDragCurrent(null)
  }

  const enabledCount = useMemo(
    () => walls.filter((wall) => wall.enabled).length,
    [walls],
  )
  const manualCount = useMemo(
    () => walls.filter((wall) => wall.source === 'manual').length,
    [walls],
  )
  const finalImageConfigured =
    apiCompatibility.floorplanEnhancement?.configured ??
    apiCompatibility.aiConfigured ??
    false
  const canCreateScene = Boolean(
    analysis &&
      semanticDraft &&
      visionReady &&
      planDimensionsValid &&
      sceneDimensionsValid &&
      semanticScaleMatches &&
      semanticReviewConfirmed &&
      enabledCount >= 4 &&
      roomSelection &&
      (generationMode !== 'ai_direct' || finalImageConfigured) &&
      !runner.busy,
  )
  const canApproveStage01 = Boolean(
    isWorkflowStage01 &&
      file &&
      analysis &&
      semanticDraft &&
      semanticDraft.rooms.length > 0 &&
      planDimensionsValid &&
      semanticScaleMatches &&
      semanticReviewConfirmed &&
      enabledCount >= 4 &&
      runner.job?.type === 'FLOORPLAN_ANALYZE' &&
      runner.job.status === 'SUCCEEDED' &&
      !runner.busy,
  )
  const enhancementCapability = useMemo(
    () => describeEnhancementCapability(apiCompatibility),
    [apiCompatibility],
  )
  const recognitionWarnings = useMemo(
    () =>
      Array.from(
        new Set([
          ...(analysis?.quality.warnings ?? []),
          ...(semanticDraft?.warnings ?? []),
        ]),
      ),
    [analysis, semanticDraft],
  )
  const recognitionProvider = analysis
    ? (analysis.quality.provider ??
      semanticDraft?.source?.provider ??
      (analysis.quality.recognitionMode?.includes('fixture')
        ? 'reviewed-fixture'
        : 'local'))
    : apiCompatibility.floorplanVision?.provider
  const recognitionModel = analysis
    ? (analysis.quality.model ??
      semanticDraft?.source?.model ??
      (analysis.quality.recognitionMode?.includes('fixture')
        ? semanticDraft?.profileId
        : 'geometric-fallback'))
    : apiCompatibility.floorplanVision?.model
  const recognitionConfidence =
    analysis?.quality.confidence ?? semanticDraft?.confidence

  const requireSemanticReview = (draft: SemanticLayout): SemanticLayout => ({
    ...draft,
    validation: {
      ...(draft.validation ?? {}),
      status: 'review_required',
      humanConfirmed: false,
    },
  })

  const commitSemanticDraft = (
    update: (current: SemanticLayout) => SemanticLayout,
  ) => {
    invalidateStage01Approval('semantic_edited')
    setSemanticDraft((current) =>
      current ? requireSemanticReview(update(current)) : null,
    )
    setSemanticReviewConfirmed(false)
    setScene(null)
  }

  const selectSemanticEntity = (
    kind: SelectedSemanticEntity['kind'],
    id: string,
    options: { openEditor?: boolean } = {},
  ) => {
    setSelectedSemanticEntity({ kind, id })
    if (options.openEditor ?? true) {
      if (semanticEditorRef.current) semanticEditorRef.current.open = true
    }
  }

  // Clicking an entity directly on the plan opens a floating editor; the panel
  // is parked on the opposite side of the stage from the entity so it never
  // covers the vertex markers and edge labels of the room being edited.
  const openEntityPopover = (
    kind: SelectedSemanticEntity['kind'],
    id: string,
    point: { clientX: number; clientY: number },
  ) => {
    selectSemanticEntity(kind, id, { openEditor: false })
    const stage = floorplanStageRef.current
    if (!stage) return
    const bounds = stage.getBoundingClientRect()
    const panelWidth = 336
    const panelHeight = Math.min(460, Math.max(240, bounds.height - 16))

    // 实体在舞台坐标系中的中心（考虑 viewBox meet 缩放与居中留白）
    const entityStageCenter = (): { x: number; y: number } | null => {
      if (!analysis || !semanticDraft) return null
      const scale = Math.min(
        bounds.width / analysis.imageWidth,
        bounds.height / analysis.imageHeight,
      )
      const offsetX = (bounds.width - analysis.imageWidth * scale) / 2
      const offsetY = (bounds.height - analysis.imageHeight * scale) / 2
      const toStage = (pixel: { x: number; y: number }) => ({
        x: offsetX + pixel.x * scale,
        y: offsetY + pixel.y * scale,
      })
      if (kind === 'room') {
        const room = semanticDraft.rooms.find((item) => item.id === id)
        if (!room) return null
        const pixels = semanticRoomPolygon(room).map((corner) =>
          toStage(semanticPointToPixel(analysis, semanticDraft, corner)),
        )
        const xs = pixels.map((pixel) => pixel.x)
        const ys = pixels.map((pixel) => pixel.y)
        return {
          x: (Math.min(...xs) + Math.max(...xs)) / 2,
          y: (Math.min(...ys) + Math.max(...ys)) / 2,
        }
      }
      if (kind === 'opening') {
        const opening = semanticDraft.openings.find((item) => item.id === id)
        if (!opening) return null
        const start = toStage(
          semanticPointToPixel(analysis, semanticDraft, opening.segment.start),
        )
        const end = toStage(
          semanticPointToPixel(analysis, semanticDraft, opening.segment.end),
        )
        return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      }
      const furniture = semanticDraft.furniture.find((item) => item.id === id)
      if (!furniture) return null
      return toStage(
        semanticPointToPixel(analysis, semanticDraft, furniture.center),
      )
    }

    const center = entityStageCenter()
    const x = center
      ? center.x < bounds.width / 2
        ? bounds.width - panelWidth - 8
        : 8
      : Math.max(
          8,
          Math.min(point.clientX - bounds.left + 14, bounds.width - panelWidth - 8),
        )
    const y = center
      ? center.y < bounds.height / 2
        ? bounds.height - panelHeight - 8
        : 8
      : Math.max(
          8,
          Math.min(point.clientY - bounds.top + 14, bounds.height - panelHeight - 8),
        )
    setEntityPopover({ kind, id, x, y })
  }

  const closeEntityPopover = () => setEntityPopover(null)

  const nextManualEntityId = (prefix: string) => {
    const knownIds = new Set(
      semanticDraft
        ? [
            ...semanticDraft.rooms,
            ...semanticDraft.walls,
            ...semanticDraft.openings,
            ...semanticDraft.furniture,
          ].map((item) => item.id)
        : [],
    )
    let id: string
    do {
      id = `${prefix}_manual_${manualEntityCounter.current++}`
    } while (knownIds.has(id))
    return id
  }

  const updateEditorWalls = (
    nextWalls: FloorplanWall[],
    thicknessMm = wallThickness,
  ) => {
    invalidateStage01Approval('walls_edited')
    setWalls(nextWalls)
    setScene(null)
    setSemanticReviewConfirmed(false)
    if (!analysis) return
    setSemanticDraft((current) =>
      current
        ? requireSemanticReview({
            ...current,
            walls: editorWallsToSemantic(
              analysis,
              current,
              nextWalls,
              thicknessMm,
            ),
          })
        : null,
    )
  }

  const updateSemanticRoom = (
    roomId: string,
    patch: Partial<Pick<SemanticRoom, 'name' | 'type'>>,
  ) => {
    commitSemanticDraft((current) => ({
      ...current,
      rooms: current.rooms.map((room) =>
        room.id === roomId ? { ...room, ...patch } : room,
      ),
    }))
  }

  // 顶点联动容差：其他房间中与被改顶点重合（≤3mm）的角点随动，
  // 保证共享墙/共角的房间在单边修改后仍然贴合。
  const VERTEX_LINK_TOLERANCE_MM = 3

  const updateSemanticRoomVertex = (
    roomId: string,
    pointIndex: number,
    axis: keyof SemanticPoint,
    value: number,
  ) => {
    commitSemanticDraft((current) => {
      const targetRoom = current.rooms.find((room) => room.id === roomId)
      if (!targetRoom) return current
      const oldPoint = semanticRoomPolygon(targetRoom)[pointIndex]
      if (!oldPoint) return current
      const boundValue = boundedInteger(
        value,
        0,
        axis === 'xMm' ? current.plan.widthMm : current.plan.depthMm,
        oldPoint[axis],
      )
      const delta = {
        xMm: axis === 'xMm' ? boundValue - oldPoint.xMm : 0,
        yMm: axis === 'yMm' ? boundValue - oldPoint.yMm : 0,
      }
      if (!delta.xMm && !delta.yMm) return current
      const isLinkedVertex = (point: SemanticPoint) =>
        Math.abs(point.xMm - oldPoint.xMm) <= VERTEX_LINK_TOLERANCE_MM &&
        Math.abs(point.yMm - oldPoint.yMm) <= VERTEX_LINK_TOLERANCE_MM
      const clamp = (point: SemanticPoint): SemanticPoint => ({
        xMm: boundedInteger(point.xMm, 0, current.plan.widthMm, 0),
        yMm: boundedInteger(point.yMm, 0, current.plan.depthMm, 0),
      })
      return {
        ...current,
        rooms: current.rooms.map((room) => {
          const polygon = semanticRoomPolygon(room).map((point, index) => {
            const isTarget = room.id === roomId && index === pointIndex
            // 被改顶点直接取新值；其他房间的重合角点施加同样的位移
            if (isTarget) {
              return clamp({ ...point, [axis]: boundValue })
            }
            if (isLinkedVertex(point)) {
              return clamp({
                xMm: point.xMm + delta.xMm,
                yMm: point.yMm + delta.yMm,
              })
            }
            return point
          })
          return {
            ...room,
            polygon,
            rect: semanticRectFromPolygon(polygon),
          }
        }),
      }
    })
  }

  const updateSemanticOpening = (
    openingId: string,
    update: (opening: SemanticOpening, draft: SemanticLayout) => SemanticOpening,
  ) => {
    commitSemanticDraft((current) => ({
      ...current,
      openings: current.openings.map((opening) =>
        opening.id === openingId
          ? normalizeSemanticOpening(update(opening, current))
          : opening,
      ),
    }))
  }

  const addSemanticOpening = (type: 'door' | 'window') => {
    if (!semanticDraft?.rooms.length) return
    const room = semanticDraft.rooms[0]
    const centerX = room.rect.xMm + room.rect.widthMm / 2
    const halfWidth = Math.max(50, Math.min(450, room.rect.widthMm * 0.25))
    const id = nextManualEntityId(type)
    const opening = normalizeSemanticOpening({
      id,
      type,
      wallAxis: 'horizontal',
      segment: {
        start: {
          xMm: boundedInteger(
            centerX - halfWidth,
            0,
            semanticDraft.plan.widthMm,
          ),
          yMm: boundedInteger(
            room.rect.yMm,
            0,
            semanticDraft.plan.depthMm,
          ),
        },
        end: {
          xMm: boundedInteger(
            centerX + halfWidth,
            0,
            semanticDraft.plan.widthMm,
          ),
          yMm: boundedInteger(
            room.rect.yMm,
            0,
            semanticDraft.plan.depthMm,
          ),
        },
      },
      roomIds: [room.id],
      confidence: 1,
    })
    commitSemanticDraft((current) => ({
      ...current,
      openings: [...current.openings, opening],
    }))
    selectSemanticEntity('opening', id)
  }

  const updateSemanticFurniture = (
    furnitureId: string,
    update: (
      furniture: SemanticFurniture,
      draft: SemanticLayout,
    ) => SemanticFurniture,
  ) => {
    commitSemanticDraft((current) => ({
      ...current,
      furniture: current.furniture.map((item) =>
        item.id === furnitureId ? update(item, current) : item,
      ),
    }))
  }

  const addSemanticFurniture = () => {
    if (!semanticDraft?.rooms.length) return
    const selectedRoom =
      selectedSemanticEntity?.kind === 'room'
        ? semanticDraft.rooms.find(
            (room) => room.id === selectedSemanticEntity.id,
          )
        : undefined
    const room = selectedRoom ?? semanticDraft.rooms[0]
    const id = nextManualEntityId('furniture')
    const item: SemanticFurniture = {
      id,
      type: 'other',
      center: {
        xMm: boundedInteger(
          room.rect.xMm + room.rect.widthMm / 2,
          0,
          semanticDraft.plan.widthMm,
        ),
        yMm: boundedInteger(
          room.rect.yMm + room.rect.depthMm / 2,
          0,
          semanticDraft.plan.depthMm,
        ),
      },
      size: {
        widthMm: boundedInteger(room.rect.widthMm * 0.25, 100, 1200),
        depthMm: boundedInteger(room.rect.depthMm * 0.2, 100, 1000),
        heightMm: 600,
      },
      rotationDeg: 0,
      roomId: room.id,
      confidence: 1,
    }
    commitSemanticDraft((current) => ({
      ...current,
      furniture: [...current.furniture, item],
    }))
    selectSemanticEntity('furniture', id)
  }

  const removeSemanticEntity = (
    kind: 'openings' | 'furniture',
    id: string,
  ) => {
    commitSemanticDraft((current) => ({
      ...current,
      [kind]: current[kind].filter((item) => item.id !== id),
    }))
    if (selectedSemanticEntity?.id === id) setSelectedSemanticEntity(null)
    if (entityPopover?.id === id) setEntityPopover(null)
  }

  // Shared entity editor cards: used by the long correction list and by the
  // floating popover that appears when an entity is clicked on the plan.
  const renderRoomGeometryCard = (draft: SemanticLayout, room: SemanticRoom) => (
    <article
      className={`semantic-geometry-card ${
        selectedSemanticEntity?.kind === 'room' &&
        selectedSemanticEntity.id === room.id
          ? 'selected'
          : ''
      }`}
      key={room.id}
      onClick={() => selectSemanticEntity('room', room.id, { openEditor: false })}
    >
      <div className="semantic-card-heading">
        <strong>{room.id}</strong>
        <span>POLYGON · mm</span>
      </div>
      <div className="semantic-room-row">
        <input
          aria-label={`${room.id} 名称`}
          value={room.name}
          maxLength={80}
          onChange={(event) =>
            updateSemanticRoom(room.id, {
              name: event.target.value,
            })
          }
        />
        <select
          aria-label={`${room.id} 类型`}
          value={room.type}
          onChange={(event) =>
            updateSemanticRoom(room.id, {
              type: event.target.value,
            })
          }
        >
          {ROOM_TYPE_OPTIONS.map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="semantic-coordinate-list">
        {semanticRoomPolygon(room).map((point, index) => (
          <div className="semantic-point-row" key={index}>
            <span>P{index + 1}</span>
            <label>
              X
              <input
                type="number"
                min={0}
                max={draft.plan.widthMm}
                step={1}
                value={point.xMm}
                onChange={(event) =>
                  updateSemanticRoomVertex(
                    room.id,
                    index,
                    'xMm',
                    Number(event.target.value),
                  )
                }
              />
            </label>
            <label>
              Y
              <input
                type="number"
                min={0}
                max={draft.plan.depthMm}
                step={1}
                value={point.yMm}
                onChange={(event) =>
                  updateSemanticRoomVertex(
                    room.id,
                    index,
                    'yMm',
                    Number(event.target.value),
                  )
                }
              />
            </label>
          </div>
        ))}
      </div>
    </article>
  )

  const renderOpeningGeometryCard = (
    draft: SemanticLayout,
    opening: SemanticOpening,
  ) => (
    <article
      className={`semantic-geometry-card ${
        selectedSemanticEntity?.kind === 'opening' &&
        selectedSemanticEntity.id === opening.id
          ? 'selected'
          : ''
      }`}
      key={opening.id}
      onClick={() =>
        selectSemanticEntity('opening', opening.id, { openEditor: false })
      }
    >
      <div className="semantic-card-heading">
        <strong>{opening.id}</strong>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            removeSemanticEntity('openings', opening.id)
          }}
        >
          删除
        </button>
      </div>
      <label className="semantic-full-field">
        类型
        <select
          value={opening.type}
          onChange={(event) =>
            updateSemanticOpening(opening.id, (current) => ({
              ...current,
              type: event.target.value,
            }))
          }
        >
          <option value="door">门</option>
          <option value="window">窗</option>
        </select>
      </label>
      <div className="semantic-coordinate-grid">
        {(
          [
            ['start', 'xMm', '起点 X'],
            ['start', 'yMm', '起点 Y'],
            ['end', 'xMm', '终点 X'],
            ['end', 'yMm', '终点 Y'],
          ] as const
        ).map(([endpoint, axis, label]) => (
          <label key={`${endpoint}-${axis}`}>
            {label}
            <input
              type="number"
              min={0}
              max={axis === 'xMm' ? draft.plan.widthMm : draft.plan.depthMm}
              step={1}
              value={opening.segment[endpoint][axis]}
              onChange={(event) =>
                updateSemanticOpening(opening.id, (current, currentDraft) => ({
                  ...current,
                  segment: {
                    ...current.segment,
                    [endpoint]: {
                      ...current.segment[endpoint],
                      [axis]: boundedInteger(
                        Number(event.target.value),
                        0,
                        axis === 'xMm'
                          ? currentDraft.plan.widthMm
                          : currentDraft.plan.depthMm,
                        current.segment[endpoint][axis],
                      ),
                    },
                  },
                }))
              }
            />
          </label>
        ))}
      </div>
      <fieldset className="semantic-room-links">
        <legend>关联房间</legend>
        {draft.rooms.map((room) => {
          const checked = (opening.roomIds ?? []).includes(room.id)
          return (
            <label key={room.id}>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  updateSemanticOpening(opening.id, (current) => ({
                    ...current,
                    roomIds: event.target.checked
                      ? Array.from(
                          new Set([...(current.roomIds ?? []), room.id]),
                        )
                      : (current.roomIds ?? []).filter((id) => id !== room.id),
                  }))
                }
              />
              {room.name}
            </label>
          )
        })}
      </fieldset>
    </article>
  )

  const renderFurnitureGeometryCard = (
    draft: SemanticLayout,
    item: SemanticFurniture,
  ) => (
    <article
      className={`semantic-geometry-card ${
        selectedSemanticEntity?.kind === 'furniture' &&
        selectedSemanticEntity.id === item.id
          ? 'selected'
          : ''
      }`}
      key={item.id}
      onClick={() =>
        selectSemanticEntity('furniture', item.id, { openEditor: false })
      }
    >
      <div className="semantic-card-heading">
        <strong>{item.id}</strong>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            removeSemanticEntity('furniture', item.id)
          }}
        >
          删除
        </button>
      </div>
      <div className="semantic-coordinate-grid">
        <label>
          类型
          <select
            value={item.type}
            onChange={(event) =>
              updateSemanticFurniture(item.id, (current) => ({
                ...current,
                type: event.target.value,
              }))
            }
          >
            {FURNITURE_TYPE_OPTIONS.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          房间
          <select
            value={item.roomId ?? ''}
            onChange={(event) =>
              updateSemanticFurniture(item.id, (current) => ({
                ...current,
                roomId: event.target.value,
              }))
            }
          >
            {draft.rooms.map((room) => (
              <option value={room.id} key={room.id}>
                {room.name}
              </option>
            ))}
          </select>
        </label>
        {(
          [
            {
              group: 'center',
              key: 'xMm',
              label: '中心 X',
              min: 0,
              max: draft.plan.widthMm,
            },
            {
              group: 'center',
              key: 'yMm',
              label: '中心 Y',
              min: 0,
              max: draft.plan.depthMm,
            },
            {
              group: 'size',
              key: 'widthMm',
              label: '宽',
              min: 1,
              max: draft.plan.widthMm,
            },
            {
              group: 'size',
              key: 'depthMm',
              label: '深',
              min: 1,
              max: draft.plan.depthMm,
            },
            {
              group: 'size',
              key: 'heightMm',
              label: '高',
              min: 1,
              max: 4500,
            },
          ] satisfies FurnitureNumericField[]
        ).map((field) => {
          const value =
            field.group === 'center'
              ? item.center[field.key]
              : (item.size[field.key] ?? 600)
          return (
            <label key={`${field.group}-${field.key}`}>
              {field.label}
              <input
                type="number"
                min={field.min}
                max={field.max}
                step={1}
                value={value}
                onChange={(event) => {
                  const nextValue = Number(event.target.value)
                  updateSemanticFurniture(item.id, (current) => {
                    if (field.group === 'center') {
                      return {
                        ...current,
                        center: {
                          ...current.center,
                          [field.key]: boundedInteger(
                            nextValue,
                            field.min,
                            field.max,
                            current.center[field.key],
                          ),
                        },
                      }
                    }
                    return {
                      ...current,
                      size: {
                        ...current.size,
                        [field.key]: boundedInteger(
                          nextValue,
                          field.min,
                          field.max,
                          current.size[field.key] ?? field.min,
                        ),
                      },
                    }
                  })
                }}
              />
            </label>
          )
        })}
        <label>
          旋转 °
          <input
            type="number"
            min={-359}
            max={359}
            step={1}
            value={item.rotationDeg ?? 0}
            onChange={(event) =>
              updateSemanticFurniture(item.id, (current) => ({
                ...current,
                rotationDeg: boundedInteger(
                  Number(event.target.value),
                  -359,
                  359,
                  current.rotationDeg ?? 0,
                ),
              }))
            }
          />
        </label>
      </div>
    </article>
  )

  const updateSemanticReviewConfirmation = (confirmed: boolean) => {
    if (!confirmed) invalidateStage01Approval('semantic_edited')
    setSemanticReviewConfirmed(confirmed)
    setSemanticDraft((current) =>
      current
        ? {
            ...current,
            validation: {
              ...(current.validation ?? {}),
              status: confirmed ? 'human_confirmed' : 'review_required',
              humanConfirmed: confirmed,
            },
          }
        : null,
    )
    if (!confirmed) setScene(null)
  }

  const applyAnalysisResult = (completed: Job | null) => {
    if (!completed?.result || completed.type !== 'FLOORPLAN_ANALYZE') return
    const result = completed.result as FloorplanAnalysis
    setPlanWidth(result.planWidthMm)
    setPlanDepth(result.planDepthMm)
    const draft = result.semanticLayout
      ? cloneSemanticLayout(result.semanticLayout)
      : null
    const editorWalls = buildEditorWalls(result, draft)
    const synchronizedDraft = draft
      ? {
          ...draft,
          walls: editorWallsToSemantic(
            result,
            draft,
            editorWalls,
            wallThickness,
          ),
        }
      : null
    setAnalysis(result)
    setSemanticDraft(synchronizedDraft)
    setSemanticReviewConfirmed(false)
    setSelectedSemanticEntity(null)
    setWalls(editorWalls)
    setRoomSelection(semanticRoomBounds(result, draft))
    setMode('review')
  }

  const analyze = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || !visionReady || !planDimensionsSubmittable || runner.busy) return
    invalidateStage01Approval('analysis_reset')
    setScene(null)
    setSemanticReviewConfirmed(false)
    setSelectedSemanticEntity(null)
    const form = new FormData()
    form.append('source_image', file)
    if (integerInRange(planWidth, 2400, 30000)) {
      form.append('plan_width_mm', String(planWidth))
    }
    if (integerInRange(planDepth, 2400, 30000)) {
      form.append('plan_depth_mm', String(planDepth))
    }
    const completed = await runner.run(
      apiFetch('/v1/floorplans/analyze', { method: 'POST', body: form }),
    )
    applyAnalysisResult(completed)
  }

  const resetAnalysis = () => {
    if (!analysis) return
    invalidateStage01Approval('analysis_reset')
    const draft = analysis.semanticLayout
      ? cloneSemanticLayout(analysis.semanticLayout)
      : null
    const editorWalls = buildEditorWalls(analysis, draft)
    const synchronizedDraft = draft
      ? {
          ...draft,
          walls: editorWallsToSemantic(
            analysis,
            draft,
            editorWalls,
            wallThickness,
          ),
        }
      : null
    setSemanticDraft(synchronizedDraft)
    setSemanticReviewConfirmed(false)
    setSelectedSemanticEntity(null)
    setWalls(editorWalls)
    setRoomSelection(semanticRoomBounds(analysis, draft))
    setScene(null)
  }

  const approveStage01 = () => {
    if (
      !canApproveStage01 ||
      !file ||
      !analysis ||
      !semanticDraft ||
      !runner.job
    ) {
      return
    }
    const approvedAt = new Date().toISOString()
    const approvedSemantic = cloneSemanticLayout({
      ...semanticDraft,
      validation: {
        ...(semanticDraft.validation ?? {}),
        status: 'human_confirmed',
        humanConfirmed: true,
        approvedAt,
      },
    })
    const approval: FloorplanStage01Approval = {
      approvedLayoutImage: file,
      approvedLayoutImageUrl: analysis.sourceImageUrl,
      semanticLayout: approvedSemantic,
      planWidthMm: planWidth,
      planDepthMm: planDepth,
      analysisJobId: runner.job.id,
      approvedLayoutVersionId: `${runner.job.id}:${Date.now()}`,
      sourceSha256: semanticDraft.sourceSha256,
      detectedBounds: { ...analysis.detectedBounds },
      approvedAt,
    }
    onApproved?.(approval)
    approvalEmittedRef.current = true
    setStage01ApprovalSubmitted(true)
  }

  const toggleWall = (id: string) => {
    if (mode !== 'review') return
    updateEditorWalls(
      walls.map((wall) =>
        wall.id === id ? { ...wall, enabled: !wall.enabled } : wall,
      ),
    )
  }

  const beginDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!analysis || mode === 'review') return
    const point = clampPoint(
      floorplanPoint(event, analysis.imageWidth, analysis.imageHeight),
      analysis.detectedBounds,
    )
    setDragStart(point)
    setDragCurrent(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!analysis || !dragStart || mode === 'review') return
    setDragCurrent(
      clampPoint(
        floorplanPoint(event, analysis.imageWidth, analysis.imageHeight),
        analysis.detectedBounds,
      ),
    )
  }

  const endDrag = () => {
    if (!analysis || !dragStart || !dragCurrent) {
      setDragStart(null)
      setDragCurrent(null)
      return
    }

    if (mode === 'draw-wall') {
      const horizontal =
        Math.abs(dragCurrent.x - dragStart.x) >=
        Math.abs(dragCurrent.y - dragStart.y)
      const end = horizontal
        ? { x: dragCurrent.x, y: dragStart.y }
        : { x: dragStart.x, y: dragCurrent.y }
      const length = Math.hypot(end.x - dragStart.x, end.y - dragStart.y)
      if (length >= 20) {
        updateEditorWalls([
          ...walls,
          {
            id: `wall_manual_${manualCounter.current++}`,
            orientation: horizontal ? 'horizontal' : 'vertical',
            x1: Math.round(dragStart.x),
            y1: Math.round(dragStart.y),
            x2: Math.round(end.x),
            y2: Math.round(end.y),
            thicknessPx: 8,
            confidence: 1,
            source: 'manual',
            enabled: true,
          },
        ])
      }
    } else {
      const x = Math.min(dragStart.x, dragCurrent.x)
      const y = Math.min(dragStart.y, dragCurrent.y)
      const width = Math.abs(dragCurrent.x - dragStart.x)
      const height = Math.abs(dragCurrent.y - dragStart.y)
      if (width >= 30 && height >= 30) {
        setRoomSelection({
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
        })
      }
    }
    setDragStart(null)
    setDragCurrent(null)
  }

  const removeLastManualWall = () => {
    const target = [...walls]
      .reverse()
      .find((wall) => wall.source === 'manual')
    if (target) {
      updateEditorWalls(walls.filter((wall) => wall.id !== target.id))
    }
  }

  const createScene = async () => {
    if (
      !analysis ||
      !semanticDraft ||
      !roomSelection ||
      !visionReady ||
      !planDimensionsValid ||
      !sceneDimensionsValid ||
      !semanticScaleMatches ||
      !semanticReviewConfirmed ||
      enabledCount < 4 ||
      runner.busy
    ) {
      return
    }
    setScene(null)
    const completed = await runner.run(
      apiFetch('/v1/floorplan-scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '0.5',
          sourceImageUrl: analysis.sourceImageUrl,
          imageWidth: analysis.imageWidth,
          imageHeight: analysis.imageHeight,
          planWidthMm: planWidth,
          planDepthMm: planDepth,
          ceilingHeightMm: ceilingHeight,
          wallThicknessMm: wallThickness,
          detectedBounds: analysis.detectedBounds,
          walls: walls
            .filter((wall) => wall.enabled)
            .map(({ id, x1, y1, x2, y2, source }) => ({
              id,
              x1,
              y1,
              x2,
              y2,
              source,
            })),
          semanticLayout: semanticDraft,
          semanticReviewConfirmed,
          roomSelection,
          roomName,
          stylePresetId: style,
          cameraPresetId: camera,
          layoutPresetId: layoutPreset,
          generationMode,
          renderQuality,
          enableEnhancement: renderQuality === 'final',
          enhancementStrength,
          designPrompt,
          useBlender:
            generationMode === 'structured_3d' && renderQuality !== 'preview',
        }),
      }),
    )
    showSceneResult(completed)
  }

  const showSceneResult = (completed: Job | null) => {
    if (!completed?.result || completed.type !== 'FLOORPLAN_SCENE') return
    setScene(completed.result as FloorplanScene)
    window.setTimeout(
      () => resultsRef.current?.scrollIntoView({ behavior: 'smooth' }),
      80,
    )
  }

  const resumeCurrentJob = async () => {
    const completed = await runner.resume()
    if (completed?.type === 'FLOORPLAN_ANALYZE') {
      applyAnalysisResult(completed)
      return
    }
    showSceneResult(completed)
  }

  const dragPreview =
    dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          width: Math.abs(dragCurrent.x - dragStart.x),
          height: Math.abs(dragCurrent.y - dragStart.y),
        }
      : null

  return (
    <div
      className={
        isWorkflowStage01
          ? 'floorplan-page floorplan-stage01-embedded'
          : 'page floorplan-page'
      }
    >
      {!isWorkflowStage01 && (
        <header className="module-header">
          <div>
            <span className="eyebrow">MODULE 01 · V0.5 VISION SEMANTICS</span>
            <h1>户型识别与效果图</h1>
            <p>
              上传任意清晰住宅平面图，由多模态视觉模型识别房间、墙体、门窗与家具；人工确认后生成受控概念效果图。
            </p>
          </div>
          <JobBadge job={runner.job} />
        </header>
      )}

      {apiCompatibility.state === 'outdated' && (
        <div className="notice notice-error api-version-notice">
          <span>
            当前后端是 V{apiCompatibility.version}，未包含 V0.5 视觉语义户型接口。请停止
            8000 端口的旧服务，并在项目根目录重新运行 <code>./scripts/dev.sh</code>。
          </span>
          <button type="button" onClick={checkApiCompatibility}>
            重新检测
          </button>
        </div>
      )}

      {apiCompatibility.state === 'offline' && (
        <div className="notice notice-error api-version-notice">
          <span>无法连接本地 API，请确认后端已经在 127.0.0.1:8000 启动。</span>
          <button type="button" onClick={checkApiCompatibility}>
            重新检测
          </button>
        </div>
      )}

      {apiCompatibility.state === 'ready' &&
        apiCompatibility.visionConfigured === false && (
          <div className="notice notice-error api-version-notice vision-config-notice">
            <span>
              未配置多模态视觉识别服务。为避免把几何墙线回退误当成任意户型语义识别，当前网页已禁用识别与建模；请在后端配置
              <code> KUYAO_API_KEY </code>后重启 API。
            </span>
            <button type="button" onClick={checkApiCompatibility}>
              重新检测
            </button>
          </div>
        )}

      <div className="floorplan-workspace">
        <form className="floorplan-controls" onSubmit={analyze}>
          <div className="control-section">
            <span className="control-section-label">01 / INPUT</span>
            <h2>图纸与比例</h2>
            <label className="file-drop compact">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={runner.busy}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null)
                  setPlanWidth(0)
                  setPlanDepth(0)
                  clearRecognizedPlan('source_changed')
                }}
              />
              <strong>{file ? file.name : '选择平面布局图'}</strong>
              <span>推荐清晰正交图 · 最大 20 MB</span>
            </label>
            <div className="field-row">
              <label>
                总宽（mm）
                <input
                  type="number"
                  min={2400}
                  max={30000}
                  placeholder="自动识别"
                  value={planWidth || ''}
                  disabled={runner.busy}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (value !== planWidth) {
                      clearRecognizedPlan('dimension_changed')
                    }
                    setPlanWidth(value)
                  }}
                />
              </label>
              <label>
                总深（mm）
                <input
                  type="number"
                  min={2400}
                  max={30000}
                  placeholder="自动识别"
                  value={planDepth || ''}
                  disabled={runner.busy}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (value !== planDepth) {
                      clearRecognizedPlan('dimension_changed')
                    }
                    setPlanDepth(value)
                  }}
                />
              </label>
            </div>
            <p className="dimension-help">
              {analysis?.quality.dimensionSource &&
              analysis.quality.dimensionSource !== 'user_input'
                ? `${
                    analysis.quality.dimensionSource === 'object_scale_estimate'
                      ? '原图无尺寸标注，已按门洞/标准家具尺度估算'
                      : '已自动识别'
                  }为 ${analysis.planWidthMm} × ${analysis.planDepthMm} mm${
                    analysis.quality.dimensionConfidence !== undefined
                      ? `，置信度 ${Math.round(analysis.quality.dimensionConfidence * 100)}%`
                      : ''
                  }；请对照图纸核对。`
                : '尺寸可留空：系统优先读取总尺寸标注；没有标注时会按门洞和标准家具尺度给出低置信度估算。'}
            </p>
            <button
              className="primary-button"
              disabled={!canAnalyze}
            >
              {runner.busy && !analysis ? '识别尺寸与结构中…' : '识别尺寸与结构'}
            </button>
          </div>

          {analysis && (
            <>
              <div className="control-section">
                <span className="control-section-label">02 / CORRECT</span>
                <h2>结构校正</h2>
                <div className="editor-modes">
                  <button
                    type="button"
                    className={mode === 'review' ? 'active' : ''}
                    onClick={() => setMode('review')}
                  >
                    点选墙线
                  </button>
                  <button
                    type="button"
                    className={mode === 'draw-wall' ? 'active' : ''}
                    onClick={() => setMode('draw-wall')}
                  >
                    补画墙线
                  </button>
                  <button
                    type="button"
                    className={mode === 'select-room' ? 'active' : ''}
                    onClick={() => setMode('select-room')}
                  >
                    框选房间
                  </button>
                </div>
                <div className="wall-stats">
                  <span>
                    <strong>{enabledCount}</strong> 已启用
                  </span>
                  <span>
                    <strong>{manualCount}</strong> 手工墙线
                  </span>
                  <span>
                    <strong>{analysis.quality.candidateCount}</strong> 候选
                  </span>
                  {semanticDraft && (
                    <span>
                      <strong>{semanticDraft.rooms.length}</strong> 房间
                    </span>
                  )}
                </div>
                <div
                  className={`semantic-recognition-card ${
                    semanticDraft ? 'is-ready' : 'is-warning'
                  }`}
                >
                  <div className="semantic-recognition-heading">
                    <strong>
                      {semanticDraft ? '视觉语义识别完成' : '仅几何墙线回退'}
                    </strong>
                    {recognitionConfidence !== undefined && (
                      <span>
                        置信度 {Math.round(recognitionConfidence * 100)}%
                      </span>
                    )}
                  </div>
                  <dl>
                    <div>
                      <dt>Provider</dt>
                      <dd>{recognitionProvider || 'local'}</dd>
                    </div>
                    <div>
                      <dt>Model</dt>
                      <dd>{recognitionModel || 'geometric-fallback'}</dd>
                    </div>
                    <div>
                      <dt>Mode</dt>
                      <dd>
                        {analysis.quality.recognitionMode || 'unknown'}
                        {analysis.quality.cacheHit ? ' · 缓存复用' : ''}
                      </dd>
                    </div>
                  </dl>
                  {semanticDraft ? (
                    <p>
                      {semanticDraft.rooms.length} 个房间 ·{' '}
                      {semanticDraft.openings.length} 个门窗 ·{' '}
                      {semanticDraft.furniture.length} 件家具；当前副本可人工校正并作为
                      后续 AI 平面布局的语义基准。
                    </p>
                  ) : (
                    <p>
                      未生成 semanticLayout，无法进入 AI 平面布局；请检查视觉服务配置或识别警告。
                    </p>
                  )}
                  {analysis.quality.visionConfigured === false && (
                    <p className="semantic-service-warning">
                      多模态视觉服务未配置，本次结果没有经过房间、门窗和家具视觉识别。
                    </p>
                  )}
                  {recognitionWarnings.length > 0 && (
                    <ul>
                      {recognitionWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
                {semanticDraft && (
                  <details
                    className="semantic-entity-editor"
                    ref={semanticEditorRef}
                  >
                    <summary>房间、门窗与家具校正</summary>
                    <div className="semantic-entity-groups">
                      <section>
                        <h3>房间</h3>
                        {semanticDraft.rooms.map((room) =>
                          renderRoomGeometryCard(semanticDraft, room),
                        )}
                      </section>
                      <section>
                        <div className="semantic-group-heading">
                          <h3>门窗</h3>
                          <div>
                            <button
                              type="button"
                              onClick={() => addSemanticOpening('door')}
                            >
                              + 门
                            </button>
                            <button
                              type="button"
                              onClick={() => addSemanticOpening('window')}
                            >
                              + 窗
                            </button>
                          </div>
                        </div>
                        {semanticDraft.openings.length ? (
                          semanticDraft.openings.map((opening) =>
                            renderOpeningGeometryCard(semanticDraft, opening),
                          )
                        ) : (
                          <p>未识别门窗</p>
                        )}
                      </section>
                      <section>
                        <div className="semantic-group-heading">
                          <h3>家具</h3>
                          <button
                            type="button"
                            onClick={addSemanticFurniture}
                          >
                            + 家具
                          </button>
                        </div>
                        {semanticDraft.furniture.length ? (
                          semanticDraft.furniture.map((item) =>
                            renderFurnitureGeometryCard(semanticDraft, item),
                          )
                        ) : (
                          <p>未识别家具</p>
                        )}
                      </section>
                    </div>
                  </details>
                )}
                <label
                  className={`semantic-review-confirmation ${
                    semanticReviewConfirmed ? 'confirmed' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={semanticReviewConfirmed}
                    disabled={!semanticDraft}
                    onChange={(event) =>
                      updateSemanticReviewConfirmation(event.target.checked)
                    }
                  />
                  <span>
                    <strong>我已核对语义布局</strong>
                    <small>
                      已确认房间边界、墙线、门窗、家具和尺寸；任何后续编辑都会要求重新确认。
                    </small>
                  </span>
                </label>
                {isWorkflowStage01 && (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={!canApproveStage01 || stage01ApprovalSubmitted}
                    onClick={approveStage01}
                  >
                    {stage01ApprovalSubmitted
                      ? '✓ Stage 01 已批准'
                      : '批准 Stage 01 并进入 AI 平面布局'}
                  </button>
                )}
                <button
                  type="button"
                  className="secondary-button"
                  onClick={removeLastManualWall}
                  disabled={manualCount === 0}
                >
                  撤销上一条补线
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={resetAnalysis}
                >
                  重置识别结果
                </button>
              </div>

              {!isWorkflowStage01 && (
                <div className="control-section">
                <span className="control-section-label">03 / SCENE</span>
                <h2>目标场景</h2>
                <label>
                  房间名称
                  <input
                    value={roomName}
                    maxLength={40}
                    onChange={(event) => setRoomName(event.target.value)}
                  />
                </label>
                <div className="field-row">
                  <label>
                    层高（mm）
                    <input
                      type="number"
                      min={2200}
                      max={4500}
                      value={ceilingHeight}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setCeilingHeight(value)
                        commitSemanticDraft((current) => ({
                          ...current,
                          plan: {
                            ...current.plan,
                            ceilingHeightMm: value,
                          },
                        }))
                      }}
                    />
                  </label>
                  <label>
                    墙厚（mm）
                    <input
                      type="number"
                      min={60}
                      max={500}
                      value={wallThickness}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setWallThickness(value)
                        updateEditorWalls(walls, value)
                      }}
                    />
                  </label>
                </div>
                <label>
                  风格预设
                  <select
                    value={style}
                    onChange={(event) => setStyle(event.target.value)}
                  >
                    <option value="modern_warm_v1">现代暖调</option>
                    <option value="modern_minimal_v1">现代极简</option>
                    <option value="natural_wood_v1">自然原木</option>
                    <option value="quiet_luxury_v1">静奢暖灰</option>
                  </select>
                </label>
                <label>
                  户型软装模板
                  <select
                    value={layoutPreset}
                    onChange={(event) => setLayoutPreset(event.target.value)}
                  >
                    <option value="auto">自动匹配</option>
                    <option value="studio">开间 Studio</option>
                    <option value="one_bedroom">一室一厅</option>
                    <option value="two_bedroom">两室一厅</option>
                  </select>
                </label>
                <label>
                  机位
                  <select
                    value={camera}
                    onChange={(event) => setCamera(event.target.value)}
                  >
                    <option value="corner_01">右前角安全机位</option>
                    <option value="corner_02">左前角安全机位</option>
                    <option value="eye_level_01">1.6 米平视机位</option>
                  </select>
                </label>
                <span className="field-label">生成模式</span>
                <div className="generation-mode" role="group" aria-label="生成模式">
                  {(
                    [
                      ['ai_direct', 'AI 直出', '原图 + 语义图 → gpt-image-2'],
                      ['structured_3d', '精确三维', 'Semantic → Blender → 增强'],
                    ] as const
                  ).map(([value, label, description]) => (
                    <button
                      type="button"
                      key={value}
                      className={generationMode === value ? 'active' : ''}
                      onClick={() => {
                        setGenerationMode(value)
                        if (value === 'ai_direct') setRenderQuality('final')
                        setScene(null)
                      }}
                    >
                      <strong>{label}</strong>
                      <small>{description}</small>
                    </button>
                  ))}
                </div>
                {generationMode === 'structured_3d' ? (
                  <>
                    <span className="field-label">输出质量</span>
                    <div className="render-quality" role="group" aria-label="输出质量">
                      {(
                        [
                          ['preview', '快速结构', '不启动 Blender'],
                          ['base', '基础渲染', 'Cycles + PBR'],
                          ['final', '最终增强', '控制图 + 增强'],
                        ] as const
                      ).map(([value, label, description]) => (
                        <button
                          type="button"
                          key={value}
                          className={renderQuality === value ? 'active' : ''}
                          onClick={() => setRenderQuality(value)}
                        >
                          <strong>{label}</strong>
                          <small>{description}</small>
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="generation-mode-help">
                    跳过 Blender，直接使用原始平面图、人工确认的语义结构图和风格参考图生成完整鸟瞰效果图。
                  </p>
                )}
                {renderQuality === 'final' && (
                  <>
                    <label className="enhancement-strength-field">
                      <span className="range-heading">
                        <span>写实重绘强度</span>
                        <strong>{Math.round(enhancementStrength * 100)}%</strong>
                      </span>
                      <input
                        type="range"
                        min={0.35}
                        max={0.85}
                        step={0.05}
                        value={enhancementStrength}
                        onChange={(event) =>
                          setEnhancementStrength(Number(event.target.value))
                        }
                      />
                      <small>
                        {generationMode === 'ai_direct'
                          ? '控制 AI 直出时的装修与资产重绘幅度；布局仍以原图和语义图为准。'
                          : '60%–70% 会把白模家具和材质重绘为写实软装，同时由 Depth ControlNet 约束墙体与相机。'}
                      </small>
                    </label>
                    <label>
                      设计补充要求
                      <textarea
                        value={designPrompt}
                        maxLength={500}
                        rows={3}
                        placeholder="例如：浅橡木、米白布艺、落地窗帘、自然日光、绿植和地毯"
                        onChange={(event) => setDesignPrompt(event.target.value)}
                      />
                    </label>
                    {!finalImageConfigured && (
                      <p className="provider-hint">
                        {generationMode === 'ai_direct'
                          ? 'AI 直出需要配置 gpt-image-2；可切换“精确三维”先输出 Blender 基础图。'
                          : '当前未配置图像增强服务，将输出 Blender 基础图和完整控制图。'}
                      </p>
                    )}
                  </>
                )}
                <button
                  type="button"
                  className="primary-button"
                  disabled={!canCreateScene}
                  onClick={createScene}
                >
                  {runner.busy
                    ? '构建场景中…'
                    : !semanticReviewConfirmed
                      ? '请先核对并确认布局'
                      : renderQuality === 'final'
                      ? '生成受控最终图'
                      : renderQuality === 'base'
                        ? '生成基础渲染'
                        : '生成结构预览'}
                </button>
                </div>
              )}
            </>
          )}
          {runner.busy && runner.job && ['QUEUED', 'RUNNING'].includes(runner.job.status) && (
            <BatchProgress
              job={runner.job}
              estimate={
                isWorkflowStage01
                  ? '视觉识别通常需要 1-3 分钟'
                  : '本机渲染通常需要 4-8 分钟'
              }
            />
          )}
          {runner.busy && runner.job?.status === 'RUNNING' && (
            <div className="notice job-running-notice">
              <strong>
                {isWorkflowStage01 ? '正在识别功能区与结构' : '本机正在生成'}
              </strong>
              <span>
                {isWorkflowStage01
                  ? '多模态视觉模型正在提取房间、墙体、门窗与家具，请保持页面打开。'
                  : '最终增强通常需要 4–8 分钟；浏览器会持续等待，CPU/GPU 高负载与风扇转动属于正常现象。'}
              </span>
            </div>
          )}
          {runner.error && (
            <div className="notice notice-error job-error-notice">
              <span>{runner.error}</span>
              {runner.job &&
                !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(
                  runner.job.status,
                ) && (
                  <button
                    type="button"
                    disabled={runner.busy}
                    onClick={resumeCurrentJob}
                  >
                    {runner.busy ? '等待中…' : '继续等待 / 获取结果'}
                  </button>
                )}
            </div>
          )}
        </form>

        <section className="floorplan-main">
          {!analysis && (
            <div className="empty-state floorplan-empty">
              <span>V0.5</span>
              <h3>先上传平面布局图</h3>
              <p>
                {isWorkflowStage01
                  ? '系统先识别房间、开口、家具和墙体，人工确认后进入 AI 平面布局。'
                  : '系统先识别房间、开口、家具和墙体，结构确认后才进入 3D。'}
              </p>
            </div>
          )}
          {analysis && (
            <>
              <div className="editor-toolbar">
                <div>
                  <strong>
                    {mode === 'review'
                      ? '点击线段启用或排除'
                      : mode === 'draw-wall'
                        ? '拖拽补画水平或垂直墙线'
                        : '拖拽框选一个目标房间'}
                  </strong>
                  <span>
                    图纸 {analysis.imageWidth} × {analysis.imageHeight}px · 比例 X{' '}
                    {analysis.scaleX.toFixed(2)} / Y {analysis.scaleY.toFixed(2)} mm/px
                    {semanticDraft ? ' · 点击房间 / 门窗 / 家具可直接修改参数' : ''}
                  </span>
                </div>
                <div className="legend">
                  <span className="legend-auto">自动墙</span>
                  {semanticDraft && (
                    <span className="legend-semantic">语义结构</span>
                  )}
                  <span className="legend-manual">手工墙</span>
                  <span className="legend-room">目标房间</span>
                  {semanticDraft && (
                    <>
                      <span className="legend-opening">门窗</span>
                      <span className="legend-furniture">家具</span>
                      <span className="legend-low-confidence">低置信度</span>
                    </>
                  )}
                </div>
              </div>

              {analysis.quality.scaleWarning && (
                <div className="scale-warning">
                  宽深比例差异为{' '}
                  {(analysis.quality.scaleDeltaRatio * 100).toFixed(1)}%，请核对总尺寸；
                  V0.5 分别按 X/Y 方向缩放。
                </div>
              )}

              <div
                className={`floorplan-stage mode-${mode}`}
                ref={floorplanStageRef}
              >
                <svg
                  viewBox={`0 0 ${analysis.imageWidth} ${analysis.imageHeight}`}
                  onPointerDown={beginDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  onClick={closeEntityPopover}
                >
                  <image
                    href={assetUrl(analysis.sourceImageUrl)}
                    width={analysis.imageWidth}
                    height={analysis.imageHeight}
                    preserveAspectRatio="none"
                  />
                  <rect
                    className="detected-bounds"
                    x={analysis.detectedBounds.x}
                    y={analysis.detectedBounds.y}
                    width={analysis.detectedBounds.width}
                    height={analysis.detectedBounds.height}
                  />
                  {semanticDraft?.rooms.map((room) => {
                    const center = semanticPointToPixel(
                      analysis,
                      semanticDraft,
                      {
                        xMm: room.rect.xMm + room.rect.widthMm / 2,
                        yMm: room.rect.yMm + room.rect.depthMm / 2,
                      },
                    )
                    return (
                      <g
                        key={room.id}
                        className={[
                          isLowConfidence(
                            room.confidence,
                            recognitionConfidence,
                          )
                            ? 'low-confidence'
                            : '',
                          selectedSemanticEntity?.kind === 'room' &&
                          selectedSemanticEntity.id === room.id
                            ? 'semantic-selected'
                            : '',
                        ].join(' ')}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEntityPopover('room', room.id, event)
                        }}
                      >
                        <polygon
                          className="semantic-room"
                          points={semanticRoomPolygon(room)
                            .map((point) =>
                              semanticPointToPixel(
                                analysis,
                                semanticDraft,
                                point,
                              ),
                            )
                            .map(({ x, y }) => `${x},${y}`)
                            .join(' ')}
                        >
                          <title>
                            {room.name} · {room.type}
                          </title>
                        </polygon>
                        <text
                          className="semantic-room-label"
                          x={center.x}
                          y={center.y}
                        >
                          {room.name}
                        </text>
                      </g>
                    )
                  })}
                  {semanticDraft &&
                    selectedSemanticEntity?.kind === 'room' &&
                    (() => {
                      const selectedRoom = semanticDraft.rooms.find(
                        (item) => item.id === selectedSemanticEntity.id,
                      )
                      return selectedRoom ? (
                        <SelectedRoomGeometryOverlay
                          analysis={analysis}
                          draft={semanticDraft}
                          room={selectedRoom}
                        />
                      ) : null
                    })()}
                  {semanticDraft?.furniture.map((item) => {
                    const center = semanticPointToPixel(
                      analysis,
                      semanticDraft,
                      item.center,
                    )
                    const width =
                      (item.size.widthMm / semanticDraft.plan.widthMm) *
                      analysis.detectedBounds.width
                    const depth =
                      (item.size.depthMm / semanticDraft.plan.depthMm) *
                      analysis.detectedBounds.height
                    return (
                      <g
                        key={item.id}
                        className={`semantic-furniture ${
                          isLowConfidence(
                            item.confidence,
                            recognitionConfidence,
                          )
                            ? 'low-confidence'
                            : ''
                        } ${
                          selectedSemanticEntity?.kind === 'furniture' &&
                          selectedSemanticEntity.id === item.id
                            ? 'semantic-selected'
                            : ''
                        }`}
                        transform={`rotate(${item.rotationDeg ?? 0} ${center.x} ${center.y})`}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEntityPopover('furniture', item.id, event)
                        }}
                      >
                        <rect
                          x={center.x - width / 2}
                          y={center.y - depth / 2}
                          width={width}
                          height={depth}
                        >
                          <title>{item.type}</title>
                        </rect>
                      </g>
                    )
                  })}
                  {walls.map((wall) => (
                    <line
                      key={wall.id}
                      className={[
                        'floorplan-wall',
                        wall.enabled ? 'enabled' : 'disabled',
                        wall.source,
                        isLowConfidence(
                          wall.confidence,
                          recognitionConfidence,
                        )
                          ? 'low-confidence'
                          : '',
                      ].join(' ')}
                      x1={wall.x1}
                      y1={wall.y1}
                      x2={wall.x2}
                      y2={wall.y2}
                      strokeWidth={Math.max(3, wall.thicknessPx)}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleWall(wall.id)
                      }}
                    />
                  ))}
                  {semanticDraft?.openings.map((opening) => {
                    const start = semanticPointToPixel(
                      analysis,
                      semanticDraft,
                      opening.segment.start,
                    )
                    const end = semanticPointToPixel(
                      analysis,
                      semanticDraft,
                      opening.segment.end,
                    )
                    return (
                      <line
                        key={opening.id}
                        className={`semantic-opening ${opening.type} ${
                          isLowConfidence(
                            opening.confidence,
                            recognitionConfidence,
                          )
                            ? 'low-confidence'
                            : ''
                        } ${
                          selectedSemanticEntity?.kind === 'opening' &&
                          selectedSemanticEntity.id === opening.id
                            ? 'semantic-selected'
                            : ''
                        }`}
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        onClick={(event) => {
                          event.stopPropagation()
                          openEntityPopover('opening', opening.id, event)
                        }}
                      >
                        <title>{opening.type}</title>
                      </line>
                    )
                  })}
                  {roomSelection && (
                    <rect
                      className="room-selection"
                      x={roomSelection.x}
                      y={roomSelection.y}
                      width={roomSelection.width}
                      height={roomSelection.height}
                    />
                  )}
                  {dragPreview && mode === 'select-room' && (
                    <rect
                      className="room-selection preview"
                      x={dragPreview.x}
                      y={dragPreview.y}
                      width={dragPreview.width}
                      height={dragPreview.height}
                    />
                  )}
                  {dragStart && dragCurrent && mode === 'draw-wall' && (
                    <line
                      className="floorplan-wall manual preview"
                      x1={dragStart.x}
                      y1={dragStart.y}
                      x2={
                        Math.abs(dragCurrent.x - dragStart.x) >=
                        Math.abs(dragCurrent.y - dragStart.y)
                          ? dragCurrent.x
                          : dragStart.x
                      }
                      y2={
                        Math.abs(dragCurrent.x - dragStart.x) >=
                        Math.abs(dragCurrent.y - dragStart.y)
                          ? dragStart.y
                          : dragCurrent.y
                      }
                    />
                  )}
                </svg>
                {entityPopover &&
                  semanticDraft &&
                  (() => {
                    const title =
                      entityPopover.kind === 'room'
                        ? '房间参数'
                        : entityPopover.kind === 'opening'
                          ? '门窗参数'
                          : '家具参数'
                    const card =
                      entityPopover.kind === 'room'
                        ? (() => {
                            const room = semanticDraft.rooms.find(
                              (item) => item.id === entityPopover.id,
                            )
                            return room
                              ? renderRoomGeometryCard(semanticDraft, room)
                              : null
                          })()
                        : entityPopover.kind === 'opening'
                          ? (() => {
                              const opening = semanticDraft.openings.find(
                                (item) => item.id === entityPopover.id,
                              )
                              return opening
                                ? renderOpeningGeometryCard(
                                    semanticDraft,
                                    opening,
                                  )
                                : null
                            })()
                          : (() => {
                              const item = semanticDraft.furniture.find(
                                (entry) => entry.id === entityPopover.id,
                              )
                              return item
                                ? renderFurnitureGeometryCard(semanticDraft, item)
                                : null
                            })()
                    if (!card) return null
                    return (
                      <div
                        className="semantic-entity-popover"
                        style={{ left: entityPopover.x, top: entityPopover.y }}
                      >
                        <header>
                          <strong>{title}</strong>
                          <button
                            type="button"
                            aria-label="关闭"
                            onClick={closeEntityPopover}
                          >
                            ×
                          </button>
                        </header>
                        <div className="semantic-entity-popover-body">{card}</div>
                      </div>
                    )
                  })()}
              </div>

              {!isWorkflowStage01 && scene && (
                <section className="floorplan-results" ref={resultsRef}>
                  <div
                    className={`scene-summary ${
                      scene.structureCheck.passed ? '' : 'scene-summary-failed'
                    }`}
                  >
                    <div>
                      <span>
                        {scene.structureCheck.passed
                          ? 'SCENE READY'
                          : 'STRUCTURE REVIEW REQUIRED'}
                      </span>
                      <h2>
                        {scene.room.name} · {scene.room.widthMm} ×{' '}
                        {scene.room.depthMm} mm
                      </h2>
                    </div>
                    <div>
                      {scene.structureCheck.wallCount} 条墙线 ·{' '}
                      {scene.structureCheck.semanticLayoutValidated &&
                        `${scene.structureCheck.roomCount} 房间 · `}
                      {scene.renderInfo
                        ? `${scene.renderInfo.width} × ${scene.renderInfo.height} · ${scene.renderInfo.durationMs} ms`
                        : scene.provider}
                    </div>
                  </div>
                  <div className="render-comparison">
                    <article className="image-card">
                      <div className="result-heading">
                        <div>
                          <h3>
                            {scene.generationMode === 'ai_direct'
                              ? '结构参考'
                              : '基础渲染'}
                          </h3>
                          <p>
                            {scene.generationMode === 'ai_direct'
                              ? '原始平面图与确认后的 Semantic 约束'
                              : 'Blender 几何、PBR 材质和固定相机'}
                          </p>
                        </div>
                        <span>
                          {scene.generationMode === 'ai_direct'
                            ? 'SOURCE + SEMANTIC'
                            : 'BASE RGB'}
                        </span>
                      </div>
                      <img
                        src={assetUrl(
                          scene.baseRenderUrl ??
                            scene.dollhouseUrl ??
                            scene.effectUrl,
                        )}
                        alt="全屋三维基础渲染"
                      />
                    </article>
                    <article className="image-card final-render-card">
                      <div className="result-heading">
                        <div>
                          <h3>最终增强</h3>
                          <p>
                            {scene.enhancement?.provider ??
                              '兼容模式增强结果'}
                            {scene.enhancement?.mode
                              ? ` · ${scene.enhancement.mode}`
                              : ''}
                          </p>
                        </div>
                        <span>FINAL</span>
                      </div>
                      <img
                        src={assetUrl(scene.finalRenderUrl ?? scene.effectUrl)}
                        alt="受控增强后的全屋三维效果图"
                      />
                      <div
                        className={`enhancement-capability enhancement-capability-${enhancementCapability.tone}`}
                      >
                        <span className="enhancement-capability-indicator" />
                        <div>
                          <strong>{enhancementCapability.label}</strong>
                          <p>{enhancementCapability.detail}</p>
                        </div>
                      </div>
                    </article>
                  </div>
                  {scene.enhancement?.notice && (
                    <div
                      className={`enhancement-notice ${
                        scene.structureCheck.passed
                          ? ''
                          : 'enhancement-notice-failed'
                      }`}
                    >
                      <strong>增强状态</strong>
                      <span>{scene.enhancement.notice}</span>
                    </div>
                  )}
                  <details className="render-diagnostics">
                    <summary>控制图与诊断结果</summary>
                    <div className="control-map-grid">
                      <article className="image-card">
                        <div className="result-heading">
                          <h3>结构边缘</h3>
                          <span>EDGE</span>
                        </div>
                        <img
                          src={assetUrl(
                            scene.controlImages?.edgeUrl ?? scene.topDownUrl,
                          )}
                          alt="结构边缘控制图"
                        />
                      </article>
                      {scene.controlImages?.depthUrl && (
                        <article className="image-card">
                          <div className="result-heading">
                            <h3>相机深度</h3>
                            <span>DEPTH</span>
                          </div>
                          <img
                            src={assetUrl(scene.controlImages.depthUrl)}
                            alt="相机深度控制图"
                          />
                        </article>
                      )}
                      {scene.controlImages?.normalUrl && (
                        <article className="image-card">
                          <div className="result-heading">
                            <h3>表面法线</h3>
                            <span>NORMAL</span>
                          </div>
                          <img
                            src={assetUrl(scene.controlImages.normalUrl)}
                            alt="表面法线控制图"
                          />
                        </article>
                      )}
                      {scene.controlImages?.semanticUrl && (
                        <article className="image-card">
                          <div className="result-heading">
                            <h3>语义分区</h3>
                            <span>SEMANTIC</span>
                          </div>
                          <img
                            src={assetUrl(scene.controlImages.semanticUrl)}
                            alt="场景语义控制图"
                          />
                        </article>
                      )}
                      <article className="image-card">
                        <div className="result-heading">
                          <h3>结构俯视</h3>
                          <span>TOP DOWN</span>
                        </div>
                        <img src={assetUrl(scene.topDownUrl)} alt="三维结构俯视图" />
                      </article>
                      <article className="image-card">
                        <div className="result-heading">
                          <h3>室内机位</h3>
                          <span>CAMERA</span>
                        </div>
                        <img
                          src={assetUrl(scene.roomPreviewUrl)}
                          alt="目标房间室内机位"
                        />
                      </article>
                    </div>
                  </details>
                  <div className="structure-metrics">
                    <span
                      className={
                        scene.structureCheck.roomInsideBounds
                          ? 'metric-pass'
                          : 'metric-fail'
                      }
                    >
                      {scene.structureCheck.roomInsideBounds ? '✓' : '×'} 房间范围
                    </span>
                    <span
                      className={
                        scene.structureCheck.cameraInsideRoom
                          ? 'metric-pass'
                          : 'metric-fail'
                      }
                    >
                      {scene.structureCheck.cameraInsideRoom ? '✓' : '×'} 相机安全
                    </span>
                    <span
                      className={
                        scene.structureCheck.wallsPreserved === false
                          ? 'metric-fail'
                          : 'metric-pass'
                      }
                    >
                      {scene.structureCheck.wallsPreserved === false ? '×' : '✓'}{' '}
                      结构边缘保留
                      {scene.structureCheck.edgeRetention !== undefined
                        ? ` ${(scene.structureCheck.edgeRetention * 100).toFixed(1)}%`
                        : ''}
                    </span>
                    <span
                      className={
                        scene.structureCheck.outputSizeMatches === false
                          ? 'metric-fail'
                          : 'metric-pass'
                      }
                    >
                      {scene.structureCheck.outputSizeMatches === false ? '×' : '✓'}{' '}
                      输出尺寸一致
                    </span>
                    {scene.structureCheck.semanticLayoutValidated && (
                      <span className="metric-pass">
                        ✓ 语义户型已校验 · {scene.structureCheck.roomCount} 房间 /{' '}
                        {scene.structureCheck.openingCount} 开口 /{' '}
                        {scene.structureCheck.furnitureCount} 家具
                      </span>
                    )}
                    {(scene.structureCheck.validationWarnings ?? []).map(
                      (warning) => (
                        <span className="metric-warn" key={warning}>
                          ! {SEMANTIC_WARNING_LABELS[warning] ?? warning}
                        </span>
                      ),
                    )}
                    {scene.structureCheck.furnitureIsSuggestion ? (
                      <span className="metric-warn">! 家具为自动软装建议</span>
                    ) : (
                      <span className="metric-pass">✓ 家具来自原图语义布局</span>
                    )}
                    <span className="metric-warn">! 视觉结果需人工确认</span>
                  </div>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
