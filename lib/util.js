import fs from 'node:fs/promises'
import path from 'node:path'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function truncate(text, maxChars, marker = '…') {
  const value = String(text ?? '')
  if (value.length <= maxChars) return { text: value, truncated: false }
  return { text: value.slice(0, Math.max(0, maxChars - marker.length)) + marker, truncated: true }
}

export function normalizeUrl(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return ''
  if (/^about:blank$/i.test(raw)) return raw
  if (/^https?:\/\//i.test(raw)) return raw
  if (/^\/\//.test(raw)) return `https:${raw}`
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(raw)) return `https://${raw}`
  throw new Error(`URL 无效：${raw}。请使用 http:// 或 https:// 开头的地址。`)
}

export function safeName(input, fallback = 'artifact') {
  const value = String(input ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
  return value || fallback
}

export function timestampName(prefix, ext) {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}-${stamp}${ext}`
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '? B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function raceAbort(promise, signal, label = '操作') {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error(`${label}已取消`))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(new Error(`${label}已取消`))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function writeTextFile(filePath, content) {
  await ensureDir(path.dirname(filePath))
  await fs.writeFile(filePath, content, 'utf8')
  return filePath
}

export function resolveInside(baseDir, requested) {
  if (!requested) return path.join(baseDir, timestampName('file', '.txt'))
  if (path.isAbsolute(requested)) return requested
  return path.resolve(baseDir, requested)
}

export function firstLine(text, max = 160) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function jsonPretty(value, maxChars) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  const bounded = truncate(text, maxChars)
  return bounded
}
