import { firstLine, normalizeUrl, truncate } from './util.js'

const BLOCK_RE =
  /验证码|人机验证|安全验证|访问被拒|访问受限|安全威胁|WAF|captcha|异常访问|请求过于频繁|too many requests/i
const RETRYABLE_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timeout|net::ERR_|IncompleteRead/i

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const uaCache = new WeakMap()

/** 取浏览器上下文的真实 UA（缓存），避免用 HeadlessChrome 默认 UA 触发站点风控。 */
async function resolveUserAgent(manager, context) {
  const cached = uaCache.get(context)
  if (cached) return cached
  let ua = ''
  try {
    const pages = context.pages?.() || []
    const page = pages.find(candidate => !candidate.isClosed?.())
    if (page) {
      ua = await page.evaluate(() => navigator.userAgent)
      const current = page.url?.() || ''
      if (/^https?:/i.test(current)) {
        try {
          uaCache.set(`${context}:referer`, new URL(current).origin + '/')
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    ua = ''
  }
  // headless 标记会被站点风控直接挑战，替换成普通桌面 UA。
  ua = String(ua || '').replace(/HeadlessChrome/g, 'Chrome').replace(/HeadlessEdg/g, 'Edg')
  if (!ua || !/Chrome|Edg|Firefox|Safari/.test(ua)) {
    ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'
  }
  uaCache.set(context, ua)
  return ua
}

/** 默认 Referer：取上下文里已有页面的同源地址，避免首屏请求被判定为裸请求。 */
async function resolveReferer(manager, context) {
  const cached = uaCache.get(`${context}:referer`)
  if (cached) return cached
  try {
    const pages = context.pages?.() || []
    const page = pages.find(candidate => !candidate.isClosed?.())
    const current = page?.url?.() || ''
    if (/^https?:/i.test(current)) {
      const referer = new URL(current).origin + '/'
      uaCache.set(`${context}:referer`, referer)
      return referer
    }
  } catch {
    /* ignore */
  }
  return ''
}

function isChallenge(text, status) {
  if (status === 200 && text.length < 6000 && text.includes('__tst_status')) return true
  if (text.length < 6000 && /document\.cookie\s*=|location\.href\s*=\s*location\.href/.test(text)) return true
  return false
}

/**
 * HTTP 快通道：复用浏览器上下文的 Cookie / UA / 代理，直接发请求，不做页面渲染。
 *
 * 适合：JSON 接口、SSR 页面、批量列表页。任何需要 JS 水合才能出内容的页面
 * 仍应走渲染路径（browser_open / browser_collect 的 render=true）。
 *
 * 返回结构保持稳定，便于 collect 复用：
 * { ok, status, method, finalUrl, contentType, headers, bytes, body,
 *   fullBody, truncated, blocked, elapsedMs, retriesUsed, error }
 */
export async function fastFetch(manager, options = {}) {
  if (!manager || typeof manager.ensure !== 'function') {
    throw new Error('fastFetch 需要有效的 BrowserManager。')
  }
  const url = normalizeUrl(options.url)
  if (!url) throw new Error('fastFetch 需要有效的 url。')
  const method = String(options.method || 'GET').toUpperCase()
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000
  const retries = Math.max(0, Math.min(Number(options.retries ?? 2) || 0, 5))
  const maxChars = Math.max(1000, Math.min(Number(options.maxChars) || 20000, 200000))

  const context = await manager.ensure()
  const request = context?.request
  if (!request || typeof request.fetch !== 'function') {
    throw new Error('当前浏览器上下文不支持 APIRequestContext（context.request 不可用）。')
  }

  const headers = {
    'accept-language': 'zh-CN,zh;q=0.9',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'user-agent': await resolveUserAgent(manager, context),
  }
  const defaultReferer = await resolveReferer(manager, context)
  if (defaultReferer) headers.referer = defaultReferer
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === undefined || value === null) continue
    headers[String(name).toLowerCase()] = String(value)
  }
  const data = options.body === undefined || options.body === null ? undefined : String(options.body)

  let retriesUsed = 0
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const startedAt = Date.now()
    try {
      const response = await request.fetch(url, {
        method,
        headers,
        data,
        timeout: timeoutMs,
        failOnStatusCode: false,
        maxRedirects: 5,
      })
      const status = response.status()
      const responseHeaders = response.headers()
      const contentType = String(responseHeaders['content-type'] || '')
      const buffer = await response.body()
      const bytes = buffer?.length || 0
      const text = buffer ? buffer.toString('utf8') : ''
      const bounded = truncate(text, maxChars, '\n…(正文已截断)')
      const blockHint = BLOCK_RE.test(`${getTitle(text)}\n${text.slice(0, 3000)}`)
      const challenge = isChallenge(text, status)
      const blocked = blockHint || challenge || [401, 403, 407, 412, 429].includes(status)
      const elapsedMs = Date.now() - startedAt
      let json = null
      if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
      }
      return {
        ok: status >= 200 && status < 400,
        status,
        method,
        finalUrl: response.url?.() || url,
        contentType,
        headers: responseHeaders,
        bytes,
        body: bounded.text,
        fullBody: text,
        truncated: bounded.truncated || text.length > maxChars,
        json,
        blocked,
        elapsedMs,
        retriesUsed,
        error: status >= 400 ? `HTTP ${status}` : null,
        title: getTitle(text),
      }
    } catch (error) {
      lastError = error
      const message = errorMessage(error)
      if (attempt >= retries || !RETRYABLE_RE.test(message)) break
      retriesUsed += 1
      await sleep(250 * (attempt + 1))
    }
  }

  return {
    ok: false,
    status: 0,
    method,
    finalUrl: url,
    contentType: '',
    headers: {},
    bytes: 0,
    body: '',
    fullBody: '',
    truncated: false,
    json: null,
    blocked: false,
    elapsedMs: 0,
    retriesUsed,
    error: errorMessage(lastError),
    title: '',
  }
}

function getTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''))
  return match ? firstLine(match[1], 180) : ''
}
