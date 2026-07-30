import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { apiFetch, assetUrl, pollJob, type Job } from './api'

type EditorMode = 'review' | 'draw-wall' | 'select-room'

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
  source: 'auto' | 'manual'
  enabled: boolean
}

type FloorplanAnalysis = {
  schemaVersion: '0.2'
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
  quality: {
    candidateCount: number
    orthogonalRatio: number
    scaleDeltaRatio: number
    scaleWarning: boolean
    requiresUserConfirmation: boolean
  }
}

type FloorplanScene = {
  provider: string
  topDownUrl: string
  roomPreviewUrl: string
  effectUrl: string
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
    requiresUserConfirmation: boolean
  }
}

type ApiCompatibility = {
  state: 'checking' | 'ready' | 'outdated' | 'offline'
  version?: string
}

function supportsFloorplanApi(version: string) {
  const [major = 0, minor = 0] = version
    .split('.')
    .slice(0, 2)
    .map((value) => Number(value))
  return major > 0 || (major === 0 && minor >= 2)
}

async function detectApiCompatibility(): Promise<ApiCompatibility> {
  try {
    const response = await apiFetch('/health')
    if (!response.ok) throw new Error(`API ${response.status}`)
    const health = (await response.json()) as { version?: string }
    const version = health.version ?? 'unknown'
    return {
      state: supportsFloorplanApi(version) ? 'ready' : 'outdated',
      version,
    }
  } catch {
    return { state: 'offline' }
  }
}

function useFloorplanJob() {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (request: Promise<Response>) => {
    setBusy(true)
    setError('')
    try {
      const response = await request
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('API 未加载 V0.2 路由，请停止旧服务并重新启动后端')
        }
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `请求失败：${response.status}`)
      }
      const created = (await response.json()) as Job
      setJob(created)
      const completed = await pollJob(created.id, setJob)
      setJob(completed)
      if (completed.status === 'FAILED') {
        throw new Error(completed.errorMessage ?? '任务执行失败')
      }
      return completed
    } catch (value) {
      const message = value instanceof Error ? value.message : '未知错误'
      setError(message)
      return null
    } finally {
      setBusy(false)
    }
  }

  return { job, busy, error, run }
}

function roomFromBounds(bounds: PixelBounds): PixelBounds {
  return {
    x: Math.round(bounds.x + bounds.width * 0.05),
    y: Math.round(bounds.y + bounds.height * 0.48),
    width: Math.round(bounds.width * 0.78),
    height: Math.round(bounds.height * 0.47),
  }
}

