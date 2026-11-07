import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from '../lib/manager.js'
import { captureSnapshot } from '../lib/snapshot.js'
import { extractPage } from '../lib/extract.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.join(here, '.tmp')
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
  snapshotMaxChars: 16000,
  extractMaxChars: 40000,
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
  const state = await manager.open({
    url: 'https://www.qcc.com/firm/d16c2bd99af50fd41b805e321d5510b9.html',
    agentId: 'qcc-detail',
  })
  await new Promise(resolve => setTimeout(resolve, 1800))
  const snapshot = await captureSnapshot(state.page, state.tabId, { maxChars: 16000 })
  console.log('--- QCC DETAIL SNAPSHOT ---')
  console.log(snapshot.text.slice(0, 6000))
  console.log('CAPTCHA', snapshot.captcha, 'REFS', snapshot.refs.length)

  const shot = await manager.artifactPath('qcc-detail.png', { ext: '.png', prefix: 'qcc' })
  await state.page.screenshot({ path: shot, fullPage: false })
  console.log('SHOT', shot)

  const text = await extractPage(state.page, { mode: 'text' })
  console.log('--- QCC DETAIL TEXT ---')
  console.log(String(text.content).slice(0, 5000))

  const labeled = await extractPage(state.page, {
    mode: 'labeled',
    labels: ['统一社会信用代码', '法定代表人', '注册资本', '成立日期', '地址', '登记状态', '企业名称'],
  })
  console.log('--- QCC LABELED ---')
  console.log(JSON.stringify(labeled.data, null, 2))

  const structured = await extractPage(state.page, {
    mode: 'structured',
    fields: {
      title: 'h1',
    },
  })
  console.log('--- QCC STRUCTURED ---')
  console.log(JSON.stringify(structured.data, null, 2))
} catch (error) {
  failed = true
  console.error('QCC DETAIL FAILED', error)
} finally {
  await manager.dispose()
}
process.exit(failed ? 1 : 0)
