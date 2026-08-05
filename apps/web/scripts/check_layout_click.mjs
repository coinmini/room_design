/**
 * 浏览器验收：打开项目画布 → 点击 02 布局节点 → 截图判断是否布局详情坞
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/tmp/room_design_browser'
mkdirSync(OUT, { recursive: true })

const PROJECT = 'project_28ad2095b5d64d15'
const BASE = 'http://127.0.0.1:5173'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('console.error:', msg.text())
})

try {
  await page.goto(`${BASE}/projects/${PROJECT}/canvas`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/01_canvas.png`, fullPage: true })
  console.log('screenshot: 01_canvas.png')

  // React Flow 节点：找带「平面布局」文案的节点
  const layoutNode = page
    .locator('.react-flow__node')
    .filter({ hasText: '平面布局' })
    .first()
  const count = await page.locator('.react-flow__node').count()
  console.log('react-flow nodes:', count)

  if ((await layoutNode.count()) === 0) {
    // 兜底：点第二个节点（常见为布局）
    const any = page.locator('.react-flow__node').nth(1)
    await any.click({ force: true })
    console.log('clicked nth(1) node fallback')
  } else {
    await layoutNode.scrollIntoViewIfNeeded()
    await layoutNode.click({ force: true })
    console.log('clicked layout node (平面布局)')
  }

  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/02_after_click.png`, fullPage: true })
  console.log('screenshot: 02_after_click.png')

  const bodyText = await page.locator('body').innerText()
  const checks = {
    hasLayoutDetailPill: bodyText.includes('02 布局详情') || bodyText.includes('布局详情'),
    hasGenerateColor: bodyText.includes('生成彩平'),
    hasApprove: bodyText.includes('批准此方案') || bodyText.includes('批准'),
    hasOldStructureError: bodyText.includes('LAYOUT_AI') || bodyText.includes('不是户型分析'),
    hasUploadPrompt: bodyText.includes('选择平面布局图') || bodyText.includes('先上传平面布局图'),
    hasStage01Pill: bodyText.includes('01 结构确认') && bodyText.includes('识别尺寸'),
  }
  console.log('checks:', JSON.stringify(checks, null, 2))

  // 再双击一次
  if ((await layoutNode.count()) > 0) {
    await layoutNode.dblclick({ force: true })
    await page.waitForTimeout(800)
    await page.screenshot({ path: `${OUT}/03_after_dblclick.png`, fullPage: true })
    console.log('screenshot: 03_after_dblclick.png')
  }

  const ok =
    checks.hasLayoutDetailPill &&
    checks.hasGenerateColor &&
    !checks.hasOldStructureError &&
    !checks.hasUploadPrompt

  console.log(ok ? 'RESULT: PASS — 布局详情坞' : 'RESULT: FAIL — 仍是旧界面或未打开详情')
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {})
  process.exit(1)
} finally {
  await browser.close()
}
