import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'
import { fastFetch } from '../lib/fetch.js'
import { parseFeedApi } from '../lib/adapters/qq-forum.js'

const profile = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-tool', 'profile')
const artifact = process.env.DSH_BROWSER_ARTIFACTS || path.join(os.homedir(), '.dsh', 'browser-tool', 'artifacts')
const section = process.argv[2] || '38984169'
const limit = Number(process.argv[3] || 100)
const guildNumber = 'iloveswufe'

const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'headless' })
const manager = new BrowserManager(config)
const endpoint =
  'https://pd.qq.com/qunng/guild/gotrpc/auth/trpc.qchannel.commreader.ComReader/GetChannelTimelineFeeds?bkn=680009538'
const headers = {
  accept: 'application/json',
  'content-type': 'application/json',
  'x-oidb': '{"uint32_service_type":10}',
  'x-qq-client-appid': '537246381',
  referer: section ? `https://pd.qq.com/g/iloveswufe?subc=${section}` : 'https://pd.qq.com/g/iloveswufe',
}

const startedAt = Date.now()
const seen = new Set()
const posts = []
let attach = 'pageNum=1&top=&feedIndexAttach='
let pageNum = 1
let finish = false
let requests = 0

try {
  await manager.ensure()
  while (posts.length < limit && !finish && pageNum <= 30) {
    const body = {
      count: 10,
      from: 7,
      guild_number: guildNumber,
      channelSign: { channel_id: section },
      feedAttchInfo: attach,
      sortOption: 1,
      need_top_info: false,
    }
    const response = await fastFetch(manager, {
      url: endpoint,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: 30000,
      retries: 2,
      maxChars: 2000000,
    })
    requests += 1
    if (!response.ok || !response.json?.data) {
      console.error('failed', response.status, response.body.slice(0, 120))
      break
    }
    const data = response.json.data
    const list = parseFeedApi(response.json, { section })
    let added = 0
    for (const post of list) {
      if (!post.post_id || seen.has(post.post_id)) continue
      seen.add(post.post_id)
      posts.push(post)
      added += 1
      if (posts.length >= limit) break
    }
    finish = data.isFinish === 1
    const next = String(data.feedAttchInfo || '')
    const m = /pageNum=(\d+)/.exec(next)
    pageNum = m ? Number(m[1]) : pageNum + 1
    attach = next || attach
    if (added === 0 && (!next || finish)) break
  }
} finally {
  await manager.dispose().catch(() => {})
}

const wall = Date.now() - startedAt
console.log(
  JSON.stringify(
    {
      section,
      limit,
      got: posts.length,
      requests,
      pages: pageNum - 1,
      wallMs: wall,
      perRequestMs: Math.round(wall / Math.max(1, requests)),
      withTinyId: posts.filter(post => post.author_tinyid).length,
    },
    null,
    2,
  ),
)
for (const post of posts.slice(0, 5)) {
  console.log(`- ${post.author_nick} (${post.author_tinyid}) ${post.posted_at} ${post.text.slice(0, 40)}`)
}