function floorplanPoint(
  event: ReactPointerEvent<SVGSVGElement>,
  width: number,
  height: number,
): Point {
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

export default function FloorplanModule() {
  const runner = useFloorplanJob()
  const [apiCompatibility, setApiCompatibility] = useState<ApiCompatibility>({
    state: 'checking',
  })
  const [file, setFile] = useState<File | null>(null)
  const [planWidth, setPlanWidth] = useState(8150)
  const [planDepth, setPlanDepth] = useState(6060)
  const [ceilingHeight, setCeilingHeight] = useState(2800)
  const [wallThickness, setWallThickness] = useState(100)
  const [roomName, setRoomName] = useState('客餐厅')
  const [style, setStyle] = useState('modern_warm_v1')
  const [camera, setCamera] = useState('corner_02')
  const [useBlender, setUseBlender] = useState(true)
  const [analysis, setAnalysis] = useState<FloorplanAnalysis | null>(null)
  const [scene, setScene] = useState<FloorplanScene | null>(null)
  const [walls, setWalls] = useState<FloorplanWall[]>([])
  const [roomSelection, setRoomSelection] = useState<PixelBounds | null>(null)
  const [mode, setMode] = useState<EditorMode>('review')
  const [dragStart, setDragStart] = useState<Point | null>(null)
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null)
  const manualCounter = useRef(1)

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

  const enabledCount = useMemo(
    () => walls.filter((wall) => wall.enabled).length,
    [walls],
  )
  const manualCount = useMemo(
    () => walls.filter((wall) => wall.source === 'manual').length,
    [walls],
  )

  const analyze = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    setScene(null)
    const form = new FormData()
    form.append('source_image', file)
    form.append('plan_width_mm', String(planWidth))
    form.append('plan_depth_mm', String(planDepth))
    const completed = await runner.run(
      apiFetch('/v1/floorplans/analyze', { method: 'POST', body: form }),
    )
    if (!completed?.result) return
    const result = completed.result as FloorplanAnalysis
    const candidates = result.wallCandidates.map((wall, index) => ({
      ...wall,
      enabled: wall.confidence >= 0.62 || index < 12,
    }))
    setAnalysis(result)
    setWalls(candidates)
    setRoomSelection(roomFromBounds(result.detectedBounds))
    setMode('review')
  }

  const resetAnalysis = () => {
    if (!analysis) return
    setWalls(
      analysis.wallCandidates.map((wall, index) => ({
        ...wall,
        enabled: wall.confidence >= 0.62 || index < 12,
      })),
    )
    setRoomSelection(roomFromBounds(analysis.detectedBounds))
    setScene(null)
  }

  const toggleWall = (id: string) => {
    if (mode !== 'review') return
    setWalls((current) =>
      current.map((wall) =>
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
        setWalls((current) => [
          ...current,
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
    setWalls((current) => {
      const target = [...current]
        .reverse()
        .find((wall) => wall.source === 'manual')
      return target ? current.filter((wall) => wall.id !== target.id) : current
    })
  }

  const createScene = async () => {
    if (!analysis || !roomSelection || enabledCount < 4) return
    setScene(null)
    const completed = await runner.run(
      apiFetch('/v1/floorplan-scenes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: '0.2',
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
          roomSelection,
          roomName,
          stylePresetId: style,
          cameraPresetId: camera,
          useBlender,
        }),
      }),
    )
    if (completed?.result) {
      setScene(completed.result as FloorplanScene)
    }
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
    <div className="page floorplan-page">
      <header className="module-header">
        <div>
          <span className="eyebrow">MODULE 01 · V0.2 PILOT</span>
          <h1>平面图结构化生效果图</h1>
          <p>
            上传正交户型图，确认墙线并框选目标房间，再创建真实三维相机、基础场景和可替换的写实增强结果。
          </p>
        </div>
        <JobBadge job={runner.job} />
      </header>

      {apiCompatibility.state === 'outdated' && (
        <div className="notice notice-error api-version-notice">
          <span>
            当前后端是 V{apiCompatibility.version}，未包含平面图分析接口。请停止
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

      <div className="floorplan-workspace">
        <form className="floorplan-controls" onSubmit={analyze}>
          <div className="control-section">
            <span className="control-section-label">01 / INPUT</span>
            <h2>图纸与比例</h2>
            <label className="file-drop compact">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null)
                  setAnalysis(null)
                  setScene(null)
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
                  value={planWidth}
                  onChange={(event) => setPlanWidth(Number(event.target.value))}
                />
              </label>
              <label>
                总深（mm）
                <input
                  type="number"
                  min={2400}
                  max={30000}
                  value={planDepth}
                  onChange={(event) => setPlanDepth(Number(event.target.value))}
                />
              </label>
            </div>
            <button
              className="primary-button"
              disabled={
                !file ||
                runner.busy ||
                apiCompatibility.state === 'outdated' ||
                apiCompatibility.state === 'offline'
              }
            >
              {runner.busy && !analysis ? '识别中…' : '识别结构'}
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
                </div>
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
                      onChange={(event) =>
                        setCeilingHeight(Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    墙厚（mm）
                    <input
                      type="number"
                      min={60}
                      max={500}
                      value={wallThickness}
                      onChange={(event) =>
                        setWallThickness(Number(event.target.value))
                      }
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
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={useBlender}
                    onChange={(event) => setUseBlender(event.target.checked)}
                  />
                  <span>
                    <strong>启用 Blender</strong>
                    <small>关闭时生成快速结构预览</small>
                  </span>
                </label>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    runner.busy || enabledCount < 4 || roomSelection === null
                  }
                  onClick={createScene}
                >
                  {runner.busy ? '构建场景中…' : '生成 3D 与效果图'}
                </button>
              </div>
            </>
          )}
          {runner.error && <div className="notice notice-error">{runner.error}</div>}
        </form>

        <section className="floorplan-main">
          {!analysis && (
            <div className="empty-state floorplan-empty">
              <span>V0.2</span>
              <h3>先上传平面布局图</h3>
              <p>系统先给出候选墙线，所有结构都由你确认后才进入 3D。</p>
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
                  </span>
                </div>
                <div className="legend">
                  <span className="legend-auto">自动墙</span>
                  <span className="legend-manual">手工墙</span>
                  <span className="legend-room">目标房间</span>
                </div>
              </div>

              {analysis.quality.scaleWarning && (
                <div className="scale-warning">
                  宽深比例差异为{' '}
                  {(analysis.quality.scaleDeltaRatio * 100).toFixed(1)}%，请核对总尺寸；
                  V0.2 分别按 X/Y 方向缩放。
                </div>
              )}

              <div className={`floorplan-stage mode-${mode}`}>
                <svg
                  viewBox={`0 0 ${analysis.imageWidth} ${analysis.imageHeight}`}
                  onPointerDown={beginDrag}
                  onPointerMove={moveDrag}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
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
                  {walls.map((wall) => (
                    <line
                      key={wall.id}
                      className={[
                        'floorplan-wall',
                        wall.enabled ? 'enabled' : 'disabled',
                        wall.source,
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
              </div>

              {scene && (
                <section className="floorplan-results">
                  <div className="scene-summary">
                    <div>
                      <span>SCENE READY</span>
                      <h2>
                        {scene.room.name} · {scene.room.widthMm} ×{' '}
                        {scene.room.depthMm} mm
                      </h2>
                    </div>
                    <div>
                      {scene.structureCheck.wallCount} 条墙线 · {scene.provider}
                    </div>
                  </div>
                  <div className="scene-grid">
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
                    <article className="image-card featured">
                      <div className="result-heading">
                        <h3>写实增强</h3>
                        <span>ENHANCED</span>
                      </div>
                      <img src={assetUrl(scene.effectUrl)} alt="室内设计意向效果图" />
                    </article>
                  </div>
                  <div className="check-grid">
                    <span>✓ 房间位于户型范围内</span>
                    <span>✓ 真实三维相机已创建</span>
                    <span>✓ 墙体数量与结构 JSON 一致</span>
                    <span>需人工确认视觉结果</span>
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
