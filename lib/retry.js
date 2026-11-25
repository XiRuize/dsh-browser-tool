/**
 * 请求中间件：状态码重试（借鉴 Scrapy RetryMiddleware）。
 *
 * - 默认重试 408/425/429/500/502/503/504；
 * - GET/HEAD/OPTIONS 全量重试；写请求（POST/PUT/PATCH/DELETE）只在 408/429/503 重试，避免重复提交；
 * - 优先遵守 Retry-After（秒数或 HTTP 日期），否则指数退避 + 抖动。
 */

export const RETRY_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504])
export const RETRY_WRITE_STATUSES = Object.freeze([408, 429, 503])

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isRetryableStatus(status) {
  return RETRY_STATUSES.includes(Number(status))
}

/** 该次失败是否值得重试。 */
export function shouldRetry({ status = 0, method = 'GET', attempt = 1, maxAttempts = 3, blocked = false } = {}) {
  if (attempt >= maxAttempts) return false
  // 被拦截（Cloudflare/F5/NCGR）换引擎才有意义，同一引擎重试是浪费。
  if (blocked) return false
  const code = Number(status) || 0
  if (code === 0) return true
  const verb = String(method).toUpperCase()
  if (RETRYABLE_METHODS.has(verb)) return isRetryableStatus(code)
  return RETRY_WRITE_STATUSES.includes(code)
}

/** 解析 Retry-After：秒数或 HTTP 日期；无效返回 null。 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null
  const text = String(value).trim()
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000))
  const date = Date.parse(text)
  if (Number.isFinite(date)) return Math.max(0, date - now)
  return null
}

/**
 * 计算本次重试等待时间。
 * @param {{attempt?:number, retryAfter?:string|number, baseMs?:number, factor?:number, maxMs?:number, jitter?:number}} options
 */
export function retryDelayMs(options = {}) {
  const {
    attempt = 1,
    retryAfter,
    baseMs = 500,
    factor = 2,
    maxMs = 30000,
    jitter = 0.3,
  } = options
  const fromHeader = parseRetryAfter(retryAfter)
  const backoff = Math.min(maxMs, Math.max(0, Number(baseMs) * Math.pow(Number(factor), Math.max(0, attempt - 1))))
  const base = fromHeader !== null ? fromHeader : backoff
  const spread = base * Math.max(0, Number(jitter))
  const value = base + (spread > 0 ? Math.random() * spread : 0)
  return Math.min(maxMs, Math.round(value))
}
