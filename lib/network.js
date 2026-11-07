import { truncate } from './util.js'

const BODY_TIMEOUT_MS = 5000
const DEFAULT_TYPES = ['xhr', 'fetch']
const SENSITIVE_HEADERS = new Set([
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
])
const CREATOR = { name: '@future/dsh-browser-tool', version: '0.2.0' }

function bodyKind(contentType) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('json')) return 'json'
  if (type.includes('xml')) return 'xml'
  if (type.includes('html')) return 'html'
  if (type.includes('javascript') || type.includes('ecmascript')) return 'javascript'
  if (type.includes('text/') || type.includes('x-www-form-urlencoded')) return 'text'
  return 'binary'
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms))
}

function pageUrl(page) {
  try {
    return page?.url?.() || ''
  } catch {
    return ''
  }
}

function isoTime(value) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : new Date().toISOString()
}

function compilePattern(urlPattern) {
  if (!urlPattern) return null
  try {
    return new RegExp(String(urlPattern), 'i')
  } catch (error) {
    throw new Error(`urlPattern 不是有效正则：${errorMessage(error)}`)
  }
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {}
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(String(name).toLowerCase())) {
      result[name] = '[已脱敏]'
    } else {
      result[name] = value
    }
  }
  return result
}

function harHeaders(headers) {
  if (!headers || typeof headers !== 'object') return []
  return Object.entries(headers).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(', ') : String(value ?? ''),
  }))
}

function queryString(url) {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

function contentLength(headers) {
  const value = Number(headers?.['content-length'])
  return Number.isFinite(value) && value >= 0 ? value : 0
}

function timingDiff(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return -1
  return Math.round(end - start)
}

function harTimings(timing) {
  const base = {
    blocked: -1,
    dns: -1,
    connect: -1,
    send: -1,
    wait: -1,
    receive: -1,
    ssl: -1,
  }
  if (!timing || typeof timing !== 'object') return base
  base.dns = timingDiff(timing.domainLookupStart, timing.domainLookupEnd)
  base.connect = timingDiff(timing.connectStart, timing.connectEnd)
  base.wait = timingDiff(timing.requestStart, timing.responseStart)
  base.receive = timingDiff(timing.responseStart, timing.responseEnd)
  base.ssl =
    Number.isFinite(timing.secureConnectionStart) &&
    timing.secureConnectionStart >= 0 &&
    Number.isFinite(timing.connectEnd) &&
    timing.connectEnd >= timing.secureConnectionStart
      ? Math.round(timing.connectEnd - timing.secureConnectionStart)
      : -1
  return base
}

function timingTotal(timings) {
  let total = 0
  for (const [key, value] of Object.entries(timings)) {
    if (key === 'ssl') continue
    if (Number.isFinite(value) && value > 0) total += value
  }
  return Math.round(total)
}

function toTiming(raw) {
  if (!raw || typeof raw !== 'object') return null
  const timing = {}
  for (const [key, value] of Object.entries(raw)) {
    if (Number.isFinite(value)) timing[key] = value
  }
  return Object.keys(timing).length > 0 ? timing : null
}

function normalizeTypes(types) {
  const list = Array.isArray(types)
    ? types.map(type => String(type || '').trim()).filter(Boolean)
    : []
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_TYPES]
}

/**
 * 页面网络响应记录器（v0.2）。
 *
 * 旧 API（NetworkRecorder 构造、start/stop/clear/list/get/snapshot）保持兼容；
 * 新增 requestHeaders/responseHeaders/resourceType/timing 等字段和 HAR 1.2 导出。
 * 捕获失败只影响单条记录，绝不向页面抛错。
 */
