export const COLOR_PLAN_VARIANTS = [
  'simple_2d',
  'topdown_3d',
  'watercolor',
  'material_realistic',
] as const

export const AXONOMETRIC_VARIANTS = [
  'isometric_day',
  'isometric_night',
  'alternate_angle',
] as const

/** 轴侧方案中文名 */
export const AXONOMETRIC_VARIANT_LABELS: Record<
  (typeof AXONOMETRIC_VARIANTS)[number],
  string
> = {
  isometric_day: '日景轴侧',
  isometric_night: '夜景轴侧',
  alternate_angle: '替代角度',
}

export const STYLE_SCHEME_VARIANTS = [
  'modern_minimal',
  'natural_wood',
  'midcentury_vintage',
] as const

/** 风格方案中文名（选方案面板） */
export const STYLE_SCHEME_VARIANT_LABELS: Record<
  (typeof STYLE_SCHEME_VARIANTS)[number],
  string
> = {
  modern_minimal: '现代极简',
  natural_wood: '自然原木',
  midcentury_vintage: '中古复古',
}

export const TONE_SCHEME_VARIANTS = [
  'warm_gold_day',
  'neutral_dusk',
  'cool_blue_night',
] as const

/** 色调方案中文名 */
export const TONE_SCHEME_VARIANT_LABELS: Record<
  (typeof TONE_SCHEME_VARIANTS)[number],
  string
> = {
  warm_gold_day: '暖金日景',
  neutral_dusk: '中性黄昏',
  cool_blue_night: '冷蓝夜景',
}
