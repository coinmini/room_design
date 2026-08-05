/**
 * 验收：打开空项目画布，节点数应为 0，不应灌入全库 orphan 资产
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const OUT = '/tmp/room_design_browser'
mkdirSync(OUT, { recursive: true })
const BASE = 'http://127.0.0.1:5173'
const EMPTY = 'project_d8cc984af1494e24'
const FULL = 'project_28ad2095b5d64d15'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

async function openCanvas(projectId) {
  await page.goto(`${BASE}/projects/${projectId}/canvas`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  await page.waitForTimeout(2000)
  const body = await page.locator('body').innerText()
  const nodeCount = await page.locator('.react-flow__node').count()
  // topbar pill like "38 节点" or "0 节点"
  const m = body.match(/(\d+)\s*节点/)
  return {
    projectId,
    flowNodes: nodeCount,
    pillNodes: m ? Number(m[1]) : null,
    hasEmptyHint: body.includes('从户型开始') || body.includes('上传户型'),
    bodySnippet: body.slice(0, 200).replace(/\s+/g, ' '),
  }
}

try {
  // homepage
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 })
  await page.screenshot({ path: `${OUT}/iso_01_home.png` })
  console.log('home ok')

  // click empty-ish project via direct URL (name 9:45)
  const empty = await openCanvas(EMPTY)
  await page.screenshot({ path: `${OUT}/iso_02_empty_project.png` })
  console.log('empty project:', JSON.stringify(empty))

  const full = await openCanvas(FULL)
  await page.screenshot({ path: `${OUT}/iso_03_full_project.png` })
  console.log('full project:', JSON.stringify(full))

  const emptyOk =
    empty.flowNodes === 0 &&
    (empty.pillNodes === 0 || empty.pillNodes === null || empty.hasEmptyHint)
  const fullOk = full.flowNodes > 0 && full.flowNodes < 80 // was 297 with orphans
  const ok = emptyOk && fullOk
  console.log(
    ok
      ? 'RESULT: PASS — 空项目隔离，满项目未灌入全库 orphan'
      : 'RESULT: FAIL — 项目资产未隔离',
  )
  process.exit(ok ? 0 : 1)
} catch (e) {
  console.error(e)
  await page.screenshot({ path: `${OUT}/iso_error.png` }).catch(() => {})
  process.exit(1)
} finally {
  await browser.close()
}
