import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserManager } from '../lib/manager.js'
import { registerBrowserTools } from '../lib/tools.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.resolve(here, '..', 'runtime')

const page = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>测试公司详情</title></head>
<body>
  <h1>测试科技有限公司</h1>
  <p class="credit">统一社会信用代码：91310000TEST</p>
  <label for="q">公司名称</label>
  <input id="q" placeholder="输入公司名称">
  <button id="go" onclick="document.getElementById('out').textContent='查询:'+document.getElementById('q').value">查询</button>
  <select id="sel"><option value="a">选项A</option><option value="b">选项B</option></select>
  <div id="out"></div>
  <table id="t"><caption>基本信息</caption><thead><tr><th>项目</th><th>值</th></tr></thead>
  <tbody><tr><td>统一社会信用代码</td><td>91310000TEST</td></tr><tr><td>法定代表人</td><td>张三</td></tr></tbody></table>
  <a href="/detail">详情链接</a>
  <a href="/detail?popup=1" target="_blank">弹出详情</a>
  <button id="load" onclick="fetch('/api/company').then(r=>r.text()).then(t=>document.getElementById('out').textContent=t)">加载接口</button>
  <iframe src="/frame" title="测试 frame"></iframe>
  <script>fetch('/api/bootstrap')</script>
</body></html>`

const detail = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>详情页</title></head><body>
<h1>详情页</h1><p>这是详情内容</p><table><tr><th>字段</th><th>值</th></tr><tr><td>状态</td><td>存续</td></tr></table></body></html>`

const frame = `<!doctype html><html><head><meta charset="utf-8"><title>Frame</title></head><body>
<button id="iframeBtn" onclick="document.body.insertAdjacentHTML('beforeend','<p>iframe 已点击</p>')">iframe按钮</button>
</body></html>`

const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1')
  if (url.pathname === '/api/company') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ name: '测试科技有限公司', creditCode: '91310000TEST' }))
    return
  }
  if (url.pathname === '/api/bootstrap') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (url.pathname === '/detail') response.end(detail)
  else if (url.pathname === '/frame') response.end(frame)
  else response.end(page)
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const config = {
  mode: 'launch',
  channel: 'msedge',
  executablePath: '',
  cdpUrl: '',
  headless: false,
  userDataDir: path.join(runtime, 'test-profile-deep'),
  artifactDir: path.join(runtime, 'test-artifacts-deep'),
  downloadsDir: path.join(runtime, 'test-downloads-deep'),
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  actionTimeoutMs: 15000,
  navigationTimeoutMs: 45000,
  snapshotMaxChars: 12000,
  extractMaxChars: 30000,
  collectConcurrency: 2,
  collectDelayMs: 100,
  collectRenderWaitMs: 350,
  idleCloseMs: 0,
  networkMaxEntries: 80,
  networkMaxBodyChars: 120000,
}

const manager = new BrowserManager(config)
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
const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} not registered`)
  return tool.execute(args, { agent: { id: 'deep-test' }, signal })
}

let failed = false
function check(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`)
  if (!condition) failed = true
}

function refFor(text, labelPart) {
  const lines = text.split('\n')
  const line = lines.find(item => item.includes(labelPart) && /@e\d+/.test(item))
  return line?.match(/@(e\d+)/)?.[1]
}

