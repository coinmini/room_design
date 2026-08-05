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
  approved?: boolean
  variantId?: string
  spaceId?: string
  spaceName?: string
}

const showLegacyTools = import.meta.env.VITE_SHOW_LEGACY_TOOLS === 'true'
const legacyModuleKeys = new Set<AssetModuleKey>([
  'floorplan',
  'white_model',
  'effect_render',
])

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
    key: 'ai_workflow',
    number: '03–08',
    label: 'AI 设计工作流',
    emptyHint:
      '彩平、轴侧、空间效果、风格、色调和局部修改结果会按工作流阶段自动归档到这里。',
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
  ...assetModules
    .filter((module) => showLegacyTools || !legacyModuleKeys.has(module.key))
    .map((module) => ({
      value: module.key,
      label: `${module.number} ${module.label}`,
    })),
]

const modeLabels: Record<string, string> = {
  ai_direct: 'AI 直出',
  structured_3d: '历史三维实验',
  ai_workflow: 'AI 工作流',
  ai_color_plan: 'AI 彩平',
  ai_axonometric: 'AI 轴侧',
  ai_space_render: 'AI 空间效果',
  ai_style_scheme: 'AI 风格方案',
  ai_tone_scheme: 'AI 色调方案',
  ai_local_edit: 'AI 局部修改',
  deterministic: '规则求解',
  ai_image: 'AI 生图',
  ai_quick: 'AI 快速渲染',
  ai_edit: 'AI 材质重绘',
  ai_edit_fallback: 'AI 回退材质替换',
  local_preview: '本地预览',
  local_edit: '本地材质编辑',
}

const workflowStageLabels: Record<string, string> = {
  color_plan: '03 彩平方案',
  axonometric: '04 轴侧方案',
  space_render: '05 空间效果',
  style: '06 风格方案',
  style_scheme: '06 风格方案',
  tone: '07 色调方案',
  tone_scheme: '07 色调方案',
  local_edit: '08 局部修改',
}

const workflowVariantLabels: Record<string, string> = {
  style_modern_minimal: '现代极简',
  style_natural_wood: '日式原木',
  style_wabi_sabi: '侘寂质感',
  style_midcentury_vintage: '中古复古',
  style_french_luxury: '法式轻奢',
  tone_warm_gold_day: '暖金日景',
  tone_neutral_dusk: '中性暮色',
  tone_cool_blue_night: '冷蓝夜景',
  local_edit: '局部修改结果',
}

type WorkflowSourceDescriptor = {
  label: string
  hint: string
  deliverableKeys: string[]
}

function workflowSourceDescriptor(
  workflowStage: string,
): WorkflowSourceDescriptor {
  if (workflowStage === 'style' || workflowStage === 'style_scheme') {
    return {
      label: '已批准空间效果基准',
      hint: 'APPROVED SPACE RENDER',
      deliverableKeys: ['sourceSpaceImageUrl', 'sourceImageUrl'],
    }
  }
  if (workflowStage === 'tone' || workflowStage === 'tone_scheme') {
    return {
      label: '已批准风格方案基准',
      hint: 'APPROVED STYLE SCHEME',
      deliverableKeys: ['sourceSpaceImageUrl', 'sourceImageUrl'],
    }
  }
  if (workflowStage === 'local_edit') {
    return {
      label: '已批准色调方案基准',
      hint: 'APPROVED TONE SCHEME',
      deliverableKeys: ['sourceSpaceImageUrl', 'sourceImageUrl'],
    }
  }
  if (workflowStage === 'axonometric' || workflowStage === 'space_render') {
    return {
      label: '已批准彩平图',
      hint: 'APPROVED COLOR PLAN',
      deliverableKeys: ['approvedColorPlanImageUrl', 'sourceImageUrl'],
    }
  }
  return {
    label: '已批准平面布局',
    hint: 'APPROVED LAYOUT',
    deliverableKeys: [
      'approvedLayoutImageUrl',
      'sourceImageUrl',
      'layoutImageUrl',
    ],
  }
}

const moduleByKey = new Map(assetModules.map((module) => [module.key, module]))