export class NetworkRecorder {
  constructor(page, options = {}) {
    this.page = page
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 80)
    this.maxBodyChars = Math.max(1000, Number(options.maxBodyChars) || 120000)
    this.includeBodies = options.includeBodies !== false
    this.entries = []
    this.active = false
    this.seq = 0
    this.filter = null
    this.lastUrlPattern = null
    this.startedAt = null
    this.pageUrl = ''
    this.types = new Set(normalizeTypes(options.resourceTypes))
    this.handler = response => this.#onResponse(response)
  }

  start({
    urlPattern,
    resourceTypes,
    maxEntries,
    maxBodyChars,
    includeBodies = true,
  } = {}) {
    this.stop()
    this.entries = []
    this.seq = 0
    if (maxEntries) this.maxEntries = Math.max(1, Number(maxEntries) || this.maxEntries)
    if (maxBodyChars) this.maxBodyChars = Math.max(1000, Number(maxBodyChars) || this.maxBodyChars)
    this.includeBodies = includeBodies !== false
    this.types = new Set(normalizeTypes(resourceTypes))
    this.filter = compilePattern(urlPattern)
    this.lastUrlPattern = urlPattern ? String(urlPattern) : null
    this.startedAt = Date.now()
    this.pageUrl = pageUrl(this.page)
    this.active = true
    try {
      this.page.on('response', this.handler)
    } catch {
      this.active = false
    }
    return this
  }

  stop() {
    if (!this.active) return
    try {
      this.page.off('response', this.handler)
    } catch {
      /* ignore */
    }
    this.active = false
  }

  clear() {
    this.entries = []
    this.seq = 0
  }

  #onResponse(response) {
    try {
      const request = response.request()
      const type = request.resourceType()
      if (!this.types.has(type)) return
      const url = response.url()
      if (this.filter && !this.filter.test(url)) return
      const responseHeaders = response.headers()
      const requestHeaders = request.headers()
      const contentType = responseHeaders['content-type'] || ''
      let rawTiming = null
      try {
        rawTiming = toTiming(request.timing?.())
      } catch {
        rawTiming = null
      }
      const startedAt =
        Number.isFinite(rawTiming?.startTime) && rawTiming.startTime > 0
          ? rawTiming.startTime
          : Date.now()
      const endedAt =
        Number.isFinite(rawTiming?.responseEnd) && rawTiming.responseEnd >= 0
          ? Math.round(startedAt + rawTiming.responseEnd)
          : Date.now()
      let redirectedFrom = null
      try {
        redirectedFrom = request.redirectedFrom?.()?.url?.() ?? null
      } catch {
        redirectedFrom = null
      }

      const entry = {
        id: `n${++this.seq}`,
        url,
        status: response.status(),
        method: request.method(),
        type,
        resourceType: type,
        contentType,
        requestHeaders: requestHeaders && typeof requestHeaders === 'object' ? { ...requestHeaders } : {},
        responseHeaders: responseHeaders && typeof responseHeaders === 'object' ? { ...responseHeaders } : {},
        at: startedAt,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        timing: rawTiming,
        redirectedFrom,
        body: null,
        bodyBytes: 0,
        bodyKind: bodyKind(contentType),
        bodyError: null,
        bodyTruncated: false,
        bodySkipped: false,
        bodyDone: false,
      }

      if (!this.includeBodies) {
        entry.bodySkipped = true
      } else if (entry.bodyKind === 'binary') {
        // 二进制只记录元数据，不把 Buffer 转成字符串。
        entry.bodySkipped = true
      } else {
        entry.bodyPromise = this.#readBody(response, entry, responseHeaders)
      }

      this.entries.push(entry)
      while (this.entries.length > this.maxEntries) this.entries.shift()
    } catch {
      /* never let capture break the page */
    }
  }

  async #readBody(response, entry, headers) {
    const length = contentLength(headers)
    if (length > this.maxBodyChars * 6) {
      entry.bodySkipped = true
      entry.bodyError = `响应体 ${length} 字节，超过记录上限`
      entry.bodyDone = true
      return
    }
    try {
      const body = await Promise.race([response.body(), timeout(BODY_TIMEOUT_MS)])
      if (!body) {
        entry.bodyError = '读取响应体超时或响应体为空'
        entry.bodyDone = true
        return
      }
      entry.bodyBytes = body.length
      let text = body.toString('utf8')
      if (text.length > this.maxBodyChars) {
        text = text.slice(0, this.maxBodyChars)
        entry.bodyTruncated = true
      }
      entry.body = text
    } catch (error) {
      entry.bodyError = errorMessage(error)
    } finally {
      entry.bodyDone = true
    }
  }

  #entryView(entry) {
    return {
      id: entry.id,
      url: entry.url,
      status: entry.status,
      method: entry.method,
      type: entry.type,
      resourceType: entry.resourceType || entry.type,
      contentType: entry.contentType,
      at: entry.at,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationMs: entry.durationMs,
      bodyKind: entry.bodyKind,
      bodyBytes: entry.bodyBytes,
      bodyTruncated: entry.bodyTruncated,
      bodySkipped: entry.bodySkipped,
      bodyError: entry.bodyError,
      hasBody: entry.body !== null,
      redirectedFrom: entry.redirectedFrom,
      requestHeaders: redactHeaders(entry.requestHeaders),
      responseHeaders: redactHeaders(entry.responseHeaders),
      timing: entry.timing,
    }
  }

  list({ urlPattern, limit = 100, type } = {}) {
    const pattern = compilePattern(urlPattern)
    const max = Math.max(1, Math.min(Number(limit) || 100, 500))
    const wanted = type ? String(type) : ''
    const entries = this.entries
      .filter(entry => !pattern || pattern.test(entry.url))
      .filter(entry => !wanted || entry.type === wanted || entry.resourceType === wanted)
      .slice(-max)
    return entries.map(entry => this.#entryView(entry))
  }

  async get({ id, urlContains, maxChars = 50000 } = {}) {
    let entry
    if (id) {
      entry = this.entries.find(candidate => candidate.id === id)
    } else if (urlContains) {
      entry = [...this.entries].reverse().find(candidate => candidate.url.includes(urlContains))
    } else {
      entry = this.entries[this.entries.length - 1]
    }
    if (!entry) {
      throw new Error('没有匹配的网络记录。先用 browser_network 的 start 开始捕获并触发页面请求。')
    }
    if (entry.bodyPromise && !entry.bodyDone) {
      await Promise.race([entry.bodyPromise, timeout(BODY_TIMEOUT_MS)])
    }
    let json = null
    if (entry.body && (entry.bodyKind === 'json' || /^[\s]*[[{]/.test(entry.body))) {
      try {
        json = JSON.parse(entry.body)
      } catch {
        json = null
      }
    }
    const limit = Math.max(1000, Math.min(Number(maxChars) || 50000, 200000))
    const bounded = truncate(entry.body || '', limit)
    return {
      ...this.#entryView(entry),
      body: bounded.text,
      bodyTruncated: entry.bodyTruncated || bounded.truncated,
      json,
    }
  }

  /** 等待所有已记录的响应体读取结束（最多 timeoutMs）。返回值仍是 pending 的条数。 */
  async waitForBodies(timeoutMs = BODY_TIMEOUT_MS) {
    const pending = this.entries.filter(entry => entry.bodyPromise && !entry.bodyDone)
    if (pending.length === 0) return 0
    await Promise.race([
      Promise.allSettled(pending.map(entry => entry.bodyPromise)),
      timeout(Math.max(0, Number(timeoutMs) || 0)),
    ])
    return this.entries.filter(entry => entry.bodyPromise && !entry.bodyDone).length
  }

  /**
   * 导出标准 HAR 1.2 对象。只返回对象，不落盘：产物路径由调用方（tools-surface）
   * 通过 BrowserManager/ArtifactStore 处理。
   *
   * @param {{redactSensitive?: boolean, includeBodies?: boolean}} options
   *   redactSensitive 默认 true，脱敏 Cookie/Authorization/Set-Cookie。
   */
  exportHar({ redactSensitive = true, includeBodies = true } = {}) {
    const headersFor = headers => {
      const normalized = redactSensitive ? redactHeaders(headers) : headers || {}
      return harHeaders(normalized)
    }
    const entries = this.entries.map(entry => {
      const timings = harTimings(entry.timing)
      const duration = Number.isFinite(entry.durationMs) ? entry.durationMs : timingTotal(timings)
      const length = entry.bodyBytes || contentLength(entry.responseHeaders)
      const content = {
        size: length,
        mimeType: entry.contentType || '',
      }
      if (includeBodies && entry.body !== null && entry.body !== undefined) {
        content.text = entry.body
      }
      const harEntry = {
        startedDateTime: isoTime(entry.startedAt),
        time: Math.max(0, duration),
        request: {
          method: entry.method,
          url: entry.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headersFor(entry.requestHeaders),
          queryString: queryString(entry.url),
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: entry.status,
          statusText: '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: headersFor(entry.responseHeaders),
          content,
          redirectURL: '',
          headersSize: -1,
          bodySize: length,
        },
        cache: {},
        timings,
        _resourceType: entry.resourceType || entry.type,
      }
      if (entry.redirectedFrom) harEntry.redirectedFrom = entry.redirectedFrom
      if (entry.bodyError) harEntry._bodyError = entry.bodyError
      if (entry.bodyTruncated) harEntry._bodyTruncated = true
      if (entry.bodySkipped) harEntry._bodySkipped = true
      if (entry.bodyPromise && !entry.bodyDone) harEntry._bodyPending = true
      return harEntry
    })

    const startedAt = this.startedAt || Date.now()
    return {
      log: {
        version: '1.2',
        creator: { ...CREATOR },
        pages: [
          {
            startedDateTime: isoTime(startedAt),
            id: 'page_1',
            title: this.pageUrl || pageUrl(this.page) || '',
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          },
        ],
        entries,
      },
    }
  }

  snapshot() {
    const byType = {}
    const byStatus = {}
    let withBody = 0
    let pendingBodies = 0
    let truncated = 0
    let skipped = 0
    let bodyBytes = 0
    for (const entry of this.entries) {
      const type = entry.resourceType || entry.type || 'unknown'
      byType[type] = (byType[type] || 0) + 1
      const status = String(entry.status ?? 0)
      byStatus[status] = (byStatus[status] || 0) + 1
      if (entry.body !== null && entry.body !== undefined) withBody += 1
      if (entry.bodyPromise && !entry.bodyDone) pendingBodies += 1
      if (entry.bodyTruncated) truncated += 1
      if (entry.bodySkipped) skipped += 1
      bodyBytes += entry.bodyBytes || 0
    }
    return {
      active: this.active,
      count: this.entries.length,
      types: [...this.types],
      filter: this.filter?.source ?? null,
      startedAt: this.startedAt,
      lastUrlPattern: this.lastUrlPattern,
      includeBodies: this.includeBodies,
      entries: {
        count: this.entries.length,
        maxEntries: this.maxEntries,
        byType,
        byStatus,
        withBody,
        pendingBodies,
        truncated,
        skipped,
        bodyBytes,
      },
    }
  }
}
