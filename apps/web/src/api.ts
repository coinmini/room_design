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

export type SceneGenerationMode = 'ai_direct' | 'structured_3d'

export type AssetModuleKey =
  | 'floorplan'
  | 'layout'
  | 'ai_workflow'
  | 'white_model'
  | 'effect_render'
  | 'material_replacement'

export type SceneAsset = {
  id: string
  ownerId: string
  projectId?: string | null
  jobId: string
  parentAssetId?: string | null
  title: string
  generationMode: string
  jobType?: string
  moduleKey?: AssetModuleKey | string
  moduleName?: string
  assetType: string
  thumbnailUrl: string | null
  deliverables: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type SceneAssetDetail = SceneAsset & {
  sourcePayload: Record<string, unknown>
  sourceResult: Record<string, unknown>
}

function xhrRequest(
  url: string,
  init: RequestInit = {},
  networkRetries = 2,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(init.method ?? 'GET', url, true)
    request.responseType = 'blob'
    request.withCredentials = init.credentials === 'include'

    new Headers(init.headers).forEach((value, name) => {
      request.setRequestHeader(name, value)
    })

    const signal = init.signal
    const removeAbortListener = () => signal?.removeEventListener('abort', abort)
    const retryOrFail = (message: string) => {
      removeAbortListener()
      if (networkRetries > 0 && !signal?.aborted) {
        // Local keep-alive races and browser extension interference can drop a
        // request before it reaches the server. Retry transient network
        // failures a couple of times with a short backoff before surfacing.
        const attempt = 3 - networkRetries
        window.setTimeout(() => {
          xhrRequest(url, init, networkRetries - 1).then(resolve, reject)
        }, 350 * attempt)
        return
      }
      reject(new TypeError(message))
    }
    const abort = () => request.abort()

    request.onload = () => {
      removeAbortListener()
      const headers = new Headers()
      request
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)
        .filter(Boolean)
        .forEach((line) => {
          const separator = line.indexOf(':')
          if (separator > 0) {
            headers.append(
              line.slice(0, separator).trim(),
              line.slice(separator + 1).trim(),
            )
          }
        })
      resolve(
        new Response(request.response, {
          status: request.status,
          statusText: request.statusText,
          headers,
        }),
      )
    }
    request.onerror = () => retryOrFail('无法连接本地 API')
    request.ontimeout = () => retryOrFail('本地 API 请求超时')
    request.onabort = () => {
      removeAbortListener()
      reject(new DOMException('请求已取消', 'AbortError'))
    }

    if (signal?.aborted) {
      request.abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.send((init.body ?? null) as XMLHttpRequestBodyInit | null)
  })
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = /^https?:\/\//.test(path) ? path : `${API_BASE}${path}`
  // Browser wallet/provider extensions can replace window.fetch and return
  // undefined even after the local request succeeds. Keep all local API and
  // artifact traffic on XHR so callers always receive a real Response.
  return xhrRequest(url, init)
}

export function createColorPlanRenders(form: FormData) {
  return apiFetch('/v1/ai-workflow/color-plans', {
    method: 'POST',
    body: form,
  })
}

export function createAxonometricRenders(form: FormData) {
  return apiFetch('/v1/ai-workflow/axonometric-views', {
    method: 'POST',
    body: form,
  })
}

export function createSpaceRenders(form: FormData) {
  return apiFetch('/v1/ai-workflow/space-renders', {
    method: 'POST',
    body: form,
  })
}

export function createStyleSchemeRenders(form: FormData) {
  return apiFetch('/v1/ai-workflow/style-schemes', {
    method: 'POST',
    body: form,
  })
}

export function createToneSchemeRenders(form: FormData) {
  return apiFetch('/v1/ai-workflow/tone-schemes', {
    method: 'POST',
    body: form,
  })
}

export function createLocalEditRender(form: FormData) {
  return apiFetch('/v1/ai-workflow/local-edits', {
    method: 'POST',
    body: form,
  })
}

export function approveWorkflowAsset(
  assetId: string,
  payload: { variantId: string; comment?: string },
) {
  return apiFetch(`/v1/assets/${encodeURIComponent(assetId)}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function assetUrl(path?: string) {
  if (!path) return ''
  if (/^https?:\/\//.test(path)) return path
  return `${API_BASE}${path}`
}

const wait = (duration: number) =>
  new Promise((resolve) => window.setTimeout(resolve, duration))

const configuredJobTimeout = Number(import.meta.env.VITE_JOB_TIMEOUT_MS)
const JOB_WAIT_TIMEOUT_MS =
  Number.isFinite(configuredJobTimeout) && configuredJobTimeout > 0
    ? configuredJobTimeout
    : 30 * 60 * 1000
const JOB_POLL_INTERVAL_MS = 1000

export async function pollJob(
  jobId: string,
  onUpdate?: (job: Job) => void,
  timeoutMs = JOB_WAIT_TIMEOUT_MS,
): Promise<Job> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const response = await apiFetch(`/v1/jobs/${jobId}`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`任务查询失败：${response.status}`)
    const job = (await response.json()) as Job
    onUpdate?.(job)
    if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(job.status)) return job
    await wait(JOB_POLL_INTERVAL_MS)
  }
  throw new Error(
    `等待已超过 ${Math.round(timeoutMs / 60000)} 分钟，后端任务 ${jobId} 可能仍在运行，请点击“继续等待”。`,
  )
}
