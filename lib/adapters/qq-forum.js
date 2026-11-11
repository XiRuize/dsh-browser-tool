/**
 * QQ 论坛（腾讯频道 pd.qq.com）采集适配器。
 *
 * 设计目标：在登录态下用最快路径拿到帖子流，而不是逐条渲染。
 *
 * 两条路径：
 * 1) SSR 列表页（默认）：直接 GET 版块页，解析服务端渲染的帖子卡片。
 *    免登录、单页 ~1s、一次 10~12 条。
 * 2) JSON 接口分页（可选）：trpc.qchannel.commreader.ComReader/GetGuildFeeds，
 *    通过 feedAttchInfo 游标翻页，一次 10 条，适合大批量归档。
 *
 * 作者存档 ID：帖子 id 形如 B_<hex><18位tinyid>0X60，tinyid 以 1441152 开头，
 * 可直接从 id 反解，不依赖接口返回。
 */

const DEFAULT_BASE = 'https://pd.qq.com/g/iloveswufe'
const DEFAULT_SECTIONS = [
  { name: '全部', subc: '' },
  { name: '热门', subc: 'hot' },
  { name: '二手', subc: '38984169' },
]
const FEED_API =
  '/qunng/guild/gotrpc/auth/trpc.qchannel.commreader.ComReader/GetGuildFeeds'
const TIMELINE_API =
  '/qunng/guild/gotrpc/auth/trpc.qchannel.commreader.ComReader/GetChannelTimelineFeeds'
const TINYID_RE = /1441152\d{11}/

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
}

