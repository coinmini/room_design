import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  API_BASE,
  apiFetch,
  assetUrl,
  pollJob,
  type Job,
} from './api'
import FloorplanModule from './FloorplanModule'
import './App.css'

type ModuleId =
  | 'overview'
  | 'floorplan'
  | 'layout'
  | 'white'
  | 'effect'
  | 'material'

const modules: Array<{
  id: ModuleId
  number: string
  title: string
  short: string
}> = [
  { id: 'overview', number: '00', title: '项目总览', short: 'V0.2 Control' },
  {
    id: 'floorplan',
    number: '01',
    title: '平面图结构化',
    short: 'Floorplan Lab',
  },
  { id: 'layout', number: '02', title: 'AI 平面布局', short: 'Layout Solver' },
  { id: 'white', number: '03', title: '白模渲染', short: 'White Model' },
  { id: 'effect', number: '04', title: '参数化效果图', short: '3D Render' },
  { id: 'material', number: '05', title: '多材质替换', short: 'Material Edit' },
]

function useJobRunner() {
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (request: Promise<Response>) => {
    setBusy(true)
    setError('')
    setJob(null)
    try {
      const response = await request
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `请求失败：${response.status}`)
      }
      const created = (await response.json()) as Job
      setJob(created)
      const completed = await pollJob(created.id, setJob)
      setJob(completed)
      if (completed.status === 'FAILED') {
        setError(completed.errorMessage ?? '任务执行失败')
      }
      return completed
    } catch (value) {
      const message = value instanceof Error ? value.message : '未知错误'
      setError(message)
      throw value
    } finally {
      setBusy(false)
    }
  }

  return { job, busy, error, run }
}

function StatusBadge({ job }: { job: Job | null }) {
  if (!job) return null
  return (
    <span className={`status status-${job.status.toLowerCase()}`}>
      <i />
      {job.status}
    </span>
  )
}

function ModuleHeader({
  index,
  title,
  description,
  job,
}: {
  index: string
  title: string
  description: string
  job: Job | null
}) {
  return (
    <header className="module-header">
      <div>
        <span className="eyebrow">MODULE {index}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <StatusBadge job={job} />
    </header>
  )
}

function ErrorNotice({ message }: { message: string }) {
  if (!message) return null
  return <div className="notice notice-error">{message}</div>
}

