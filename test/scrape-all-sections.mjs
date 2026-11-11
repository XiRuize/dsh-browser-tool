import fs from 'node:fs/promises'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'
import { fastFetch } from '../lib/fetch.js'
import { parseFeedApi } from '../lib/adapters/qq-forum.js'

const profile = 'C:/Users/生升/.dsh/browser-tool/profile'
const artifact = 'C:/Users/生升/.dsh/browser-tool/artifacts'
const outDir = process.argv[2] || 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/full'
const limit = Number(process.argv[3] || 100)
const concurrency = Number(process.argv[4] || 4)

const sections = [
  { name: '全部', subc: '634804985' },
  { name: '柳林', subc: '654210383' },
  { name: '光华', subc: '714966807' },
  { name: '树洞', subc: '5749913' },
  { name: '情感', subc: '5750838' },
  { name: '选课', subc: '741041212' },
  { name: '二手', subc: '38984169' },
  { name: '校宠', subc: '716737185' },
  { name: '摄影', subc: '662315276' },
  { name: '影音', subc: '495011466' },
  { name: '失物', subc: '38984591' },
  { name: '拼车', subc: '38984057' },
  { name: '防骗', subc: '718991315' },
]

const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'headless' })
const manager = new BrowserManager(config)
const endpoint =
  'https://pd.qq.com/qunng/guild/gotrpc/auth/trpc.qchannel.commreader.ComReader/GetChannelTimelineFeeds?bkn=680009538'

async function collectSection(section) {
  const startedAt = Date.now()
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-oidb': '{"uint32_service_type":10}',
    'x-qq-client-appid': '537246381',
    referer: `https://pd.qq.com/g/iloveswufe?subc=${section.subc}`,
  }
  const seen = new Set()
  const posts = []
  let attach = 'pageNum=1&top=&feedIndexAttach='
  let pageNum = 1
  let finish = false
  let requests = 0

  while (posts.length < limit && !finish && pageNum <= 30) {
    const body = {
      count: 10,
      from: 7,
      guild_number: 'iloveswufe',
      channelSign: { channel_id: section.subc },
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
    if (!response.ok || !response.json?.data) break
    const data = response.json.data
    let added = 0
    for (const post of parseFeedApi(response.json, { section: section.name })) {
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
    if (added === 0 && pageNum > 12) break
  }
  return {
    section: section.name,
    subc: section.subc,
    got: posts.length,
    requests,
    wallMs: Date.now() - startedAt,
    withTinyId: posts.filter(post => post.author_tinyid).length,
    posts,
  }
}

const startedAt = Date.now()
const results = []
try {
  await manager.ensure()
  const queue = sections.slice()
  async function worker() {
    while (queue.length > 0) {
      const section = queue.shift()
      try {
        results.push(await collectSection(section))
      } catch (error) {
        console.error('failed', section.name, error?.message)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, sections.length) }, () => worker()))
} finally {
  await manager.dispose().catch(() => {})
}

await fs.mkdir(outDir, { recursive: true })
const summary = results.map(({ posts, ...rest }) => rest)
for (const result of results) {
  await fs.writeFile(
    path.join(outDir, `section-${result.subc}.json`),
    JSON.stringify({ section: result.section, subc: result.subc, posts: result.posts }, null, 2),
    'utf8',
  )
}
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
console.log(
  JSON.stringify(
    {
      wallMs: Date.now() - startedAt,
      total: results.reduce((sum, r) => sum + r.got, 0),
      sections: summary,
    },
    null,
    2,
  ),
)
