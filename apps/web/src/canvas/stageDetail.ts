/**
 * 01–08 图片阶段详情坞：元信息 + 下游主操作。
 * 01 先放大预览，再点图进入结构编辑器；02–08 为方案图详情。
 */

export type StageDetailMeta = {
  code: string
  pill: string
  description: string
  footer: string
  /** 是否展示「批准」按钮（01 用结构确认、08 末端结果一般不批） */
  showApprove: boolean
  /** 主图是否可点进入编辑（01 结构编辑） */
  imageClickHint?: string
}

export type StageDeriveAction = {
  action: string
  label: string
  primary?: boolean
}

/** 单击即可进入图片详情坞的阶段（02–08 方案图；01 单独用 canOpenStageDetail） */
export const IMAGE_DETAIL_STAGES = [
  'layout',
  'color_plan',
  'axonometric',
  'space_render',
  'style_scheme',
  'tone_scheme',
  'local_edit',
] as const

export type ImageDetailStage = (typeof IMAGE_DETAIL_STAGES)[number]

export function isImageDetailStage(stage: string): stage is ImageDetailStage {
  return (IMAGE_DETAIL_STAGES as readonly string[]).includes(stage)
}

/** 01–08：均可先放大预览（01 再进结构编辑器） */
export function canOpenStageDetail(stage: string): boolean {
  return stage === 'floorplan' || isImageDetailStage(stage)
}

const STAGE_META: Record<string, StageDetailMeta> = {
  floorplan: {
    code: '01 / STRUCTURE DETAIL',
    pill: '阶段 01 · 结构识别',
    description:
      '已载入户型识别结果。点击大图进入结构编辑器，核对房间参数并确认后可生成布局（02）。',
    footer: '单击大图或点「编辑结构」进入编辑模式；确认结构后返回图谱再生成布局。',
    showApprove: false,
    imageClickHint: '点击进入结构编辑',
  },
  layout: {
    code: '02 / LAYOUT DETAIL',
    pill: '阶段 02 · 平面布局',
    description: '已载入当前节点布局图。可批准此方案，或直接生成彩平（03）。',
    footer: '此图已从画布节点自动载入，无需重新上传。批准后可用于生成彩平。',
    showApprove: true,
  },
  color_plan: {
    code: '03 / COLOR PLAN DETAIL',
    pill: '阶段 03 · 彩平方案',
    description: '已载入当前彩平方案图。可批准此方案，或派生轴侧（04）/ 分空间（05）。',
    footer: '此图已从画布节点自动载入。批准后可生成轴测图或分空间效果。',
    showApprove: true,
  },
  axonometric: {
    code: '04 / AXONOMETRIC DETAIL',
    pill: '阶段 04 · 轴侧方案',
    description: '已载入当前轴侧图。可批准此方案，或继续生成分空间（05）。',
    footer: '此图已从画布节点自动载入。批准后可派生分空间效果。',
    showApprove: true,
  },
  space_render: {
    code: '05 / SPACE RENDER DETAIL',
    pill: '阶段 05 · 分空间效果',
    description: '已载入当前分空间效果图。可批准此方案，或生成风格方案（06）。',
    footer: '此图已从画布节点自动载入。批准后可进入风格方案阶段。',
    showApprove: true,
  },
  style_scheme: {
    code: '06 / STYLE SCHEME DETAIL',
    pill: '阶段 06 · 风格方案',
    description: '已载入当前风格方案图。可批准此方案，或生成色调方案（07）。',
    footer: '此图已从画布节点自动载入。批准后可进入色调阶段。',
    showApprove: true,
  },
  tone_scheme: {
    code: '07 / TONE SCHEME DETAIL',
    pill: '阶段 07 · 色调方案',
    description: '已载入当前色调方案图。可批准此方案，或进行局部修改（08）。',
    footer: '此图已从画布节点自动载入。批准后可发起局部修改。',
    showApprove: true,
  },
  local_edit: {
    code: '08 / LOCAL EDIT DETAIL',
    pill: '阶段 08 · 局部修改',
    description: '已载入局部修改结果。可查看原图或下载归档。',
    footer: '此为流程末端结果图，已从画布节点自动载入。',
    showApprove: false,
  },
}

export function stageDetailMeta(stage: string): StageDetailMeta {
  if (STAGE_META[stage]) return STAGE_META[stage]
  return {
    code: `${stage.toUpperCase()} DETAIL`,
    pill: stage,
    description: '已载入当前节点方案图。',
    footer: '此图已从画布节点自动载入。',
    showApprove: true,
  }
}

/** 各阶段详情页主按钮：01 编辑结构 / 02–08 派生下一阶段 */
export function primaryDeriveActionsForStage(stage: string): StageDeriveAction[] {
  switch (stage) {
    case 'floorplan':
      return [
        {
          action: 'view_structure',
          label: '编辑结构',
          primary: true,
        },
        {
          action: 'generate_layout',
          label: '生成布局（02）',
        },
      ]
    case 'layout':
      return [
        {
          action: 'generate_color_plan',
          label: '生成彩平（03）',
          primary: true,
        },
      ]
    case 'color_plan':
      return [
        {
          action: 'generate_axonometric',
          label: '生成轴侧（04）',
          primary: true,
        },
        {
          action: 'generate_space_render',
          label: '生成分空间（05）',
        },
      ]
    case 'axonometric':
      return [
        {
          action: 'generate_space_render',
          label: '生成分空间（05）',
          primary: true,
        },
      ]
    case 'space_render':
      return [
        {
          action: 'generate_style_scheme',
          label: '生成风格方案（06）',
          primary: true,
        },
      ]
    case 'style_scheme':
      return [
        {
          action: 'generate_tone_scheme',
          label: '生成色调方案（07）',
          primary: true,
        },
      ]
    case 'tone_scheme':
      return [
        {
          action: 'local_edit',
          label: '局部修改（08）',
          primary: true,
        },
      ]
    case 'local_edit':
    default:
      return []
  }
}
