import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  apiFetch,
  assetUrl,
  pollJob,
  type AssetModuleKey,
  type Job,
  type SceneAsset,
  type SceneAssetDetail,
} from './api'

type AssetFilter = 'all' | AssetModuleKey
type VariantType = 'camera' | 'material'
type RenderQuality = 'base' | 'final'

type AssetModuleDefinition = {
  key: AssetModuleKey
  number: string
  label: string
  emptyHint: string
}

type GalleryItem = {
  key: string
  label: string
  hint: string
  url: string
}

const assetModules: AssetModuleDefinition[] = [
  {
    key: 'floorplan',
    number: '01',
    label: '户型识别与效果图',
    emptyHint: '从“户型识别与效果图”生成一次效果图后会自动出现在这里。',
  },
  {
    key: 'layout',
    number: '02',
    label: 'AI 平面布局',
    emptyHint: '从“AI 平面布局”生成一套布局后会自动出现在这里。',
  },
  {
    key: 'white_model',
    number: '03',
    label: '白模渲染',
    emptyHint: '从“白模渲染”生成一次本地预览或 AI 渲染后会自动出现在这里。',
  },
  {
    key: 'material_replacement',
    number: '04',
    label: 'AI 多材质替换',
    emptyHint: '从“AI 多材质替换”完成一次材质方案后会自动出现在这里。',
  },
  {
    key: 'effect_render',
    number: 'H',
    label: '历史快速房间渲染',
    emptyHint: '这里仅保留旧版本快速房间渲染记录，当前生产模块不会继续新增此类资产。',
  },
]

const filterOptions: Array<{ value: AssetFilter; label: string }> = [
  { value: 'all', label: '全部模块' },
  ...assetModules.map((module) => ({
    value: module.key,
    label: `${module.number} ${module.label}`,
  })),
]

const modeLabels: Record<string, string> = {
  ai_direct: 'AI 直出',
  structured_3d: '精确三维',
  deterministic: '规则求解',
  ai_image: 'AI 生图',
  ai_quick: 'AI 快速渲染',
  ai_edit: 'AI 材质重绘',
  ai_edit_fallback: 'AI 回退材质替换',
  local_preview: '本地预览',
  local_edit: '本地材质编辑',
}

const moduleByKey = new Map(assetModules.map((module) => [module.key, module]))

const moduleByJobType: Record<string, AssetModuleKey> = {
  FLOORPLAN_SCENE: 'floorplan',
  LAYOUT: 'layout',
  LAYOUT_AI: 'layout',
  WHITE_MODEL_RENDER: 'white_model',
  EFFECT_RENDER: 'effect_render',
  MATERIAL_REPLACEMENT: 'material_replacement',
}

function normalizeModuleKey(value: unknown): AssetModuleKey | undefined {
  if (typeof value !== 'string') return undefined
  const aliases: Record<string, AssetModuleKey> = {
    floorplan: 'floorplan',
    floorplan_scene: 'floorplan',
    layout: 'layout',
    white: 'white_model',
    white_model: 'white_model',
    effect: 'effect_render',
    effect_render: 'effect_render',
    material: 'material_replacement',
    material_replacement: 'material_replacement',
  }
  return aliases[value.trim().toLowerCase()]
}

function inferAssetModule(asset: SceneAsset): AssetModuleDefinition {
  const metadata = asRecord(asset.metadata)
  const explicit = normalizeModuleKey(asset.moduleKey)
  if (explicit) return moduleByKey.get(explicit)!

  const jobType = (
    asset.jobType ?? pickString(metadata, 'jobType', 'job_type')
  )?.toUpperCase()
  if (jobType && moduleByJobType[jobType]) {
    return moduleByKey.get(moduleByJobType[jobType])!
  }

  const assetType = asset.assetType.toLowerCase()
  if (assetType.includes('layout')) return moduleByKey.get('layout')!
  if (assetType.includes('white')) return moduleByKey.get('white_model')!
  if (assetType.includes('material')) {
    return moduleByKey.get('material_replacement')!
  }
  if (assetType.includes('effect')) return moduleByKey.get('effect_render')!

  const generationMode = asset.generationMode.toLowerCase()
  if (['deterministic', 'ai_image'].includes(generationMode)) {
    return moduleByKey.get('layout')!
  }
  if (['ai_quick'].includes(generationMode)) {
    return moduleByKey.get('white_model')!
  }
  if (['local_edit', 'ai_edit', 'ai_edit_fallback'].includes(generationMode)) {
    return moduleByKey.get('material_replacement')!
  }

  // Legacy ai_direct / structured_3d scene assets predate moduleKey.
  return moduleByKey.get('floorplan')!
}

