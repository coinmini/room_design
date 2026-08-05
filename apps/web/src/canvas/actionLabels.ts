/** 画布 action → 中文短名（toast / 防连点提示） */
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    upload_floorplan_submit: '01 户型识别',
    reanalyze: '01 重新识别',
    generate_layout: '02 布局',
    generate_color_plan: '03 彩平',
    generate_axonometric: '04 轴侧',
    generate_space_render: '05 分空间',
    generate_style_scheme: '06 风格',
    generate_tone_scheme: '07 色调',
    local_edit: '08 局部修改',
  }
  return map[action] || action
}
