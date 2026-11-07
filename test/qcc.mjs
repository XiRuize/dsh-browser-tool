import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from '../lib/manager.js'
import { captureSnapshot } from '../lib/snapshot.js'
import { extractPage } from '../lib/extract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.resolve(here, '..', 'runtime')

const config = {
  mode: 'launch',
  channel: 'msedge',
  executablePath: '',
  cdpUrl: '',
  headless: false,
  userDataDir: path.join(runtime, 'qcc-profile'),
  artifactDir: path.join(runtime, 'qcc-artifacts'),
  downloadsDir: path.join(runtime, 'qcc-downloads'),
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  actionTimeoutMs: 20000,
  navigationTimeoutMs: 60000,
  snapshotMaxChars: 14000,
  extractMaxChars: 30000,
  collectConcurrency: 1,
  collectDelayMs: 1500,
  collectRenderWaitMs: 1200,
  idleCloseMs: 0,
  networkMaxEntries: 80,
  networkMaxBodyChars: 120000,
}

const manager = new BrowserManager(config)
let failed = false
try {
  const state = await manager.open({ url: 'https://www.qcc.com/', agentId: 'qcc-test' })
  await new Promise(resolve => setTimeout(resolve, 1800))
  const snapshot = await captureSnapshot(state.page, state.tabId, { maxChars: 14000 })
  console.log('--- QCC SNAPSHOT ---')
  console.log(snapshot.text.slice(0, 5000))
  console.log('CAPTCHA', snapshot.captcha, 'REFS', snapshot.refs.length)

  const shot1 = await manager.artifactPath('qcc-home.png', { ext: '.png', prefix: 'qcc' })
  await state.page.screenshot({ path: shot1, fullPage: false })
  console.log('SHOT', shot1)

  const extracted = await extractPage(state.page, { mode: 'text' })
  console.log('--- QCC TEXT ---')
  console.log(String(extracted.content).slice(0, 2500))

  if (!snapshot.captcha) {
    const input = snapshot.refs.find(ref => ['textbox', 'searchbox', 'combobox'].includes(ref.role))
    console.log('SEARCH INPUT', input?.ref, input?.name)
    if (input) {
      const locator = state.page.locator(`[data-dsh-ref="${input.ref}"]`)
      await locator.fill('阿里巴巴')
      await locator.press('Enter')
      await new Promise(resolve => setTimeout(resolve, 3500))
      const searchSnapshot = await captureSnapshot(state.page, state.tabId, { maxChars: 14000 })
      console.log('--- QCC SEARCH ---')
      console.log(searchSnapshot.text.slice(0, 5000))
      console.log('CAPTCHA', searchSnapshot.captcha, 'REFS', searchSnapshot.refs.length)
      const shot2 = await manager.artifactPath('qcc-search.png', { ext: '.png', prefix: 'qcc' })
      await state.page.screenshot({ path: shot2, fullPage: false })
      console.log('SHOT', shot2)
    }
  }
} catch (error) {
  failed = true
  console.error('QCC TEST FAILED', error)
} finally {
  await manager.dispose()
}
process.exit(failed ? 1 : 0)
