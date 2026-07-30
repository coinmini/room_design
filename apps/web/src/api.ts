export const API_BASE =
  import.meta.env.VITE_API_URL?.replace(/\/$/, '') ?? 'http://127.0.0.1:8000'

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'

export type Job = {
  id: string
  projectId?: string
  parentJobId?: string
  type: string
  status: JobStatus
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
  errorCode?: string
  errorMessage?: string
  createdAt: string
  updatedAt: string
}

export function apiFetch(path: string, init?: RequestInit) {
  return fetch(`${API_BASE}${path}`, init)
}

export function assetUrl(path?: string) {
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return path
  return `${API_BASE}${path}`
}

const wait = (duration: number) =>
  new Promise((resolve) => window.setTimeout(resolve, duration))

export async function pollJob(
  jobId: string,
  onUpdate?: (job: Job) => void,
): Promise<Job> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await apiFetch(`/v1/jobs/${jobId}`)
    if (!response.ok) throw new Error(`任务查询失败：${response.status}`)
    const job = (await response.json()) as Job
    onUpdate?.(job)
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) return job
    await wait(750)
  }
  throw new Error('任务等待超时')
}

