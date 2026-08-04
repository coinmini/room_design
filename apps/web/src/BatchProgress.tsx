import { useEffect, useState } from 'react'

import type { Job } from './api'

// B2：批次预期数量（variants 或选中的空间列表）
export function expectedBatchCount(job: Job | null): number {
  if (!job) return 0
  const variants = job.payload?.variants
  if (Array.isArray(variants) && variants.length) return variants.length
  const spaces = job.payload?.selected_space_ids
  if (Array.isArray(spaces) && spaces.length) return spaces.length
  return 0
}

export function ElapsedText({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(since).getTime()) / 1000),
  )
  const minutes = Math.floor(seconds / 60)
  return (
    <>
      {minutes}分{String(seconds % 60).padStart(2, '0')}秒
    </>
  )
}

// B2：运行中进度条——计时器 + 已完成 M/N（可选）+ 阶段耗时预期。
// 03~08 阶段传 estimate/hint；01~02 阶段只传 estimate（单调用任务无 N/M）。
export function BatchProgress({
  job,
  doneCount,
  total,
  estimate,
  hint,
}: {
  job: Job | null
  doneCount?: number
  total?: number
  estimate?: string
  hint?: string
}) {
  if (!job || !['QUEUED', 'RUNNING'].includes(job.status)) return null
  const expected = total ?? expectedBatchCount(job)
  return (
    <div className="workflow-batch-progress">
      <span>
        已生成 <ElapsedText since={job.startedAt ?? job.createdAt} />
      </span>
      {expected > 0 && doneCount !== undefined && (
        <span>
          已完成 {Math.min(doneCount, expected)}/{expected}
        </span>
      )}
      {estimate && <span>{estimate}</span>}
      {hint && <span>{hint}</span>}
    </div>
  )
}