const moduleByJobType: Record<string, AssetModuleKey> = {
  FLOORPLAN_SCENE: 'floorplan',
  LAYOUT: 'layout',
  LAYOUT_AI: 'layout',
  WHITE_MODEL_RENDER: 'white_model',
  EFFECT_RENDER: 'effect_render',
  MATERIAL_REPLACEMENT: 'material_replacement',
  AI_WORKFLOW_COLOR_PLAN: 'ai_workflow',
  AI_WORKFLOW_AXONOMETRIC: 'ai_workflow',
  AI_WORKFLOW_SPACE_RENDER: 'ai_workflow',
  COLOR_PLAN_RENDER: 'ai_workflow',
  AXONOMETRIC_RENDER: 'ai_workflow',
  SPACE_RENDER: 'ai_workflow',
  AI_COLOR_PLAN: 'ai_workflow',
  AI_AXONOMETRIC: 'ai_workflow',
  AI_SPACE_RENDER: 'ai_workflow',
  AI_STYLE_SCHEME: 'ai_workflow',
  AI_TONE_SCHEME: 'ai_workflow',
  AI_LOCAL_EDIT: 'ai_workflow',
}

function normalizeModuleKey(value: unknown): AssetModuleKey | undefined {
  if (typeof value !== 'string') return undefined
  const aliases: Record<string, AssetModuleKey> = {
    floorplan: 'floorplan',
    floorplan_scene: 'floorplan',
    layout: 'layout',
    ai_workflow: 'ai_workflow',
    color_plan: 'ai_workflow',
    axonometric: 'ai_workflow',
    space_render: 'ai_workflow',
    style: 'ai_workflow',
    style_scheme: 'ai_workflow',
    tone: 'ai_workflow',
    tone_scheme: 'ai_workflow',
    local_edit: 'ai_workflow',
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

  if (pickString(metadata, 'workflowStage', 'workflow_stage')) {
    return moduleByKey.get('ai_workflow')!
  }

  const assetType = asset.assetType.toLowerCase()
  if (assetType.includes('layout')) return moduleByKey.get('layout')!
  if (
    assetType.includes('color_plan') ||
    assetType.includes('axonometric') ||
    assetType.includes('space_render') ||
    assetType.includes('style_scheme') ||
    assetType.includes('tone_scheme') ||
    assetType.includes('local_edit')
  ) {
    return moduleByKey.get('ai_workflow')!
  }
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
    '保存旧版户型实验生成的结构参考与效果图，仅作为历史能力兼容。',
  layout:
    '保存 AI 生成的平面布局方案。概念布局与尺寸仍需人工复核后使用。',
  ai_workflow:
    '保存 AI 工作流 03–08 生成的彩平、轴侧、空间效果、风格、色调和局部修改结果，并保留阶段与父资产谱系。',
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
  ai_workflow: '下载当前阶段图片',
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

function approvalStatusLabel(status?: string): string {
  const labels: Record<string, string> = {
    approved: '已批准',
    review_required: '待人工确认',
    rejected: '已驳回',
  }
  return status ? (labels[status] ?? status) : '待人工确认'
}

function safeDownloadPart(value: string): string {
  return Array.from(value.normalize('NFKC'))
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
}

function imageExtension(blob: Blob, url: string): string {
  const extensionByMime: Record<string, string> = {
    'image/avif': 'avif',
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/svg+xml': 'svg',
    'image/webp': 'webp',
  }
  const normalizedMime = blob.type.toLowerCase().split(';')[0]
  if (extensionByMime[normalizedMime]) return extensionByMime[normalizedMime]

  const urlExtension = url
    .split(/[?#]/)[0]
    .match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]
    ?.toLowerCase()
  return urlExtension &&
    ['avif', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp'].includes(urlExtension)
    ? urlExtension === 'jpeg'
      ? 'jpg'
      : urlExtension
    : 'png'
}

function semanticLayoutFromDetail(
  detail: SceneAssetDetail,
): Record<string, unknown> | null {
  const candidates = [
    detail.sourcePayload.semanticLayout,
    detail.sourcePayload.semantic_layout,
    detail.sourceResult.semanticLayout,
    detail.sourceResult.semantic_layout,
    detail.metadata.semanticLayout,
    detail.metadata.semantic_layout,
  ]

  for (const candidate of candidates) {
    const record = asRecord(candidate)
    if (!Object.keys(record).length) continue
    const nested = asRecord(record.semanticLayout ?? record.semantic_layout)
    const layout = Object.keys(nested).length ? nested : record
    if (Array.isArray(layout.rooms)) return layout
  }
  return null
}

function galleryDownloadFilename(
  detail: SceneAssetDetail,
  item: GalleryItem,
  extension: string,
): string {
  const module = inferAssetModule(detail)
  const metadata = asRecord(detail.metadata)
  const semanticLayout = asRecord(
    detail.sourcePayload.semantic_layout ??
      detail.sourcePayload.semanticLayout ??
      detail.sourceResult.semanticLayout ??
      detail.sourceResult.semantic_layout,
  )
  const semanticRooms = Array.isArray(semanticLayout.rooms)
    ? semanticLayout.rooms
    : []
  const semanticRoom = semanticRooms
    .map(asRecord)
    .find(
      (room) =>
        item.spaceId &&
        pickString(room, 'id', 'roomId', 'room_id') === item.spaceId,
    )
  const spaceLabel =
    item.spaceName ??
    (semanticRoom
      ? pickString(semanticRoom, 'name', 'label', 'roomName', 'room_name')
      : undefined) ??
    pickString(metadata, 'spaceName', 'space_name') ??
    item.spaceId
  const workflowStage = pickString(
    metadata,
    'workflowStage',
    'workflow_stage',
  )
  const variantLabel = item.variantId
    ? workflowVariantLabels[item.variantId] ?? item.variantId.replaceAll('_', ' ')
    : undefined
  const parts = [
    'AI设计工作流',
    module.key === 'layout'
      ? '02 平面布局'
      : workflowStage
        ? workflowStageLabels[workflowStage] ?? workflowStage
        : module.label,
    spaceLabel,
    variantLabel,
    item.label,
    `资产-${detail.id.slice(-8)}`,
  ]
    .filter((part): part is string => Boolean(part?.trim()))
    .map(safeDownloadPart)
    .filter(Boolean)
    .filter((part, index, values) => values.indexOf(part) === index)

  return `${parts.join('_')}.${extension}`
}

function semanticLayoutDownloadFilename(detail: SceneAssetDetail): string {
  return [
    'AI设计工作流',
    '02平面布局',
    'SemanticLayout',
    `资产-${detail.id.slice(-8)}`,
  ]
    .map(safeDownloadPart)
    .filter(Boolean)
    .join('_')
    .concat('.json')
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
    const describedLayouts = layouts.flatMap((layout, index) => {
      const record = asRecord(layout)
      const url = pickString(
        record,
        'previewUrl',
        'url',
        'imageUrl',
        'outputUrl',
      )
      if (!url) return []
      const variantId = pickString(record, 'layoutId', 'layout_id', 'variantId')
      return [
        {
          key: `layout-${variantId ?? index}`,
          label: `布局方案 ${index + 1}`,
          hint:
            detail.generationMode === 'ai_image'
              ? 'AI LAYOUT'
              : 'LEGACY LAYOUT',
          url,
          variantId,
        },
      ]
    })
    const previewUrls = [
      ...assetUrls(detail, 'previewUrls', 'layoutUrls', 'outputUrls'),
    ]
    return uniqueGallery([
      ...describedLayouts,
      ...previewUrls.map((url, index) => ({
        key: `layout-fallback-${index}`,
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

  if (module.key === 'ai_workflow') {
    const metadata = asRecord(detail.metadata)
    const approvedVariantId =
      pickString(metadata, 'approvedVariantId', 'approved_variant_id') ??
      pickString(detail.deliverables, 'approvedVariantId', 'approved_variant_id')
    const workflowStage =
      pickString(metadata, 'workflowStage', 'workflow_stage') ??
      pickString(result, 'workflowStage', 'workflow_stage') ??
      'ai_workflow'
    const sourceDescriptor = workflowSourceDescriptor(workflowStage)
    const resultOutputs = Array.isArray(result.outputs) ? result.outputs : []
    const describedOutputs = resultOutputs.flatMap((output, index) => {
      const record = asRecord(output)
      const url = pickString(
        record,
        'url',
        'imageUrl',
        'outputUrl',
        'previewUrl',
      )
      if (!url) return []
      const variantId = pickString(record, 'variantId', 'variant_id')
      const spaceId = pickString(record, 'spaceId', 'space_id')
      const spaceName = pickString(record, 'spaceName', 'space_name')
      const friendlyVariantLabel = variantId
        ? workflowVariantLabels[variantId]
        : undefined
      return [
        {
          key: `workflow-${workflowStage}-${variantId ?? spaceId ?? index}`,
          label:
            spaceName ??
            friendlyVariantLabel ??
            (workflowStage === 'style_scheme'
              ? `风格方案 ${index + 1}`
              : workflowStage === 'tone_scheme'
                ? `色调方案 ${index + 1}`
                : variantId?.replaceAll('_', ' ')) ??
            `${workflowStageLabels[workflowStage] ?? 'AI 工作流'} ${index + 1}`,
          hint: [workflowStage, variantId, spaceId]
            .filter(Boolean)
            .join(' · ')
            .toUpperCase()
            .replaceAll('_', ' '),
          url,
          approved: Boolean(variantId && variantId === approvedVariantId),
          variantId,
          spaceId,
          spaceName,
        },
      ]
    })
    const fallbackOutputUrls = [
      ...assetUrls(
        detail,
        'outputUrls',
        'renderUrls',
        'imageUrls',
        'finalImageUrl',
      ),
      ...urlsFromValue(result.renders),
      ...urlsFromValue(result.images),
      ...urlsFromValue(result.variants),
    ]
    return uniqueGallery([
      ...describedOutputs,
      ...fallbackOutputUrls.map((url, index) => ({
        key: `workflow-${workflowStage}-${index}`,
        label: `${workflowStageLabels[workflowStage] ?? 'AI 工作流'} ${index + 1}`,
        hint: workflowStage.toUpperCase().replaceAll('_', ' '),
        url,
      })),
      {
        key: 'workflow-final',
        label: workflowStageLabels[workflowStage] ?? 'AI 工作流结果',
        hint: 'AI WORKFLOW',
        url: finalUrl ?? '',
      },
      {
        key: 'workflow-source',
        label: sourceDescriptor.label,
        hint: sourceDescriptor.hint,
        url: assetFile(detail, ...sourceDescriptor.deliverableKeys) ?? '',
      },
      ...(workflowStage === 'local_edit'
        ? [
            {
              key: 'workflow-mask',
              label: '局部修改蒙版',
              hint: 'EDIT MASK · WHITE = EDIT',
              url: assetFile(detail, 'maskImageUrl') ?? '',
            },
          ]
        : []),
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
    { key: 'final', label: '历史最终增强', hint: 'LEGACY FINAL', url: finalUrl ?? '' },
    {
      key: 'base',
      label: '历史基础渲染',
      hint: 'LEGACY BASE',
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

type AssetLibraryProps = {
  /** 从首页 / 深链传入时，挂载后自动打开该资产详情 */
  initialAssetId?: string | null
}

export default function AssetLibrary({
  initialAssetId = null,
}: AssetLibraryProps = {}) {
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
  const [downloadingGalleryKey, setDownloadingGalleryKey] = useState('')
  const detailRef = useRef<HTMLElement | null>(null)
  const openedInitialRef = useRef(false)

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

  // 首页 / 深链：自动打开指定资产（列表加载后；若列表未命中则直接拉详情）
  useEffect(() => {
    if (!initialAssetId || openedInitialRef.current) return
    if (loading) return

    openedInitialRef.current = true
    const hit = assets.find((asset) => asset.id === initialAssetId)
    setDetail(null)
    setDetailLoading(true)
    setSelectedId(initialAssetId)
    setRenderJob(null)
    setRenderNotice('')
    if (hit) {
      const moduleKey = inferAssetModule(hit).key
      setFilter(moduleKey)
    }
    window.setTimeout(
      () => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      120,
    )
  }, [initialAssetId, loading, assets])

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

  const downloadGalleryItem = async (item: GalleryItem) => {
    if (!detail || downloadingGalleryKey) return
    setDownloadingGalleryKey(item.key)
    setError('')
    try {
      const response = await apiFetch(item.url, { cache: 'no-store' })
      if (!response.ok) {
        throw new Error(`图片下载失败：${response.status}`)
      }
      const blob = await response.blob()
      if (!blob.size) throw new Error('图片下载失败：服务端返回了空文件')

      const objectUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = objectUrl
      anchor.download = galleryDownloadFilename(
        detail,
        item,
        imageExtension(blob, item.url),
      )
      anchor.style.display = 'none'
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
    } catch (value) {
      setError(value instanceof Error ? value.message : '图片下载失败')
    } finally {
      setDownloadingGalleryKey('')
    }
  }

  const downloadSemanticLayout = () => {
    if (!detail) return
    const semanticLayout = semanticLayoutFromDetail(detail)
    if (!semanticLayout) {
      setError('该平面布局资产没有保存完整的 SemanticLayout')
      return
    }

    setError('')
    const blob = new Blob([JSON.stringify(semanticLayout, null, 2)], {
      type: 'application/json;charset=utf-8',
    })
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = semanticLayoutDownloadFilename(detail)
    anchor.style.display = 'none'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000)
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
  const selectedSemanticLayout = detail
    ? semanticLayoutFromDetail(detail)
    : null
  const workflowApprovalStatus = pickString(
    selectedMetadata,
    'approvalStatus',
    'approval_status',
  )
  const workflowApprovedVariantId =
    pickString(selectedMetadata, 'approvedVariantId', 'approved_variant_id') ??
    (detail
      ? pickString(
          detail.deliverables,
          'approvedVariantId',
          'approved_variant_id',
        )
      : undefined)
  const workflowApprovedAt = pickString(
    selectedMetadata,
    'approvedAt',
    'approved_at',
  )
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
    showLegacyTools &&
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
            彩平、轴侧、空间效果及后续编辑结果都会自动归档。可按工作流阶段追溯输入、版本和生成图片。
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
                const workflowStage = pickString(
                  metadata,
                  'workflowStage',
                  'workflow_stage',
                )
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
                        <small>
                          {workflowStage
                            ? (workflowStageLabels[workflowStage] ?? workflowStage)
                            : generationModeLabel(asset.generationMode)}
                        </small>
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
              <p>选择左侧资产查看所属工作流阶段、生成图片和可下载文件。</p>
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
                    {selectedModule?.key === 'ai_workflow' &&
                      `${workflowStageLabels[pickString(selectedMetadata, 'workflowStage', 'workflow_stage') ?? ''] ?? 'AI 工作流'} · `}
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
                    <div className="asset-gallery-item-heading">
                      <div className="asset-gallery-item-copy">
                        <strong>
                          {item.label}
                          {item.approved && (
                            <span
                              className="asset-module-badge asset-module-ai_workflow"
                              style={{ marginLeft: 8, verticalAlign: 'middle' }}
                            >
                              <i>✓</i>
                              已批准
                            </span>
                          )}
                        </strong>
                        <span>{item.hint}</span>
                      </div>
                      {(selectedModule?.key === 'ai_workflow' ||
                        selectedModule?.key === 'layout') && (
                        <button
                          type="button"
                          className="asset-gallery-download"
                          disabled={Boolean(downloadingGalleryKey)}
                          onClick={() => void downloadGalleryItem(item)}
                          aria-label={`单独下载${item.label}`}
                        >
                          {downloadingGalleryKey === item.key
                            ? '下载中…'
                            : '↓ 单独下载'}
                        </button>
                      )}
                    </div>
                    <img src={assetUrl(item.url)} alt={item.label} />
                  </article>
                ))}
              </div>

              {selectedModule?.key === 'layout' && (
                <section className="asset-deliverables layout-archive-deliverables">
                  <div>
                    <span>STAGE 02 · RECOVERY PACKAGE</span>
                    <h3>平面布局可恢复交付物</h3>
                    <p>
                      每张布局图可在上方单独下载；SemanticLayout JSON
                      保留了生成该批布局时的房间、墙体、门窗与尺寸约束，可用于从后续阶段继续。
                    </p>
                  </div>
                  <div className="asset-download-grid">
                    <button
                      type="button"
                      className="asset-download asset-download-button"
                      onClick={downloadSemanticLayout}
                      disabled={!selectedSemanticLayout}
                    >
                      <span>JSON</span>
                      <strong>
                        {selectedSemanticLayout
                          ? '下载 SemanticLayout'
                          : '无可用 SemanticLayout'}
                      </strong>
                    </button>
                  </div>
                  {!selectedSemanticLayout && (
                    <p className="deliverable-warning">
                      该历史资产生成时未保存完整 SemanticLayout；新生成的
                      Stage 02 资产会自动保留并允许下载。
                    </p>
                  )}
                </section>
              )}

              {selectedModule?.key === 'ai_workflow' && (
                <section
                  className={`material-provider-state asset-material-provider-state ${
                    workflowApprovalStatus === 'approved'
                      ? 'is-ai'
                      : 'is-fallback'
                  }`}
                >
                  <span className="material-provider-indicator" />
                  <div>
                    <strong>
                      {workflowApprovalStatus === 'approved'
                        ? '工作流方案已批准'
                        : '工作流方案等待人工确认'}
                    </strong>
                    <p>
                      {workflowApprovalStatus === 'approved'
                        ? '下游阶段应继承已批准变体及当前资产 ID。'
                        : '请选择具体成功变体完成审批后，再作为下游生成基准。'}
                    </p>
                  </div>
                  <dl>
                    <div>
                      <dt>approvalStatus</dt>
                      <dd>{approvalStatusLabel(workflowApprovalStatus)}</dd>
                    </div>
                    <div>
                      <dt>approvedVariantId</dt>
                      <dd>{workflowApprovedVariantId ?? '—'}</dd>
                    </div>
                    <div>
                      <dt>approvedAt</dt>
                      <dd>
                        {workflowApprovedAt ? formatDate(workflowApprovedAt) : '—'}
                      </dd>
                    </div>
                  </dl>
                </section>
              )}

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
                      这是旧版实验生成的图像资产，可继续浏览和下载；当前默认设计流程使用纯 AI 阶段资产。
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
