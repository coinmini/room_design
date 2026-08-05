import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  apiFetch,
  assetUrl,
  createWhiteModelRender,
  pollJob,
  type Job,
} from '../api'
import { apiError } from '../workflow/media'
import AboutSheet from './AboutSheet'
import FbDock from './FbDock'
import NotifySheet, { countUnreadNotices } from './NotifySheet'
import UserSheet from './UserSheet'
import {
  SCHOOL_CARDS,
  SCHOOL_TABS,
  SCHOOL_VISIBLE,
  type SchoolCard,
  type SchoolTabKey,
} from './schoolData'
import { SchoolDetailSheet, SchoolListSheet } from './SchoolSheets'
import './home.css'

type Project = {
  id: string
  name: string
  designPrompt?: string | null
  coverUrl?: string | null
  updatedAt?: string | null
  createdAt?: string
}

type SceneAsset = {
  id: string
  projectId?: string | null
  title: string
  thumbnailUrl?: string | null
  createdAt: string
}

type Health = {
  status?: string
  version?: string
  aiDesignWorkflow?: {
    configured?: boolean
    provider?: string | null
    model?: string | null
  }
  floorplanEnhancement?: {
    configured?: boolean
    provider?: string | null
  }
}

type LocalAttachment = {
  id: string
  file: File
  previewUrl: string
}

function relativeTime(iso?: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return iso.slice(0, 10)
}

const CHIP_ACTIONS = [
  { label: 'PS插件', tone: 'orange' },
  { label: '创作者挑战赛', tone: 'purple' },
  { label: '加入合伙人', tone: 'cyan' },
  { label: '邀请有礼', tone: 'peach' },
]

