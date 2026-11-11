import fs from 'node:fs/promises'

import { BrowserManager } from '../../lib/manager.js'
import { resolveConfig } from '../../lib/config.js'

const base = 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/five'
const profile = 'C:/Users/生升/.dsh/browser-tool/profile'
const artifact = 'C:/Users/生升/.dsh/browser-tool/artifacts'

const targets = JSON.parse(await fs.readFile(`${base}/eligible-targets.json`, 'utf8'))
const start = Number(process.argv[2] || 0)
const count = Number(process.argv[3] || 5)
const delayMin = Number(process.argv[4] || 10000)
const delayMax = Number(process.argv[5] || 16000)
const text = process.argv[6] || 'dd'
const slice = targets.slice(start, start + count)

const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'window' })
const manager = new BrowserManager(config)
const results = []

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rand = (min, max) => Math.round(min + Math.random() * (max - min))

try {
  await manager.ensure()
  for (const [index, target] of slice.entries()) {
    const record = { ...target, ok: false, error: '', at: new Date().toISOString() }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let page = null
      try {
        await manager.ensure()
        const state = await manager.createPage({ activate: true })
        page = state.page
        await page.goto(target.link, { waitUntil: 'domcontentloaded', timeout: 45000 })
        await page.waitForTimeout(2200)
        await page.locator('.bottom-input__text').first().click({ timeout: 10000 })
        await page.locator('.ProseMirror').first().click({ timeout: 6000 })
        await page.keyboard.type(text)
        const send = page.getByRole('button', { name: '发送' }).first()
        await send.waitFor({ state: 'visible', timeout: 6000 })
        await send.click()
        let hit = 0
        for (let i = 0; i < 10; i += 1) {
          await page.waitForTimeout(900)
          hit = await page.locator('.comment-list-item', { hasText: text }).count().catch(() => 0)
          if (hit > 0) break
        }
        record.ok = hit > 0
        record.hit = hit
        await page.close().catch(() => {})
        break
      } catch (error) {
        record.error = String(error?.message || error).slice(0, 140)
        await page?.close().catch(() => {})
        await sleep(800)
      }
    }
    results.push(record)
    console.log(`[${start + index + 1}/${targets.length}] ${record.ok ? 'OK' : 'FAIL'} ${target.post_id.slice(0, 18)} ${record.error}`)
    if (index < slice.length - 1) await sleep(rand(delayMin, delayMax))
  }
} finally {
  await manager.dispose().catch(() => {})
}

const out = `${base}/comment-results-${start}.json`
await fs.writeFile(out, JSON.stringify(results, null, 2), 'utf8')
console.log(JSON.stringify({ start, count: results.length, ok: results.filter(r => r.ok).length, out }, null, 2))
