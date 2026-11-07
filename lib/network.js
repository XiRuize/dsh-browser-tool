import { truncate } from './util.js'

function bodyKind(contentType) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('json')) return 'json'
  if (type.includes('xml')) return 'xml'
  if (type.includes('html')) return 'html'
  if (type.includes('javascript') || type.includes('ecmascript')) return 'javascript'
  if (type.includes('text/') || type.includes('x-www-form-urlencoded')) return 'text'
  return 'binary'
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(() => resolve(null), ms))
}

export class NetworkRecorder {
  constructor(page, options = {}) {
    this.page = page
    this.maxEntries = Math.max(1, Number(options.maxEntries) || 80)
    this.maxBodyChars = Math.max(1000, Number(options.maxBodyChars) || 120000)
    this.entries = []
    this.active = false
    this.seq = 0
    this.filter = null
    this.types = new Set(options.resourceTypes || ['xhr', 'fetch'])
    this.handler = response => this.#onResponse(response)
  }

  start({ urlPattern, resourceTypes, maxEntries, maxBodyChars } = {}) {
    this.stop()
    this.entries = []
    this.seq = 0
    if (maxEntries) this.maxEntries = Math.max(1, Number(maxEntries) || this.maxEntries)
    if (maxBodyChars) this.maxBodyChars = Math.max(1000, Number(maxBodyChars) || this.maxBodyChars)
    this.types = new Set(resourceTypes?.length ? resourceTypes : ['xhr', 'fetch'])
    this.filter = urlPattern ? new RegExp(urlPattern, 'i') : null
    this.active = true
    this.page.on('response', this.handler)
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
      const headers = response.headers()
      const contentType = headers['content-type'] || ''
      const entry = {
        id: `n${++this.seq}`,
        url,
        status: response.status(),
        method: request.method(),
        type,
        contentType,
        requestHeaders: request.headers(),
        at: Date.now(),
        body: null,
        bodyBytes: 0,
        bodyKind: bodyKind(contentType),
        bodyError: null,
        bodyTruncated: false,
        bodySkipped: false,
      }
      if (entry.bodyKind !== 'binary') {
        entry.bodyPromise = this.#readBody(response, entry, headers)
      }
      this.entries.push(entry)
      while (this.entries.length > this.maxEntries) this.entries.shift()
    } catch {
      /* never let capture break the page */
    }
  }

  async #readBody(response, entry, headers) {
    const length = Number(headers['content-length'] || 0)
    if (length > this.maxBodyChars * 6) {
      entry.bodySkipped = true
      entry.bodyError = `响应体 ${length} 字节，超过记录上限`
      return
    }
    try {
      const body = await Promise.race([response.body(), timeout(5000)])
      if (!body) {
        entry.bodyError = '读取响应体超时或响应体为空'
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
      entry.bodyError = error instanceof Error ? error.message : String(error)
    }
  }

  list({ urlPattern, limit = 100 } = {}) {
    const pattern = urlPattern ? new RegExp(urlPattern, 'i') : null
    const entries = this.entries
      .filter(entry => !pattern || pattern.test(entry.url))
      .slice(-Math.max(1, Math.min(Number(limit) || 100, 500)))
    return entries.map(entry => ({
      id: entry.id,
      url: entry.url,
      status: entry.status,
      method: entry.method,
      type: entry.type,
      contentType: entry.contentType,
      at: entry.at,
      bodyKind: entry.bodyKind,
      bodyBytes: entry.bodyBytes,
      bodyTruncated: entry.bodyTruncated,
      bodySkipped: entry.bodySkipped,
      bodyError: entry.bodyError,
      hasBody: entry.body !== null,
    }))
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
    if (entry.bodyPromise) {
      await Promise.race([entry.bodyPromise, timeout(5000)])
    }
    let json = null
    if (entry.body && (entry.bodyKind === 'json' || /^[\s]*[\[{]/.test(entry.body))) {
      try {
        json = JSON.parse(entry.body)
      } catch {
        json = null
      }
    }
    const bounded = truncate(entry.body || '', Math.max(1000, Number(maxChars) || 50000))
    return {
      id: entry.id,
      url: entry.url,
      status: entry.status,
      method: entry.method,
      type: entry.type,
      contentType: entry.contentType,
      at: entry.at,
      bodyKind: entry.bodyKind,
      bodyBytes: entry.bodyBytes,
      bodyTruncated: entry.bodyTruncated || bounded.truncated,
      bodyError: entry.bodyError,
      body: bounded.text,
      json,
    }
  }

  snapshot() {
    return {
      active: this.active,
      count: this.entries.length,
      types: [...this.types],
      filter: this.filter?.source ?? null,
    }
  }
}
