export type SchoolTabKey = 'tutor' | 'works'

export type SchoolCard = {
  id: string
  title: string
  en: string
  image: string
  /** 讲师姓名 */
  instructor: string
  /** 讲师简介 */
  instructorBio: string
  /** 课程或作品介绍 */
  description: string
  /** 课时 / 作品标签 */
  meta?: string
}

export const SCHOOL_TABS: Array<{ key: SchoolTabKey; label: string }> = [
  { key: 'tutor', label: '讲师课程' },
  { key: 'works', label: '讲师作品' },
]

export const SCHOOL_VISIBLE = 3

export const SCHOOL_CARDS: Record<SchoolTabKey, SchoolCard[]> = {
  tutor: [
    {
      id: 'tutor-live',
      title: '直播授课 · 方案拆解',
      en: 'Live Class',
      image: '/courses/tutor-live.jpg',
      instructor: '林晓',
      instructorBio:
        '资深室内设计师，10 年方案与软装经验，擅长从客户需求拆解到空间叙事的完整链路。',
      description:
        '通过真实项目直播拆解需求、动线与材质选择，带你看懂一套方案从概念到落地表达的关键决策。适合有一定基础、希望提升方案逻辑的设计师。',
      meta: '视频课 · 6 课时',
    },
    {
      id: 'tutor-online',
      title: 'AI 工作流系统课',
      en: 'AI Workflow',
      image: '/courses/tutor-online.jpg',
      instructor: '周衡',
      instructorBio:
        'AI 设计工具布道者，专注户型到效果图全链路自动化，服务多家设计工作室与独立工作室。',
      description:
        '系统讲解提示词、参考图、阶段生成与资产归档，建立可复用的 AI 室内设计工作流，减少重复劳动。',
      meta: '视频课 · 8 课时',
    },
    {
      id: 'tutor-workshop',
      title: '材质与色板实战',
      en: 'Material Lab',
      image: '/courses/tutor-workshop.jpg',
      instructor: '苏晚',
      instructorBio:
        '材质与色彩顾问，长期服务高端住宅与酒店项目，擅长温暖系与极简系色板构建。',
      description:
        '从色温、对比与触感出发，手把手完成墙地柜软装色板，并映射到 AI 渲染中的材质关键词。',
      meta: '视频课 · 5 课时',
    },
    {
      id: 'tutor-render',
      title: '写实渲染大师班',
      en: 'Render Master',
      image: '/courses/tutor-render.jpg',
      instructor: '韩澈',
      instructorBio:
        '效果图与灯光专家，曾任职国际可视化工作室，追求摄影级光影与材质真实感。',
      description:
        '聚焦灯光层次、曝光与后期质感增强，学会把 AI 粗渲推进到可交付的写实成片。',
      meta: '视频课 · 10 课时',
    },
    {
      id: 'tutor-class',
      title: '大师班 · 现场教学',
      en: 'Master Class',
      image: '/courses/tutor-class.jpg',
      instructor: '陈叙',
      instructorBio:
        '设计院校客座讲师，强调「概念—结构—表现」三位一体的教学体系。',
      description:
        '还原课堂现场的提问与点评，覆盖方案汇报话术、客户异议处理与作品集呈现。',
      meta: '视频课 · 4 课时',
    },
    {
      id: 'tutor-tablet',
      title: '平板端方案精修',
      en: 'Tablet Studio',
      image: '/courses/tutor-tablet.jpg',
      instructor: '周衡',
      instructorBio:
        'AI 设计工具布道者，专注移动端与桌面端协同的高效创作习惯。',
      description:
        '演示平板端标注、局部修改与客户沟通截图流程，让外勤也能推进方案迭代。',
      meta: '视频课 · 3 课时',
    },
    {
      id: 'tutor-lighting',
      title: '灯光设计进阶',
      en: 'Lighting Lab',
      image: '/courses/tutor-lighting.jpg',
      instructor: '韩澈',
      instructorBio:
        '效果图与灯光专家，擅长氛围光与功能光的平衡表达。',
      description:
        '从主光、补光到灯带与艺术灯具，系统建立室内灯光逻辑，并转化到 AI 提示中。',
      meta: '视频课 · 5 课时',
    },
    {
      id: 'tutor-layout',
      title: '家具布局与动线',
      en: 'Layout Lab',
      image: '/courses/tutor-layout.jpg',
      instructor: '林晓',
      instructorBio:
        '资深室内设计师，擅长小户型动线优化与功能区重组。',
      description:
        '用真实户型练习家具落位、动线宽度与视线关系，输出可落地的平面布局策略。',
      meta: '视频课 · 6 课时',
    },
    {
      id: 'tutor-palette',
      title: '风格色板系统课',
      en: 'Style Palette',
      image: '/courses/tutor-palette.jpg',
      instructor: '苏晚',
      instructorBio:
        '材质与色彩顾问，建立多风格可复用的色板库方法论。',
      description:
        '覆盖原木、意式轻奢、现代极简等风格色板模板，学会快速匹配项目气质。',
      meta: '视频课 · 4 课时',
    },
  ],
  works: [
    {
      id: 'work-gallery',
      title: '作品集展览墙',
      en: 'Portfolio Wall',
      image: '/courses/work-gallery.jpg',
      instructor: '陈叙',
      instructorBio:
        '设计院校客座讲师，作品集辅导经验丰富，擅长叙事型展示结构。',
      description:
        '为毕业季与求职季打造的展览墙叙事，强调序列、节奏与项目亮点提炼。',
      meta: '作品 · 展示设计',
    },
    {
      id: 'work-villa',
      title: '别墅客厅代表作',
      en: 'Villa Living',
      image: '/courses/work-villa.jpg',
      instructor: '林晓',
      instructorBio:
        '资深室内设计师，专注高端住宅公共区的尺度与氛围营造。',
      description:
        '双层挑高客厅，暖木与石材对话，兼顾会客仪式感与日常舒适。',
      meta: '作品 · 住宅',
    },
    {
      id: 'work-hotel',
      title: '酒店套房作品',
      en: 'Hotel Suite',
      image: '/courses/work-hotel.jpg',
      instructor: '苏晚',
      instructorBio:
        '材质与色彩顾问，酒店软装与色彩体系实践者。',
      description:
        '套房以低饱和暖色为主，灯光层次细腻，呈现度假式私密体验。',
      meta: '作品 · 酒店',
    },
    {
      id: 'work-rooftop',
      title: '屋顶花园作品',
      en: 'Rooftop Garden',
      image: '/courses/work-rooftop.jpg',
      instructor: '韩澈',
      instructorBio:
        '灯光与氛围专家，兼做景观夜景可视化。',
      description:
        '屋顶露台结合灯串与城市天际线，打造可社交可独处的户外客厅。',
      meta: '作品 · 景观',
    },
    {
      id: 'work-penthouse',
      title: '空中别墅客厅',
      en: 'Penthouse',
      image: '/courses/work-penthouse.jpg',
      instructor: '林晓',
      instructorBio:
        '资深室内设计师，擅长大尺度落地窗与景观借景。',
      description:
        '全景落地窗客厅，家具克制、材质克制，让城市景观成为主角。',
      meta: '作品 · 住宅',
    },
    {
      id: 'work-spa',
      title: '极简 SPA 卫浴',
      en: 'Spa Bath',
      image: '/courses/work-spa.jpg',
      instructor: '苏晚',
      instructorBio:
        '材质与色彩顾问，偏好石材与柔光结合的疗愈空间。',
      description:
        '独立浴缸与洞石墙面，天光洒落，呈现极简 SPA 般的沐浴仪式。',
      meta: '作品 · 卫浴',
    },
    {
      id: 'work-kitchen',
      title: '开放式厨餐厅',
      en: 'Kitchen Dining',
      image: '/courses/work-kitchen.jpg',
      instructor: '周衡',
      instructorBio:
        'AI 设计工具布道者，也长期输出可落地的开放式厨房方案。',
      description:
        '中岛串联烹饪与用餐，橡木与岩板对比，适合家庭社交动线。',
      meta: '作品 · 厨房',
    },
    {
      id: 'work-courtyard',
      title: '中式庭院夜景',
      en: 'Courtyard Night',
      image: '/courses/work-courtyard.jpg',
      instructor: '韩澈',
      instructorBio:
        '灯光与氛围专家，擅长水景倒影与夜景叙事。',
      description:
        '庭院水面与灯笼倒影交织，现代中式气质，适合别墅园林配套。',
      meta: '作品 · 景观',
    },
    {
      id: 'work-cafe',
      title: '精品咖啡空间',
      en: 'Boutique Cafe',
      image: '/courses/work-cafe.jpg',
      instructor: '陈叙',
      instructorBio:
        '商业空间与叙事体验设计，注重动线与停留点设计。',
      description:
        '弧形卡座与水磨石地面，绿植与暖光营造轻松社交氛围。',
      meta: '作品 · 商业',
    },
  ],
}
