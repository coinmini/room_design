/**
 * 进入画布时恢复进行中生成：骨架占位 + 继续 poll。
 */

import { useCallback, useEffect, type MutableRefObject } from 'react'
import { pollJob } from '../api'
import {
  removeActiveCanvasJob,
  upsertActiveCanvasJob,
} from './activeJobs'
import { collectActiveJobsToResume } from './resumeActiveJobs'
import type { SkeletonSlot } from './skeletonMath'
import type { CanvasGraph } from './types'
import type { Job } from '../api'

export function useResumeActiveJobs(opts: {
  projectId: string
  graphRef: MutableRefObject<CanvasGraph | null>
  selectedId: string | null
  applyGraph: (body: CanvasGraph, selected: string | null) => void
  loadGraph: (opts?: { fit?: boolean }) => Promise<void>
  bindSkeletonsToJob: (groupId: string, job: Job) => void
  clearSkeletonGroup: (groupId: string) => void
  mergeRestoredSkeletons: (restored: SkeletonSlot[]) => void
  setNotice: (msg: string) => void
  setBusy: (v: boolean) => void
  busyRef: MutableRefObject<boolean>
  busyActionRef: MutableRefObject<string | null>
}) {
  const {
    projectId,
    graphRef,
    selectedId,
    applyGraph,
    loadGraph,
    bindSkeletonsToJob,
    clearSkeletonGroup,
    mergeRestoredSkeletons,
    setNotice,
    setBusy,
    busyRef,
    busyActionRef,
  } = opts

  const resumeActiveJobs = useCallback(
    async (signal?: AbortSignal) => {
      const toResume = await collectActiveJobsToResume(projectId, signal)
      if (signal?.aborted || !toResume.length) return

      const restored: SkeletonSlot[] = []
      for (const item of toResume) {
        for (const slot of item.slots) {
          restored.push({
            id: slot.id,
            groupId: item.groupId,
            label: slot.label,
            workflowStage: slot.workflowStage,
            parentAssetId: item.parentAssetId,
            parentNodeId: item.parentNodeId,
            jobId: item.jobId,
          })
        }
        upsertActiveCanvasJob(projectId, item)
      }
      mergeRestoredSkeletons(restored)
      if (graphRef.current) {
        applyGraph(graphRef.current, selectedId)
      }
      setNotice(`恢复 ${toResume.length} 个进行中的生成任务…`)
      busyActionRef.current = toResume[0]?.action ?? null
      busyRef.current = true
      setBusy(true)

      await Promise.all(
        toResume.map(async (item) => {
          try {
            const completed = await pollJob(
              item.jobId,
              (job) => {
                bindSkeletonsToJob(item.groupId, job)
              },
              undefined,
              signal,
            )
            removeActiveCanvasJob(projectId, {
              jobId: item.jobId,
              groupId: item.groupId,
            })
            clearSkeletonGroup(item.groupId)
            if (completed.status === 'SUCCEEDED') {
              await loadGraph({ fit: false })
              setNotice(
                item.action === 'generate_layout'
                  ? '布局生成完成'
                  : '生成任务已完成',
              )
            } else {
              await loadGraph({ fit: false })
              setNotice(
                `任务结束：${completed.status}${
                  completed.errorMessage ? ` · ${completed.errorMessage}` : ''
                }`,
              )
            }
          } catch (err) {
            if (signal?.aborted) return
            setNotice(
              err instanceof Error
                ? err.message
                : '恢复轮询失败，稍后刷新重试',
            )
          }
        }),
      )

      if (!signal?.aborted) {
        busyRef.current = false
        busyActionRef.current = null
        setBusy(false)
      }
    },
    [
      projectId,
      applyGraph,
      selectedId,
      clearSkeletonGroup,
      loadGraph,
      bindSkeletonsToJob,
      mergeRestoredSkeletons,
      graphRef,
      setNotice,
      setBusy,
      busyRef,
      busyActionRef,
    ],
  )

  useEffect(() => {
    const ac = new AbortController()
    const timer = window.setTimeout(() => {
      void resumeActiveJobs(ac.signal)
    }, 400)
    return () => {
      ac.abort()
      window.clearTimeout(timer)
    }
  }, [projectId, resumeActiveJobs])

  return { resumeActiveJobs }
}
