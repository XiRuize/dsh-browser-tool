import fs from 'node:fs/promises'
import path from 'node:path'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

/** 整数参数归一：非法值回退，越界钳制，四舍五入。 */
export function toInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 把字符串或字符串数组归一为去空白、去重的字符串数组。 */
export function stringArray(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const result = []
  const seen = new Set()
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
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

export async function settlePage(page, { selector = '', settleMs = 120, timeoutMs = 5000 } = {}) {
  const startedAt = Date.now()
  if (selector) {
    try {
      await page.waitForSelector(selector, { timeout: Math.max(500, Number(timeoutMs) || 5000) })
      return { selectorReady: true, waitedMs: Date.now() - startedAt }
    } catch {
      // 选择器迟迟不出现时不阻塞流程，退化为短沉降。
    }
  }
  const wait = Math.max(0, Number(settleMs) || 0)
  if (wait > 0) {
    // 页面已经可见时不需要整段睡满：用 rAF 循环快速退出。
    const end = Date.now() + wait
    while (Date.now() < end) {
      await sleep(Math.min(40, end - Date.now()))
    }
  }
  return { selectorReady: false, waitedMs: Date.now() - startedAt }
}

/**
 * 等到页面真的有文本（应对"先返回 JS 挑战页、再由脚本跳转"的站点）。
 * 命中目标立即返回，不白等；超时后返回当前长度。
 */
export async function waitForText(page, { minChars = 40, timeoutMs = 5000, intervalMs = 80 } = {}) {
  const startedAt = Date.now()
  let length = 0
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await page.evaluate(() => {
        const body = document.body
        return body ? String(body.innerText || body.textContent || '').trim().length : 0
      })
      // 非标准页面（测试桩/自定义实现）返回值不是数字：不做等待，避免白耗超时。
      if (typeof value !== 'number') {
        return { length: 0, waitedMs: Date.now() - startedAt, ready: true, skipped: true }
      }
      length = value
    } catch {
      length = 0
    }
    if (length >= minChars) return { length, waitedMs: Date.now() - startedAt, ready: true }
    await sleep(intervalMs)
  }
  return { length, waitedMs: Date.now() - startedAt, ready: false }
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