function Overview() {
  const [health, setHealth] = useState<{
    status: string
    version: string
    blenderEnabled: boolean
  } | null>(null)

  useEffect(() => {
    apiFetch('/health')
      .then((response) => response.json())
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  return (
    <div className="page">
      <header className="hero-header">
        <span className="eyebrow">LOCAL PILOT · V0.2</span>
        <h1>
          从空间数据到
          <br />
          可沟通的设计意向
        </h1>
        <p>
          在 V0.1 四模块之上增加平面图结构化工作台，打通真实户型图、可校正结构、
          三维相机与概念效果图的完整验证闭环。
        </p>
        <div className="hero-actions">
          <span className={`service-dot ${health ? 'online' : ''}`} />
          {health
            ? `API 在线 · V${health.version} · Blender ${
                health.blenderEnabled ? '已启用' : '未启用'
              }`
            : `等待 API · ${API_BASE}`}
        </div>
      </header>

      <section className="metric-grid">
        <article>
          <strong>5</strong>
          <span>功能模块</span>
        </article>
        <article>
          <strong>1</strong>
          <span>统一任务协议</span>
        </article>
        <article>
          <strong>2</strong>
          <span>完整用户闭环</span>
        </article>
        <article>
          <strong>0</strong>
          <span>施工级承诺</span>
        </article>
      </section>

      <section className="flow-card">
        <div className="section-title">
          <span>PRIMARY FLOW</span>
          <h2>最小业务链路</h2>
        </div>
        <div className="flow">
          {['识别墙线', '人工校正', '框选房间', '3D 与机位', '效果增强'].map(
            (item, index) => (
              <div className="flow-step" key={item}>
                <small>{String(index + 1).padStart(2, '0')}</small>
                <strong>{item}</strong>
              </div>
            ),
          )}
        </div>
      </section>

      <div className="notice">
        AI 结果用于概念设计与效果预览，不作为尺寸、材料色差或施工依据。
      </div>
    </div>
  )
}

type LayoutResult = {
  layouts: Array<{
    layoutId: string
    strategy: string
    previewUrl: string
    placements: Array<Record<string, unknown>>
    metrics: {
      requirementCoverage: number
      minimumClearanceMm: number
      usableAreaRatio: number
    }
  }>
}

type SceneDraft = {
  roomType: string
  widthMm: number
  depthMm: number
  placements: Array<Record<string, unknown>>
}

function LayoutModule({
  onUseInEffect,
}: {
  onUseInEffect: (scene: SceneDraft) => void
}) {
  const runner = useJobRunner()
  const [roomType, setRoomType] = useState('living_room')
  const [width, setWidth] = useState(5200)
  const [depth, setDepth] = useState(4200)
  const result = runner.job?.result as LayoutResult | null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runner.run(
      apiFetch('/v1/layouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomType,
          widthMm: width,
          depthMm: depth,
          count: 2,
        }),
      }),
    )
  }

  return (
    <div className="page">
      <ModuleHeader
        index="02"
        title="AI 家装平面布局"
        description="在固定房间边界内生成两套无硬碰撞的家具布局，并返回可追溯指标。"
        job={runner.job}
      />
      <div className="workspace">
        <form className="control-panel" onSubmit={submit}>
          <h2>房间与需求</h2>
          <label>
            房间类型
            <select value={roomType} onChange={(e) => setRoomType(e.target.value)}>
              <option value="living_room">客厅</option>
              <option value="dining_room">餐厅</option>
              <option value="bedroom">卧室</option>
            </select>
          </label>
          <div className="field-row">
            <label>
              开间（mm）
              <input
                type="number"
                min={2400}
                max={12000}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              />
            </label>
            <label>
              进深（mm）
              <input
                type="number"
                min={2400}
                max={12000}
                value={depth}
                onChange={(e) => setDepth(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="constraint-list">
            <span>固定墙体</span>
            <span>门窗禁入</span>
            <span>标准家具</span>
            <span>两套策略</span>
          </div>
          <button className="primary-button" disabled={runner.busy}>
            {runner.busy ? '求解中…' : '生成布局方案'}
          </button>
          <ErrorNotice message={runner.error} />
        </form>

        <section className="result-panel">
          {!result && (
            <div className="empty-state">
              <span>01</span>
              <h3>等待布局求解</h3>
              <p>建议使用 5.2m × 4.2m 客厅进行首次测试。</p>
            </div>
          )}
          {result?.layouts.map((layout, index) => (
            <article className="layout-card" key={layout.layoutId}>
              <div className="result-heading">
                <div>
                  <small>方案 {String.fromCharCode(65 + index)}</small>
                  <h3>
                    {layout.strategy === 'circulation_first'
                      ? '动线优先'
                      : '空间利用优先'}
                  </h3>
                </div>
                <span>{Math.round(layout.metrics.requirementCoverage * 100)}%</span>
              </div>
              <img src={assetUrl(layout.previewUrl)} alt="家具布局预览" />
              <dl className="metrics">
                <div>
                  <dt>最小净距</dt>
                  <dd>{layout.metrics.minimumClearanceMm} mm</dd>
                </div>
                <div>
                  <dt>家具面积比</dt>
                  <dd>{Math.round(layout.metrics.usableAreaRatio * 100)}%</dd>
                </div>
              </dl>
              <button
                className="use-layout-button"
                type="button"
                onClick={() =>
                  onUseInEffect({
                    roomType,
                    widthMm: width,
                    depthMm: depth,
                    placements: layout.placements,
                  })
                }
              >
                使用此方案生成效果图 →
              </button>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}

type WhiteResult = {
  controlImageUrl: string
  outputs: Array<{ seed: number; url: string; width: number; height: number }>
  notice: string
}

function WhiteModelModule() {
  const runner = useJobRunner()
  const [file, setFile] = useState<File | null>(null)
  const [style, setStyle] = useState('modern_minimal_v1')
  const [prompt, setPrompt] = useState('浅木色、暖光、米白色布艺')
  const result = runner.job?.result as WhiteResult | null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    const form = new FormData()
    form.append('source_image', file)
    form.append('room_type', 'living_room')
    form.append('style_preset_id', style)
    form.append('prompt', prompt)
    await runner.run(apiFetch('/v1/white-model-renders', { method: 'POST', body: form }))
  }

  return (
    <div className="page">
      <ModuleHeader
        index="03"
        title="AI 白模渲染"
        description="上传单空间白模截图，提取 Canny 结构控制并生成两张固定风格候选图。"
        job={runner.job}
      />
      <div className="workspace">
        <form className="control-panel" onSubmit={submit}>
          <h2>白模输入</h2>
          <label className="file-drop">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <strong>{file ? file.name : '选择白模截图'}</strong>
            <span>PNG / JPG / WEBP · 最大 20 MB</span>
          </label>
          <label>
            风格预设
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              <option value="modern_minimal_v1">现代极简</option>
              <option value="modern_warm_v1">现代暖调</option>
              <option value="natural_wood_v1">自然原木</option>
              <option value="quiet_luxury_v1">静奢灰调</option>
            </select>
          </label>
          <label>
            补充描述
            <textarea
              maxLength={100}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={!file || runner.busy}>
            {runner.busy ? '生成中…' : '生成两张候选图'}
          </button>
          <ErrorNotice message={runner.error} />
        </form>
        <section className="result-panel image-results">
          {!result && (
            <div className="empty-state">
              <span>02</span>
              <h3>等待白模截图</h3>
              <p>首版锁定输入视角，不恢复或修改 3D。</p>
            </div>
          )}
          {result && (
            <>
              <article className="control-preview">
                <small>STRUCTURE CONTROL</small>
                <img src={assetUrl(result.controlImageUrl)} alt="Canny 控制图" />
              </article>
              {result.outputs.map((output, index) => (
                <article className="image-card" key={output.seed}>
                  <div className="result-heading">
                    <h3>候选 {index + 1}</h3>
                    <span>Seed {output.seed}</span>
                  </div>
                  <img src={assetUrl(output.url)} alt={`白模渲染候选 ${index + 1}`} />
                </article>
              ))}
              <p className="adapter-note">{result.notice}</p>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

type EffectResult = {
  provider: string
  baseRenderUrl: string
  outputUrl: string
  cameraPresetId: string
  structureCheck: { passed: boolean; wallsPreserved: boolean; cameraInsideRoom: boolean }
}

function EffectModule({ sceneDraft }: { sceneDraft: SceneDraft | null }) {
  const runner = useJobRunner()
  const [roomType, setRoomType] = useState(sceneDraft?.roomType ?? 'living_room')
  const [style, setStyle] = useState('modern_warm_v1')
  const [camera, setCamera] = useState('corner_01')
  const [useBlender, setUseBlender] = useState(true)
  const result = runner.job?.result as EffectResult | null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    await runner.run(
      apiFetch('/v1/effect-renders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomType,
          widthMm: sceneDraft?.widthMm ?? 5200,
          depthMm: sceneDraft?.depthMm ?? 4200,
          ceilingHeightMm: 2800,
          stylePresetId: style,
          cameraPresetId: camera,
          placements: sceneDraft?.placements ?? [],
          useBlender,
        }),
      }),
    )
  }

  return (
    <div className="page">
      <ModuleHeader
        index="04"
        title="参数化效果图"
        description="从结构化房间参数或家具布局创建真实三维相机和基础场景。"
        job={runner.job}
      />
      <div className="workspace">
        <form className="control-panel" onSubmit={submit}>
          <h2>场景参数</h2>
          <label>
            房间类型
            <select value={roomType} onChange={(event) => setRoomType(event.target.value)}>
              <option value="living_room">客厅</option>
              <option value="dining_room">餐厅</option>
              <option value="bedroom">卧室</option>
            </select>
          </label>
          <label>
            机位
            <select value={camera} onChange={(event) => setCamera(event.target.value)}>
              <option value="corner_01">右前角安全机位</option>
              <option value="corner_02">左前角安全机位</option>
              <option value="eye_level_01">1.6 米平视机位</option>
            </select>
          </label>
          {sceneDraft && (
            <div className="source-chip">
              已载入布局方案 · {sceneDraft.placements.length} 件家具 ·{' '}
              {sceneDraft.widthMm} × {sceneDraft.depthMm} mm
            </div>
          )}
          <label>
            风格预设
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              <option value="modern_warm_v1">现代暖调</option>
              <option value="modern_minimal_v1">现代极简</option>
              <option value="natural_wood_v1">自然原木</option>
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
              <small>关闭时使用快速基础预览</small>
            </span>
          </label>
          <button className="primary-button" disabled={runner.busy}>
            {runner.busy ? '构建场景中…' : '生成效果图'}
          </button>
          <ErrorNotice message={runner.error} />
        </form>
        <section className="result-panel image-results">
          {!result && (
            <div className="empty-state">
              <span>03</span>
              <h3>等待场景构建</h3>
              <p>Blender 首次启动可能需要 10～30 秒。</p>
            </div>
          )}
          {result && (
            <>
              <article className="image-card">
                <div className="result-heading">
                  <h3>基础渲染</h3>
                  <span>{result.provider}</span>
                </div>
                <img src={assetUrl(result.baseRenderUrl)} alt="基础场景渲染" />
              </article>
              <article className="image-card featured">
                <div className="result-heading">
                  <h3>设计意向图</h3>
                  <span>{result.cameraPresetId}</span>
                </div>
                <img src={assetUrl(result.outputUrl)} alt="设计意向效果图" />
              </article>
              <div className="check-grid">
                <span>✓ 相机在房间内</span>
                <span>✓ 墙体结构保持</span>
                <span>✓ 质量检查通过</span>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

type MaskType = 'wall' | 'floor'

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('蒙版导出失败'))))
  })
}

function MaterialModule() {
  const runner = useJobRunner()
  const [file, setFile] = useState<File | null>(null)
  const [activeMask, setActiveMask] = useState<MaskType>('wall')
  const [wallStyle, setWallStyle] = useState('warm_gray')
  const [floorStyle, setFloorStyle] = useState('oak_light')
  const [maskState, setMaskState] = useState({ wall: false, floor: false })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceImageRef = useRef<HTMLImageElement | null>(null)
  const masksRef = useRef<Record<MaskType, HTMLCanvasElement> | null>(null)
  const drawingRef = useRef(false)
  const previousRef = useRef<{ x: number; y: number } | null>(null)
  const result = runner.job?.result as
    | { outputUrl: string; comparisonUrl: string; outsideMaskPolicy: string }
    | null

  const renderCanvas = () => {
    const canvas = canvasRef.current
    const image = sourceImageRef.current
    const masks = masksRef.current
    if (!canvas || !image || !masks) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    ;(['wall', 'floor'] as MaskType[]).forEach((type) => {
      const overlay = document.createElement('canvas')
      overlay.width = canvas.width
      overlay.height = canvas.height
      const overlayContext = overlay.getContext('2d')
      if (!overlayContext) return
      overlayContext.drawImage(masks[type], 0, 0)
      overlayContext.globalCompositeOperation = 'source-in'
      overlayContext.fillStyle = type === 'wall' ? '#3B82F6' : '#F59E0B'
      overlayContext.fillRect(0, 0, overlay.width, overlay.height)
      context.save()
      context.globalAlpha = type === activeMask ? 0.42 : 0.25
      context.drawImage(overlay, 0, 0)
      context.restore()
    })
  }

  const loadSource = (selected: File | null) => {
    setFile(selected)
    setMaskState({ wall: false, floor: false })
    if (!selected) return
    const url = URL.createObjectURL(selected)
    const image = new Image()
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const scale = Math.min(1, 820 / image.width, 560 / image.height)
      canvas.width = Math.round(image.width * scale)
      canvas.height = Math.round(image.height * scale)
      const makeMask = () => {
        const value = document.createElement('canvas')
        value.width = canvas.width
        value.height = canvas.height
        return value
      }
      sourceImageRef.current = image
      masksRef.current = { wall: makeMask(), floor: makeMask() }
      renderCanvas()
      URL.revokeObjectURL(url)
    }
    image.src = url
  }

  useEffect(renderCanvas, [activeMask])

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!
    const bounds = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * canvas.width,
      y: ((event.clientY - bounds.top) / bounds.height) * canvas.height,
    }
  }

  const paint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !masksRef.current) return
    const current = point(event)
    const previous = previousRef.current ?? current
    const selected = masksRef.current[activeMask].getContext('2d')
    const otherType: MaskType = activeMask === 'wall' ? 'floor' : 'wall'
    const other = masksRef.current[otherType].getContext('2d')
    if (!selected || !other) return
    ;[
      [selected, 'source-over'],
      [other, 'destination-out'],
    ].forEach(([context, operation]) => {
      const value = context as CanvasRenderingContext2D
      value.globalCompositeOperation = operation as GlobalCompositeOperation
      value.strokeStyle = '#FFFFFF'
      value.lineCap = 'round'
      value.lineJoin = 'round'
      value.lineWidth = 42
      value.beginPath()
      value.moveTo(previous.x, previous.y)
      value.lineTo(current.x, current.y)
      value.stroke()
      value.globalCompositeOperation = 'source-over'
    })
    previousRef.current = current
    setMaskState((state) => ({ ...state, [activeMask]: true }))
    renderCanvas()
  }

  const beginPaint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true
    previousRef.current = point(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    paint(event)
  }

  const endPaint = () => {
    drawingRef.current = false
    previousRef.current = null
  }

  const clearMasks = () => {
    if (!masksRef.current) return
    ;(['wall', 'floor'] as MaskType[]).forEach((type) => {
      const mask = masksRef.current![type]
      mask.getContext('2d')?.clearRect(0, 0, mask.width, mask.height)
    })
    setMaskState({ wall: false, floor: false })
    renderCanvas()
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    const form = new FormData()
    form.append('source_image', file)
    form.append('wall_style', wallStyle)
    form.append('floor_style', floorStyle)
    if (masksRef.current && maskState.wall) {
      form.append('wall_mask', await canvasBlob(masksRef.current.wall), 'wall-mask.png')
    }
    if (masksRef.current && maskState.floor) {
      form.append('floor_mask', await canvasBlob(masksRef.current.floor), 'floor-mask.png')
    }
    await runner.run(
      apiFetch('/v1/material-replacement-renders', {
        method: 'POST',
        body: form,
      }),
    )
  }

  return (
    <div className="page">
      <ModuleHeader
        index="05"
        title="多材质替换"
        description="用画笔指定墙面与地面区域，分别生成材质并在原图上羽化合成。"
        job={runner.job}
      />
      <form className="material-workspace" onSubmit={submit}>
        <aside className="material-tools">
          <label className="file-drop compact">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => loadSource(event.target.files?.[0] ?? null)}
            />
            <strong>{file ? file.name : '选择室内图片'}</strong>
          </label>
          <div className="segmented">
            <button
              type="button"
              className={activeMask === 'wall' ? 'active' : ''}
              onClick={() => setActiveMask('wall')}
            >
              <i className="wall-color" /> 墙面
            </button>
            <button
              type="button"
              className={activeMask === 'floor' ? 'active' : ''}
              onClick={() => setActiveMask('floor')}
            >
              <i className="floor-color" /> 地面
            </button>
          </div>
          <label>
            墙面材质
            <select value={wallStyle} onChange={(event) => setWallStyle(event.target.value)}>
              <option value="warm_gray">暖灰墙漆</option>
              <option value="ivory">象牙白</option>
              <option value="sage">鼠尾草绿</option>
              <option value="clay">陶土暖色</option>
            </select>
          </label>
          <label>
            地面材质
            <select
              value={floorStyle}
              onChange={(event) => setFloorStyle(event.target.value)}
            >
              <option value="oak_light">浅色橡木</option>
              <option value="oak_natural">自然橡木</option>
              <option value="walnut">胡桃木</option>
              <option value="stone_gray">灰色石材</option>
            </select>
          </label>
          <button type="button" className="secondary-button" onClick={clearMasks}>
            清空蒙版
          </button>
          <button className="primary-button" disabled={!file || runner.busy}>
            {runner.busy ? '替换中…' : '生成材质对比'}
          </button>
          <p className="tool-tip">未绘制区域时，系统使用上下分区演示蒙版。</p>
          <ErrorNotice message={runner.error} />
        </aside>
        <section className="mask-stage">
          {!file && (
            <div className="empty-state">
              <span>04</span>
              <h3>上传图片后开始涂抹</h3>
              <p>蓝色代表墙面，橙色代表地面；两类蒙版自动互斥。</p>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={file ? 'visible' : ''}
            onPointerDown={beginPaint}
            onPointerMove={paint}
            onPointerUp={endPaint}
            onPointerCancel={endPaint}
            onPointerLeave={endPaint}
          />
          {result && (
            <article className="comparison-card">
              <div className="result-heading">
                <h3>原图 / 替换结果</h3>
                <span>蒙版外像素恢复</span>
              </div>
              <img src={assetUrl(result.comparisonUrl)} alt="材质替换对比" />
            </article>
          )}
        </section>
      </form>
    </div>
  )
}

