import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'

const profile = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-tool', 'profile')
const artifact = process.env.DSH_BROWSER_ARTIFACTS || path.join(os.homedir(), '.dsh', 'browser-tool', 'artifacts')
const subc = process.argv[2] || '38984169'
const limit = Number(process.argv[3] || 100)
const outDir = process.argv[4] || path.join(process.cwd(), 'test-output', 'watch')

const url = `https://pd.qq.com/g/iloveswufe?subc=${subc}`
const config = resolveConfig({
  userDataDir: profile,
  artifactDir: artifact,
  visibility: 'window',
  navigationTimeoutMs: 60000,
})
const manager = new BrowserManager(config)

const extract = () =>
  [...document.querySelectorAll('.msgBox')].map(box => {
    const pick = selector => box.querySelector(selector)?.innerText?.trim() || ''
    const texts = [...box.querySelectorAll('.feed-detail-text')].map(node => node.innerText.trim()).filter(Boolean)
    return {
      post_id: box.getAttribute('data-index') || '',
      author: pick('.nick'),
      time: pick('.edit-time'),
      text: texts.join(' '),
      link: box.querySelector('a.game-guild-main__short-content')?.href || '',
    }
  })

const startedAt = Date.now()
const seen = new Map()
let scrolls = 0
let stalled = 0
let page = null

try {
  await manager.ensure()
  const state = await manager.createPage({ activate: true })
  page = state.page
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.msgBox', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(600)

  const box = await page.locator('#scrollableDiv').boundingBox().catch(() => null)
  const cx = box ? box.x + box.width / 2 : 700
  const cy = box ? box.y + box.height / 2 : 450
  await page.mouse.move(cx, cy)

  for (let round = 0; round < 30 && seen.size < limit; round += 1) {
    const rows = await page.evaluate(extract)
    for (const row of rows) {
      if (!row.post_id || seen.has(row.post_id)) continue
      seen.set(row.post_id, { ...row, section: subc })
    }
    process.stderr.write(`\r已采集 ${seen.size}/${limit}（滚动 ${scrolls} 次）`)
    if (seen.size >= limit) break
    const before = seen.size
    // 虚拟滚动容器：直接推到底部触发它的 scroll 事件（比 mouse.wheel 稳定）。
    await page.evaluate(() => {
      const targets = document.querySelectorAll('#scrollableDiv, .vue-recycle-scroller, .game-guild-main__waterfalls')
      for (const el of targets) {
        el.scrollTop = el.scrollHeight
        el.dispatchEvent(new Event('scroll', { bubbles: true }))
      }
    })
    await page.mouse.wheel(0, 1800).catch(() => {})
    scrolls += 1
    await page.waitForTimeout(900)
    const rowsAfter = await page.evaluate(extract)
    for (const row of rowsAfter) {
      if (!row.post_id || seen.has(row.post_id)) continue
      seen.set(row.post_id, { ...row, section: subc })
    }
    stalled = seen.size === before ? stalled + 1 : 0
    if (stalled >= 4) break
  }
} finally {
  await manager.dispose().catch(() => {})
}

const posts = [...seen.values()].slice(0, limit)
await fs.mkdir(outDir, { recursive: true })
const file = path.join(outDir, `watch-${subc}.json`)
await fs.writeFile(file, JSON.stringify({ subc, url, posts }, null, 2), 'utf8')
console.log(
  JSON.stringify(
    { subc, got: posts.length, scrolls, wallMs: Date.now() - startedAt, file },
    null,
    2,
  ),
)
