/**
 * 画布进行中任务：离开页面后仍可恢复占位与轮询。
 * 以 localStorage 记骨架元数据，并以 /v1/jobs?projectId= 校验服务端状态。
 */

import type { Job } from '../api'

const storageKey = (projectId: string) =>
  `room_design_canvas_active_jobs:${projectId}`

export type ActiveCanvasJobRecord = {
  jobId: string
  action: string
  groupId: string
  parentAssetId?: string
  parentNodeId?: string
  slots: Array<{
    id: string
    label: string
    workflowStage: string
  }>
  updatedAt: number
}

export function loadActiveCanvasJobs(projectId: string): ActiveCanvasJobRecord[] {
  try {
    const raw = localStorage.getItem(storageKey(projectId))
    if (!raw) return []
    const parsed = JSON.parse(raw) as ActiveCanvasJobRecord[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item) => item && typeof item.jobId === 'string')
  } catch {
    return []
  }
}

export function saveActiveCanvasJobs(
  projectId: string,
  jobs: ActiveCanvasJobRecord[],
): void {
  try {
    if (!jobs.length) {
      localStorage.removeItem(storageKey(projectId))
      return
    }
    localStorage.setItem(storageKey(projectId), JSON.stringify(jobs))
  } catch {
    /* quota / private mode */
  }
}

export function upsertActiveCanvasJob(
  projectId: string,
  record: ActiveCanvasJobRecord,
): void {
  const current = loadActiveCanvasJobs(projectId).filter(
    (item) => item.jobId !== record.jobId && item.groupId !== record.groupId,
  )
  current.push({ ...record, updatedAt: Date.now() })
  saveActiveCanvasJobs(projectId, current)
}

export function removeActiveCanvasJob(
  projectId: string,
  opts: { jobId?: string; groupId?: string },
): void {
  const next = loadActiveCanvasJobs(projectId).filter((item) => {
    if (opts.jobId && item.jobId === opts.jobId) return false
    if (opts.groupId && item.groupId === opts.groupId) return false
    return true
  })
  saveActiveCanvasJobs(projectId, next)
}

export function clearActiveCanvasJobs(projectId: string): void {
  saveActiveCanvasJobs(projectId, [])
}

/** 服务端 job.type → 画布 action（用于恢复骨架列） */
export function actionFromJobType(type: string): string | null {
  switch (type) {
    case 'LAYOUT':
    case 'LAYOUT_AI':
      return 'generate_layout'
    case 'AI_COLOR_PLAN':
      return 'generate_color_plan'
    case 'AI_AXONOMETRIC':
      return 'generate_axonometric'
    case 'AI_SPACE_RENDER':
      return 'generate_space_render'
    case 'AI_STYLE_SCHEME':
      return 'generate_style_scheme'
    case 'AI_TONE_SCHEME':
      return 'generate_tone_scheme'
    case 'AI_LOCAL_EDIT':
      return 'local_edit'
    case 'FLOORPLAN_ANALYZE':
      return 'upload_floorplan_submit'
    default:
      return null
  }
}

export function workflowStageFromAction(action: string): string {
  switch (action) {
    case 'generate_layout':
      return 'layout'
    case 'generate_color_plan':
      return 'color_plan'
    case 'generate_axonometric':
      return 'axonometric'
    case 'generate_space_render':
      return 'space_render'
    case 'generate_style_scheme':
      return 'style_scheme'
    case 'generate_tone_scheme':
      return 'tone_scheme'
    case 'local_edit':
      return 'local_edit'
    case 'upload_floorplan_submit':
    case 'reanalyze':
      return 'floorplan'
    default:
      return 'other'
  }
}

export function isActiveJobStatus(status: Job['status'] | string): boolean {
  return status === 'QUEUED' || status === 'RUNNING'
}

export function parentAssetIdFromJob(job: Job): string | undefined {
  const payload = job.payload ?? {}
  const id =
    payload.asset_parent_id ??
    payload.assetParentId ??
    payload.parent_asset_id ??
    payload.parentAssetId
  return typeof id === 'string' && id ? id : undefined
}