function App() {
  const [active, setActive] = useState<ModuleId>('overview')
  const [sceneDraft, setSceneDraft] = useState<SceneDraft | null>(null)
  const activeModule = useMemo(
    () => modules.find((item) => item.id === active) ?? modules[0],
    [active],
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setActive('overview')}>
          <span>RD</span>
          <div>
            <strong>ROOM DESIGN</strong>
            <small>LOCAL MVP</small>
          </div>
        </button>
        <nav>
          {modules.map((item) => (
            <button
              key={item.id}
              className={item.id === active ? 'active' : ''}
              onClick={() => setActive(item.id)}
            >
              <span>{item.number}</span>
              <div>
                <strong>{item.title}</strong>
                <small>{item.short}</small>
              </div>
            </button>
          ))}
        </nav>
        <footer>
          <span className="service-dot online" />
          Local workspace
          <small>Concept preview only</small>
        </footer>
      </aside>

      <main>
        <div className="topbar">
          <span>
            WORKSPACE / {activeModule.number} / {activeModule.short.toUpperCase()}
          </span>
          <div>
            <span className="api-label">API · 127.0.0.1:8000</span>
            <span className="avatar">BL</span>
          </div>
        </div>
        {active === 'overview' && <Overview />}
        {active === 'floorplan' && <FloorplanModule />}
        {active === 'layout' && (
          <LayoutModule
            onUseInEffect={(scene) => {
              setSceneDraft(scene)
              setActive('effect')
            }}
          />
        )}
        {active === 'white' && <WhiteModelModule />}
        {active === 'effect' && <EffectModule sceneDraft={sceneDraft} />}
        {active === 'material' && <MaterialModule />}
      </main>
    </div>
  )
}

export default App
