import { apiFetch, assetUrl } from '../api'

function imageFileExtension(blob: Blob): string {
  if (blob.type.includes('jpeg')) return 'jpg'
  if (blob.type.includes('webp')) return 'webp'
  return 'png'
}

/** 从 artifacts URL 拉成 File，供 multipart 工作流接口使用（带缓存穿透）。 */
export async function fetchArtifactAsFile(
  pathOrUrl: string | null | undefined,
  name: string,
): Promise<File> {
  if (!pathOrUrl) throw new Error(`缺少${name}图片`)
  const absolute = assetUrl(pathOrUrl)
  const separator = absolute.includes('?') ? '&' : '?'
  const response = await apiFetch(
    `${absolute}${separator}workflow_restore=${Date.now()}`,
    { cache: 'no-store' },
  )
  if (!response.ok) throw new Error(`读取${name}失败：${response.status}`)
  const blob = await response.blob()
  if (!blob.size) throw new Error(`${name}图片为空`)
  return new File([blob], `${name}.${imageFileExtension(blob)}`, {
    type: blob.type || 'image/png',
  })
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function apiError(detail: unknown, status: number): string {
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === 'object' && item && 'msg' in item
          ? String((item as { msg: unknown }).msg)
          : String(item),
      )
      .join('; ')
  }
  return `请求失败：${status}`
}
