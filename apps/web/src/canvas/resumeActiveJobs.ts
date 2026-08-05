/**
 * 离开再进：合并服务端 RUNNING/QUEUED job 与 localStorage 骨架，恢复轮询。
 * 纯数据层；UI 绑定（setState / poll）由调用方完成。
 */

import { apiFetch, type Job } from '../api'
import {
  actionFromJobType,
  clearActiveCanvasJobs,
  isActiveJobStatus,
  loadActiveCanvasJobs,
  parentAssetIdFromJob,
  removeActiveCanvasJob,
  type ActiveCanvasJobRecord,
  workflowStageFromAction,
} from './activeJobs'

export function skeletonCountForAction(action: string, job: Job): number {
  if (action === 'generate_layout') {
    return Math.max(1, Number(job.payload?.count) || 2)
  }
  if (action === 'generate_color_plan') return 4
  if (
    action === 'generate_axonometric' ||
    action === 'generate_style_scheme' ||
    action === 'generate_tone_scheme'
  ) {
    return 3
  }
  // 分空间：payload 里可能有 selected_space_ids
  if (action === 'generate_space_render') {
    const raw = job.payload?.selected_space_ids
    if (typeof raw === 'string' && raw.trim()) {
      return Math.max(1, raw.split(',').filter(Boolean).length)
    }
    return 1
  }
  return 1
}

/**
 * 收集需要恢复的进行中任务记录。
 * 网络失败时仍尽量用 localStorage；无活跃任务时清理陈旧本地记录。
 */
export async function collectActiveJobsToResume(
  projectId: string,
  signal?: AbortSignal,
): Promise<ActiveCanvasJobRecord[]> {
  let serverJobs: Job[] = []
  try {
    const response = await apiFetch(
      `/v1/jobs?projectId=${encodeURIComponent(projectId)}&limit=50`,
      { cache: 'no-store', signal },
    )
    if (response.ok) {
      const list = (await response.json()) as Job[]
      serverJobs = Array.isArray(list)
        ? list.filter((j) => isActiveJobStatus(j.status))
        : []
    }
  } catch {
    /* 网络失败时仍尝试 localStorage */
  }
  if (signal?.aborted) return []

  const local = loadActiveCanvasJobs(projectId)
  const byJobId = new Map<string, ActiveCanvasJobRecord>()
  for (const item of local) byJobId.set(item.jobId, item)

  const toResume: ActiveCanvasJobRecord[] = []
  for (const job of serverJobs) {
    const action = actionFromJobType(job.type)
    if (!action) continue
    const cached = byJobId.get(job.id)
    const parentAssetId = cached?.parentAssetId || parentAssetIdFromJob(job)
    const stage = workflowStageFromAction(action)
    const count = skeletonCountForAction(action, job)
    const groupId = cached?.groupId || `resume-${job.id}`
    const slots =
      cached?.slots?.length === count
        ? cached.slots
        : Array.from({ length: count }, (_, i) => ({
            id: `${groupId}-${i + 1}`,
            label:
              action === 'generate_layout'
                ? `布局方案 ${i + 1}`
                : `生成中 ${i + 1}`,
            workflowStage: stage,
          }))
    toResume.push({
      jobId: job.id,
      action,
      groupId,
      parentAssetId,
      parentNodeId: cached?.parentNodeId,
      slots,
      updatedAt: Date.now(),
    })
  }

  for (const item of local) {
    if (toResume.some((r) => r.jobId === item.jobId)) continue
    try {
      const response = await apiFetch(
        `/v1/jobs/${encodeURIComponent(item.jobId)}`,
        { cache: 'no-store', signal },
      )
      if (!response.ok) {
        removeActiveCanvasJob(projectId, { jobId: item.jobId })
        continue
      }
      const job = (await response.json()) as Job
      if (isActiveJobStatus(job.status)) toResume.push(item)
      else removeActiveCanvasJob(projectId, { jobId: item.jobId })
    } catch {
      /* keep for next visit */
    }
  }

  if (!toResume.length && local.length) {
    clearActiveCanvasJobs(projectId)
  }
  return toResume
}
