/**
 * 浏览器验收：打开项目画布 → 堆叠图库 / 详情坞（不误进 01 结构编辑）
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/tmp/room_design_browser'
mkdirSync(OUT, { recursive: true })

const PROJECT = process.argv[2] || 'project_28ad2095b5d64d15'
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:5173'

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
  await page.waitForSelector('.react-flow__node', { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/01_canvas.png`, fullPage: true })
  console.log('screenshot: 01_canvas.png')

  const count = await page.locator('.react-flow__node').count()
  console.log('react-flow nodes:', count)

  const stack = page
    .locator('.react-flow__node')
    .filter({ hasText: /堆叠|张/ })
    .first()
  if ((await stack.count()) > 0) {
    await stack.click({ force: true })
    await page.waitForTimeout(800)
    console.log('opened stack gallery')
    const cell = page
      .locator('.canvas-stack-gallery-cell:not(.is-empty)')
      .first()
    if ((await cell.count()) > 0) {
      await cell.click({ force: true })
      await page.waitForTimeout(900)
      console.log('clicked gallery cell')
    }
  } else {
    const any = page.locator('.react-flow__node').nth(1)
    await any.click({ force: true })
    console.log('clicked nth(1) node fallback')
    await page.waitForTimeout(900)
  }

  await page.screenshot({ path: `${OUT}/02_after_click.png`, fullPage: true })
  console.log('screenshot: 02_after_click.png')

  const body = await page.locator('body').innerText()
  const checks = {
    hasDetailDock:
      (await page.locator('.canvas-layout-detail-dock').count()) > 0 ||
      (await page.locator('.canvas-stack-gallery').count()) > 0,
    hasApprove: /批准/.test(body),
    hasOldStructureError: /无法打开结构编辑器：任务类型为 LAYOUT/.test(body),
    hasReturn: /返回图谱|关闭|一屏预览|全屏/.test(body),
  }
  console.log('checks:', JSON.stringify(checks, null, 2))

  const ok =
    !checks.hasOldStructureError &&
    (checks.hasDetailDock || checks.hasApprove || checks.hasReturn)
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL — 未打开详情/图库')
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {})
  process.exit(1)
} finally {
  await browser.close()
}
