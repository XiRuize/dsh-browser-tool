import fs from 'node:fs/promises'

import { BrowserManager } from '../../lib/manager.js'
import { resolveConfig } from '../../lib/config.js'

const profile = 'C:/Users/生升/.dsh/browser-tool/profile'
const artifact = 'C:/Users/生升/.dsh/browser-tool/artifacts'
const targetsPath = 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/five/targets.json'
const outPath = 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/five/targets-status.json'

const targets = JSON.parse(await fs.readFile(targetsPath, 'utf8'))
const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'headless' })
const manager = new BrowserManager(config)
const results = []

const DD_RE = /(^|[\s，。,.!])(dd|滴滴|d|私我|私聊)([\s，。,.!]|$)/i
const CLOSED_RE = /不用了|不需要|已出|已收|已买到|已找到|已解决|已结束|封贴|已拼|已租|已转|出完了|收到了/
const TIME_SENSITIVE = new Set(['演员/代课', '跑腿/代取'])

try {
  await manager.ensure()
  const state = await manager.createPage({ activate: false })
  const page = state.page
  for (const target of targets) {
    const record = {
      ...target,
      ok: true,
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
      try {
        await page.goto(target.link, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForTimeout(1900)
        const info = await page.evaluate(() => {
          const pick = selector => document.querySelector(selector)?.innerText?.trim() || ''
          const comments = [...document.querySelectorAll('.comment-list-item')].map(el =>
            (el.innerText || '').replace(/\s+/g, ' ').trim(),
          )
          return {
            title: document.title,
            postTime: pick('.feed-info__detail__time'),
            postText: [...document.querySelectorAll('.feed-detail-text')].map(el => el.innerText).join(' '),
            comments,
          }
        })
        record.title = info.title
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
        break
      } catch (error) {
        record.ok = false
        record.eligible = false
        record.error = String(error?.message || error).slice(0, 160)
        await page.waitForTimeout(500)
      }
    }
    results.push(record)
    console.log(
      `${record.ok ? 'OK ' : 'ERR'} ${record.eligible ? '可评论' : '跳过  '} ${record.post_id.slice(0, 18)} ` +
        `${record.postTime} | dd=${record.hasDD} closed=${record.closed} stale=${record.stale} | ` +
        `${(record.comments[0] || '').slice(0, 32)}`,
    )
  }
} finally {
  await manager.dispose().catch(() => {})
}

await fs.writeFile(outPath, JSON.stringify(results, null, 2), 'utf8')
const eligible = results.filter(r => r.eligible)
console.log(
  JSON.stringify(
    {
      total: results.length,
      eligible: eligible.length,
      skippedDD: results.filter(r => r.hasDD).length,
      skippedClosed: results.filter(r => r.closed).length,
      skippedStale: results.filter(r => r.stale).length,
      errors: results.filter(r => !r.ok).length,
      outPath,
    },
    null,
    2,
  ),
)