/** 精选案例（本地静态图 + 设计意向，点击后新建项目并进入画布） */
const FEATURED_CASES: Array<{
  id: string
  title: string
  tag: string
  image: string
  prompt: string
}> = [
  {
    id: 'case-01',
    title: '流线玻璃幕墙',
    tag: '建筑外观',
    image: '/cases/case-01.jpg',
    prompt:
      '现代流线型玻璃幕墙建筑外观，蓝天背景下的当代建筑摄影，干净专业的商业立面表达',
  },
  {
    id: 'case-02',
    title: '采光客厅',
    tag: '室内',
    image: '/cases/case-02.jpg',
    prompt:
      '明亮自然采光现代客厅，浅色木地板与白色沙发，落地窗外花园，北欧日式融合室内设计',
  },
  {
    id: 'case-03',
    title: '暮色庭院',
    tag: '景观',
    image: '/cases/case-03.jpg',
    prompt:
      '暮色中式现代庭院，木廊架与暖色灯串，石径与水景，高端住宅景观氛围',
  },
  {
    id: 'case-04',
    title: '夜色亭廊',
    tag: '景观',
    image: '/cases/case-04.jpg',
    prompt:
      '夜间庭院木亭与暖光灯笼，水面倒影与绿意，静谧的中式现代景观空间',
  },
  {
    id: 'case-05',
    title: '菜园小院',
    tag: '景观',
    image: '/cases/case-05.jpg',
    prompt:
      '户外花园用餐区，黑板菜单与木桌，攀藤与菜园，乡村生活美学景观',
  },
  {
    id: 'case-06',
    title: '开放厨房',
    tag: '室内',
    image: '/cases/case-06.jpg',
    prompt:
      '开放式现代厨房客厅，白色大理石岛台与暖木柜体，吊灯与柔和日光，高端住宅室内',
  },
  {
    id: 'case-07',
    title: '城市住区',
    tag: '建筑',
    image: '/cases/case-07.jpg',
    prompt:
      '现代高层住区航拍，裙房绿化与玻璃塔楼，当代中国城市建筑摄影',
  },
  {
    id: 'case-08',
    title: '曲线立面',
    tag: '建筑',
    image: '/cases/case-08.jpg',
    prompt:
      '曲面玻璃商业建筑外立面，蓝天背景，流动感当代建筑外观',
  },
  {
    id: 'case-09',
    title: '一居室效果图',
    tag: '室内',
    image: '/cases/case-09.jpg',
    prompt:
      '一居室现代室内效果图，真实材质与自然光，可继续在画布上迭代布局与风格',
  },
  {
    id: 'case-10',
    title: '工作室 户型空间',
    tag: '室内',
    image: '/cases/case-10.jpg',
    prompt:
      '工作室户型室内效果图，干净明亮的现代居住空间，作为画布工作流起点',
  },
  {
    id: 'case-11',
    title: '儿童房',
    tag: '室内',
    image: '/cases/case-11.jpg',
    prompt: '现代儿童房，柔和色彩与趣味收纳，北欧风格儿童空间',
  },
  {
    id: 'case-12',
    title: '屋顶露台',
    tag: '景观',
    image: '/cases/case-12.jpg',
    prompt: '夜间屋顶露台花园，灯串与沙发，城市天际线，高端户外生活',
  },
  {
    id: 'case-13',
    title: '日式卧室',
    tag: '室内',
    image: '/cases/case-13.jpg',
    prompt: '日式现代卧室，浅木与白墙，晨光氛围，宁静住宅室内',
  },
  {
    id: 'case-14',
    title: '主卧卫浴',
    tag: '室内',
    image: '/cases/case-14.jpg',
    prompt: '奢华主卧卫浴，独立浴缸与大理石，落地窗景观，SPA 级浴室',
  },
  {
    id: 'case-15',
    title: '步入式衣帽间',
    tag: '室内',
    image: '/cases/case-15.jpg',
    prompt: '现代步入式衣帽间，中岛与暖色灯光，高端住宅收纳空间',
  },
  {
    id: 'case-16',
    title: '景观餐厅',
    tag: '室内',
    image: '/cases/case-16.jpg',
    prompt: '当代餐厅，长木桌与吊灯，落地玻璃望向花园，室内设计摄影',
  },
  {
    id: 'case-17',
    title: '书房',
    tag: '室内',
    image: '/cases/case-17.jpg',
    prompt: '现代书房，嵌入式书架与书桌，柔和日光，专业居家办公空间',
  },
  {
    id: 'case-18',
    title: '泳池庭院',
    tag: '建筑',
    image: '/cases/case-18.jpg',
    prompt: '现代别墅庭院泳池，蓝天与热带植物，中式当代别墅外观',
  },
  {
    id: 'case-19',
    title: '工业风客厅',
    tag: '室内',
    image: '/cases/case-19.jpg',
    prompt: '工业风 loft 客厅，混凝土与砖墙，大窗与皮沙发，现代室内',
  },
  {
    id: 'case-20',
    title: '吧台厨房',
    tag: '室内',
    image: '/cases/case-20.jpg',
    prompt: '现代厨房中岛吧台，白色与橡木材质，晨光，住宅室内',
  },
  {
    id: 'case-21',
    title: '绿墙大堂',
    tag: '商业',
    image: '/cases/case-21.jpg',
    prompt: '精品酒店大堂，垂直绿墙与大理石，暖色氛围，酒店室内',
  },
  {
    id: 'case-22',
    title: '影音室',
    tag: '室内',
    image: '/cases/case-22.jpg',
    prompt: '现代影音室，大屏投影与软性 LED 灯槽，居家影院氛围',
  },
  {
    id: 'case-23',
    title: '茶室',
    tag: '室内',
    image: '/cases/case-23.jpg',
    prompt: '中式现代茶室，低桌与灯笼，原木与绿植，静谧室内空间',
  },
  {
    id: 'case-24',
    title: '阳台花园',
    tag: '景观',
    image: '/cases/case-24.jpg',
    prompt: '现代阳台花园，户外家具与攀藤，城市景观，住宅户外设计',
  },
  {
    id: 'case-25',
    title: '挑空门厅',
    tag: '室内',
    image: '/cases/case-25.jpg',
    prompt: '现代挑空门厅，悬浮楼梯与玻璃栏杆，天窗采光，奢华住宅室内',
  },
  {
    id: 'case-26',
    title: '酒窖',
    tag: '室内',
    image: '/cases/case-26.jpg',
    prompt: '现代酒窖品鉴室，深色木与石材，氛围灯光，高端住宅室内',
  },
  {
    id: 'case-27',
    title: '两居室效果图',
    tag: '室内',
    image: '/cases/case-27.jpg',
    prompt: '两居室现代室内效果图，真实材质与布局，可继续在画布迭代',
  },
  {
    id: 'case-28',
    title: '户型效果图',
    tag: '室内',
    image: '/cases/case-28.jpg',
    prompt: '由平面图生成的室内效果图，结构清晰，适合作为工作流起点',
  },
  {
    id: 'case-29',
    title: 'Kuyao 写实渲染',
    tag: '室内',
    image: '/cases/case-29.jpg',
    prompt: '高质量写实室内渲染，自然光与材质细节，画布创作参考',
  },
]

