import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  API_BASE,
  apiFetch,
  assetUrl,
  pollJob,
  type Job,
} from './api'
import AssetLibrary from './AssetLibrary'
import FloorplanModule from './FloorplanModule'
import { ProjectCanvas } from './canvas'
import './App.css'

const AiDesignWorkflow = lazy(() => import('./legacy/AiDesignWorkflow'))

type ModuleId =
  | 'overview'
  | 'workflow'
  | 'canvas'
  | 'floorplan'
  | 'white'
  | 'material'
  | 'assets'

type ModuleDef = {
  id: ModuleId
  number: string
  title: string
  short: string
  badge?: string
}

const iconProps = {
  width: 17,
  height: 17,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const moduleIcons: Record<ModuleId, React.ReactNode> = {
  overview: (
    <svg {...iconProps}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </svg>
  ),
  workflow: (
    <svg {...iconProps}>
      <circle cx="5" cy="5" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="19" r="2" />
      <path d="M7 5h4a4 4 0 0 1 4 4v0a3 3 0 0 0 3 3" />
      <path d="M7 19h4a4 4 0 0 0 4-4v0a3 3 0 0 1 3-3" />
    </svg>
  ),
  canvas: (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <circle cx="8" cy="11" r="1.6" />
      <circle cx="14" cy="9" r="1.6" />
      <path d="M9.4 10.4l3.2-1.2" />
      <path d="M15.4 9.8l2.2 2.4" />
    </svg>
  ),
  floorplan: (
    <svg {...iconProps}>
      <rect x="3" y="3" width="18" height="18" rx="1.6" />
      <path d="M3 12h9V3" />
      <path d="M12 12v9h9" />
      <path d="M15 12h6" />
    </svg>
  ),
  white: (
    <svg {...iconProps}>
      <path d="M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2l8-4.4z" />
      <path d="M12 12l8-4.4" />
      <path d="M12 12v9.6" />
      <path d="M12 12L4 7.2" />
    </svg>
  ),
  material: (
    <svg {...iconProps}>
      <path d="M12 3.5s6.5 7 6.5 11a6.5 6.5 0 1 1-13 0c0-4 6.5-11 6.5-11z" />
    </svg>
  ),
  assets: (
    <svg {...iconProps}>
      <rect x="3" y="4" width="18" height="16" rx="1.8" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M3 17l5-4 4 3 4.5-3.5L21 16" />
    </svg>
  ),
}

const showLegacyTools = import.meta.env.VITE_SHOW_LEGACY_TOOLS === 'true'

const navGroups: Array<{ label: string; items: ModuleDef[] }> = [
  {
    label: '工作台',
    items: [
      { id: 'overview', number: '00', title: '项目总览', short: 'Overview' },
      {
        id: 'canvas',
        number: 'C',
        title: '无限画布',
        short: 'Project Canvas',
        badge: '主路径',
      },
    ],
  },
  {
    label: '调整阶段',
    items: [
      {
        id: 'material',
        number: '04',
        title: 'AI 多材质替换',
        short: 'Material Edit',
      },
    ],
  },
  ...(showLegacyTools
    ? [
        {
          label: '历史实验能力',
          items: [
            {
              id: 'workflow' as const,
              number: 'H0',
              title: '旧版 8 阶段向导',
              short: 'Legacy Workflow',
              badge: '废弃',
            },
            {
              id: 'floorplan' as const,
              number: 'H1',
              title: '旧版户型工作室',
              short: 'Legacy Floorplan',
              badge: '实验',
            },
            {
              id: 'white' as const,
              number: 'H2',
              title: '白模渲染实验',
              short: 'Legacy White Model',
              badge: '实验',
            },
          ],
        },
      ]
    : []),
  {
    label: '资产中心',
    items: [
      { id: 'assets', number: '05', title: '我的资产', short: 'Asset Library' },
    ],
  },
]

const modules: ModuleDef[] = navGroups.flatMap((group) => group.items)

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

  const reset = () => {
    if (busy) return
    setJob(null)
    setError('')
  }

  return { job, busy, error, run, reset }
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
        <span className="eyebrow">LOCAL PILOT · V0.6</span>
        <h1>
          从空间数据到
          <br />
          可沟通的设计意向
        </h1>
        <p>
          围绕功能区标注、AI 平面布局、彩平、轴侧、空间效果与局部修改，建立逐步确认、持续派生的设计项目闭环。
        </p>
        <div className="hero-actions">
          <span className={`service-dot ${health ? 'online' : ''}`} />
          {health
            ? `AI 工作流 API 在线 · V${health.version}`
            : `等待 API · ${API_BASE}`}
        </div>
      </header>

      <section className="metric-grid">
        <article>
          <strong>8</strong>
          <span>规划设计阶段</span>
        </article>
        <article>
          <strong>1</strong>
          <span>统一任务协议</span>
        </article>
        <article>
          <strong>3</strong>
          <span>已实现 AI 视觉阶段</span>
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
          {['功能区标注', 'AI 平面布局', 'AI 彩平', 'AI 轴侧', '空间效果'].map(
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

type WhiteGenerationMode = 'ai_quick' | 'local_preview'

type WhiteStructureAudit = {
  performed: boolean
  passed: boolean
  inputSizeMatches: boolean
  edgeRetention: number
  layoutDriftScore: number
  tolerancePx: number
  registrationApplied: boolean
  perspectiveTransformApplied: boolean
  requiresUserConfirmation: boolean
}

type WhiteLocalResult = {
  generationMode?: 'local_preview'
  provider: string
  modelRevision: string
  controlImageUrl: string
  outputs: Array<{ seed: number; url: string; width: number; height: number }>
  notice: string
}

type WhiteAiResult = {
  generationMode: 'ai_quick'
  provider: string
  model: string
  modelRevision: string
  promptVersion: string
  controlImageUrl: string
  outputs: Array<{
    url: string
    width: number
    height: number
    provider: string
    model: string
    structureAudit: WhiteStructureAudit
  }>
  structureAudit: WhiteStructureAudit
  isConceptOnly: boolean
  constructionReady: boolean
  requiresUserConfirmation: boolean
  notice: string
}

type WhiteResult = WhiteLocalResult | WhiteAiResult

function WhiteModelModule() {
  const runner = useJobRunner()
  const [generationMode, setGenerationMode] =
    useState<WhiteGenerationMode>('ai_quick')
  const [file, setFile] = useState<File | null>(null)
  const [styleReferences, setStyleReferences] = useState<File[]>([])
  const [style, setStyle] = useState('modern_minimal_v1')
  const [prompt, setPrompt] = useState('浅木色、暖光、米白色布艺')
  const result = runner.job?.result as WhiteResult | null
  const isAiResult = result?.generationMode === 'ai_quick'

  const switchGenerationMode = (nextMode: WhiteGenerationMode) => {
    if (nextMode === generationMode || runner.busy) return
    setGenerationMode(nextMode)
    runner.reset()
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file) return
    const form = new FormData()
    form.append('source_image', file)
    form.append('generation_mode', generationMode)
    form.append('room_type', 'living_room')
    form.append('style_preset_id', style)
    form.append('prompt', prompt)
    form.append('count', generationMode === 'ai_quick' ? '1' : '2')
    if (generationMode === 'ai_quick') {
      styleReferences.forEach((reference) =>
        form.append('style_references', reference),
      )
    }
    await runner.run(apiFetch('/v1/white-model-renders', { method: 'POST', body: form }))
  }

  return (
    <div className="page">
      <ModuleHeader
        index="03"
        title="AI 白模渲染"
        description="上传白模截图：默认由 AI 生成一张受结构审计约束的概念效果图，也可切换本地保真预览生成两张候选。"
        job={runner.job}
      />
      <div className="workspace white-workspace">
        <form className="control-panel white-control-panel" onSubmit={submit}>
          <h2>白模输入</h2>
          <div className="white-mode-switch" aria-label="白模生成模式">
            <button
              className={generationMode === 'ai_quick' ? 'active' : ''}
              type="button"
              disabled={runner.busy}
              onClick={() => switchGenerationMode('ai_quick')}
            >
              <strong>AI 快速渲染</strong>
              <span>白模 + 风格参考 → AI 概念图</span>
              <small>DEFAULT</small>
            </button>
            <button
              className={generationMode === 'local_preview' ? 'active' : ''}
              type="button"
              disabled={runner.busy}
              onClick={() => switchGenerationMode('local_preview')}
            >
              <strong>本地保真预览</strong>
              <span>Canny 锁边 + 两张固定候选</span>
              <small>LOCAL</small>
            </button>
          </div>
          <p className="white-mode-note">
            {generationMode === 'ai_quick'
              ? 'AI 会重新绘制材质、灯光和软装；结构审计只用于提示偏移风险，结果仍需人工确认。'
              : '完全在本机处理，用于快速核对输入视角和边线，不代表最终写实质量。'}
          </p>
          <label className="file-drop">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <strong>{file ? file.name : '选择白模截图'}</strong>
            <span>PNG / JPG / WEBP · 最大 20 MB</span>
          </label>
          {generationMode === 'ai_quick' && (
            <div className="white-reference-section">
              <div className="white-field-heading">
                <div>
                  <strong>风格参考图</strong>
                  <span>只参考材质、色彩与氛围，不作为空间结构</span>
                </div>
                <small>{styleReferences.length} / 3</small>
              </div>
              <label className="file-drop compact white-reference-drop">
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(event) =>
                    setStyleReferences(
                      Array.from(event.target.files ?? []).slice(0, 3),
                    )
                  }
                />
                <strong>
                  {styleReferences.length
                    ? '重新选择参考图'
                    : '选择最多 3 张风格参考图'}
                </strong>
                <span>可选 · 支持多选</span>
              </label>
              {styleReferences.length > 0 && (
                <div className="white-reference-files">
                  {styleReferences.map((reference) => (
                    <span key={`${reference.name}-${reference.lastModified}`}>
                      {reference.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
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
            {generationMode === 'ai_quick' ? '设计要求' : '补充描述'}
            <textarea
              maxLength={500}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <button className="primary-button" disabled={!file || runner.busy}>
            {runner.busy
              ? '生成中…'
              : generationMode === 'ai_quick'
                ? '生成 AI 概念效果图'
                : '生成两张本地候选图'}
          </button>
          <ErrorNotice message={runner.error} />
        </form>
        <section className="result-panel image-results white-results">
          {!result && (
            <div className="empty-state">
              <span>{generationMode === 'ai_quick' ? 'AI' : '02'}</span>
              <h3>等待白模截图</h3>
              <p>
                {generationMode === 'ai_quick'
                  ? '输出二维概念效果图，并报告结构边线保留率。'
                  : '锁定输入视角，不恢复或修改 3D。'}
              </p>
            </div>
          )}
          {result && isAiResult && (
            <>
              <article className="control-preview">
                <small>STRUCTURE CONTROL · AUDIT INPUT</small>
                <img src={assetUrl(result.controlImageUrl)} alt="结构审计控制图" />
              </article>
              {result.outputs.map((output, index) => {
                const audit = output.structureAudit ?? result.structureAudit
                const auditPassed = audit?.passed === true
                return (
                  <article
                    className={`image-card white-ai-result-card ${
                      auditPassed ? 'audit-passed' : 'audit-failed'
                    }`}
                    key={output.url}
                  >
                    <div className="result-heading white-ai-result-heading">
                      <div>
                        <small>AI CONCEPT IMAGE {index + 1}</small>
                        <h3>AI 快速渲染</h3>
                      </div>
                      <span className={auditPassed ? 'passed' : 'failed'}>
                        {auditPassed ? '结构审计通过' : '结构需人工复核'}
                      </span>
                    </div>
                    <img src={assetUrl(output.url)} alt="AI 白模概念渲染" />
                    <div className="white-result-summary">
                      <dl>
                        <div>
                          <dt>Provider</dt>
                          <dd>{output.provider || result.provider}</dd>
                        </div>
                        <div>
                          <dt>Model</dt>
                          <dd>{output.model || result.model}</dd>
                        </div>
                      </dl>
                      <div className="white-concept-status">
                        <span>概念图</span>
                        <span>非三维模型</span>
                        <span>需人工确认</span>
                      </div>
                      <section
                        className={`white-audit ${
                          auditPassed ? 'passed' : 'failed'
                        }`}
                      >
                        <header>
                          <strong>结构一致性审计</strong>
                          <span>{auditPassed ? 'PASSED' : 'REVIEW REQUIRED'}</span>
                        </header>
                        <dl>
                          <div>
                            <dt>边线保留率</dt>
                            <dd>{Math.round((audit?.edgeRetention ?? 0) * 100)}%</dd>
                          </div>
                          <div>
                            <dt>布局漂移分</dt>
                            <dd>{(audit?.layoutDriftScore ?? 0).toFixed(3)}</dd>
                          </div>
                          <div>
                            <dt>审计容差</dt>
                            <dd>{audit?.tolerancePx ?? 0} px</dd>
                          </div>
                          <div>
                            <dt>输入尺寸</dt>
                            <dd>{audit?.inputSizeMatches ? '一致' : '不一致'}</dd>
                          </div>
                        </dl>
                        {!auditPassed && (
                          <p>
                            图片已经生成，但结构审计未通过。请对照原白模检查墙线、开口与透视后再使用。
                          </p>
                        )}
                      </section>
                      <p className="white-model-boundary">
                        这是二维概念图，不是可编辑模型，也不会回写或修改 Blender 场景。
                      </p>
                      <p className="white-ai-notice">{result.notice}</p>
                      <a
                        className="white-download"
                        href={assetUrl(output.url)}
                        download
                        target="_blank"
                        rel="noreferrer"
                      >
                        下载概念图
                      </a>
                    </div>
                  </article>
                )
              })}
            </>
          )}
          {result && !isAiResult && (
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

type MaskType = 'wall' | 'floor'

type MaterialStructureCheck = {
  passed?: boolean
  outsideMaskPixelsPreserved?: boolean
  outsideMaskChangedPixelRatio?: number
  edgeRetention?: number
}

type MaterialResult = {
  outputUrl: string
  comparisonUrl: string
  regions: Array<{ semanticClass: string; stylePresetId: string }>
  outsideMaskPolicy: string
  generationMode?: 'ai_edit' | 'ai_edit_fallback' | 'local_edit'
  provider?: string
  model?: string
  requestedProvider?: string
  fallbackUsed?: boolean
  fallbackReason?: string | null
  notice?: string
  structureCheck?: MaterialStructureCheck
}

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
  const result = runner.job?.result as MaterialResult | null
  const isAiResult =
    result?.generationMode === 'ai_edit' && result.fallbackUsed !== true
  const isFallbackResult = Boolean(
    result &&
      (result.generationMode === 'ai_edit_fallback' || result.fallbackUsed),
  )
  const isLegacyLocalResult = Boolean(result && !result.generationMode)

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
    runner.reset()
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
        index="04"
        title="AI 多材质替换"
        description="用墙面与地面蒙版限定编辑区域，再由 AI 重绘真实材质；AI 不可用时会明确回退到本地保真替换。"
        job={runner.job}
      />
      <form className="material-workspace" onSubmit={submit}>
        <aside className="material-tools">
          <label className="file-drop compact">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={runner.busy}
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
            <select
              value={wallStyle}
              disabled={runner.busy}
              onChange={(event) => setWallStyle(event.target.value)}
            >
              <option value="warm_gray">暖灰墙漆</option>
              <option value="ivory">象牙白</option>
              <option value="sage">鼠尾草绿</option>
              <option value="clay">陶土暖色</option>
              <option value="microcement_cream">奶油微水泥</option>
              <option value="travertine_beige">米黄洞石</option>
            </select>
          </label>
          <label>
            地面材质
            <select
              value={floorStyle}
              disabled={runner.busy}
              onChange={(event) => setFloorStyle(event.target.value)}
            >
              <option value="oak_light">浅色橡木</option>
              <option value="oak_natural">自然橡木</option>
              <option value="walnut">胡桃木</option>
              <option value="stone_gray">灰色石材</option>
              <option value="terrazzo_light">浅色水磨石</option>
            </select>
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={runner.busy}
            onClick={clearMasks}
          >
            清空蒙版
          </button>
          <button className="primary-button" disabled={!file || runner.busy}>
            {runner.busy ? 'AI 正在重绘材质…' : '生成 AI 材质方案'}
          </button>
          <p className="tool-tip">
            可只涂墙面或地面；未涂蒙版时系统使用默认上下分区。AI 结果仍需人工确认。
          </p>
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
            <div className="material-result">
              <section
                className={`material-provider-state ${
                  isAiResult
                    ? 'is-ai'
                    : isFallbackResult
                      ? 'is-fallback'
                      : 'is-local'
                }`}
              >
                <span className="material-provider-indicator" />
                <div>
                  <strong>
                    {isAiResult
                      ? 'AI 材质重绘完成'
                      : isFallbackResult
                        ? 'AI 服务未完成，已回退本地保真替换'
                        : '本地材质替换结果'}
                  </strong>
                  <p>
                    {result.notice ??
                      (isLegacyLocalResult
                        ? '这是旧版或本地处理结果，不代表 AI Provider 已执行。'
                        : '材质结果已生成，请结合蒙版边界与结构检查人工复核。')}
                  </p>
                </div>
                <dl>
                  <div>
                    <dt>实际 Provider</dt>
                    <dd>{result.provider ?? '本地处理器'}</dd>
                  </div>
                  <div>
                    <dt>模型</dt>
                    <dd>{result.model ?? '本地材质合成'}</dd>
                  </div>
                  {result.requestedProvider && (
                    <div>
                      <dt>请求 Provider</dt>
                      <dd>{result.requestedProvider}</dd>
                    </div>
                  )}
                </dl>
                {isFallbackResult && result.fallbackReason && (
                  <p className="material-fallback-reason">
                    回退原因：{result.fallbackReason}
                  </p>
                )}
              </section>
              <div className="material-result-grid">
                <article
                  className={`comparison-card material-final-card ${
                    isAiResult
                      ? 'is-ai'
                      : isFallbackResult
                        ? 'is-fallback'
                        : 'is-local'
                  }`}
                >
                  <div className="result-heading">
                    <h3>材质重绘结果</h3>
                    <span>
                      {isAiResult
                        ? 'AI EDIT'
                        : isFallbackResult
                          ? 'AI FALLBACK'
                          : 'LOCAL EDIT'}
                    </span>
                  </div>
                  <img src={assetUrl(result.outputUrl)} alt="材质重绘结果" />
                </article>
                <article className="comparison-card">
                  <div className="result-heading">
                    <h3>原图 / 替换结果</h3>
                    <span>蒙版边界复核</span>
                  </div>
                  <img src={assetUrl(result.comparisonUrl)} alt="材质替换对比" />
                </article>
              </div>
              <div className="material-audit-status">
                <span>
                  {result.structureCheck?.passed === true
                    ? '✓ 结构检查通过'
                    : result.structureCheck?.passed === false
                      ? '! 结构检查需复核'
                      : '— 未返回结构审计'}
                </span>
                <span>
                  {result.structureCheck?.outsideMaskPixelsPreserved === true
                    ? '✓ 蒙版外像素保留'
                    : result.structureCheck?.outsideMaskPixelsPreserved === false
                      ? '! 蒙版外存在变化'
                      : result.outsideMaskPolicy === 'source_pixels_preserved'
                        ? '蒙版外采用原图像素'
                        : result.outsideMaskPolicy}
                </span>
                {result.structureCheck?.outsideMaskChangedPixelRatio !==
                  undefined && (
                  <span>
                    蒙版外变化{' '}
                    {(
                      result.structureCheck.outsideMaskChangedPixelRatio * 100
                    ).toFixed(2)}
                    %
                  </span>
                )}
                {result.structureCheck?.edgeRetention !== undefined && (
                  <span>
                    边缘保留{' '}
                    {Math.round(result.structureCheck.edgeRetention * 100)}%
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
      </form>
    </div>
  )
}

function CanvasModule({ onOpenAssets }: { onOpenAssets: () => void }) {
  const [projectId, setProjectId] = useState(
    () => localStorage.getItem('room_design_canvas_project_id') ?? '',
  )
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>(
    [],
  )
  const [bootError, setBootError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const response = await apiFetch('/v1/projects')
        if (!response.ok) throw new Error(`加载项目失败：${response.status}`)
        const list = (await response.json()) as Array<{ id: string; name: string }>
        if (cancelled) return
        setProjects(list)
        if (projectId && list.some((item) => item.id === projectId)) return
        if (list[0]) {
          setProjectId(list[0].id)
          localStorage.setItem('room_design_canvas_project_id', list[0].id)
          return
        }
        // 默认项目策略：无项目时自动创建一个本地默认项目
        const created = await apiFetch('/v1/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '默认画布项目' }),
        })
        if (!created.ok) throw new Error('无法创建默认项目')
        const project = (await created.json()) as { id: string; name: string }
        if (cancelled) return
        setProjects([project])
        setProjectId(project.id)
        localStorage.setItem('room_design_canvas_project_id', project.id)
      } catch (value) {
        if (!cancelled) {
          setBootError(value instanceof Error ? value.message : '项目初始化失败')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  return (
    <div className="page" style={{ height: 'calc(100vh - 88px)', minHeight: 640 }}>
      <header className="module-header" style={{ marginBottom: 12 }}>
        <div>
          <span className="eyebrow">CANVAS</span>
          <h1>无限画布</h1>
          <p>
            按 workflowStage 分列展示本项目谱系；支持缩放平移、小地图与节点批准。
            仅显示当前 project 下的资产，不会合并其它项目或无项目资产。
          </p>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="eyebrow">PROJECT</span>
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value)
              localStorage.setItem(
                'room_design_canvas_project_id',
                event.target.value,
              )
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {bootError ? <div className="notice notice-error">{bootError}</div> : null}
      {projectId ? (
        <div style={{ height: 'calc(100% - 110px)' }}>
          <ProjectCanvas projectId={projectId} onOpenAssets={onOpenAssets} />
        </div>
      ) : (
        <div className="notice">正在准备默认项目…</div>
      )}
    </div>
  )
}

type AppProps = {
  initialModule?: string | null
  initialAssetId?: string | null
}

function resolveModuleId(value?: string | null): ModuleId | null {
  if (
    value === 'canvas' ||
    value === 'assets' ||
    value === 'workflow' ||
    value === 'overview' ||
    value === 'material' ||
    value === 'floorplan' ||
    value === 'white'
  ) {
    return value
  }
  return null
}

function App({ initialModule = null, initialAssetId = null }: AppProps = {}) {
  const [bootAssetId] = useState<string | null>(
    () => initialAssetId?.trim() || null,
  )
  const [active, setActive] = useState<ModuleId>(() => {
    // 带 assetId 深链时默认打开资产库
    if (initialAssetId?.trim()) {
      return resolveModuleId(initialModule) ?? 'assets'
    }
    const fromQuery = resolveModuleId(initialModule)
    // 旧向导仅在显式 legacy 开关时允许；否则落到画布
    if (fromQuery === 'workflow' && !showLegacyTools) {
      return 'canvas'
    }
    if (fromQuery) return fromQuery
    // 兼容旧深链：WorkspaceBridge 曾写入 sessionStorage
    const fromSession = sessionStorage.getItem('room_design_workspace_module')
    sessionStorage.removeItem('room_design_workspace_module')
    const resolved = resolveModuleId(fromSession)
    if (resolved === 'workflow' && !showLegacyTools) return 'canvas'
    return resolved ?? 'canvas'
  })
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
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  className={item.id === active ? 'active' : ''}
                  onClick={() => setActive(item.id)}
                >
                  <span className="nav-icon">{moduleIcons[item.id]}</span>
                  <div>
                    <strong>{item.title}</strong>
                    <small>{item.short}</small>
                  </div>
                  {item.badge && <em className="nav-badge">{item.badge}</em>}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <footer>
          <span className="service-dot online" />
          本地个人资产空间
          <small>生成结果自动保存</small>
        </footer>
      </aside>

      <main>
        <div className="topbar">
          <span>
            WORKSPACE / {activeModule.number} / {activeModule.short.toUpperCase()}
          </span>
          <div>
            <span className="api-label local-account-label">
              本地个人账户 · BL
            </span>
            <span className="avatar">BL</span>
          </div>
        </div>
        {active === 'overview' && <Overview />}
        <section
          className="persistent-workflow-module"
          hidden={active !== 'workflow'}
        >
          {active === 'workflow' ? (
            <Suspense fallback={<div className="notice">加载旧版向导…</div>}>
              <AiDesignWorkflow />
            </Suspense>
          ) : null}
        </section>
        {active === 'canvas' && (
          <CanvasModule onOpenAssets={() => setActive('assets')} />
        )}
        {active === 'floorplan' && <FloorplanModule />}
        {active === 'white' && <WhiteModelModule />}
        {active === 'material' && <MaterialModule />}
        {active === 'assets' && (
          <AssetLibrary initialAssetId={bootAssetId} />
        )}
      </main>
    </div>
  )
}

export default App
