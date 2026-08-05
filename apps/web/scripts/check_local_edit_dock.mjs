/**
 * 浏览器验收：进入 08 局部修改专注坞，确认源图可加载（非黑屏/非 CORS 报错）
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'

const OUT = '/tmp/room_design_browser'
mkdirSync(OUT, { recursive: true })

const PROJECT = 'project_28ad2095b5d64d15'
const BASE = 'http://127.0.0.1:5173'
const ARTIFACT = 'floorplan-kuyao-final-c8f8b5d6ed16.png'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrors.push(msg.text())
    console.log('console.error:', msg.text().slice(0, 200))
  }
})

const log = (...a) => console.log(...a)

try {
  await page.goto(`${BASE}/projects/${PROJECT}/canvas`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  // 等 React Flow 节点
  await page.waitForSelector('.react-flow__node', { timeout: 30000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/local_edit_01_canvas.png` })

  // 在页面内用 XHR 测 artifact（与 apiFetch 一致）
  const xhrProbe = await page.evaluate(async (name) => {
    return await new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      const url = `http://127.0.0.1:8000/artifacts/${name}?t=${Date.now()}`
      xhr.open('GET', url, true)
      xhr.responseType = 'blob'
      xhr.onload = () =>
        resolve({
          status: xhr.status,
          size: xhr.response?.size ?? 0,
          type: xhr.response?.type ?? '',
        })
      xhr.onerror = () => resolve({ status: 0, error: 'xhr error' })
      xhr.send()
    })
  }, ARTIFACT)
  log('xhrProbe from canvas origin:', JSON.stringify(xhrProbe))

  // 展开 07 色调堆叠（若仍折叠）
  const toneStack = page
    .locator('.react-flow__node')
    .filter({ hasText: /色调 · \d+ 张|tone.*张/i })
    .first()
  if ((await toneStack.count()) > 0) {
    await toneStack.click({ force: true })
    await page.waitForTimeout(600)
    log('expanded tone stack')
  }

  // 点已批准的 warm gold day（避免点到「收起」按钮）
  const warm = page
    .locator('.react-flow__node')
    .filter({ hasText: /warm gold day|暖金/i })
    .first()
  if ((await warm.count()) === 0) {
    throw new Error('找不到 tone warm gold day 节点')
  }
  // 点节点主体/图片区域
  const warmBox = await warm.boundingBox()
  if (warmBox) {
    await page.mouse.click(
      warmBox.x + warmBox.width / 2,
      warmBox.y + warmBox.height * 0.55,
    )
  } else {
    await warm.click({ force: true, position: { x: 100, y: 120 } })
  }
  log('clicked warm gold day')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/local_edit_02_detail.png` })

  let body = await page.locator('body').innerText()
  log(
    'detail?',
    body.includes('07') || body.includes('TONE'),
    'local btn?',
    body.includes('局部修改'),
  )

  // 详情坞里的「局部修改（08）」
  const localBtn = page.getByRole('button', { name: /局部修改/ })
  if ((await localBtn.count()) === 0) {
    // 再点一次节点
    await warm.click({ force: true, position: { x: 110, y: 140 } })
    await page.waitForTimeout(1000)
  }
  await page.getByRole('button', { name: /局部修改/ }).first().click({ timeout: 10000 })
  log('clicked 局部修改')

  // 等待坞与加载
  await page.waitForTimeout(500)
  await page
    .getByText(/08 局部修改|LOCAL EDIT|修改说明/)
    .first()
    .waitFor({ timeout: 15000 })
  // 等待 ready 或 error
  for (let i = 0; i < 40; i++) {
    body = await page.locator('body').innerText()
    if (
      body.includes('源图加载失败') ||
      body.includes('读取源图失败') ||
      body.includes('提交局部修改') ||
      body.includes('清除标注')
    ) {
      // 若还在 loading 会只有 正在载入
      if (!body.includes('正在载入源图')) break
    }
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/local_edit_03_dock.png` })

  body = await page.locator('body').innerText()
  const hasDock =
    body.includes('08 局部修改') ||
    body.includes('LOCAL EDIT') ||
    body.includes('红笔')
  const hasLoadError =
    body.includes('源图加载失败') ||
    body.includes('读取源图失败') ||
    body.includes('跨域')
  const stillLoading = body.includes('正在载入源图')

  const canvasStats = await page.evaluate(() => {
    const c = document.querySelector('.canvas-local-edit-canvas')
    if (!c) return { found: false }
    const w = c.width
    const h = c.height
    const display = getComputedStyle(c).display
    if (!w || !h) return { found: true, w, h, display, empty: true }
    const ctx = c.getContext('2d')
    if (!ctx) return { found: true, w, h, display, noCtx: true }
    const sample = ctx.getImageData(
      Math.floor(w * 0.2),
      Math.floor(h * 0.2),
      Math.max(2, Math.floor(w * 0.6)),
      Math.max(2, Math.floor(h * 0.6)),
    )
    let nonBlack = 0
    let samples = 0
    for (let i = 0; i < sample.data.length; i += 32) {
      samples += 1
      const r = sample.data[i]
      const g = sample.data[i + 1]
      const b = sample.data[i + 2]
      const a = sample.data[i + 3]
      if (a > 8 && (r > 12 || g > 12 || b > 12)) nonBlack += 1
    }
    return { found: true, w, h, display, nonBlack, samples }
  })
  log('canvasStats:', JSON.stringify(canvasStats))

  const imageVisible =
    canvasStats.found &&
    canvasStats.display !== 'none' &&
    (canvasStats.w || 0) > 10 &&
    (canvasStats.nonBlack || 0) > 30

  const result = {
    xhrProbe,
    hasDock,
    hasLoadError,
    stillLoading,
    imageVisible,
    canvasStats,
    consoleErrors: consoleErrors.slice(0, 8),
  }
  writeFileSync(`${OUT}/local_edit_result.json`, JSON.stringify(result, null, 2))
  log('RESULT json:', JSON.stringify(result, null, 2))

  const ok =
    hasDock &&
    !hasLoadError &&
    !stillLoading &&
    imageVisible &&
    xhrProbe.status === 200 &&
    xhrProbe.size > 1000

  console.log(
    ok
      ? 'RESULT: PASS — 08 局部修改坞源图已加载'
      : 'RESULT: FAIL — 坞未打开或源图未显示',
  )
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/local_edit_error.png` }).catch(() => {})
  process.exit(1)
} finally {
  await browser.close()
}
