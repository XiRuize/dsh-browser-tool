import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { BrowserManager } from '../lib/manager.js'
import { registerBrowserTools } from '../lib/tools.js'
import { startLocalServer } from './live-server.mjs'

/**
 * 深度场景测试（v0.1 的 23 项核心断言，适配 v0.2 工具返回）。
 *
 * 默认跳过；显式开启真实 Edge：
 *   $env:DSH_BROWSER_E2E='1'; node test/deep.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = path.join(here, '.tmp')
const dirs = {
  profile: path.join(tmpRoot, 'deep-profile'),
  artifacts: path.join(tmpRoot, 'deep-artifacts'),
  downloads: path.join(tmpRoot, 'deep-downloads'),
}

if (process.env.DSH_BROWSER_E2E !== '1') {
  console.log('DEEP SKIPPED: 设置 DSH_BROWSER_E2E=1 后运行（会启动真实 Edge，默认 headless）。')
  process.exit(0)
}

function isSpawnBlocked(error) {
  const message = String(error?.message || error || '')
  return /EPERM|EACCES|access is denied|spawn .*EPERM|browserType\.launch: spawn|启动被系统拒绝/i.test(message)
}

function refFor(text, labelPart) {
  const lines = String(text || '').split('\n')
  const line = lines.find(item => item.includes(labelPart) && /@e\d+/.test(item))
  return line?.match(/@(e\d+)/)?.[1]
}

let failed = false
let skipped = false
let passed = 0
const FAILED_LABELS = []

function check(condition, label) {
  if (condition) {
    passed += 1
    console.log(`PASS ${label}`)
  } else {
    failed = true
    FAILED_LABELS.push(label)
    console.log(`FAIL ${label}`)
  }
}

let server = null
let manager = null
let step = '初始化'

try {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.mkdir(tmpRoot, { recursive: true })

  step = '启动本地测试服务'
  server = await startLocalServer()
  const base = server.base

  step = '构造配置与 BrowserManager'
  const config = resolveConfig({
    mode: 'launch',
    channel: 'msedge',
    executablePath: '',
    cdpUrl: '',
    visibility: 'headless',
    userDataDir: dirs.profile,
    artifactDir: dirs.artifacts,
    downloadsDir: dirs.downloads,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    actionTimeoutMs: 15000,
    navigationTimeoutMs: 45000,
    snapshotMaxChars: 12000,
    extractMaxChars: 30000,
    collectConcurrency: 2,
    collectDelayMs: 0,
    collectRenderWaitMs: 200,
    idleCloseMs: 0,
    networkMaxEntries: 80,
    networkMaxBodyChars: 120000,
  })
  manager = new BrowserManager(config)
  const tools = new Map()
  const fakeCtx = {
    effect: callback => callback(),
    tools: {
      register: definition => {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  registerBrowserTools(fakeCtx, manager, config)
  const signal = new AbortController().signal
  const call = async (name, args = {}) => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`工具未注册：${name}`)
    return tool.execute(args, { agent: { id: 'deep-test' }, signal })
  }

  step = 'open/type/click'
  const opened = await call('browser_open', { url: base })
  check(opened.snapshot.text.includes('测试科技有限公司'), 'open snapshot 包含标题')
  const inputRef = refFor(opened.snapshot.text, '[textbox]')
  const buttonRef = refFor(opened.snapshot.text, '查询')
  check(Boolean(inputRef && buttonRef), `找到输入框与按钮 ref（${inputRef}, ${buttonRef}）`)

  const typed = await call('browser_act', { action: 'type', ref: inputRef, value: '阿里巴巴' })
  check(
    typed.snapshot?.text?.length > 0 && typed.verify?.ok === true && typed.verify?.value === '阿里巴巴',
    'type 返回快照且回读 value',
  )
  const clicked = await call('browser_act', { action: 'click', ref: buttonRef })
  check(clicked.snapshot.text.includes('查询:阿里巴巴'), 'click 更新页面')

  step = 'extract tables/labeled/structured'
  const tables = await call('browser_extract', { mode: 'tables' })
  check(tables.data?.[0]?.rows?.some(row => row.includes('91310000TEST')), 'tables 提取信用代码')
  const labeled = await call('browser_extract', {
    mode: 'labeled',
    labels: ['统一社会信用代码', '法定代表人'],
  })
  check(labeled.data?.['统一社会信用代码'] === '91310000TEST', 'labeled 提取信用代码')
  check(labeled.data?.['法定代表人'] === '张三', 'labeled 提取法定代表人')

  const structured = await call('browser_extract', {
    mode: 'structured',
    fields: { name: 'h1', code: '.credit', link: { selector: 'a', attr: 'href' } },
  })
  check(structured.data?.name === '测试科技有限公司', 'structured 提取标题')
  check(String(structured.data?.link).startsWith(base), 'structured href 解析为绝对地址')

  step = 'iframe 快照与点击'
  const frameShot = await call('browser_snapshot', {})
  check(frameShot.snapshot.text.includes('[frame f1]'), 'iframe frame 标记')
  const iframeRef = refFor(frameShot.snapshot.text, 'iframe按钮')
  check(Boolean(iframeRef), `找到 iframe 内按钮 ref（${iframeRef}）`)
  if (iframeRef) {
    const iframeClick = await call('browser_act', { action: 'click', ref: iframeRef })
    check(iframeClick.ok === true, 'iframe 内点击')
  } else {
    check(false, 'iframe 内点击')
  }

  step = 'network 捕获'
  await call('browser_network', { action: 'start', urlPattern: '/api/' })
  await call('browser_act', { action: 'click', selector: '#load' })
  await new Promise(resolve => setTimeout(resolve, 800))
  const networkList = await call('browser_network', { action: 'list' })
  check(networkList.entries.some(entry => entry.url.includes('/api/company')), 'network 捕获 /api/company')
  const networkGet = await call('browser_network', { action: 'get', urlContains: '/api/company' })
  check(networkGet.record?.json?.creditCode === '91310000TEST', 'network 解析 JSON 响应')

  step = 'screenshot'
  const shot = await call('browser_screenshot', { path: 'deep-test.png', fullPage: false })
  check(shot.bytes > 1000, `screenshot ${shot.bytes} bytes`)

  step = 'tabs 新建/切换/关闭'
  const tabOpen = await call('browser_open', { url: `${base}/detail`, newTab: true })
  check(tabOpen.snapshot.text.includes('详情页'), '新标签页打开详情')
  const tabs = await call('browser_tabs', { action: 'list' })
  check(tabs.tabs.length >= 2, 'tabs list >= 2')
  const switched = await call('browser_tabs', { action: 'switch', tab: 't1' })
  check(switched.page.tab === 't1', '切换到 t1')
  await call('browser_tabs', { action: 'close' })
  check((await call('browser_tabs', { action: 'list' })).tabs.length >= 1, '关闭标签页后仍有页面')

  step = 'collect'
  const collected = await call('browser_collect', {
    urls: [`${base}/detail?a=1`, `${base}/detail?a=2`],
    mode: 'text',
    delayMs: 0,
    save: true,
  })
  check(collected.succeeded === 2, `collect 2 页（${collected.succeeded}/${collected.count}）`)
  check(Boolean(collected.savedPath), 'collect 保存 JSON')
  console.log('COLLECT', collected.savedPath)

  step = 'popup'
  await call('browser_open', { url: base })
  const popupSnap = await call('browser_snapshot', {})
  const popupRef = refFor(popupSnap.snapshot.text, '弹出详情')
  check(Boolean(popupRef), `找到弹窗 ref（${popupRef}）`)
  if (popupRef) {
    const popupClick = await call('browser_act', { action: 'click', ref: popupRef })
    const popupTabs = await call('browser_tabs', { action: 'list' })
    const active = popupTabs.tabs.find(tab => tab.active)
    check(popupClick.ok && Boolean(active?.url.includes('/detail?popup=1')), 'popup 新标签页成为 active')
  } else {
    check(false, 'popup 新标签页成为 active')
  }
} catch (error) {
  if (isSpawnBlocked(error)) {
    skipped = true
    console.log('')
    console.log('DEEP SKIPPED: browser spawn blocked by sandbox')
    console.log(`原因：${error?.message || error}`)
  } else {
    failed = true
    console.error('')
    console.error(`DEEP FAILED at step: ${step}`)
    console.error(error?.stack || error)
  }
} finally {
  try {
    await manager?.dispose()
  } catch (error) {
    if (!skipped) console.error('清理 BrowserManager 失败：', error)
  }
  try {
    await server?.close()
  } catch {
    /* ignore */
  }
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
}

console.log('')
if (skipped) {
  console.log('DEEP RESULT SKIPPED (browser spawn blocked by sandbox; 真实浏览器路径未验证)')
  process.exit(0)
}
console.log(`DEEP RESULT ${passed} PASS, ${FAILED_LABELS.length} FAIL`)
if (failed) {
  for (const label of FAILED_LABELS) console.log(`- FAIL ${label}`)
}
process.exit(failed ? 1 : 0)
