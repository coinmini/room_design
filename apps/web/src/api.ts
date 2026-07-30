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

function xhrFormRequest(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open(init.method ?? 'POST', url, true)
    request.responseType = 'blob'
    request.withCredentials = init.credentials === 'include'

    new Headers(init.headers).forEach((value, name) => {
      request.setRequestHeader(name, value)
    })

    const signal = init.signal
    const removeAbortListener = () => signal?.removeEventListener('abort', abort)
    const fail = (message: string) => {
      removeAbortListener()
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
    request.onerror = () => fail('无法连接本地 API')
    request.ontimeout = () => fail('本地 API 请求超时')
    request.onabort = () => {
      removeAbortListener()
      reject(new DOMException('请求已取消', 'AbortError'))
    }

    if (signal?.aborted) {
      request.abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.send(init.body as FormData)
  })
}

export function apiFetch(path: string, init?: RequestInit) {
  const url = `${API_BASE}${path}`
  if (init?.body instanceof FormData) {
    return xhrFormRequest(url, init)
  }
  return fetch(url, init)
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
