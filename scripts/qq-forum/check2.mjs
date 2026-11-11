import fs from 'node:fs/promises'

import { BrowserManager } from '../../lib/manager.js'
import { resolveConfig } from '../../lib/config.js'

const profile = 'C:/Users/生升/.dsh/browser-tool/profile'
const artifact = 'C:/Users/生升/.dsh/browser-tool/artifacts'
const base = 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/five'
const targets = JSON.parse(await fs.readFile(`${base}/targets.json`, 'utf8'))
const start = Number(process.argv[2] || 0)
const count = Number(process.argv[3] || 10)
const slice = targets.slice(start, start + count)

const DD_RE = /(^|[\s，。,.!])(dd|滴滴|d|私我|私聊)([\s，。,.!]|$)/i
const CLOSED_RE = /不用了|不需要|已出|已收|已买到|已找到|已解决|已结束|封贴|已拼|已租|已转|出完了|收到了/
const TIME_SENSITIVE = new Set(['演员/代课', '跑腿/代取'])

const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'headless' })
const manager = new BrowserManager(config)
const results = []

try {
  await manager.ensure()
  for (const target of slice) {
    const record = {
      ...target,
      ok: false,
      postTime: '',
      postText: '',
      comments: [],
      hasDD: false,
      closed: false,
      stale: false,
      eligible: false,
      error: '',
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let page = null
      try {
        await manager.ensure()
        const state = await manager.createPage({ activate: false })
        page = state.page
        await page.goto(target.link, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForTimeout(1800)
        const info = await page.evaluate(() => {
          const pick = selector => document.querySelector(selector)?.innerText?.trim() || ''
          const comments = [...document.querySelectorAll('.comment-list-item')].map(el =>
            (el.innerText || '').replace(/\s+/g, ' ').trim(),
          )
          return {
            postTime: pick('.feed-info__detail__time'),
            postText: [...document.querySelectorAll('.feed-detail-text')].map(el => el.innerText).join(' '),
            comments,
          }
        })
        record.postTime = info.postTime
        record.postText = info.postText.slice(0, 120)
        record.comments = info.comments.slice(0, 8)
        const joined = `${info.postText} ${info.comments.join(' ')}`
        record.hasDD = info.comments.some(comment => DD_RE.test(comment))
        record.closed = CLOSED_RE.test(joined)
        const days = record.postTime
          ? (Date.now() - new Date(`${record.postTime}T00:00:00+08:00`).getTime()) / 86400000
          : 99
        record.stale = days > 1 && TIME_SENSITIVE.has(target.category)
        record.eligible = !record.hasDD && !record.closed && !record.stale
        record.ok = true
        await page.close().catch(() => {})
        break
      } catch (error) {
        record.error = String(error?.message || error).slice(0, 120)
        await page?.close().catch(() => {})
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    }
    results.push(record)
    console.log(
      `${record.ok ? 'OK ' : 'ERR'} ${record.eligible ? '可评论' : '跳过  '} ${target.post_id.slice(0, 18)} ` +
        `${record.postTime} | dd=${record.hasDD} closed=${record.closed} stale=${record.stale}`,
    )
  }
} finally {
  await manager.dispose().catch(() => {})
}

const out = `${base}/status-${start}-${start + slice.length}.json`
await fs.writeFile(out, JSON.stringify(results, null, 2), 'utf8')
console.log(JSON.stringify({ start, count: results.length, eligible: results.filter(r => r.eligible).length, ok: results.filter(r => r.ok).length, out }, null, 2))
