/**
 * 主路径浏览器端到端（Playwright）
 *
 * 覆盖：首页 → 项目库 → 资产 → 画布节点/堆叠图库/详情坞/拖把线生成 UI → 项目隔离 → 账户面板
 *
 * 用法（需 web:5173 + api:8000）:
 *   node scripts/check_e2e_main.mjs [projectId] [emptyProjectId]
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'

const OUT = '/tmp/room_design_e2e'
mkdirSync(OUT, { recursive: true })

const BASE = process.env.WEB_BASE || 'http://127.0.0.1:5173'
const API = process.env.API_BASE || 'http://127.0.0.1:8000'
const FULL =
  process.argv[2] ||
  process.env.CANVAS_PROJECT_ID ||
  'project_28ad2095b5d64d15'
const EMPTY =
  process.argv[3] ||
  process.env.EMPTY_PROJECT_ID ||
  'project_d8cc984af1494e24'

const report = { steps: [], ok: false }
const log = (...a) => console.log(...a)
const step = (name, ok, extra = {}) => {
  report.steps.push({ name, ok, ...extra })
  log(`${ok ? 'PASS' : 'FAIL'}: ${name}`, extra)
  return ok
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push(String(e)))

try {
  // --- 1. Home ---
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/01_home.png`, fullPage: true })
  const homeText = await page.locator('body').innerText()
  step('home_loads', /项目|设计|资产|学堂|生成/.test(homeText), {
    snippet: homeText.slice(0, 80).replace(/\s+/g, ' '),
  })

  // Account chip
  const userChip = page.locator('button.fb-user-chip').first()
  if ((await userChip.count()) > 0) {
    await userChip.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${OUT}/01b_account.png`, fullPage: true })
    const acct = await page.locator('body').innerText()
    const acctOk =
      (await page.locator('.fb-acct-menu, [aria-label="账户菜单"]').count()) >
        0 || /积分|订阅|存储|设置|账户/.test(acct)
    step('home_account_panel', acctOk)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  } else {
    step('home_account_panel', false, { reason: 'no fb-user-chip' })
  }

  // --- 2. Projects ---
  await page.goto(`${BASE}/projects`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/02_projects.png`, fullPage: true })
  const projectLinks = await page.locator(`a[href*="/projects/"]`).count()
  const projectCards = await page
    .locator('[class*="project"], article, .fb-project-card')
    .count()
  step('projects_page', projectLinks + projectCards > 0, {
    projectLinks,
    projectCards,
  })

  // --- 3. Assets ---
  await page.goto(`${BASE}/assets`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForTimeout(800)
  await page.screenshot({ path: `${OUT}/03_assets.png`, fullPage: true })
  const assetsText = await page.locator('body').innerText()
  step('assets_page', /我的资产|资产/.test(assetsText), {
    snippet: assetsText.slice(0, 60).replace(/\s+/g, ' '),
  })

  // --- 4. API graph ---
  const graphRes = await fetch(
    `${API}/v1/projects/${encodeURIComponent(FULL)}/canvas-graph`,
  )
  const graph = graphRes.ok ? await graphRes.json() : null
  step('api_canvas_graph', Boolean(graph?.nodes?.length), {
    status: graphRes.status,
    nodeCount: graph?.nodes?.length ?? 0,
  })

  // --- 5. Open full canvas ---
  await page.goto(`${BASE}/projects/${FULL}/canvas`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForSelector('.react-flow__node', { timeout: 30000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/04_canvas.png`, fullPage: true })
  const flowNodes = await page.locator('.react-flow__node').count()
  const spawnHandles = await page.locator('.canvas-handle-spawn').count()
  step('canvas_nodes', flowNodes > 0, { flowNodes, spawnHandles })

  // --- 6. Stack gallery ---
  const stack = page
    .locator('.react-flow__node')
    .filter({ hasText: /堆叠|张/ })
    .first()
  let galleryOk = false
  if ((await stack.count()) > 0) {
    await stack.scrollIntoViewIfNeeded()
    await stack.click({ force: true })
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/05_stack_gallery.png`, fullPage: true })
    const cells = await page.locator('.canvas-stack-gallery-cell').count()
    const hasGallery =
      (await page.locator('.canvas-stack-gallery').count()) > 0 ||
      cells > 0 ||
      (await page.locator('body').innerText()).includes('一屏预览')
    galleryOk = hasGallery && cells >= 1
    step('stack_gallery', galleryOk, { cells })

    // Open a cell → detail dock if possible
    const approvedCell = page
      .locator('.canvas-stack-gallery-cell')
      .filter({ hasText: /已批准/ })
      .first()
    const anyCell = page.locator('.canvas-stack-gallery-cell:not(.is-empty)').first()
    const cell = (await approvedCell.count()) > 0 ? approvedCell : anyCell
    if ((await cell.count()) > 0) {
      await cell.click({ force: true })
      await page.waitForTimeout(900)
      await page.screenshot({
        path: `${OUT}/06_detail_from_gallery.png`,
        fullPage: true,
      })
      const detail =
        (await page.locator('.canvas-layout-detail-dock').count()) > 0 ||
        (await page.locator('.canvas-structure-dock').count()) > 0
      step('detail_from_gallery', detail)
      if (detail) {
        const back = page.locator('button', { hasText: /返回图谱|返回/ }).first()
        if ((await back.count()) > 0) {
          await back.click()
          await page.waitForTimeout(500)
        }
      }
    } else {
      step('detail_from_gallery', false, { reason: 'no gallery cell' })
    }

    // Close gallery if still open
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const closeGallery = page
      .locator('.canvas-stack-gallery button', { hasText: /关闭|返回/ })
      .first()
    if ((await closeGallery.count()) > 0) {
      await closeGallery.click().catch(() => {})
      await page.waitForTimeout(400)
    }
  } else {
    step('stack_gallery', false, { reason: 'no stack node' })
    step('detail_from_gallery', false, { reason: 'skipped' })
  }

  // --- 7. Click non-stack layout / color node for detail ---
  // Ensure gallery closed
  if ((await page.locator('.canvas-stack-gallery').count()) > 0) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
  }
  const single = page
    .locator('.react-flow__node')
    .filter({ hasText: /彩平|轴侧|风格|色调|布局/ })
    .filter({ hasNotText: /堆叠|点击全屏/ })
    .first()
  if ((await single.count()) > 0) {
    await single.scrollIntoViewIfNeeded()
    await single.click({ force: true })
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${OUT}/07_node_detail.png`, fullPage: true })
    const detail =
      (await page.locator('.canvas-layout-detail-dock').count()) > 0 ||
      (await page.locator('button', { hasText: /批准|取消批准|生成/ }).count()) >
        0
    step('node_click_detail_or_actions', detail)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const back = page.locator('button', { hasText: /返回图谱/ }).first()
    if ((await back.count()) > 0) {
      await back.click()
      await page.waitForTimeout(400)
    }
  } else {
    // double-click stack is still ok if earlier detail worked
    const prev = report.steps.find((s) => s.name === 'detail_from_gallery')
    step('node_click_detail_or_actions', Boolean(prev?.ok), {
      reason: 'no non-stack stage node; rely on gallery path',
    })
  }

  // --- 8. Spawn mop wire ---
  // re-open canvas cleanly
  await page.goto(`${BASE}/projects/${FULL}/canvas`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForSelector('.react-flow__node', { timeout: 30000 })
  await page.waitForTimeout(1000)
  const handle = page.locator('.canvas-handle-spawn').first()
  let spawnOk = false
  if ((await handle.count()) > 0) {
    // hover parent so handle is visible
    const parent = handle.locator('xpath=ancestor::div[contains(@class,"react-flow__node")][1]')
    if ((await parent.count()) > 0) {
      await parent.hover({ force: true }).catch(() => {})
    }
    await page.waitForTimeout(200)
    const box = await handle.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 140, box.y + 60, { steps: 16 })
      await page.mouse.up()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${OUT}/08_spawn.png`, fullPage: true })
      const menu = await page.locator('.canvas-spawn-menu').count()
      const dialog = await page.locator('.canvas-gen-dialog').count()
      const panel = await page
        .locator('.canvas-stage-panel, [class*="stage-panel"]')
        .count()
      spawnOk = menu + dialog + panel > 0
      step('spawn_ui', spawnOk, { menu, dialog, panel })
    } else {
      step('spawn_ui', false, { reason: 'handle no bbox' })
    }
  } else {
    const hasApproved = Boolean(
      graph?.nodes?.some(
        (n) => n.approved || n.approvalStatus === 'approved',
      ),
    )
    // no spawn handle without approved nodes is acceptable
    step('spawn_ui', !hasApproved, {
      reason: 'no spawn handle',
      hasApproved,
    })
  }

  // --- 9. Isolation: empty project ---
  await page.goto(`${BASE}/projects/${EMPTY}/canvas`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${OUT}/09_empty.png`, fullPage: true })
  const emptyNodes = await page.locator('.react-flow__node').count()
  const emptyBody = await page.locator('body').innerText()
  const emptyOk =
    emptyNodes === 0 &&
    (/从户型开始|上传户型/.test(emptyBody) || emptyNodes === 0)
  step('empty_project_isolation', emptyOk, {
    emptyNodes,
    hasHint: /从户型开始|上传户型/.test(emptyBody),
  })

  // --- 10. Console ---
  const serious = consoleErrors.filter(
    (t) =>
      !/favicon|Download the React DevTools|ResizeObserver|Failed to load resource/.test(
        t,
      ),
  )
  step('no_serious_console_errors', serious.length === 0, {
    count: serious.length,
    sample: serious.slice(0, 5),
  })

  report.ok = report.steps.every((s) => s.ok)
  report.consoleErrors = serious
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  log(report.ok ? '\nALL E2E PATHS OK' : '\nSOME E2E PATHS FAILED')
  log('report:', `${OUT}/report.json`)
  log('screenshots:', OUT)
  process.exitCode = report.ok ? 0 : 1
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/error.png`, fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
