/**
 * 画布生成骨架：spawn / 绑定 job 进度 / 清组。
 * 与 graph apply 解耦，通过 onApplyGraph 回调刷 UI。
 */

import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { Job } from '../api'
import {
  actionFromJobType,
  removeActiveCanvasJob,
  upsertActiveCanvasJob,
} from './activeJobs'
import {
  expectedSkeletonSlots,
  type SkeletonExtras,
  type SkeletonSlot,
} from './skeletonMath'
import type { CanvasGraph, CanvasGraphNode } from './types'

type ApplyGraphFn = (body: CanvasGraph, selected: string | null) => void

export function useCanvasSkeletons(opts: {
  projectId: string
  graphRef: MutableRefObject<CanvasGraph | null>
  selectedId: string | null
  applyGraph: ApplyGraphFn
}) {
  const { projectId, graphRef, selectedId, applyGraph } = opts
  const [skeletonSlots, setSkeletonSlots] = useState<SkeletonSlot[]>([])
  const skeletonSlotsRef = useRef<SkeletonSlot[]>([])
  skeletonSlotsRef.current = skeletonSlots

  const clearSkeletonGroup = useCallback(
    (groupId: string) => {
      setSkeletonSlots((current) => {
        const removed = current.filter((s) => s.groupId === groupId)
        const next = current.filter((s) => s.groupId !== groupId)
        skeletonSlotsRef.current = next
        for (const slot of removed) {
          removeActiveCanvasJob(projectId, {
            groupId: slot.groupId,
            jobId: slot.jobId,
          })
        }
        return next
      })
    },
    [projectId],
  )

  const spawnSkeletons = useCallback(
    (
      action: string,
      parent: CanvasGraphNode | null,
      extras?: SkeletonExtras,
    ): string => {
      const groupId = `gen-${action}-${Date.now()}`
      const slots = expectedSkeletonSlots(action, parent, extras).map(
        (slot, index) => ({
          ...slot,
          id: `${groupId}-${index + 1}`,
          groupId,
        }),
      )
      setSkeletonSlots((current) => {
        const next = [...current, ...slots]
        skeletonSlotsRef.current = next
        return next
      })
      const body = graphRef.current
      if (body) {
        queueMicrotask(() => {
          applyGraph(body, parent?.id ?? null)
        })
      }
      return groupId
    },
    [applyGraph, graphRef],
  )

  const bindSkeletonsToJob = useCallback(
    (groupId: string, job: Job) => {
      setSkeletonSlots((current) => {
        const group = current.filter((s) => s.groupId === groupId)
        const total = group.length || 1
        const result = (job.result || {}) as Record<string, unknown>
        const outputs = Array.isArray(result.outputs)
          ? (result.outputs as Array<Record<string, unknown>>)
          : Array.isArray(result.layouts)
            ? (result.layouts as Array<Record<string, unknown>>)
            : []
        const succeededFromResult =
          typeof result.succeededCount === 'number'
            ? result.succeededCount
            : outputs.filter(
                (o) =>
                  o &&
                  (o.status === 'succeeded' ||
                    typeof o.url === 'string' ||
                    typeof o.previewUrl === 'string'),
              ).length
        const next = current.map((slot) => {
          if (slot.groupId !== groupId) return slot
          const groupIndex = group.findIndex((s) => s.id === slot.id)
          const out =
            groupIndex >= 0 && groupIndex < outputs.length
              ? outputs[groupIndex]
              : null
          const outUrl =
            out && typeof out === 'object'
              ? String(out.url || out.previewUrl || '')
              : ''
          const outOk =
            Boolean(outUrl) && (!out?.status || out.status === 'succeeded')
          return {
            ...slot,
            jobId: job.id,
            jobStatus: job.status,
            totalCount: total,
            succeededCount: succeededFromResult,
            url: outOk ? outUrl : slot.url,
            errorMessage:
              job.status === 'FAILED'
                ? job.errorMessage || '生成失败'
                : job.status === 'CANCELED'
                  ? '已取消'
                  : null,
            label:
              job.status === 'FAILED'
                ? `${slot.label.replace(/（.*?）$/, '')}（失败）`
                : outOk
                  ? slot.label.replace(/（.*?）$/, '').replace(/…$/, '') +
                    '（已出图）'
                  : slot.label,
          }
        })
        skeletonSlotsRef.current = next
        const groupSlots = next.filter((s) => s.groupId === groupId)
        if (groupSlots.length) {
          const action =
            actionFromJobType(job.type) ||
            (groupSlots[0].workflowStage === 'layout'
              ? 'generate_layout'
              : groupSlots[0].workflowStage)
          upsertActiveCanvasJob(projectId, {
            jobId: job.id,
            action,
            groupId,
            parentAssetId: groupSlots[0].parentAssetId,
            parentNodeId: groupSlots[0].parentNodeId,
            slots: groupSlots.map((s) => ({
              id: s.id,
              label: s.label,
              workflowStage: s.workflowStage,
            })),
            updatedAt: Date.now(),
          })
        }
        if (graphRef.current) {
          queueMicrotask(() => {
            if (graphRef.current) applyGraph(graphRef.current, selectedId)
          })
        }
        return next
      })
    },
    [projectId, applyGraph, selectedId, graphRef],
  )

  const resetSkeletonsForRetry = useCallback((groupId: string) => {
    setSkeletonSlots((current) => {
      const next = current.map((s) =>
        s.groupId === groupId
          ? {
              ...s,
              jobStatus: 'QUEUED',
              errorMessage: null,
              label: s.label
                .replace(/（失败）$/, '')
                .replace(/（已出图）$/, ''),
              url: undefined,
            }
          : s,
      )
      skeletonSlotsRef.current = next
      return next
    })
  }, [])

  const mergeRestoredSkeletons = useCallback((restored: SkeletonSlot[]) => {
    setSkeletonSlots((current) => {
      const existingJobIds = new Set(
        current.map((s) => s.jobId).filter(Boolean),
      )
      const merged = [
        ...current,
        ...restored.filter((s) => !existingJobIds.has(s.jobId)),
      ]
      skeletonSlotsRef.current = merged
      return merged
    })
  }, [])

  return {
    skeletonSlots,
    setSkeletonSlots,
    skeletonSlotsRef,
    clearSkeletonGroup,
    spawnSkeletons,
    bindSkeletonsToJob,
    resetSkeletonsForRetry,
    mergeRestoredSkeletons,
  }
}
