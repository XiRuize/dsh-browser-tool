/**
 * 无状态取数阶梯（0.9.1）。
 *
 * 按「官方 API → RSS/Atom → 静态 HTML → 动态渲染」顺序尝试，返回实际生效的层级
 * 与逐级证据；不做站点记忆、不写站点适配。所有网络/解析能力由调用方注入，
 * 便于单测与复用（curl/playwright/表单签名都在上层）。
 */

const FEED_TYPES = [
  'application/rss+xml',
  'application/atom+xml',
  'application/feed+json',
  'application/xml',
  'text/xml',
]

export const DEFAULT_TIERS = Object.freeze(['api', 'feed', 'static', 'render'])

function unescapeEntities(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function stripTags(text) {
  return unescapeEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function tagText(block, name) {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')
  const match = re.exec(block)
  if (!match) return ''
  const raw = match[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw)
  return stripTags(cdata ? cdata[1] : raw)
}

function atomLink(block) {
  const re = /<link\b([^>]*)\/?>/gi
  let match
  while ((match = re.exec(block))) {
    const attrs = match[1]
    if (!/rel=["']alternate["']/i.test(attrs) && !/href=/i.test(attrs)) continue
    const href = /href=["']([^"']+)["']/i.exec(attrs)
    if (href) return href[1]
  }
  return ''
}

/** 从 HTML 里找 feed 地址（link rel=alternate 优先），再补常见路径。 */
export function discoverFeedUrls(html, baseUrl = '') {
  const urls = []
  const push = value => {
    try {
      const url = new URL(value, baseUrl).href
      if (!urls.includes(url)) urls.push(url)
    } catch {
      /* ignore */
    }
  }
  const linkRe = /<link\b([^>]*)>/gi
  let match
  while ((match = linkRe.exec(String(html || '')))) {
    const attrs = match[1]
    const type = (/type=["']([^"']+)["']/i.exec(attrs) || [])[1] || ''
    const href = (/href=["']([^"']+)["']/i.exec(attrs) || [])[1] || ''
    if (!href) continue
    if (FEED_TYPES.some(item => type.toLowerCase().includes(item.split('+')[0]))) push(href)
  }
  try {
    const base = new URL(baseUrl)
    for (const path of ['/feed', '/feed.xml', '/rss.xml', '/atom.xml']) {
      const candidate = new URL(path, base).href
      if (!urls.includes(candidate)) urls.push(candidate)
    }
  } catch {
    /* ignore */
  }
  return urls.slice(0, 4)
}

export function looksLikeFeed(contentType = '', body = '') {
  const type = String(contentType).toLowerCase()
  if (FEED_TYPES.some(item => type.includes(item.split('+')[0]))) return true
  const text = String(body || '').slice(0, 2000)
  return /<rss\b|<feed\b[\s\S]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(text)
}

/** 解析 RSS 2.0 / Atom，返回统一的 items。 */
export function parseFeed(body, baseUrl = '') {
  const text = String(body || '')
  const isAtom = /<feed\b/i.test(text) && !/<rss\b/i.test(text)
  const blockRe = isAtom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi
  const items = []
  let match
  while ((match = blockRe.exec(text)) && items.length < 500) {
    const block = match[0]
    const title = tagText(block, 'title')
    let link = isAtom ? atomLink(block) : tagText(block, 'link')
    if (!link) link = tagText(block, 'guid')
    const date = tagText(block, isAtom ? 'updated' : 'pubDate') || tagText(block, isAtom ? 'published' : 'dc:date')
    const summary = tagText(block, isAtom ? 'summary' : 'description').slice(0, 500)
    if (!title && !link) continue
    let absolute = link
    try {
      if (link) absolute = new URL(link, baseUrl).href
    } catch {
      /* 保留原值 */
    }
    items.push({ title, link: absolute, date, summary })
  }
  const channel = /<channel\b[\s\S]*?<\/channel>/i.exec(text)
  const feedTitle = channel ? tagText(channel[0], 'title') : tagText(text, 'title')
  return { format: isAtom ? 'atom' : 'rss', title: feedTitle, items }
}

function countItems(payload) {
  if (Array.isArray(payload)) return payload.length
  if (payload && typeof payload === 'object') {
    for (const key of ['items', 'data', 'results', 'records', 'list', 'rows']) {
      if (Array.isArray(payload[key])) return payload[key].length
    }
  }
  return 0
}

function resultOk(result, minItems) {
  if (!result) return false
  if (Array.isArray(result.data)) return result.data.length >= minItems
  const text = String(result.content || result.text || '')
  return text.length >= Math.max(80, minItems * 20)
}

/**
 * 执行阶梯。
 * @param {object} options
 * @param {string} options.url 起始页面
 * @param {string[]} [options.tiers]
 * @param {{url:string, method?:string, body?:string, headers?:object}} [options.api]
 * @param {(opts:object)=>Promise<{status:number, contentType:string, body:string, headers?:object, blocked?:boolean}>} options.fetchText
 * @param {(html:string)=>Promise<{mode:string, data?:any[], content?:string, count?:number}>} options.extractStatic
 * @param {()=>Promise<{mode:string, data?:any[], content?:string, count?:number}>} options.extractRender
 */
export async function runLadder(options = {}) {
  const started = Date.now()
  const url = String(options.url || '')
  const tiers = (Array.isArray(options.tiers) && options.tiers.length
    ? options.tiers.map(String)
    : [...DEFAULT_TIERS]
  ).filter(tier => DEFAULT_TIERS.includes(tier))
  const minItems = Math.max(1, Number(options.minItems) || 1)
  const attempts = []
  const attempt = async (tier, fn) => {
    const at = Date.now()
    try {
      const value = await fn()
      const ok = Boolean(value?.ok)
      attempts.push({ tier, ok, ms: Date.now() - at, ...(value?.meta || {}) })
      return ok ? value : null
    } catch (error) {
      attempts.push({ tier, ok: false, ms: Date.now() - at, reason: String(error?.message || error).slice(0, 300) })
      return null
    }
  }

  // T0 官方 API（调用方显式给端点）
  if (tiers.includes('api') && options.api && options.api.url) {
    const hit = await attempt('api', async () => {
      const res = await options.fetchText({
        url: options.api.url,
        method: options.api.method || 'GET',
        body: options.api.body,
        headers: options.api.headers,
      })
      if (res.blocked) return { ok: false, meta: { status: res.status, reason: 'blocked' } }
      if (res.status < 200 || res.status >= 300) return { ok: false, meta: { status: res.status } }
      let json = null
      try {
        json = JSON.parse(res.body)
      } catch {
        json = null
      }
      const count = countItems(json)
      if (!json || count < minItems) return { ok: false, meta: { status: res.status, count } }
      return { ok: true, mode: 'api', data: json, count, meta: { status: res.status, count } }
    })
    if (hit) {
      return { ok: true, tier: 'api', attempts, data: hit.data, mode: 'api', count: hit.count, ms: Date.now() - started }
    }
  }

  // 页面 HTML：feed 发现与静态解析共用一次抓取
  let page = null
  if (tiers.includes('feed') || tiers.includes('static')) {
    try {
      page = await options.fetchText({ url })
    } catch (error) {
      attempts.push({ tier: 'page', ok: false, reason: String(error?.message || error).slice(0, 300) })
      page = null
    }
  }

  // T1 RSS / Atom
  if (tiers.includes('feed') && page && !page.blocked) {
    // 直接给的就是 feed 地址时，先解析本页
    if (looksLikeFeed(page.contentType, page.body)) {
      const directFeed = parseFeed(page.body, page.finalUrl || url)
      if (directFeed.items.length >= minItems) {
        attempts.push({ tier: 'feed', ok: true, ms: 0, status: page.status, url: page.finalUrl || url, format: directFeed.format, count: directFeed.items.length })
        return {
          ok: true, tier: 'feed', attempts, data: directFeed.items, mode: 'feed',
          count: directFeed.items.length, ms: Date.now() - started,
        }
      }
    }

    const candidates = discoverFeedUrls(page.body, page.finalUrl || url)
    for (const candidate of candidates) {
      const hit = await attempt('feed', async () => {
        const res = await options.fetchText({ url: candidate })
        if (res.blocked) return { ok: false, meta: { status: res.status, url: candidate, reason: 'blocked' } }
        if (!looksLikeFeed(res.contentType, res.body)) {
          return { ok: false, meta: { status: res.status, url: candidate, reason: 'not-feed' } }
        }
        const feed = parseFeed(res.body, res.finalUrl || candidate)
        if (feed.items.length < minItems) {
          return { ok: false, meta: { status: res.status, url: candidate, count: feed.items.length } }
        }
        return {
          ok: true,
          mode: 'feed',
          data: feed.items,
          count: feed.items.length,
          meta: { status: res.status, url: candidate, format: feed.format, count: feed.items.length },
        }
      })
      if (hit) {
        return {
          ok: true,
          tier: 'feed',
          attempts,
          data: hit.data,
          mode: 'feed',
          count: hit.count,
          ms: Date.now() - started,
        }
      }
    }
  }

  // T2 静态 HTML（不等待 JS）
  if (tiers.includes('static') && page && !page.blocked && page.status >= 200 && page.status < 400) {
    const hit = await attempt('static', async () => {
      const extracted = await options.extractStatic(page.body)
      if (!resultOk(extracted, minItems)) {
        return { ok: false, meta: { status: page.status, count: extracted?.data?.length ?? 0, reason: 'no-items' } }
      }
      return {
        ok: true,
        mode: extracted.mode,
        data: extracted.data,
        content: extracted.content,
        count: extracted.data?.length ?? 1,
        meta: { status: page.status, mode: extracted.mode },
      }
    })
    if (hit) {
      return {
        ok: true,
        tier: 'static',
        attempts,
        data: hit.data,
        content: hit.content,
        mode: hit.mode,
        count: hit.count,
        ms: Date.now() - started,
      }
    }
  }

  // T3 动态渲染
  if (tiers.includes('render')) {
    const hit = await attempt('render', async () => {
      const extracted = await options.extractRender()
      if (!resultOk(extracted, minItems)) {
        return { ok: false, meta: { mode: extracted?.mode, count: extracted?.data?.length ?? 0, reason: 'no-items' } }
      }
      return {
        ok: true,
        mode: extracted.mode,
        data: extracted.data,
        content: extracted.content,
        count: extracted.data?.length ?? 1,
        meta: { mode: extracted.mode },
      }
    })
    if (hit) {
      return {
        ok: true,
        tier: 'render',
        attempts,
        data: hit.data,
        content: hit.content,
        mode: hit.mode,
        count: hit.count,
        ms: Date.now() - started,
      }
    }
  }

  return {
    ok: false,
    tier: null,
    attempts,
    reason: '阶梯已穷尽：API / Feed / 静态 / 渲染均未取到满足条件的数据',
    ms: Date.now() - started,
  }
}
