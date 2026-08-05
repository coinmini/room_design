/**
 * 画布 MVP 主路径浏览器回归（Playwright）
 *
 * 1) 打开画布并看到节点
 * 2) 点击布局相关节点 → 详情坞 / 堆叠图库
 * 3) 若有已批准布局：拖线或菜单可打开生成彩平相关 UI
 *
 * 用法（需 web:5173 + api:8000）:
 *   node scripts/check_canvas_mvp_paths.mjs [projectId]
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'

const OUT = '/tmp/room_design_mvp_paths'
mkdirSync(OUT, { recursive: true })

const PROJECT =
  process.argv[2] ||
  process.env.CANVAS_PROJECT_ID ||
  'project_28ad2095b5d64d15'
const BASE = process.env.WEB_BASE || 'http://127.0.0.1:5173'
const API = process.env.API_BASE || 'http://127.0.0.1:8000'

const log = (...args) => console.log(...args)
const fail = (msg) => {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

async function apiGraph(projectId) {
  const res = await fetch(
    `${API}/v1/projects/${encodeURIComponent(projectId)}/canvas-graph`,
  )
  if (!res.ok) throw new Error(`canvas-graph ${res.status}`)
  return res.json()
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const report = { projectId: PROJECT, steps: [] }

try {
  // --- Path 0: API graph exists ---
  let graph
  try {
    graph = await apiGraph(PROJECT)
    report.steps.push({
      name: 'api_canvas_graph',
      ok: true,
      nodeCount: graph.nodes?.length ?? 0,
    })
    log('path0 api graph nodes:', graph.nodes?.length ?? 0)
  } catch (e) {
    report.steps.push({ name: 'api_canvas_graph', ok: false, error: String(e) })
    fail(`api graph: ${e}`)
  }

  // --- Path 1: open canvas, see nodes ---
  await page.goto(`${BASE}/projects/${PROJECT}/canvas`, {
    waitUntil: 'networkidle',
    timeout: 60000,
  })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${OUT}/01_canvas.png`, fullPage: true })
  const nodeCount = await page.locator('.react-flow__node, .canvas-node-card').count()
  report.steps.push({ name: 'open_canvas_nodes', ok: nodeCount > 0, nodeCount })
  log('path1 nodes:', nodeCount)
  if (nodeCount === 0) fail('canvas has zero nodes')

  // --- Path 2: click layout / stack / detail ---
  let openedDetail = false
  const stack = page.locator('.canvas-node-card', { hasText: '堆叠' }).first()
  if ((await stack.count()) > 0) {
    await stack.click()
    await page.waitForTimeout(1000)
    await page.screenshot({ path: `${OUT}/02_stack_or_detail.png`, fullPage: true })
    const gallery = await page.locator('.canvas-stack-gallery, [class*="stack-gallery"]').count()
    const detail = await page
      .locator('.canvas-layout-detail-dock, .canvas-structure-dock')
      .count()
    openedDetail = gallery > 0 || detail > 0
    // try open approved item
    const approvedBtn = page.locator('button', { hasText: '已批准' }).first()
    if ((await approvedBtn.count()) > 0) {
      await approvedBtn.click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${OUT}/02b_detail.png`, fullPage: true })
      openedDetail =
        openedDetail ||
        (await page.locator('.canvas-layout-detail-dock').count()) > 0
    }
  } else {
    const anyCard = page.locator('.canvas-node-card').nth(1)
    if ((await anyCard.count()) > 0) {
      await anyCard.click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${OUT}/02_click.png`, fullPage: true })
      openedDetail =
        (await page.locator('.canvas-layout-detail-dock, .canvas-structure-dock').count()) >
        0
    }
  }
  report.steps.push({ name: 'open_detail_or_gallery', ok: openedDetail })
  log('path2 detail/gallery:', openedDetail)
  if (!openedDetail) fail('could not open detail dock or stack gallery')

  // close overlays
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const back = page.locator('button', { hasText: '返回图谱' })
  if ((await back.count()) > 0) {
    await back.first().click()
    await page.waitForTimeout(400)
  }

  // --- Path 3: spawn UI from approved layout (color plan dialog or menu) ---
  let spawnOk = false
  const spawnHandle = page.locator('.canvas-handle-spawn').first()
  if ((await spawnHandle.count()) > 0) {
    const box = await spawnHandle.boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(80, 400, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: `${OUT}/03_spawn.png`, fullPage: true })
      const menu = await page.locator('.canvas-spawn-menu').count()
      const dialog = await page.locator('.canvas-gen-dialog, .canvas-space-select').count()
      spawnOk = menu > 0 || dialog > 0
      log('path3 spawn menu/dialog:', menu, dialog)
    }
  } else {
    // no approved spawn handle — still pass if graph has only unapproved layouts
    const hasApproved = Boolean(
      graph?.nodes?.some((n) => n.approved || n.approvalStatus === 'approved'),
    )
    spawnOk = !hasApproved
    log('path3 no spawn handle; hasApproved=', hasApproved, 'treat as', spawnOk)
  }
  report.steps.push({ name: 'spawn_ui', ok: spawnOk })
  if (!spawnOk) fail('spawn UI not shown for approved node')

  const allOk = report.steps.every((s) => s.ok)
  report.ok = allOk
  writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
  log(allOk ? 'ALL PATHS OK' : 'SOME PATHS FAILED')
  log('report:', `${OUT}/report.json`)
} catch (e) {
  console.error(e)
  process.exitCode = 1
} finally {
  await browser.close()
}
