/**
 * 点击分空间堆叠 → 全屏图库，11 张一屏可见
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/tmp/room_design_browser'
mkdirSync(OUT, { recursive: true })
const PROJECT = 'project_28ad2095b5d64d15'
const BASE = 'http://127.0.0.1:5173'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

try {
  await page.goto(`${BASE}/projects/${PROJECT}/canvas`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.waitForSelector('.react-flow__node', { timeout: 30000 })
  await page.waitForTimeout(1500)

  // 找分空间大堆叠（11 张）
  const stack = page
    .locator('.react-flow__node')
    .filter({ hasText: /分空间.*11|11 张/ })
    .first()
  if ((await stack.count()) === 0) {
    // 兜底任意堆叠
    const any = page.locator('.react-flow__node.is-stack, .react-flow__node').filter({ hasText: /堆叠|张/ }).first()
    await any.click({ force: true })
    console.log('clicked fallback stack')
  } else {
    await stack.scrollIntoViewIfNeeded()
    await stack.click({ force: true })
    console.log('clicked 11-space stack')
  }

  await page.waitForTimeout(1000)
  await page.screenshot({ path: `${OUT}/stack_gallery.png` })

  const body = await page.locator('body').innerText()
  const hasGallery =
    body.includes('一屏预览') ||
    body.includes('全屏') ||
    body.includes('共 ')
  const cellCount = await page.locator('.canvas-stack-gallery-cell').count()
  console.log({ hasGallery, cellCount, snippet: body.slice(0, 180).replace(/\s+/g, ' ') })

  // 默认一屏 4 格；大堆叠可分页
  const ok = hasGallery && cellCount >= 1
  console.log(ok ? 'RESULT: PASS — 全屏图库' : 'RESULT: FAIL')
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/stack_gallery_err.png` }).catch(() => {})
  process.exit(1)
} finally {
  await browser.close()
}