function clean(text) {
  return decodeEntities(String(text || ''))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从帖子 id 反解作者 tiny_id。 */
export function tinyIdOfFeed(feedId) {
  const match = TINYID_RE.exec(String(feedId || ''))
  return match ? match[0] : ''
}

/**
 * 解析 SSR 列表页中的帖子卡片。
 * 只依赖稳定的 class 名（msgBox / nick / edit-time / feed-detail-text），
 * 页面改版时需要在 test 里补一条真实样本。
 */
export function parseSsrPosts(html, { section = '', base = DEFAULT_BASE } = {}) {
  const text = String(html || '')
  const posts = []
  const blocks = text.split('<div class="msgBox" data-index="')
  for (let index = 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    const idMatch = /^(B_[0-9A-Za-z]+)"/.exec(block)
    if (!idMatch) continue
    const postId = idMatch[1]
    const nick = /class="nick[^"]*"[^>]*>([^<]{0,80})</.exec(block)
    const when = /class="edit-time"[^>]*>([^<]{0,40})</.exec(block)
    const href = /href="([^"]*\/post\/[^"]+)"/.exec(block)
    const texts = [...block.matchAll(/class="feed-detail-text"[^>]*>([^<]{0,400})</g)].map(m => clean(m[1]))
    const avatar = /class="avatar[^"]*"[^>]*>[\s\S]{0,400}?src="([^"]+)"/.exec(block)
    const counts = [...block.matchAll(/class="game-guild-main__short-content__text"[^>]*>([^<]{1,20})</g)].map(m =>
      clean(m[1]),
    )
    let link = href ? decodeEntities(href[1]) : ''
    if (link.startsWith('/')) link = new URL(link, base).toString()
    posts.push({
      section,
      post_id: postId,
      author_tinyid: tinyIdOfFeed(postId),
      author_nick: nick ? clean(nick[1]) : '',
      posted_at: when ? clean(when[1]) : '',
      text: texts.join(' ').trim(),
      link,
      avatar: avatar ? decodeEntities(avatar[1]) : '',
      counts,
      via: 'ssr',
    })
  }
  return posts
}

/** 解析 GetGuildFeeds 的 JSON 响应（与 SSR 输出同构）。 */
export function parseFeedApi(payload, { section = '' } = {}) {
  const feeds = payload?.data?.vecFeed || []
  return feeds.map(feed => {
    const poster = feed.poster || {}
    const title = feed.title?.contents || feed.contents?.contents || []
    const text = title
      .filter(item => item.type === 1 && item.text_content)
      .map(item => item.text_content.text)
      .join(' ')
    return {
      section,
      post_id: feed.id || '',
      author_tinyid: poster.id || tinyIdOfFeed(feed.id),
      author_nick: poster.nick || '',
      posted_at: feed.createTime || '',
      text: clean(text),
      link: `${DEFAULT_BASE}/post/${feed.id}`,
      avatar: poster.icon?.iconUrl || '',
      comment_count: feed.commentCount ?? null,
      view_count: feed.visitorInfo?.viewCount ?? null,
      ip: feed.ip_location_province || '',
      via: 'api',
    }
  })
}

function matchKeywords(post, keywords) {
  if (!keywords || keywords.length === 0) return true
  const haystack = `${post.text} ${post.author_nick}`
  return keywords.some(keyword => haystack.includes(keyword))
}

function normalizeKeywords(input) {
  if (input === undefined || input === null) return []
  const list = Array.isArray(input) ? input : [input]
  return list.map(item => String(item).trim()).filter(Boolean)
}

/** 渲染一次频道页，逐个点开版块收集 ?subc= 映射；失败时回退默认版块。 */
export async function discoverSections(manager, base = DEFAULT_BASE, { settleMs = 250 } = {}) {
  let state = null
  try {
    state = await manager.createPage({ activate: false })
    const page = state?.page
    if (!page) return []
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('.tab-bar__item__text', { timeout: 8000 }).catch(() => {})
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.tab-bar__item__text')].map(el => el.textContent.trim()).filter(Boolean),
    )
    if (!Array.isArray(labels) || labels.length === 0) return []
    const found = []
    for (const label of labels) {
      const clicked = await page
        .evaluate(name => {
          const nodes = [...document.querySelectorAll('.tab-bar__item__text')]
          const target = nodes.find(el => el.textContent.trim() === name)
          const item = target?.closest('.tab-bar__item')
          if (!item) return false
          item.click()
          return true
        }, label)
        .catch(() => false)
      if (!clicked) continue
      await page.waitForTimeout(settleMs)
      let subc = ''
      try {
        const current = new URL(page.url())
        subc = current.searchParams.get('subc') || ''
      } catch {
        subc = ''
      }
      found.push({ name: label, subc })
    }
    const seen = new Set()
    return found.filter(section => {
      const key = `${section.name}|${section.subc}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  } catch {
    return []
  } finally {
    try {
      if (state?.page && !state.page.isClosed()) await state.page.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 采集 QQ 论坛帖子。
 *
 * @param {object} manager BrowserManager（需要 ensure() 返回 BrowserContext）
 * @param {object} options
 *   - guild: 频道号或完整 base url（默认 iloveswufe）
 *   - sections: [{name, subc}]，默认全部/热门/二手
 *   - discover: true 时先渲染一次频道页，自动发现全部版块的 subc
 *   - limit: 目标条数，默认 100
 *   - keywords: 关键词过滤
 *   - api: 可选 { body, pageSize, maxPages } 走 JSON 分页
 *   - onProgress: 进度回调
 * @returns {Promise<{posts: Array, sections: Array, stats: object}>}
 */
export async function collectQqForum(manager, options = {}) {
  const { fastFetch } = await import('../fetch.js')
  const guild = String(options.guild || 'iloveswufe').trim()
  const base = /^https?:/.test(guild) ? guild : `https://pd.qq.com/g/${guild}`
  let sections =
    Array.isArray(options.sections) && options.sections.length > 0 ? options.sections : DEFAULT_SECTIONS
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 1000))
  const keywords = normalizeKeywords(options.keywords)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const onSectionDone = typeof options.onSectionDone === 'function' ? options.onSectionDone : null

  const seen = new Set()
  const posts = []
  const totalLimit = options.paginate ? limit * sections.length : limit
  const stats = { requests: 0, failed: 0, duplicates: 0, sections: [] }

  if (options.discover) {
    const discovered = await discoverSections(manager, base)
    if (discovered.length > 0) sections = discovered
    stats.discovered = discovered.length
  }

  function addPosts(list, sectionName) {
    let added = 0
    for (const post of list) {
      if (!post.post_id || seen.has(post.post_id)) {
        if (post.post_id) stats.duplicates += 1
        continue
      }
      if (!matchKeywords(post, keywords)) continue
      seen.add(post.post_id)
      posts.push(post)
      added += 1
      if (posts.length >= totalLimit) break
    }
    stats.sections.push({ section: sectionName, fetched: list.length, added })
    return added
  }

  // 分页模式：每个版块用 GetChannelTimelineFeeds 游标翻到 limit 条。
  if (options.paginate) {
    const guildNumber = /\/g\/([^/?#]+)/.exec(base)?.[1] || guild
    const apiConcurrency = Math.max(1, Math.min(Number(options.concurrency) || 3, 6))

    // watch 模式：可见窗口里滚动翻页，串行（同一窗口），慢但肉眼可验。
    if (options.watch) {
      for (const section of sections) {
        if (posts.length >= totalLimit) break
        try {
          const rows = await collectSectionByScroll({ manager, base, section, limit, onProgress })
          addPosts(rows, section.name)
          stats.sections.push({ section: section.name, fetched: rows.length, added: rows.length, via: 'scroll' })
          onSectionDone?.(section, rows)
        } catch {
          stats.failed += 1
        }
      }
      return { posts, sections: stats.sections, stats: { ...stats, total: posts.length } }
    }

    const queueApi = sections.slice()
    async function apiWorker() {
      while (queueApi.length > 0) {
        if (posts.length >= totalLimit) return
        const section = queueApi.shift()
        const before = posts.length
        try {
          await collectSectionTimeline({
            manager,
            base,
            guildNumber,
            section,
            limit,
            stats,
            onProgress,
            addPosts,
          })
        } catch {
          stats.failed += 1
        }
        const added = posts.length - before
        if (added > 0) {
          onSectionDone?.(section, posts.slice(before))
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(apiConcurrency, queueApi.length) }, () => apiWorker()),
    )
    return { posts, sections: stats.sections, stats: { ...stats, total: posts.length } }
  }

  // 版块 SSR 并发抓取（默认 4 路），命中 limit 后提前收工。
  const queue = sections.slice()
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 4, 8))
  async function sectionWorker() {
    while (queue.length > 0) {
      if (posts.length >= limit) return
      const section = queue.shift()
      const url = section.subc ? `${base}?subc=${encodeURIComponent(section.subc)}` : base
      stats.requests += 1
      try {
        const response = await fastFetch(manager, {
          url,
          timeoutMs: options.timeoutMs || 30000,
          retries: options.retries ?? 1,
          maxChars: 800000,
        })
        if (!response.ok || (response.bytes || 0) < 5000) {
          stats.failed += 1
          continue
        }
        addPosts(parseSsrPosts(response.fullBody || response.body, { section: section.name, base }), section.name)
        onProgress?.({ section: section.name, total: posts.length, via: 'ssr' })
      } catch {
        stats.failed += 1
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => sectionWorker()),
  )

  // 可选：JSON 接口分页，继续补足到 limit。
  if (options.api && posts.length < limit) {
    await collectByApi({ manager, options, base, keywords, posts, seen, stats, limit, onProgress })
  }

  return { posts, sections: stats.sections, stats: { ...stats, total: posts.length } }
}

/** 可见翻页：真实页面里推滚动容器，边滚边抽 DOM，人眼可看。 */
async function collectSectionByScroll({ manager, base, section, limit, onProgress }) {
  const url = section.subc ? `${base}?subc=${encodeURIComponent(section.subc)}` : base
  const state = await manager.createPage({ activate: true })
  const page = state.page
  const found = new Map()
  const extract = () =>
    [...document.querySelectorAll('.msgBox')].map(box => {
      const pick = selector => box.querySelector(selector)?.innerText?.trim() || ''
      const texts = [...box.querySelectorAll('.feed-detail-text')]
        .map(node => node.innerText.trim())
        .filter(Boolean)
      return {
        section: '',
        post_id: box.getAttribute('data-index') || '',
        author_tinyid: tinyIdOfFeed(box.getAttribute('data-index') || ''),
        author_nick: pick('.nick'),
        posted_at: pick('.edit-time'),
        text: texts.join(' '),
        link: box.querySelector('a.game-guild-main__short-content')?.href || '',
        avatar: '',
        via: 'scroll',
      }
    })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForSelector('.msgBox', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(500)
    let stalled = 0
    let scrolls = 0
    while (found.size < limit && stalled < 4 && scrolls < 40) {
      const rows = await page.evaluate(extract)
      const before = found.size
      for (const row of rows) {
        if (!row.post_id || found.has(row.post_id)) continue
        found.set(row.post_id, { ...row, section: section.name })
      }
      onProgress?.({ section: section.name, total: found.size, via: 'scroll', scrolls })
      if (found.size >= limit) break
      await page.evaluate(() => {
        const targets = document.querySelectorAll(
          '#scrollableDiv, .vue-recycle-scroller, .game-guild-main__waterfalls',
        )
        for (const el of targets) {
          el.scrollTop = el.scrollHeight
          el.dispatchEvent(new Event('scroll', { bubbles: true }))
        }
      })
      await page.mouse.wheel(0, 1600).catch(() => {})
      scrolls += 1
      await page.waitForTimeout(900)
      stalled = found.size === before ? stalled + 1 : 0
    }
    return [...found.values()].slice(0, limit)
  } finally {
    try {
      if (!page.isClosed()) await page.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 用 GetChannelTimelineFeeds 游标分页抓单个版块（每页 10 条，可到 100+）。
 * 请求体来自真实抓包：x-oidb 必须是 service_type=10，否则返回 150 no privilege。
 */
/** 腾讯 g_tk：djb2(skey) & 0x7fffffff。纯函数，便于单测。 */
export function bknFromSkey(skey) {
  const text = String(skey || '')
  if (!text) return ''
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return String(hash & 0x7fffffff)
}

const bknCache = new Map()
const BKN_TTL_MS = 5 * 60 * 1000

/** 从浏览器 Cookie 现算 bkn（g_tk），带 5 分钟缓存，避免每页都读 Cookie。 */
async function resolveBkn(manager, url, { force = false } = {}) {
  const key = new URL(url).origin
  const cached = bknCache.get(key)
  if (!force && cached && Date.now() - cached.at < BKN_TTL_MS) return cached.value
  try {
    const cookies = await manager.context.cookies(url)
    const skey =
      cookies.find(cookie => cookie.name === 'p_skey')?.value ||
      cookies.find(cookie => cookie.name === 'skey')?.value ||
      ''
    const value = bknFromSkey(skey)
    if (value) bknCache.set(key, { value, at: Date.now() })
    return value
  } catch {
    return cached?.value || ''
  }
}

/** 指数退避 + 抖动；只用于可重试的限流/风控响应。 */
function backoffDelay(attempt) {
  const base = Math.min(4000, 400 * 2 ** attempt)
  return base + Math.floor(Math.random() * 250)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function collectSectionTimeline({ manager, base, guildNumber, section, limit, stats, onProgress, addPosts }) {
  const { fastFetch } = await import('../fetch.js')
  const endpointUrl = new URL(TIMELINE_API, base)
  const bkn = await resolveBkn(manager, base)
  if (bkn) endpointUrl.searchParams.set('bkn', bkn)
  const endpoint = endpointUrl.toString()
  const channelId = String(section.subc || '634804985')
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-oidb': '{"uint32_service_type":10}',
    'x-qq-client-appid': '537246381',
    referer: section.subc ? `${base}?subc=${section.subc}` : base,
  }
  let attach = 'pageNum=1&top=&feedIndexAttach='
  let pageNum = 1
  let addedTotal = 0
  let finish = false

  while (addedTotal < limit && !finish && pageNum <= 30) {
    const body = {
      count: Math.min(20, Math.max(1, limit - addedTotal)),
      from: 7,
      guild_number: guildNumber,
      channelSign: { channel_id: channelId },
      feedAttchInfo: attach,
      sortOption: 1,
      need_top_info: false,
    }
    stats.requests += 1
    let response = null
    let endpointNow = endpoint
    for (let attempt = 0; attempt <= 3; attempt += 1) {
      try {
        response = await fastFetch(manager, {
          url: endpointNow,
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          timeoutMs: 30000,
          retries: 0,
          maxChars: 2000000,
        })
      } catch {
        response = null
      }
      if (response?.ok && response.json?.data) break
      const retcode = Number(response?.json?.retcode ?? 0)
      const status = Number(response?.status ?? 0)
      // 150 = bkn/权限失效：刷新 bkn 后立刻重试一次。
      if ((retcode === 150 || status === 403) && attempt <= 1) {
        const fresh = await resolveBkn(manager, base, { force: true })
        if (fresh) {
          const refreshed = new URL(endpointNow)
          refreshed.searchParams.set('bkn', fresh)
          endpointNow = refreshed.toString()
        }
        continue
      }
      const retryable = status === 429 || status === 0 || status >= 500
      if (!retryable || attempt >= 3) break
      stats.backoffs = (stats.backoffs || 0) + 1
      await sleep(backoffDelay(attempt))
    }
    if (!response || !response.ok || !response.json?.data) {
      stats.failed += 1
      if (response?.status) stats.lastStatus = response.status
      break
    }
    const data = response.json.data
    const list = parseFeedApi(response.json, { section: section.name })
    const added = addPosts(list, section.name)
    addedTotal += added
    finish = data.isFinish === 1
    const next = String(data.feedAttchInfo || '')
    const pageMatch = /pageNum=(\d+)/.exec(next)
    const nextPage = pageMatch ? Number(pageMatch[1]) : pageNum + 1
    if (!next || nextPage <= pageNum) {
      if (added === 0) break
      pageNum = nextPage > pageNum ? nextPage : pageNum + 1
    } else {
      pageNum = nextPage
    }
    attach = next || attach
    onProgress?.({ section: section.name, page: pageNum, added: addedTotal, limit })
    if (added === 0 && finish) break
    if (added === 0 && !next) break
  }
  return addedTotal
}

async function collectByApi({ manager, options, base, keywords, posts, seen, stats, limit, onProgress }) {
  const { fastFetch } = await import('../fetch.js')
  const api = options.api || {}
  const pageSize = Math.max(1, Math.min(Number(api.pageSize) || 20, 50))
  const maxPages = Math.max(1, Math.min(Number(api.maxPages) || Math.ceil(limit / pageSize) + 2, 100))
  const endpoint = new URL(FEED_API, base).toString()
  let cursor = api.cursor || ''

  for (let page = 0; page < maxPages && posts.length < limit; page += 1) {
    const body = typeof api.body === 'function'
      ? api.body({ cursor, page, pageSize })
      : api.body
    if (!body) break
    const payload = typeof body === 'string' ? body : JSON.stringify(body).replaceAll('{{cursor}}', cursor).replaceAll('{{pageSize}}', String(pageSize)).replaceAll('{{page}}', String(page))

    stats.requests += 1
    const response = await fastFetch(manager, {
      url: endpoint,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-oidb': '{"uint32_service_type":13}',
        'x-qq-client-appid': '537246381',
        ...(api.headers || {}),
      },
      body: payload,
      timeoutMs: options.timeoutMs || 30000,
      retries: options.retries ?? 1,
      maxChars: 800000,
    })
    if (!response.ok || !response.json) {
      stats.failed += 1
      break
    }
    const list = parseFeedApi(response.json, { section: api.section || '全部' })
    let added = 0
    for (const post of list) {
      if (!post.post_id || seen.has(post.post_id)) continue
      if (!matchKeywords(post, keywords)) continue
      seen.add(post.post_id)
      posts.push(post)
      added += 1
      if (posts.length >= limit) break
    }
    onProgress?.({ section: 'api', page, added, total: posts.length })
    cursor = response.json?.data?.feedAttchInfo || ''
    if (!cursor || added === 0 || response.json?.data?.isFinish) break
  }
}