try {
  const opened = await call('browser_open', { url: base })
  check(opened.snapshot.text.includes('测试科技有限公司'), 'open snapshot has heading')
  const inputRef = refFor(opened.snapshot.text, '[textbox]')
  const buttonRef = refFor(opened.snapshot.text, '查询')
  check(Boolean(inputRef && buttonRef), `found input/button refs (${inputRef}, ${buttonRef})`)

  const typed = await call('browser_act', { action: 'type', ref: inputRef, value: '阿里巴巴' })
  check(typed.snapshot.text.length > 0, 'type returns snapshot')
  const clicked = await call('browser_act', { action: 'click', ref: buttonRef })
  check(clicked.snapshot.text.includes('查询:阿里巴巴'), 'click updates page')

  const tables = await call('browser_extract', { mode: 'tables' })
  check(tables.data?.[0]?.rows?.some(row => row.includes('91310000TEST')), 'tables extraction')
  const labeled = await call('browser_extract', {
    mode: 'labeled',
    labels: ['统一社会信用代码', '法定代表人'],
  })
  check(labeled.data?.['统一社会信用代码'] === '91310000TEST', 'labeled extraction code')
  check(labeled.data?.['法定代表人'] === '张三', 'labeled extraction legal representative')

  const structured = await call('browser_extract', {
    mode: 'structured',
    fields: { name: 'h1', code: '.credit', link: { selector: 'a', attr: 'href' } },
  })
  check(structured.data?.name === '测试科技有限公司', 'structured extraction name')
  check(String(structured.data?.link).startsWith(base), 'structured absolute href')

  const frameShot = await call('browser_snapshot', {})
  check(frameShot.snapshot.text.includes('[frame f1]'), 'iframe frame marker')
  const iframeRef = refFor(frameShot.snapshot.text, 'iframe按钮')
  check(Boolean(iframeRef), `found iframe ref (${iframeRef})`)
  if (iframeRef) {
    const iframeClick = await call('browser_act', { action: 'click', ref: iframeRef })
    check(iframeClick.ok, 'iframe click')
  }

  await call('browser_network', { action: 'start', urlPattern: '/api/' })
  const loadRef = refFor((await call('browser_snapshot', {})).snapshot.text, '加载接口')
  await call('browser_act', { action: 'click', ref: loadRef })
  await new Promise(resolve => setTimeout(resolve, 600))
  const networkList = await call('browser_network', { action: 'list' })
  check(networkList.entries.some(entry => entry.url.includes('/api/company')), 'network capture list')
  const networkGet = await call('browser_network', { action: 'get', urlContains: '/api/company' })
  check(networkGet.record.json?.creditCode === '91310000TEST', 'network JSON body')

  const shot = await call('browser_screenshot', { path: 'deep-test.png', fullPage: false })
  check(shot.bytes > 1000, `screenshot ${shot.bytes} bytes`)

  const tabOpen = await call('browser_open', { url: `${base}/detail`, newTab: true })
  check(tabOpen.snapshot.text.includes('详情页'), 'new tab open')
  const tabs = await call('browser_tabs', { action: 'list' })
  check(tabs.tabs.length >= 2, 'tabs list')
  const switched = await call('browser_tabs', { action: 'switch', tab: 't1' })
  check(switched.page.tab === 't1', 'switch tab')
  await call('browser_tabs', { action: 'close' })
  check((await call('browser_tabs', { action: 'list' })).tabs.length >= 1, 'close tab')

  const collected = await call('browser_collect', {
    urls: [`${base}/detail?a=1`, `${base}/detail?a=2`],
    mode: 'text',
  })
  check(collected.succeeded === 2, `collect 2 pages (${collected.succeeded}/${collected.count})`)
  check(Boolean(collected.savedPath), 'collect saved JSON')
  console.log('COLLECT', collected.savedPath)

  await call('browser_open', { url: base })
  const popupSnap = await call('browser_snapshot', {})
  const popupRef = refFor(popupSnap.snapshot.text, '弹出详情')
  check(Boolean(popupRef), `found popup ref (${popupRef})`)
  if (popupRef) {
    const popupClick = await call('browser_act', { action: 'click', ref: popupRef })
    const popupTabs = await call('browser_tabs', { action: 'list' })
    const active = popupTabs.tabs.find(tab => tab.active)
    console.log('POPUP', JSON.stringify({ resultPage: popupClick.page, tabs: popupTabs.tabs }, null, 2))
    check(popupClick.ok && active?.url.includes('/detail?popup=1'), 'popup tab becomes active')
  }
} catch (error) {
  failed = true
  console.error('DEEP TEST FAILED', error)
} finally {
  await manager.dispose()
  server.close()
}

process.exit(failed ? 1 : 0)