const MAX_ATTACHMENTS = 4
const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']

function jobErrorMessage(job: Job): string {
  return (
    job.errorMessage ||
    (typeof job.result?.detail === 'string' ? job.result.detail : null) ||
    `任务失败：${job.status}`
  )
}

export default function HomePage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const assetsSectionRef = useRef<HTMLElement>(null)
  const attachmentsRef = useRef<LocalAttachment[]>([])
  const [prompt, setPrompt] = useState(
    '帮我把这张图渲染成真实的效果图，真实感，左边是椅子，地板是木地板…',
  )
  const [attachments, setAttachments] = useState<LocalAttachment[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [assets, setAssets] = useState<SceneAsset[]>([])
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)
  const [genStatus, setGenStatus] = useState('')
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<Project | null>(null)
  const [schoolTab, setSchoolTab] = useState<SchoolTabKey>('tutor')
  const [schoolPage, setSchoolPage] = useState(0)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [userOpen, setUserOpen] = useState(false)
  const [notifyUnread, setNotifyUnread] = useState(() => countUnreadNotices())
  const [schoolDetail, setSchoolDetail] = useState<SchoolCard | null>(null)
  const [schoolListOpen, setSchoolListOpen] = useState(false)
  const schoolViewportRef = useRef<HTMLDivElement>(null)
  const [displayName, setDisplayName] = useState(
    () => localStorage.getItem('room_design_display_name') || '设计师',
  )

  const schoolCards = SCHOOL_CARDS[schoolTab]
  const schoolMaxPage = Math.max(0, schoolCards.length - SCHOOL_VISIBLE)

  const scrollSchoolTo = (pageIndex: number) => {
    const viewport = schoolViewportRef.current
    if (!viewport) return
    const card = viewport.querySelector('.fb-course-card') as HTMLElement | null
    if (!card) return
    const styles = window.getComputedStyle(viewport.querySelector('.fb-carousel-track')!)
    const gap = Number.parseFloat(styles.columnGap || styles.gap || '12') || 12
    const step = card.offsetWidth + gap
    const clamped = Math.max(0, Math.min(schoolMaxPage, pageIndex))
    viewport.scrollTo({ left: clamped * step, behavior: 'smooth' })
    setSchoolPage(clamped)
  }

  useEffect(() => {
    setSchoolPage(0)
    const viewport = schoolViewportRef.current
    if (viewport) viewport.scrollTo({ left: 0 })
  }, [schoolTab])

  // 学堂轮播自动播放
  useEffect(() => {
    if (schoolMaxPage <= 0) return
    const timer = window.setInterval(() => {
      setSchoolPage((current) => {
        const next = current >= schoolMaxPage ? 0 : current + 1
        const viewport = schoolViewportRef.current
        const card = viewport?.querySelector(
          '.fb-course-card',
        ) as HTMLElement | null
        if (viewport && card) {
          const track = viewport.querySelector('.fb-carousel-track')
          const gap = track
            ? Number.parseFloat(
                window.getComputedStyle(track).columnGap ||
                  window.getComputedStyle(track).gap ||
                  '12',
              ) || 12
            : 12
          viewport.scrollTo({ left: next * (card.offsetWidth + gap), behavior: 'smooth' })
        }
        return next
      })
    }, 4200)
    return () => window.clearInterval(timer)
  }, [schoolTab, schoolMaxPage])

  attachmentsRef.current = attachments

  const modelLabel = useMemo(() => {
    const workflow = health?.aiDesignWorkflow
    if (workflow?.configured && (workflow.provider || workflow.model)) {
      const provider = workflow.provider || 'kuyao'
      const model = workflow.model
      return model ? `${provider} · ${model}` : provider
    }
    const enhancement = health?.floorplanEnhancement
    if (enhancement?.configured && enhancement.provider) {
      return enhancement.provider
    }
    return 'kuyao'
  }, [health])

  const kuyaoReady = Boolean(health?.aiDesignWorkflow?.configured)

  const refresh = async () => {
    try {
      const [projectsResp, assetsResp, healthResp] = await Promise.all([
        apiFetch('/v1/projects'),
        apiFetch('/v1/assets?limit=24'),
        apiFetch('/health'),
      ])
      if (projectsResp.ok) {
        setProjects((await projectsResp.json()) as Project[])
      }
      if (assetsResp.ok) {
        setAssets((await assetsResp.json()) as SceneAsset[])
      }
      if (healthResp.ok) {
        setHealth((await healthResp.json()) as Health)
      }
    } catch (value) {
      setError(value instanceof Error ? value.message : '加载失败')
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((item) =>
        URL.revokeObjectURL(item.previewUrl),
      )
    }
  }, [])

  useEffect(() => {
    if (!pendingDelete) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setPendingDelete(null)
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [pendingDelete, busy])

  const createProject = async (
    name?: string,
    designPrompt?: string,
    coverUrl?: string,
  ) => {
    setBusy(true)
    setError('')
    setGenStatus('')
    try {
      const response = await apiFetch('/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name?.trim() || `未命名项目`,
          designPrompt: designPrompt?.trim() || undefined,
          coverUrl: coverUrl?.trim() || undefined,
        }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: unknown
        } | null
        throw new Error(apiError(payload?.detail, response.status))
      }
      const project = (await response.json()) as Project
      localStorage.setItem('room_design_canvas_project_id', project.id)
      navigate(`/projects/${project.id}/canvas`)
    } catch (value) {
      setError(value instanceof Error ? value.message : '创建失败')
    } finally {
      setBusy(false)
    }
  }

  const openFeaturedCase = (caseItem: (typeof FEATURED_CASES)[number]) => {
    void createProject(caseItem.title, caseItem.prompt, caseItem.image)
  }

  const requestDeleteProject = (project: Project) => {
    setError('')
    setPendingDelete(project)
  }

  const cancelDeleteProject = () => {
    if (busy) return
    setPendingDelete(null)
  }

  const confirmDeleteProject = async () => {
    const project = pendingDelete
    if (!project || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(
        `/v1/projects/${encodeURIComponent(project.id)}`,
        { method: 'DELETE' },
      )
      // 204 No Content is success; also accept 200/202 for compatibility
      if (!response.ok && response.status !== 204) {
        let detail = `删除失败：${response.status}`
        try {
          const payload = (await response.json()) as { detail?: unknown } | null
          detail = apiError(payload?.detail, response.status)
        } catch {
          // empty body (e.g. some 4xx) — keep status message
        }
        throw new Error(detail)
      }
      setProjects((current) => current.filter((p) => p.id !== project.id))
      const stored = localStorage.getItem('room_design_canvas_project_id')
      if (stored === project.id) {
        localStorage.removeItem('room_design_canvas_project_id')
      }
      setPendingDelete(null)
    } catch (value) {
      setError(value instanceof Error ? value.message : '删除失败')
      setPendingDelete(null)
    } finally {
      setBusy(false)
    }
  }

  const addAttachments = (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) return
    setError('')
    setAttachments((current) => {
      const remaining = MAX_ATTACHMENTS - current.length
      if (remaining <= 0) {
        setError(`最多附加 ${MAX_ATTACHMENTS} 张图片（1 张主图 + 最多 3 张风格参考）`)
        return current
      }
      const next: LocalAttachment[] = []
      for (const file of list.slice(0, remaining)) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          setError('仅支持 JPEG / PNG / WebP 本地图片')
          continue
        }
        if (file.size > 20 * 1024 * 1024) {
          setError('单张图片不能超过 20 MB')
          continue
        }
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })
      }
      return [...current, ...next]
    })
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return current.filter((item) => item.id !== id)
    })
  }

  const generateFromLocalImage = async () => {
    if (attachments.length === 0) {
      setError('请先点击 ⧉ 添加本地图片，再生成效果图')
      return
    }
    if (!kuyaoReady) {
      setError('Kuyao 图像 API 未配置，请检查服务端 KUYAO_API_KEY / KUYAO_IMAGE_MODEL')
      return
    }

    setBusy(true)
    setError('')
    setGenStatus('提交生图任务…')
    try {
      const [source, ...styleRefs] = attachments
      const form = new FormData()
      form.append('source_image', source.file)
      form.append('generation_mode', 'ai_quick')
      form.append('room_type', 'living_room')
      form.append('style_preset_id', 'modern_minimal_v1')
      form.append(
        'prompt',
        prompt.trim() || '真实感室内效果图，自然光，高质量材质',
      )
      styleRefs.slice(0, 3).forEach((item) => {
        form.append('style_references', item.file)
      })

      const response = await createWhiteModelRender(form)
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          detail?: string | Array<{ msg?: string }>
        } | null
        const detail = payload?.detail
        const message =
          typeof detail === 'string'
            ? detail
            : Array.isArray(detail)
              ? detail.map((d) => d.msg).filter(Boolean).join('；')
              : `提交失败：${response.status}`
        throw new Error(message || `提交失败：${response.status}`)
      }

      const created = (await response.json()) as Job
      setGenStatus('Kuyao 生成中…')
      const job = await pollJob(created.id, (update) => {
        if (update.status === 'QUEUED') setGenStatus('排队中…')
        else if (update.status === 'RUNNING') setGenStatus('Kuyao 生成中…')
      })

      if (job.status !== 'SUCCEEDED') {
        throw new Error(jobErrorMessage(job))
      }

      setGenStatus('已写入我的资产')
      await refresh()
      // Brief success flash then clear status
      window.setTimeout(() => setGenStatus(''), 2500)
      assetsSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
      })
    } catch (value) {
      setGenStatus('')
      setError(value instanceof Error ? value.message : '生图失败')
    } finally {
      setBusy(false)
    }
  }

  const handlePromptSubmit = async () => {
    if (attachments.length > 0) {
      await generateFromLocalImage()
      return
    }
    await createProject(undefined, prompt)
  }

  // 首页预览最多 4 个项目缩略图（另加「新建项目」）
  const recentProjects = [...projects]
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0
      const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0
      return tb - ta
    })
    .slice(0, 4)

  const coverOf = (project: Project) => {
    const cover = project.coverUrl
    if (cover) return cover
    return (
      assets.find((a) => a.projectId === project.id)?.thumbnailUrl || null
    )
  }

  const coverSrc = (path?: string | null) => {
    if (!path) return ''
    // 本地 public 精选案例等静态资源
    if (path.startsWith('/cases/') || path.startsWith('/assets/')) return path
    return assetUrl(path)
  }

  const sendTitle =
    attachments.length > 0
      ? '使用 kuyao 生成效果图并写入我的资产'
      : '新建项目并进入画布'

  return (
    <div className="fb-home">
      {/* 纯黑星空上的横向银河带 */}
      <div className="fb-sky-milky" aria-hidden />

      {/* 顶通 lime 条 */}
      <div className="fb-banner">
        <span>
          本地无限画布工作台 · 模型 {modelLabel}
          <button
            type="button"
            className="fb-banner-link"
            onClick={() => void createProject(undefined, prompt)}
          >
            立即体验
          </button>
        </span>
      </div>

      <FbDock
        active="home"
        createDisabled={busy}
        onCreate={() => void createProject('未命名项目', prompt)}
        onNotifyClick={() => setNotifyOpen(true)}
        onAppsClick={() => setAboutOpen(true)}
        notifyCount={notifyUnread}
      />

      {/* 右上用户胶囊 */}
      <div className="fb-top-chips">
        <button
          type="button"
          className="fb-user-chip"
          aria-label="打开个人中心"
          onClick={() => setUserOpen(true)}
        >
          <span className="fb-user-avatar" aria-hidden>
            {displayName.slice(0, 1)}
          </span>
          <div className="fb-user-meta">
            <strong>本地用户</strong>
            <span>免费</span>
          </div>
        </button>
        {CHIP_ACTIONS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`fb-action-chip fb-action-chip--${chip.tone}`}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <main className="fb-main">
        {/* 顶部三块等宽：限时赛事 / 图片生成 / 项目预览 */}
        <div className="fb-promo">
          <div className="fb-promo-inner">
            <span className="fb-promo-tag">限时赛事</span>
            <div className="fb-promo-copy">
              <strong>在本地工作台，完成户型 → 布局 → 效果图全链路</strong>
              <span>无限画布 · 多方案堆叠 · 结构确认 · 局部修改</span>
            </div>
            <button
              type="button"
              className="fb-promo-cta"
              onClick={() => void createProject(undefined, prompt)}
            >
              开始创作
            </button>
          </div>
        </div>

        <section className="fb-hero" aria-label="图片生成">
          <h1>
            HI！{displayName}，今天需要我帮你做点什么？
          </h1>
          <p>一站式智能创作引擎，每一位专业设计师的进阶标配</p>

          <form
            className="fb-prompt"
            onSubmit={(event) => {
              event.preventDefault()
              void handlePromptSubmit()
            }}
          >
            {attachments.length > 0 ? (
              <div className="fb-prompt-attachments" aria-label="已附加本地图片">
                {attachments.map((item, index) => (
                  <div key={item.id} className="fb-attach-chip">
                    <img src={item.previewUrl} alt={item.file.name} />
                    <span className="fb-attach-role">
                      {index === 0 ? '主图' : `参考 ${index}`}
                    </span>
                    <button
                      type="button"
                      className="fb-attach-remove"
                      title="移除"
                      disabled={busy}
                      onClick={() => removeAttachment(item.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="描述设计意向；附加本地图片后点 ↑ 用 kuyao 真实生图…"
              disabled={busy}
            />
            <div className="fb-prompt-bar">
              <div className="fb-prompt-left">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files) {
                      addAttachments(event.target.files)
                    }
                    event.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="fb-prompt-tool"
                  title="添加本地图片"
                  disabled={busy || attachments.length >= MAX_ATTACHMENTS}
                  onClick={() => fileInputRef.current?.click()}
                >
                  ⧉
                </button>
                <button
                  type="button"
                  className="fb-model-select"
                  title="默认使用 kuyao 图像 API"
                >
                  {modelLabel}
                  <span aria-hidden>▾</span>
                </button>
                {attachments.length > 0 ? (
                  <span className="fb-attach-hint">
                    {attachments.length}/{MAX_ATTACHMENTS} 张
                  </span>
                ) : null}
              </div>
              <button
                type="submit"
                className="fb-prompt-send"
                disabled={busy}
                title={sendTitle}
              >
                {busy ? '…' : '↑'}
              </button>
            </div>
          </form>
          {genStatus ? <div className="fb-gen-status">{genStatus}</div> : null}
          {error ? <div className="fb-error">{error}</div> : null}
        </section>

        {/* 最近项目 — 与赛事条/生图框等宽，最多 4 个预览 */}
        <section
          className="fb-projects"
          aria-label="所有项目预览"
          style={
            {
              ['--fb-project-cols']: String(1 + recentProjects.length),
            } as CSSProperties
          }
        >
          <button
            type="button"
            className="fb-project-new"
            disabled={busy}
            onClick={() => void createProject('未命名项目')}
          >
            <span className="fb-project-new-plus">+</span>
            <span>新建项目</span>
          </button>
          {recentProjects.map((project) => {
            const cover = coverOf(project)
            return (
              <div key={project.id} className="fb-project-card-wrap">
                <Link
                  to={`/projects/${project.id}/canvas`}
                  className="fb-project-card"
                  onClick={() =>
                    localStorage.setItem(
                      'room_design_canvas_project_id',
                      project.id,
                    )
                  }
                >
                  <div className="fb-project-thumb">
                    {cover ? (
                      <img src={coverSrc(cover)} alt="" />
                    ) : (
                      <div className="fb-project-thumb-empty">无封面</div>
                    )}
                  </div>
                  <div className="fb-project-meta">
                    <strong title={project.name}>{project.name}</strong>
                    <span>
                      编辑于{' '}
                      {relativeTime(project.updatedAt || project.createdAt)}
                    </span>
                  </div>
                </Link>
                <button
                  type="button"
                  className="fb-project-delete"
                  title="删除项目"
                  disabled={busy}
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    requestDeleteProject(project)
                  }}
                >
                  删除
                </button>
              </div>
            )
          })}
          <Link to="/projects" className="fb-all-projects">
            所有项目 ›
          </Link>
        </section>

        {/* 我的学堂：讲师课程 / 讲师作品 轮播 */}
        <section className="fb-courses fb-band fb-band--md" aria-label="我的学堂">
          <div className="fb-section-head">
            <div className="fb-school-heading">
              <h2>我的学堂</h2>
              <div className="fb-tabs" role="tablist" aria-label="学堂分类">
                {SCHOOL_TABS.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    aria-selected={schoolTab === tab.key}
                    className={`fb-tab${schoolTab === tab.key ? ' is-active' : ''}`}
                    onClick={() => setSchoolTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="fb-section-link"
              onClick={() => setSchoolListOpen(true)}
            >
              全部{schoolTab === 'tutor' ? '课程' : '作品'} ›
            </button>
          </div>

          <div className="fb-carousel">
            <button
              type="button"
              className="fb-carousel-nav fb-carousel-nav--prev"
              aria-label="上一组"
              disabled={schoolPage <= 0}
              onClick={() => scrollSchoolTo(schoolPage - 1)}
            >
              ‹
            </button>
            <div className="fb-carousel-viewport" ref={schoolViewportRef}>
              <div className="fb-carousel-track">
                {schoolCards.map((card) => (
                  <button
                    key={`${schoolTab}-${card.id}`}
                    type="button"
                    className="fb-course-card"
                    onClick={() => setSchoolDetail(card)}
                  >
                    <img
                      className="fb-course-cover"
                      src={card.image}
                      alt={card.title}
                      loading="lazy"
                    />
                    <div className="fb-course-shade" aria-hidden />
                    <div className="fb-course-copy">
                      <div className="fb-course-en">{card.en}</div>
                      <div className="fb-course-title">{card.title}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className="fb-carousel-nav fb-carousel-nav--next"
              aria-label="下一组"
              disabled={schoolPage >= schoolMaxPage}
              onClick={() => scrollSchoolTo(schoolPage + 1)}
            >
              ›
            </button>
          </div>

          {schoolMaxPage > 0 ? (
            <div className="fb-carousel-dots" role="tablist" aria-label="轮播页">
              {Array.from({ length: schoolMaxPage + 1 }, (_, index) => (
                <button
                  key={index}
                  type="button"
                  className={`fb-carousel-dot${
                    schoolPage === index ? ' is-active' : ''
                  }`}
                  aria-label={`第 ${index + 1} 页`}
                  onClick={() => scrollSchoolTo(index)}
                />
              ))}
            </div>
          ) : null}
        </section>

        {/* 我的资产 — 与我的学堂等宽 */}
        <section
          className="fb-assets fb-band fb-band--md"
          ref={assetsSectionRef}
        >
          <div className="fb-section-head">
            <h2>我的资产</h2>
            <Link to="/assets" className="fb-section-link">
              查看全部 ›
            </Link>
          </div>
          {assets.length > 0 ? (
            <div className="fb-asset-row">
              {assets.slice(0, 8).map((asset) => (
                <Link
                  key={asset.id}
                  to={`/assets?assetId=${encodeURIComponent(asset.id)}`}
                  className="fb-asset-card"
                  title={`打开「${asset.title}」`}
                >
                  <div className="fb-asset-thumb">
                    {asset.thumbnailUrl ? (
                      <img
                        src={assetUrl(asset.thumbnailUrl)}
                        alt={asset.title}
                      />
                    ) : (
                      <div className="fb-project-thumb-empty">无图</div>
                    )}
                  </div>
                  <div className="fb-asset-meta">
                    <strong title={asset.title}>{asset.title}</strong>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="fb-assets-empty">
              {busy && attachments.length > 0
                ? '生图完成后会出现在这里…'
                : '附加本地图片后点 ↑，生成结果会出现在这里'}
            </div>
          )}
        </section>

        {/* 精选案例 — 最宽瀑布流；点击进入画布 */}
        <section
          className="fb-cases fb-band fb-band--xl"
          id="fb-featured-cases"
        >
          <div className="fb-section-head">
            <div className="fb-cases-heading">
              <h2>精选案例</h2>
              <div className="fb-cases-pills" role="tablist" aria-label="案例筛选">
                <button type="button" className="fb-case-pill is-active">
                  推荐
                </button>
                <button type="button" className="fb-case-pill">
                  最新
                </button>
              </div>
            </div>
            <span className="fb-section-link">{FEATURED_CASES.length} 个案例</span>
          </div>
          <div className="fb-cases-masonry">
            {FEATURED_CASES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="fb-case-card"
                disabled={busy}
                title={`打开案例「${item.title}」进入画布`}
                onClick={() => openFeaturedCase(item)}
              >
                <img src={item.image} alt={item.title} loading="lazy" />
                <div className="fb-case-overlay">
                  <span className="fb-case-tag">{item.tag}</span>
                  <strong>{item.title}</strong>
                </div>
              </button>
            ))}
          </div>
        </section>
      </main>

      <AboutSheet open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <NotifySheet
        open={notifyOpen}
        onClose={() => setNotifyOpen(false)}
        onUnreadChange={setNotifyUnread}
      />
      <UserSheet
        open={userOpen}
        onClose={() => {
          setUserOpen(false)
          setDisplayName(
            localStorage.getItem('room_design_display_name') || '设计师',
          )
        }}
        displayName={displayName}
        stats={{
          projectCount: projects.length,
          assetCount: assets.length,
          modelLabel,
          modelReady: kuyaoReady,
          notifyUnread,
        }}
        onOpenAbout={() => setAboutOpen(true)}
        onOpenNotify={() => setNotifyOpen(true)}
      />
      <SchoolDetailSheet
        open={Boolean(schoolDetail)}
        kind={schoolTab}
        card={schoolDetail}
        onClose={() => setSchoolDetail(null)}
      />
      <SchoolListSheet
        open={schoolListOpen}
        kind={schoolTab}
        cards={schoolCards}
        onClose={() => setSchoolListOpen(false)}
        onSelect={(card) => {
          setSchoolListOpen(false)
          setSchoolDetail(card)
        }}
      />

      {pendingDelete ? (
        <div
          className="fb-modal-root"
          role="presentation"
          onClick={cancelDeleteProject}
        >
          <div
            className="fb-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fb-delete-title"
            aria-describedby="fb-delete-desc"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="fb-modal-icon" aria-hidden>
              🗑
            </div>
            <h2 id="fb-delete-title">删除项目</h2>
            <p id="fb-delete-desc">
              确定删除项目「
              <strong>{pendingDelete.name}</strong>
              」？
              <br />
              画布记录将移除，生成图片资产会保留在库中。
            </p>
            <div className="fb-modal-actions">
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--ghost"
                disabled={busy}
                onClick={cancelDeleteProject}
              >
                取消
              </button>
              <button
                type="button"
                className="fb-modal-btn fb-modal-btn--danger"
                disabled={busy}
                onClick={() => void confirmDeleteProject()}
              >
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
