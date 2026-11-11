import fs from 'node:fs/promises'

import { BrowserManager } from '../../lib/manager.js'
import { resolveConfig } from '../../lib/config.js'

const base = 'C:/Users/生升/Documents/deepseek-harness/default-workspace/qq_forum/five'
const profile = 'C:/Users/生升/.dsh/browser-tool/profile'
const artifact = 'C:/Users/生升/.dsh/browser-tool/artifacts'
const targets = JSON.parse(await fs.readFile(`${base}/eligible-targets.json`, 'utf8'))
const index = Number(process.argv[2] || 0)
const target = targets[index]
if (!target) {
  console.log(JSON.stringify({ index, error: 'out-of-range' }))
  process.exit(0)
}

const config = resolveConfig({ userDataDir: profile, artifactDir: artifact, visibility: 'window' })
const manager = new BrowserManager(config)
const record = { index, post_id: target.post_id, ok: false, skipped: false, error: '' }

try {
  await manager.ensure()
  const state = await manager.createPage({ activate: true })
  const page = state.page
  await page.goto(target.link, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForTimeout(2200)
  const existing = await page.locator('.comment-list-item', { hasText: 'dd' }).count().catch(() => 0)
  if (existing > 0) {
    record.skipped = true
    record.ok = true
  } else {
    await page.locator('.bottom-input__text').first().click({ timeout: 10000 })
    await page.locator('.ProseMirror').first().click({ timeout: 6000 })
    await page.keyboard.type('dd')
    const send = page.getByRole('button', { name: '发送' }).first()
    await send.waitFor({ state: 'visible', timeout: 6000 })
    await send.click()
    for (let i = 0; i < 10; i += 1) {
      await page.waitForTimeout(900)
      const hit = await page.locator('.comment-list-item', { hasText: 'dd' }).count().catch(() => 0)
      if (hit > 0) {
        record.ok = true
        break
      }
    }
  }
} catch (error) {
  record.error = String(error?.message || error).slice(0, 140)
} finally {
  await manager.dispose().catch(() => {})
}

await fs.appendFile(`${base}/one-comments.jsonl`, `${JSON.stringify(record)}\n`, 'utf8')
console.log(JSON.stringify(record))
