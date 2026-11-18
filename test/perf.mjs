import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'
import { registerBrowserTools } from '../lib/tools.js'
import { startLocalServer } from './live-server.mjs'

const root = path.join(os.tmpdir(), `perf-${Date.now()}`)
fs.mkdirSync(root, { recursive: true })
const server = await startLocalServer()
const config = resolveConfig({
  visibility: 'headless',
  userDataDir: path.join(root, 'profile'),
  artifactDir: path.join(root, 'artifacts'),
  downloadsDir: path.join(root, 'downloads'),
  siteToolsDir: path.join(root, 'site-tools'),
  actionHud: false,
})
const manager = new BrowserManager(config)
const tools = new Map()
registerBrowserTools(
  { effect: cb => cb(), tools: { register: def => { tools.set(def.name, def); return () => {} } } },
  manager,
  config,
)
const call = (name, args = {}, agent = 'perf') =>
  tools.get(name).execute(args, { agent: { id: agent }, signal: new AbortController().signal })

const rows = []
async function timed(label, fn) {
  const started = performance.now()
  const value = await fn()
  rows.push([label, Math.round(performance.now() - started)])
  return value
}

try {
  const boot = performance.now()
  const opened = await call('browser_open', { url: `${server.base}/` })
  rows.push(['初启 + 打开（含 Edge 冷启动）', Math.round(performance.now() - boot)])
  const tab = opened.page.tab

  await timed('open 热复用（同页再开）', () => call('browser_open', { url: `${server.base}/detail` }))
  await call('browser_open', { url: `${server.base}/`, tab })
  await timed('snapshot 全页', () => call('browser_snapshot', { tab }))
  await timed('snapshot 限定 selector=#t', () => call('browser_snapshot', { tab, selector: '#t' }))
  await timed('act scroll（auto 快照）', () => call('browser_act', { action: 'scroll', amount: 300, tab }))
  await timed('act scroll（snapshot=false）', () =>
    call('browser_act', { action: 'scroll', amount: 300, tab, snapshot: false }),
  )
  await timed('act click（auto 快照）', () => call('browser_act', { action: 'click', selector: '#go', tab }))
  await timed('extract text（body，3k）', () => call('browser_extract', { mode: 'text', maxChars: 3000, tab }))
  await timed('extract records（限定 #long-list）', () =>
    call('browser_extract', { mode: 'records', selector: '#long-list', itemSelector: 'li', fields: { text: '' }, limit: 50, tab }),
  )
  await timed('screenshot 视口', () => call('browser_screenshot', { path: 'perf-vp.png', tab }))
  await timed('screenshot 整页', () => call('browser_screenshot', { path: 'perf-full.png', fullPage: true, tab }))

  await call('browser_open', { url: `${server.base}/paged?page=1`, tab })
  const paged = await timed('paginate 3 页（records）', () =>
    call('browser_paginate', {
      tab,
      maxPages: 3,
      mode: 'records',
      selector: '#page-items',
      itemSelector: 'li.page-item',
      fields: { title: 'h3' },
      save: false,
    }),
  )
  rows.push(['  └ 每页均摊 ms', Math.round(paged.ms / Math.max(1, paged.totalPages))])

  const batch = await timed('batch：goto + 提取（一次调用）', () =>
    call('browser_batch', {
      tab,
      steps: [
        { action: 'goto', url: `${server.base}/paged?page=2`, label: '跳转第 2 页' },
        { action: 'extract', mode: 'records', selector: '#page-items', itemSelector: 'li.page-item', fields: { title: 'h3' }, label: '读取条目' },
      ],
    }),
  )
  rows.push(['  └ batch 条目数', batch.steps?.[1]?.extract?.data?.length ?? 0])

  console.table(rows)
} catch (error) {
  console.error('PERF FAIL', error?.message)
  console.table(rows)
} finally {
  await manager.dispose().catch(() => {})
  await server.close()
}
process.exit(0)
