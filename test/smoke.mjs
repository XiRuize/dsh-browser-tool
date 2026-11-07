import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from '../lib/manager.js'
import { captureSnapshot } from '../lib/snapshot.js'
import { extractPage, boundExtractResult } from '../lib/extract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.join(here, '.tmp')

const config = {
  mode: 'launch',
  channel: 'msedge',
  executablePath: '',
  cdpUrl: '',
  headless: false,
  userDataDir: path.join(runtime, 'test-profile'),
  artifactDir: path.join(runtime, 'test-artifacts'),
  downloadsDir: path.join(runtime, 'test-downloads'),
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  actionTimeoutMs: 15000,
  navigationTimeoutMs: 45000,
  snapshotMaxChars: 12000,
  extractMaxChars: 30000,
  collectConcurrency: 2,
  collectDelayMs: 800,
  collectRenderWaitMs: 700,
  idleCloseMs: 0,
  networkMaxEntries: 80,
  networkMaxBodyChars: 120000,
}

const manager = new BrowserManager(config)
let failed = false

try {
  const state = await manager.open({ url: 'https://example.com', agentId: 'smoke' })
  console.log('OPEN', state.tabId, state.page.url())

  const snapshot = await captureSnapshot(state.page, state.tabId, { maxChars: 12000 })
  manager.setRefs(state.page, snapshot.refMap)
  console.log('--- SNAPSHOT ---')
  console.log(snapshot.text.slice(0, 2500))
  console.log('REFS', snapshot.refs.length)

  const extracted = await extractPage(state.page, { mode: 'text' })
  const bounded = boundExtractResult(extracted, 30000)
  console.log('--- EXTRACT ---')
  console.log(bounded.content?.slice(0, 800))

  const shotPath = await manager.artifactPath('smoke-example.png', { ext: '.png', prefix: 'shot' })
  await state.page.screenshot({ path: shotPath, fullPage: true })
  console.log('SHOT', shotPath)

  const link = state.page.locator('a').first()
  if (await link.count()) {
    const href = await link.getAttribute('href')
    console.log('LINK', href)
  }
} catch (error) {
  failed = true
  console.error('SMOKE FAILED', error)
} finally {
  await manager.dispose()
}

process.exit(failed ? 1 : 0)