function moduleDisplayName(
  asset: SceneAsset,
  module: AssetModuleDefinition,
): string {
  // The API keeps the original moduleName for historical compatibility. Do not
  // present the retired EFFECT_RENDER pipeline as a current production module.
  if (module.key === 'effect_render') return module.label
  return asset.moduleName?.trim() || module.label
}

function generationModeLabel(mode: string): string {
  return modeLabels[mode] ?? mode.replaceAll('_', ' ').toUpperCase()
}

const moduleAssetNotes: Record<AssetModuleKey, string> = {
  floorplan:
    '保存户型识别与效果图模块生成的结构参考、最终效果图与三维交付物；精确三维资产可继续派生机位和材质版本。',
  layout:
    '保存 AI 生成的平面布局方案。概念布局与尺寸仍需人工复核后使用。',
  white_model:
    '保存白模的本地保真预览或 AI 快速渲染结果，以及用于结构复核的控制图。',
  effect_render:
    '保留旧版快速房间渲染的基础图与最终图，仅供历史浏览和下载；它不再代表当前生产模块，也不会从这里继续创建新版本。',
  material_replacement:
    '保存 AI 材质重绘或显式本地回退结果与前后对比图，原始图像和蒙版外区域保持独立可追溯。',
}

const moduleDownloadLabels: Record<AssetModuleKey, string> = {
  floorplan: '下载最终效果图',
  layout: '下载布局方案',
  white_model: '下载白模渲染',
  effect_render: '下载历史渲染图',
  material_replacement: '下载材质替换结果',
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pickString(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function assetFile(
  detail: SceneAssetDetail,
  ...keys: string[]
): string | undefined {
  return pickString(detail.deliverables, ...keys)
}

function urlsFromValue(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value]
  if (Array.isArray(value)) return value.flatMap(urlsFromValue)
  const record = asRecord(value)
  const nested = pickString(
    record,
    'url',
    'previewUrl',
    'outputUrl',
    'imageUrl',
    'finalRenderUrl',
  )
  return nested ? [nested] : []
}

function assetUrls(
  detail: SceneAssetDetail,
  ...keys: string[]
): string[] {
  return keys.flatMap((key) => urlsFromValue(detail.deliverables[key]))
}

function uniqueGallery(items: GalleryItem[]): GalleryItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (!item.url || seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function assetGallery(detail: SceneAssetDetail): GalleryItem[] {
  const result = detail.sourceResult
  const controlImages = asRecord(result.controlImages)
  const module = inferAssetModule(detail)
  const finalUrl =
    assetFile(
      detail,
      'finalImageUrl',
      'finalRenderUrl',
      'imageUrl',
      'outputUrl',
      'comparisonUrl',
      'previewUrl',
    ) ??
    pickString(
      result,
      'finalRenderUrl',
      'effectUrl',
      'outputUrl',
      'comparisonUrl',
      'previewUrl',
    ) ??
    detail.thumbnailUrl

  if (module.key === 'layout') {
    const layouts = Array.isArray(result.layouts) ? result.layouts : []
    const previewUrls = [
      ...assetUrls(detail, 'previewUrls', 'layoutUrls', 'outputUrls'),
      ...layouts.flatMap(urlsFromValue),
    ]
    return uniqueGallery([
      ...previewUrls.map((url, index) => ({
        key: `layout-${index}`,
        label: `布局方案 ${index + 1}`,
        hint:
          detail.generationMode === 'ai_image' ? 'AI LAYOUT' : 'LEGACY LAYOUT',
        url,
      })),
      {
        key: 'layout-final',
        label: '布局方案',
        hint: 'LAYOUT',
        url: finalUrl ?? '',
      },
      {
        key: 'source',
        label: '输入平面图',
        hint: 'SOURCE',
        url: assetFile(detail, 'sourceImageUrl') ?? '',
      },
    ])
  }

  if (module.key === 'white_model') {
    const outputUrls = [
      ...assetUrls(detail, 'outputUrls', 'renderUrls'),
      ...urlsFromValue(result.outputs),
    ]
    return uniqueGallery([
      ...outputUrls.map((url, index) => ({
        key: `white-output-${index}`,
        label: outputUrls.length > 1 ? `白模渲染 ${index + 1}` : '白模渲染结果',
        hint: detail.generationMode === 'ai_quick' ? 'AI QUICK' : 'LOCAL',
        url,
      })),
      {
        key: 'white-final',
        label: '白模渲染结果',
        hint: 'RENDER',
        url: finalUrl ?? '',
      },
      {
        key: 'white-control',
        label: detail.generationMode === 'ai_quick' ? '结构权威图' : '边缘控制图',
        hint: 'CONTROL',
        url:
          assetFile(detail, 'controlImageUrl') ??
          pickString(result, 'controlImageUrl') ??
          '',
      },
      {
        key: 'white-source',
        label: '输入白模',
        hint: 'SOURCE',
        url: assetFile(detail, 'sourceImageUrl') ?? '',
      },
    ])
  }

  if (module.key === 'effect_render') {
    return uniqueGallery([
      {
        key: 'effect-final',
        label: '历史快速房间渲染',
        hint: 'LEGACY FINAL',
        url: finalUrl ?? '',
      },
      {
        key: 'effect-base',
        label: '历史基础场景渲染',
        hint: 'LEGACY BASE',
        url:
          assetFile(detail, 'baseImageUrl', 'baseRenderUrl') ??
          pickString(result, 'baseRenderUrl') ??
          '',
      },
    ])
  }

  if (module.key === 'material_replacement') {
    return uniqueGallery([
      {
        key: 'material-comparison',
        label: '材质替换对比',
        hint: 'BEFORE / AFTER',
        url:
          assetFile(detail, 'comparisonUrl') ??
          pickString(result, 'comparisonUrl') ??
          '',
      },
      {
        key: 'material-final',
        label: '材质替换结果',
        hint: 'RESULT',
        url:
          assetFile(detail, 'outputUrl', 'finalImageUrl') ??
          pickString(result, 'outputUrl') ??
          finalUrl ??
          '',
      },
      {
        key: 'material-source',
        label: '原始室内图',
        hint: 'SOURCE',
        url: assetFile(detail, 'sourceImageUrl') ?? '',
      },
    ])
  }

  if (detail.generationMode === 'ai_direct') {
    return uniqueGallery([
      {
        key: 'final',
        label: '最终效果图',
        hint: 'GPT-IMAGE-2',
        url: finalUrl ?? '',
      },
      {
        key: 'source',
        label: '原始平面图',
        hint: 'SOURCE',
        url: assetFile(detail, 'sourceImageUrl') ?? '',
      },
      {
        key: 'semantic',
        label: 'Semantic 约束图',
        hint: 'STRUCTURE',
        url:
          assetFile(detail, 'semanticUrl', 'topDownUrl') ??
          pickString(result, 'topDownUrl') ??
          '',
      },
    ])
  }

  return uniqueGallery([
    { key: 'final', label: '最终增强', hint: 'FINAL', url: finalUrl ?? '' },
    {
      key: 'base',
      label: 'Blender 基础渲染',
      hint: 'BASE RGB',
      url:
        assetFile(detail, 'baseImageUrl', 'baseRenderUrl') ??
        pickString(result, 'baseRenderUrl', 'dollhouseUrl') ??
        '',
    },
    {
      key: 'topdown',
      label: '结构俯视',
      hint: 'TOP DOWN',
      url:
        assetFile(detail, 'topDownImageUrl', 'topDownUrl') ??
        pickString(result, 'topDownUrl') ??
        '',
    },
    {
      key: 'camera',
      label: '室内机位',
      hint: 'CAMERA',
      url:
        assetFile(detail, 'roomPreviewImageUrl', 'roomPreviewUrl') ??
        pickString(result, 'roomPreviewUrl') ??
        '',
    },
    {
      key: 'depth',
      label: '深度控制图',
      hint: 'DEPTH',
      url:
        assetFile(detail, 'depthUrl') ??
        pickString(controlImages, 'depthUrl') ??
        '',
    },
  ])
}

function AssetDownload({
  href,
  label,
  kind,
}: {
  href?: string
  label: string
  kind: string
}) {
  if (!href) return null
  return (
    <a
      className="asset-download"
      href={assetUrl(href)}
      target="_blank"
      rel="noreferrer"
      download
    >
      <span>{kind}</span>
      <strong>{label}</strong>
    </a>
  )
}

export default function AssetLibrary() {
  const [filter, setFilter] = useState<AssetFilter>('all')
  const [assets, setAssets] = useState<SceneAsset[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<SceneAssetDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [variantType, setVariantType] = useState<VariantType>('camera')
  const [cameraPresetId, setCameraPresetId] = useState('corner_01')
  const [stylePresetId, setStylePresetId] = useState('modern_warm_v1')
  const [renderQuality, setRenderQuality] = useState<RenderQuality>('base')
  const [renderJob, setRenderJob] = useState<Job | null>(null)
  const [rendering, setRendering] = useState(false)
  const [renderNotice, setRenderNotice] = useState('')
  const detailRef = useRef<HTMLElement | null>(null)

  const loadAssets = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const response = await apiFetch('/v1/assets?limit=100', {
        cache: 'no-store',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `资产列表加载失败：${response.status}`)
      }
      const loaded = (await response.json()) as SceneAsset[]
      setAssets(loaded)
      setError('')
      return loaded
    } catch (value) {
      if (!silent) {
        setError(value instanceof Error ? value.message : '资产列表加载失败')
      }
      return []
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (assetId: string) => {
    setDetailLoading(true)
    try {
      const response = await apiFetch(`/v1/assets/${assetId}`, {
        cache: 'no-store',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `资产详情加载失败：${response.status}`)
      }
      const loaded = (await response.json()) as SceneAssetDetail
      setDetail(loaded)
      setCameraPresetId(
        pickString(loaded.sourcePayload, 'cameraPresetId') ?? 'corner_01',
      )
      setStylePresetId(
        pickString(loaded.sourcePayload, 'stylePresetId') ?? 'modern_warm_v1',
      )
      setError('')
      return loaded
    } catch (value) {
      setError(value instanceof Error ? value.message : '资产详情加载失败')
      setDetail(null)
      return null
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadAssets(), 0)
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadAssets(true)
    }
    const interval = window.setInterval(refresh, 12_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [loadAssets])

  useEffect(() => {
    if (!selectedId) return
    const timeout = window.setTimeout(() => void loadDetail(selectedId), 0)
    return () => window.clearTimeout(timeout)
  }, [loadDetail, selectedId])

  const filteredAssets = useMemo(
    () =>
      filter === 'all'
        ? assets
        : assets.filter((asset) => inferAssetModule(asset).key === filter),
    [assets, filter],
  )

  const moduleCounts = useMemo(() => {
    const counts = Object.fromEntries(
      assetModules.map((module) => [module.key, 0]),
    ) as Record<AssetModuleKey, number>
    assets.forEach((asset) => {
      counts[inferAssetModule(asset).key] += 1
    })
    return counts
  }, [assets])

  const activeModule = filter === 'all' ? null : moduleByKey.get(filter) ?? null

  const gallery = useMemo(() => (detail ? assetGallery(detail) : []), [detail])

  const openAsset = (asset: SceneAsset) => {
    setDetail(null)
    setDetailLoading(true)
    setSelectedId(asset.id)
    setRenderJob(null)
    setRenderNotice('')
    window.setTimeout(
      () => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      80,
    )
  }

  const selectModuleFilter = (nextFilter: AssetFilter) => {
    setFilter(nextFilter)
    if (nextFilter === 'all' || !selectedId) return
    const selectedAsset = assets.find((asset) => asset.id === selectedId)
    if (selectedAsset && inferAssetModule(selectedAsset).key === nextFilter) return
    setSelectedId(null)
    setDetail(null)
    setRenderJob(null)
    setRenderNotice('')
  }

  const createVariant = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!detail || detail.generationMode !== 'structured_3d' || rendering) return
    setRendering(true)
    setRenderJob(null)
    setRenderNotice('')
    setError('')
    try {
      const response = await apiFetch(`/v1/assets/${detail.id}/renders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          variantType,
          cameraPresetId,
          stylePresetId,
          renderQuality,
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.detail ?? `派生渲染提交失败：${response.status}`)
      }
      const created = (await response.json()) as Job
      setRenderJob(created)
      const completed = await pollJob(created.id, setRenderJob)
      setRenderJob(completed)
      if (completed.status === 'FAILED') {
        throw new Error(completed.errorMessage ?? '派生渲染失败')
      }

      const refreshed = await loadAssets(true)
      const jobResult = asRecord(completed.result)
      const nestedAsset = asRecord(jobResult.asset)
      const resultAssetId =
        pickString(jobResult, 'assetId') ?? pickString(nestedAsset, 'id')
      const derived = refreshed
        .filter(
          (asset) =>
            asset.id === resultAssetId ||
            asset.jobId === completed.id ||
            asset.parentAssetId === detail.id,
        )
        .sort((first, second) =>
          second.createdAt.localeCompare(first.createdAt),
        )[0]

      if (derived) {
        setSelectedId(derived.id)
      } else {
        await loadDetail(detail.id)
      }
      setRenderNotice('新版本已经生成并自动保存到个人资产。')
    } catch (value) {
      setError(value instanceof Error ? value.message : '派生渲染失败')
    } finally {
      setRendering(false)
    }
  }

  const selectedMetadata = detail ? asRecord(detail.metadata) : {}
  const selectedModule = detail ? inferAssetModule(detail) : null
  const room = asRecord(selectedMetadata.room)
  const structureCheck = detail
    ? asRecord(detail.sourceResult.structureCheck)
    : {}
  const finalImageUrl = detail
    ? assetFile(
        detail,
        'finalImageUrl',
        'finalRenderUrl',
        'imageUrl',
        'outputUrl',
        'comparisonUrl',
        'previewUrl',
      ) ??
      pickString(
        detail.sourceResult,
        'finalRenderUrl',
        'effectUrl',
        'outputUrl',
        'comparisonUrl',
        'previewUrl',
      ) ??
      detail.thumbnailUrl ??
      undefined
    : undefined
  const blendUrl = detail
    ? assetFile(detail, 'blendUrl', 'blenderFileUrl', 'modelUrl')
    : undefined
  const glbUrl = detail
    ? assetFile(detail, 'glbUrl', 'gltfUrl', 'webModelUrl')
    : undefined
  const manifestUrl = detail
    ? assetFile(detail, 'manifestUrl') ??
      pickString(detail.sourceResult, 'manifestUrl')
    : undefined
  const assetCapabilities = detail
    ? asRecord(detail.deliverables.capabilities)
    : {}
  const materialProvider = detail
    ? pickString(detail.sourceResult, 'provider')
    : undefined
  const materialModel = detail
    ? pickString(detail.sourceResult, 'model')
    : undefined
  const materialRequestedProvider = detail
    ? pickString(detail.sourceResult, 'requestedProvider')
    : undefined
  const materialNotice = detail
    ? pickString(detail.sourceResult, 'notice')
    : undefined
  const materialFallbackReason = detail
    ? pickString(detail.sourceResult, 'fallbackReason')
    : undefined
  const materialFallbackUsed = Boolean(
    detail &&
      (detail.generationMode === 'ai_edit_fallback' ||
        detail.sourceResult.fallbackUsed === true),
  )
  const materialAiCompleted = Boolean(
    detail &&
      detail.generationMode === 'ai_edit' &&
      detail.sourceResult.fallbackUsed !== true,
  )
  const canEditStructuredAsset =
    selectedModule?.key === 'floorplan' &&
    detail?.generationMode === 'structured_3d' &&
    assetCapabilities.editableModel === true
  const primaryDownloadUrl = finalImageUrl ?? gallery[0]?.url

  return (
    <div className="page asset-library-page">
      <header className="module-header asset-library-header">
        <div>
          <span className="eyebrow">MODULE 05 · PERSONAL ASSETS</span>
          <h1>我的资产</h1>
          <p>
            当前功能模块生成的结果及旧版本历史记录都会归档。可按来源浏览、下载交付物，或从精确三维资产继续生成新机位与材质版本。
          </p>
        </div>
        <div className="asset-sync-state">
          <span className="service-dot online" />
          自动同步
        </div>
      </header>

      <div className="asset-library-toolbar">
        <div className="asset-filter" role="group" aria-label="资产模块筛选">
          {filterOptions.map((option) => (
            <button
              type="button"
              key={option.value}
              className={filter === option.value ? 'active' : ''}
              onClick={() => selectModuleFilter(option.value)}
            >
              {option.label}
              <span>
                {option.value === 'all'
                  ? assets.length
                  : moduleCounts[option.value]}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="asset-refresh-button"
          onClick={() => void loadAssets()}
          disabled={loading}
        >
          {loading ? '同步中…' : '刷新资产'}
        </button>
      </div>

      {error && <div className="notice notice-error asset-error">{error}</div>}

      <section className="asset-library-shell">
        <div className="asset-history-panel">
          <div className="asset-panel-heading">
            <div>
              <span>HISTORY</span>
              <h2>{activeModule ? activeModule.label : '全部生成历史'}</h2>
            </div>
            <small>
              {filteredAssets.length} 项
              {filter !== 'all' ? ` / 共 ${assets.length} 项` : ''}
            </small>
          </div>

          {loading && assets.length === 0 ? (
            <div className="asset-list-state">正在读取个人资产…</div>
          ) : filteredAssets.length === 0 ? (
            <div className="asset-list-state">
              <strong>
                {activeModule ? `暂无${activeModule.label}资产` : '这里还没有资产'}
              </strong>
              <span>
                {activeModule
                  ? activeModule.emptyHint
                  : '完成任一功能模块的生成后，结果会自动归档到这里。'}
              </span>
            </div>
          ) : (
            <div className="asset-card-grid">
              {filteredAssets.map((asset) => {
                const metadata = asRecord(asset.metadata)
                const assetModule = inferAssetModule(asset)
                const assetRoom = asRecord(metadata.room)
                const dimensions =
                  typeof assetRoom.widthMm === 'number' &&
                  typeof assetRoom.depthMm === 'number'
                    ? `${assetRoom.widthMm} × ${assetRoom.depthMm} mm`
                    : pickString(metadata, 'roomName', 'summary')
                return (
                  <button
                    type="button"
                    className={`asset-card ${selectedId === asset.id ? 'selected' : ''}`}
                    key={asset.id}
                    onClick={() => openAsset(asset)}
                  >
                    <div className="asset-card-cover">
                      {asset.thumbnailUrl ? (
                        <img src={assetUrl(asset.thumbnailUrl)} alt={asset.title} />
                      ) : (
                        <span>NO PREVIEW</span>
                      )}
                      <span
                        className={`asset-module-badge asset-module-${assetModule.key}`}
                      >
                        <i>{assetModule.number}</i>
                        {moduleDisplayName(asset, assetModule)}
                      </span>
                    </div>
                    <div className="asset-card-body">
                      <strong>{asset.title}</strong>
                      <span>{dimensions ?? asset.assetType}</span>
                      <div className="asset-card-meta">
                        <small>{formatDate(asset.createdAt)}</small>
                        <small>{generationModeLabel(asset.generationMode)}</small>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <section className="asset-detail-panel" ref={detailRef}>
          {!selectedId && (
            <div className="asset-detail-empty">
              <span>ASSET</span>
              <h2>选择一项历史资产</h2>
              <p>选择左侧模块资产查看图片和交付物；精确三维还可继续派生机位与材质版本。</p>
            </div>
          )}
          {selectedId && detailLoading && !detail && (
            <div className="asset-detail-empty">
              <span>SYNC</span>
              <h2>正在打开资产</h2>
            </div>
          )}
          {detail && (
            <>
              <div className="asset-detail-heading">
                <div>
                  <span>
                    MODULE {selectedModule?.number} ·{' '}
                    {selectedModule
                      ? moduleDisplayName(detail, selectedModule)
                      : '未知来源'}
                  </span>
                  <h2>{detail.title}</h2>
                  <p>
                    {pickString(room, 'name') ?? '全屋场景'} ·{' '}
                    {generationModeLabel(detail.generationMode)} ·{' '}
                    {formatDate(detail.createdAt)} · 资产 {detail.id.slice(-8)}
                  </p>
                </div>
                <span
                  className={`asset-module-badge asset-module-${selectedModule?.key ?? 'floorplan'}`}
                >
                  <i>{selectedModule?.number}</i>
                  {selectedModule
                    ? moduleDisplayName(detail, selectedModule)
                    : '未知来源'}
                </span>
              </div>

              <div
                className={`asset-gallery ${gallery.length === 1 ? 'single' : ''}`}
              >
                {gallery.map((item) => (
                  <article className="asset-gallery-item" key={item.key}>
                    <div>
                      <strong>{item.label}</strong>
                      <span>{item.hint}</span>
                    </div>
                    <img src={assetUrl(item.url)} alt={item.label} />
                  </article>
                ))}
              </div>

              {selectedModule?.key !== 'floorplan' ? (
                <>
                  <div className="module-asset-actions">
                    <div>
                      <span>
                        MODULE {selectedModule?.number} ·{' '}
                        {selectedModule
                          ? moduleDisplayName(detail, selectedModule)
                          : '未知来源'}
                      </span>
                      <strong>{selectedModule?.label}图像资产</strong>
                      <p>
                        {selectedModule
                          ? moduleAssetNotes[selectedModule.key]
                          : '该模块生成的图像结果已保存，可随时浏览和下载。'}
                      </p>
                    </div>
                    <AssetDownload
                      href={primaryDownloadUrl}
                      label={
                        selectedModule
                          ? moduleDownloadLabels[selectedModule.key]
                          : '下载生成结果'
                      }
                      kind={
                        selectedModule?.key === 'layout' &&
                        detail.generationMode === 'deterministic'
                          ? 'SVG'
                          : 'PNG'
                      }
                    />
                  </div>
                  {selectedModule?.key === 'material_replacement' && (
                    <section
                      className={`material-provider-state asset-material-provider-state ${
                        materialAiCompleted
                          ? 'is-ai'
                          : materialFallbackUsed
                            ? 'is-fallback'
                            : 'is-local'
                      }`}
                    >
                      <span className="material-provider-indicator" />
                      <div>
                        <strong>
                          {materialAiCompleted
                            ? 'AI 材质重绘资产'
                            : materialFallbackUsed
                              ? 'AI 请求已回退为本地材质结果'
                              : '本地材质结果'}
                        </strong>
                        <p>
                          {materialNotice ??
                            '该历史资产没有 Provider 状态元数据，按本地材质结果展示。'}
                        </p>
                      </div>
                      <dl>
                        <div>
                          <dt>实际 Provider</dt>
                          <dd>{materialProvider ?? '本地处理器'}</dd>
                        </div>
                        <div>
                          <dt>模型</dt>
                          <dd>{materialModel ?? '本地材质合成'}</dd>
                        </div>
                        {materialRequestedProvider && (
                          <div>
                            <dt>请求 Provider</dt>
                            <dd>{materialRequestedProvider}</dd>
                          </div>
                        )}
                      </dl>
                      {materialFallbackUsed && materialFallbackReason && (
                        <p className="material-fallback-reason">
                          回退原因：{materialFallbackReason}
                        </p>
                      )}
                    </section>
                  )}
                </>
              ) : detail.generationMode === 'ai_direct' ? (
                <div className="ai-asset-actions">
                  <div>
                    <strong>AI 直出图像资产</strong>
                    <p>
                      此模式没有 Blender 模型；原始平面图与 Semantic
                      仅用于约束生成，可下载最终效果图留存。
                    </p>
                  </div>
                  <AssetDownload
                    href={primaryDownloadUrl}
                    label="下载最终效果图"
                    kind="PNG"
                  />
                </div>
              ) : canEditStructuredAsset ? (
                <>
                  <section className="structured-workbench">
                    <div className="workbench-heading">
                      <div>
                        <span>STRUCTURED 3D WORKBENCH</span>
                        <h3>精确三维工作台</h3>
                      </div>
                      <small>
                        结构校验{' '}
                        {structureCheck.passed === false ? '需复核' : '已通过'}
                      </small>
                    </div>

                    <form className="workbench-controls" onSubmit={createVariant}>
                      <div className="variant-selector" role="group" aria-label="派生类型">
                        <button
                          type="button"
                          className={variantType === 'camera' ? 'active' : ''}
                          onClick={() => setVariantType('camera')}
                        >
                          <strong>新机位</strong>
                          <span>保持模型与材质</span>
                        </button>
                        <button
                          type="button"
                          className={variantType === 'material' ? 'active' : ''}
                          onClick={() => setVariantType('material')}
                        >
                          <strong>材质版本</strong>
                          <span>重建 Blender 材质</span>
                        </button>
                      </div>

                      <label>
                        相机机位
                        <select
                          value={cameraPresetId}
                          onChange={(event) => setCameraPresetId(event.target.value)}
                        >
                          <option value="corner_01">右前角安全机位</option>
                          <option value="corner_02">左前角安全机位</option>
                          <option value="eye_level_01">1.6 米平视机位</option>
                        </select>
                      </label>
                      <label>
                        材质 / 风格预设
                        <select
                          value={stylePresetId}
                          onChange={(event) => setStylePresetId(event.target.value)}
                        >
                          <option value="modern_warm_v1">现代暖调</option>
                          <option value="modern_minimal_v1">现代极简</option>
                          <option value="natural_wood_v1">自然原木</option>
                        </select>
                      </label>
                      <label>
                        输出质量
                        <select
                          value={renderQuality}
                          onChange={(event) =>
                            setRenderQuality(event.target.value as RenderQuality)
                          }
                        >
                          <option value="base">Blender 基础渲染</option>
                          <option value="final">最终写实增强</option>
                        </select>
                      </label>
                      <button
                        className="primary-button workbench-submit"
                        disabled={rendering}
                      >
                        {rendering
                          ? `正在生成 · ${renderJob?.status ?? 'QUEUED'}`
                          : variantType === 'camera'
                            ? '生成新机位版本'
                            : '生成新材质版本'}
                      </button>
                    </form>

                    <div className="workbench-model-note">
                      <strong>模型与写实图是两层资产</strong>
                      <p>
                        Blender 保存可编辑几何、相机和基础材质；gpt-image-2
                        只生成最终写实外观，不会把新增装饰或材质细节自动回写到
                        .blend / .glb 模型。
                      </p>
                    </div>
                    {renderNotice && (
                      <div className="workbench-success" aria-live="polite">
                        {renderNotice}
                      </div>
                    )}
                  </section>

                  <section className="asset-deliverables">
                    <div>
                      <span>DELIVERABLES</span>
                      <h3>三维交付物</h3>
                    </div>
                    <div className="asset-download-grid">
                      <AssetDownload
                        href={finalImageUrl}
                        label="最终效果图"
                        kind="PNG"
                      />
                      <AssetDownload
                        href={blendUrl}
                        label="Blender 可编辑场景"
                        kind="BLEND"
                      />
                      <AssetDownload
                        href={glbUrl}
                        label="通用三维模型"
                        kind="GLB"
                      />
                      <AssetDownload
                        href={manifestUrl}
                        label="场景与审计清单"
                        kind="JSON"
                      />
                    </div>
                    {!blendUrl && !glbUrl && (
                      <p className="deliverable-warning">
                        这项历史资产生成时尚未产出模型交付文件；生成一个新机位或材质版本后会补齐可下载文件。
                      </p>
                    )}
                  </section>
                </>
              ) : (
                <div className="module-asset-actions">
                  <div>
                    <span>MODULE 01 · 户型识别与效果图</span>
                    <strong>效果图图像资产</strong>
                    <p>
                      当前资产没有可编辑 Blender 模型交付物，可浏览和下载效果图，不能继续生成三维机位或材质版本。
                    </p>
                  </div>
                  <AssetDownload
                    href={primaryDownloadUrl}
                    label="下载最终效果图"
                    kind="PNG"
                  />
                </div>
              )}
            </>
          )}
        </section>
      </section>
    </div>
  )
}
