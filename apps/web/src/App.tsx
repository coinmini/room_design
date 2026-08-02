import { useEffect, useMemo, useRef, useState } from 'react'
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
import './App.css'

type ModuleId =
  | 'overview'
  | 'floorplan'
  | 'layout'
  | 'white'
  | 'material'
  | 'assets'

const modules: Array<{
  id: ModuleId
  number: string
  title: string
  short: string
}> = [
  { id: 'overview', number: '00', title: '项目总览', short: 'V0.5 Vision' },
  {
    id: 'floorplan',
    number: '01',
    title: '户型识别与效果图',
    short: 'Floorplan Studio',
  },
  { id: 'layout', number: '02', title: 'AI 平面布局', short: 'AI Layout' },
  { id: 'white', number: '03', title: '白模渲染', short: 'White Model' },
  {
    id: 'material',
    number: '04',
    title: 'AI 多材质替换',
    short: 'AI Material Edit',
  },
  { id: 'assets', number: '05', title: '我的资产', short: 'Asset Library' },
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
        <span className="eyebrow">LOCAL PILOT · V0.5</span>
        <h1>
          从空间数据到
          <br />
          可沟通的设计意向
        </h1>
        <p>
          围绕户型识别、结构校正、三维场景与概念效果图，打通从真实户型到可复用资产的完整验证闭环。
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

type AiLayoutResult = {
  generationMode: 'ai_image'
  provider: string
  model: string
  notice: string
  sourceMode: 'uploaded' | 'generated_rectangle'
  isConceptOnly: true
  constructionReady: false
  requiresUserConfirmation: true
  templateIds: string[]
  templateVersion: string
  layouts: Array<{
    layoutId: string
    strategy: string
    previewUrl: string
    generationMode: 'ai_image'
    provider: string
    model: string
    notice: string
    isConceptOnly: true
    constructionReady: false
    requiresUserConfirmation: true
  }>
}

function LayoutModule() {
  const runner = useJobRunner()
  const [aiFile, setAiFile] = useState<File | null>(null)
  const [aiRoomType, setAiRoomType] = useState('whole_home')
  const [aiWidth, setAiWidth] = useState(8150)
  const [aiDepth, setAiDepth] = useState(6060)
  const [designPrompt, setDesignPrompt] = useState(
    '保留墙体、门窗和功能分区，优化家具尺度、收纳与日常动线。',
  )
  const result = runner.job?.result as AiLayoutResult | null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    const form = new FormData()
    if (aiFile) form.append('source_image', aiFile)
    form.append('room_type', aiRoomType)
    form.append('width_mm', String(aiWidth))
    form.append('depth_mm', String(aiDepth))
    form.append('count', '1')
    form.append('design_prompt', designPrompt)
    await runner.run(
      apiFetch('/v1/layouts/ai', {
        method: 'POST',
        body: form,
      }),
    )
  }

  return (
    <div className="page">
      <ModuleHeader
        index="02"
        title="AI 家装平面布局"
        description="上传户型或结构图，由图像模型结合空间尺寸、设计要求与内置范例，生成可沟通的家装平面概念方案。"
        job={runner.job}
      />
      <div className="workspace layout-workspace">
        <form className="control-panel layout-control-panel" onSubmit={submit}>
          <h2>AI 概念布局</h2>
          <label className="file-drop layout-source-drop">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => setAiFile(event.target.files?.[0] ?? null)}
            />
            <strong>{aiFile ? aiFile.name : '可选上传毛坯 / 结构图'}</strong>
            <span>
              {aiFile
                ? '已使用上传图作为主要结构参考'
                : '未上传时按输入尺寸创建矩形房间，再结合内置范例生成'}
            </span>
          </label>
          <label>
            设计范围
            <select
              value={aiRoomType}
              onChange={(event) => setAiRoomType(event.target.value)}
            >
              <option value="whole_home">全屋</option>
              <option value="living_room">客厅</option>
              <option value="dining_room">餐厅</option>
              <option value="bedroom">卧室</option>
            </select>
          </label>
          <div className="field-row">
            <label>
              总宽 / 开间（mm）
              <input
                type="number"
                min={2400}
                max={30000}
                value={aiWidth}
                onChange={(event) => setAiWidth(Number(event.target.value))}
              />
            </label>
            <label>
              总深 / 进深（mm）
              <input
                type="number"
                min={2400}
                max={30000}
                value={aiDepth}
                onChange={(event) => setAiDepth(Number(event.target.value))}
              />
            </label>
          </div>
          <label>
            设计要求
            <textarea
              value={designPrompt}
              maxLength={500}
              onChange={(event) => setDesignPrompt(event.target.value)}
              placeholder="例如：原木风、客餐厅一体、增加收纳，保留门窗与承重墙"
            />
          </label>
          <div className="layout-reference-section">
            <div>
              <span>REFERENCE SET</span>
              <strong>系统自动参考 3 套内置范例</strong>
            </div>
            <div className="layout-reference-grid">
              {[
                ['/examples/平面图.jpeg', '尺寸清晰两居'],
                ['/examples/平面图2.jpeg', '不规则全屋'],
                ['/examples/平面图3.jpeg', '多房全屋'],
              ].map(([url, label], index) => (
                <figure key={url}>
                  <img src={assetUrl(url)} alt={label} />
                  <figcaption>
                    <span>0{index + 1}</span>
                    {label}
                  </figcaption>
                </figure>
              ))}
            </div>
            <p>范例只提供表达方式与家具尺度参考，不会覆盖上传图的结构。</p>
          </div>
          <div className="constraint-list">
            <span>结构优先</span>
            <span>家具完整</span>
            <span>动线合理</span>
            <span>概念预览</span>
          </div>
          <button className="primary-button" disabled={runner.busy}>
            {runner.busy ? 'AI 正在生成布局…' : '生成 AI 概念布局'}
          </button>
          <ErrorNotice message={runner.error} />
        </form>

        <section className="result-panel layout-result-panel">
          {!result && (
            <div className="empty-state">
              <span>AI</span>
              <h3>等待概念布局生成</h3>
              <p>可直接输入全屋尺寸，上传结构图后能更好地保持真实边界。</p>
            </div>
          )}
          {result &&
            result.layouts.map((layout, index) => (
              <article className="layout-card ai-layout-card" key={layout.layoutId}>
                <div className="result-heading">
                  <div>
                    <small>AI CONCEPT · {String(index + 1).padStart(2, '0')}</small>
                    <h3>家装平面概念方案</h3>
                  </div>
                  <span>{layout.provider ?? result.provider ?? 'AI IMAGE'}</span>
                </div>
                <img src={assetUrl(layout.previewUrl)} alt="AI 家装平面概念布局" />
                <div className="ai-layout-status">
                  <span>概念图</span>
                  <span>非施工图</span>
                  <span>需人工确认</span>
                </div>
                <div className="ai-layout-meta">
                  <div>
                    <span>供应商</span>
                    <strong>{layout.provider ?? result.provider ?? '未返回'}</strong>
                  </div>
                  <div>
                    <span>模型</span>
                    <strong>{layout.model ?? '图像生成模型'}</strong>
                  </div>
                  <div>
                    <span>输入</span>
                    <strong>
                      {result.sourceMode === 'uploaded' ? '上传结构图' : '尺寸矩形'}
                    </strong>
                  </div>
                </div>
                <div className="ai-layout-notice">
                  <strong>概念方案提醒</strong>
                  <p>
                    {layout.notice ??
                      result.notice ??
                      'AI 平面图用于方案沟通，需要结合尺寸与结构进行人工复核。'}
                  </p>
                </div>
                <a
                  className="ai-layout-download"
                  href={assetUrl(layout.previewUrl)}
                  target="_blank"
                  rel="noreferrer"
                  download
                >
                  下载概念布局图
                </a>
              </article>
            ))}
        </section>
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

function App() {
  const [active, setActive] = useState<ModuleId>('overview')
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
        {active === 'floorplan' && <FloorplanModule />}
        {active === 'layout' && <LayoutModule />}
        {active === 'white' && <WhiteModelModule />}
        {active === 'material' && <MaterialModule />}
        {active === 'assets' && <AssetLibrary />}
      </main>
    </div>
  )
}

export default App
