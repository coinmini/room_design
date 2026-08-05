/**
 * W3-2：并发模型辅助。
 * jobs: Map<nodeId, Job>
 * busyJobIds: Set<jobId>
 * abortControllers: Map<jobId, AbortController>
 */

import type { Job } from '../api'

export type JobMap = Map<string, Job>
export type BusySet = Set<string>
export type AbortMap = Map<string, AbortController>

export function createJobMap(initial?: Iterable<[string, Job]>): JobMap {
  return new Map(initial)
}

export function upsertJob(map: JobMap, nodeId: string, job: Job): JobMap {
  const next = new Map(map)
  next.set(nodeId, job)
  return next
}

export function removeJobs(map: JobMap, nodeIds: string[]): JobMap {
  const next = new Map(map)
  for (const id of nodeIds) next.delete(id)
  return next
}

/** 按 stage 前缀清理（兼容旧向导 stage key，W3-3 设基准时不再调用删除下游）。 */
export function jobsForStagePrefix(map: JobMap, stage: string): Array<[string, Job]> {
  return [...map.entries()].filter(
    ([key, job]) => key.startsWith(`${stage}:`) || job.payload?.workflow_stage === stage,
  )
}

export function markBusy(busy: BusySet, jobId: string): BusySet {
  const next = new Set(busy)
  next.add(jobId)
  return next
}

export function clearBusy(busy: BusySet, jobId: string): BusySet {
  const next = new Set(busy)
  next.delete(jobId)
  return next
}

export function isBusy(busy: BusySet, jobId?: string | null): boolean {
  if (!jobId) return busy.size > 0
  return busy.has(jobId)
}

export function trackAbort(map: AbortMap, jobId: string): AbortController {
  map.get(jobId)?.abort()
  const controller = new AbortController()
  map.set(jobId, controller)
  return controller
}

export function releaseAbort(map: AbortMap, jobId: string): void {
  map.delete(jobId)
}

export function abortAll(map: AbortMap): void {
  for (const controller of map.values()) controller.abort()
  map.clear()
}

/** 节点身份：生成中用 jobId:variant；归档后用 assetId:variant。 */
export function jobNodeId(jobId: string, variantId = '_batch'): string {
  return `${jobId}:${variantId}`
}

export function assetNodeId(assetId: string, variantId: string): string {
  return `${assetId}:${variantId}`
}
