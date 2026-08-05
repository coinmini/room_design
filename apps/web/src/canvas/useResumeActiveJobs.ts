/**
 * 进入画布时恢复进行中生成：骨架占位 + 继续 poll。
 * busy 用引用计数，避免与前台动作互相清掉「执行中」。
 * effect 只依赖 projectId，避免点选节点反复中止轮询。
 */

import {
  useCallback,
  useEffect,
  useRef,
  type MutableRefObject,
} from 'react'
import { pollJob, type Job } from '../api'
import {
  removeActiveCanvasJob,
  upsertActiveCanvasJob,
} from './activeJobs'
import { collectActiveJobsToResume } from './resumeActiveJobs'
import type { SkeletonSlot } from './skeletonMath'
import type { CanvasGraph } from './types'

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
  /** busy 引用计数：+1 begin / -1 end，归零才清 UI */
  busyCountRef: MutableRefObject<number>
  busyActionRef: MutableRefObject<string | null>
  setBusy: (v: boolean) => void
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
    busyCountRef,
    busyActionRef,
    setBusy,
  } = opts

  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const applyGraphRef = useRef(applyGraph)
  applyGraphRef.current = applyGraph
  const loadGraphRef = useRef(loadGraph)
  loadGraphRef.current = loadGraph
  const bindRef = useRef(bindSkeletonsToJob)
  bindRef.current = bindSkeletonsToJob
  const clearRef = useRef(clearSkeletonGroup)
  clearRef.current = clearSkeletonGroup
  const mergeRef = useRef(mergeRestoredSkeletons)
  mergeRef.current = mergeRestoredSkeletons
  const setNoticeRef = useRef(setNotice)
  setNoticeRef.current = setNotice
  const setBusyRef = useRef(setBusy)
  setBusyRef.current = setBusy

  const beginBusy = useCallback(
    (action?: string) => {
      busyCountRef.current += 1
      if (action) busyActionRef.current = action
      setBusyRef.current(true)
    },
    [busyCountRef, busyActionRef],
  )

  const endBusy = useCallback(() => {
    busyCountRef.current = Math.max(0, busyCountRef.current - 1)
    if (busyCountRef.current === 0) {
      busyActionRef.current = null
      setBusyRef.current(false)
    }
  }, [busyCountRef, busyActionRef])

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
      mergeRef.current(restored)
      if (graphRef.current) {
        applyGraphRef.current(graphRef.current, selectedIdRef.current)
      }
      setNoticeRef.current(`恢复 ${toResume.length} 个进行中的生成任务…`)
      beginBusy(toResume[0]?.action ?? 'resume')

      await Promise.all(
        toResume.map(async (item) => {
          try {
            const completed = await pollJob(
              item.jobId,
              (job) => {
                bindRef.current(item.groupId, job)
              },
              undefined,
              signal,
            )
            removeActiveCanvasJob(projectId, {
              jobId: item.jobId,
              groupId: item.groupId,
            })
            if (completed.status === 'SUCCEEDED') {
              clearRef.current(item.groupId)
              await loadGraphRef.current({ fit: false })
              setNoticeRef.current(
                item.action === 'generate_layout'
                  ? '布局生成完成'
                  : '生成任务已完成',
              )
            } else {
              // FAILED/CANCELED：保留骨架供重试/丢弃，并拉 partial 临时节点
              bindRef.current(item.groupId, completed)
              await loadGraphRef.current({ fit: false })
              setNoticeRef.current(
                `任务结束：${completed.status}${
                  completed.errorMessage ? ` · ${completed.errorMessage}` : ''
                }`,
              )
            }
          } catch (err) {
            if (signal?.aborted) return
            // 轮询失败：标失败态并清 active 记录，避免永久「生成中」堆叠
            removeActiveCanvasJob(projectId, {
              jobId: item.jobId,
              groupId: item.groupId,
            })
            bindRef.current(item.groupId, {
              id: item.jobId,
              type: 'UNKNOWN',
              status: 'FAILED',
              errorMessage:
                err instanceof Error ? err.message : '恢复轮询失败',
              payload: {},
              result: null,
            } as Job)
            setNoticeRef.current(
              err instanceof Error
                ? err.message
                : '恢复轮询失败，可丢弃占位后重试',
            )
          }
        }),
      )

      if (!signal?.aborted) {
        endBusy()
      }
    },
    [projectId, graphRef, beginBusy, endBusy],
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
    // 仅 projectId 变化时恢复；resumeActiveJobs 已用 ref 读最新 apply/load
  }, [projectId, resumeActiveJobs])

  return { resumeActiveJobs }
}
