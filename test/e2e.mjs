import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig } from '../lib/config.js'
import { BrowserManager } from '../lib/manager.js'
import { registerBrowserTools } from '../lib/tools.js'
import { startLocalServer } from './live-server.mjs'

/**
 * 真实 Edge 端到端测试（显式开启）。
 *
 * 默认跳过，避免 CI / 桌面环境被浏览器窗口干扰：
 *   node test/e2e.mjs
 *   $env:DSH_BROWSER_E2E='1'; node test/e2e.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = path.join(here, '.tmp')
const dirs = {
  profile: path.join(tmpRoot, 'e2e-profile'),
  artifacts: path.join(tmpRoot, 'e2e-artifacts'),
  downloads: path.join(tmpRoot, 'e2e-downloads'),
}

if (process.env.DSH_BROWSER_E2E !== '1') {
  console.log('E2E SKIPPED: 设置 DSH_BROWSER_E2E=1 后运行（会启动真实 Edge，默认 headless）。')
  process.exit(0)
}

function isSpawnBlocked(error) {
  const message = String(error?.message || error || '')
  return /EPERM|EACCES|access is denied|spawn .*EPERM|browserType\.launch: spawn|启动被系统拒绝/i.test(message)
}

let assertions = 0
function check(condition, label, details = '') {
  assertions += 1
  if (!condition) {
    throw new Error(`断言失败：${label}${details ? `（${details}）` : ''}`)
  }
  console.log(`PASS ${label}`)
}

let step = '初始化'
let server = null
let manager = null
let skipped = false
let failed = false

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
    collectConcurrency: 3,
    collectDelayMs: 0,
    collectRenderWaitMs: 200,
    idleCloseMs: 0,
    maxTabs: 24,
    allowEval: false,
    allowAbsoluteArtifacts: false,
  })
  check(config.visibility === 'headless', 'resolveConfig 使用 headless')
  check(config.idleCloseMs === 0, 'idleCloseMs=0')
  // 站点工具清单放到临时目录，避免污染真实 ~/.dsh/browser-tool/site-tools。
  config.siteToolsDir = path.join(tmpRoot, 'site-tools-e2e')

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
  const call = async (name, args = {}, agentId = 'e2e-lead') => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`工具未注册：${name}`)
    return tool.execute(args, { agent: { id: agentId }, signal })
  }

  step = 'browser_status 初始状态'
  const status0 = await call('browser_status')
  check(status0.ok === true, 'browser_status 返回 ok')
  check(status0.artifactDir === config.artifactDir, 'browser_status 返回 artifactDir')
  check(status0.visibility === 'headless', 'browser_status 报告 headless')

  step = 'browser_open headless 打开页面'
  const opened = await call('browser_open', { url: base })
  check(opened.ok === true, 'browser_open 返回 ok')
  check(opened.snapshot.text.includes('测试科技有限公司'), 'open snapshot 包含标题')
  check(Array.isArray(opened.snapshot.refs) && opened.snapshot.refs.length > 0, 'open snapshot 生成 refs')
  check(opened.page.url === base || opened.page.url.startsWith(base), 'open 返回页面 URL')
  const mainTab = opened.page.tab

  step = 'browser_observe structure/text/meta'
  const observed = await call('browser_read', { source: 'observe', layers: ['structure', 'text', 'meta'], tab: mainTab })
  check(Boolean(observed.layers.structure?.text), 'observe structure 层有文本')
  check(observed.layers.text?.text.includes('测试科技有限公司'), 'observe text 层包含正文')
  check(observed.layers.meta?.title.includes('测试公司详情'), 'observe meta 层包含标题')
  check(observed.layers.meta?.counts?.tables >= 1, 'observe meta 统计表格')

  step = 'browser_inspect overview/dom/html/css/a11y/resources'
  const overview = await call('browser_read', { source: 'inspect', mode: 'overview', tab: mainTab })
  check(overview.page?.title.includes('测试公司详情'), 'inspect overview 标题')
  check(overview.counts?.tables >= 1, 'inspect overview 统计表格')
  const dom = await call('browser_read', { source: 'inspect', mode: 'dom', selector: 'body', tab: mainTab })
  check(dom.count > 0 && /input|table|button/.test(dom.text), 'inspect dom 返回节点树')
  const html = await call('browser_read', { source: 'inspect', mode: 'html', fullPage: true, tab: mainTab })
  check(html.html.includes('<h1') && html.html.includes('测试科技有限公司'), 'inspect html 返回 outerHTML')
  const css = await call('browser_read', { source: 'inspect', mode: 'css', selector: '#q', tab: mainTab })
  check(Boolean(css.styles?.['font-size'] || css.styles?.display), 'inspect css 返回 computed styles')
  const a11y = await call('browser_read', { source: 'inspect', mode: 'a11y', selector: 'body', tab: mainTab })
  check(typeof a11y.yaml === 'string' && (a11y.yaml.length > 0 || a11y.rows.length > 0), 'inspect a11y 返回 aria 快照')
  const resources = await call('browser_read', { source: 'inspect', mode: 'resources', tab: mainTab })
  check(Array.isArray(resources.entries) && resources.count >= 1, 'inspect resources 返回资源列表')

  step = 'browser_extract tables/labeled/markdown/forms'
  const tables = await call('browser_read', { source: 'extract', mode: 'tables', tab: mainTab })
  check(tables.data?.[0]?.rows?.some(row => row.includes('91310000TEST')), 'extract tables 包含信用代码')
  const labeled = await call('browser_read', { source: 'extract',
    mode: 'labeled',
    labels: ['统一社会信用代码', '法定代表人', '注册资本'],
    tab: mainTab,
  })
  check(labeled.data?.['统一社会信用代码'] === '91310000TEST', 'extract labeled 信用代码')
  check(labeled.data?.['法定代表人'] === '张三', 'extract labeled 法定代表人')
  check(labeled.data?.['注册资本'] === '1000万元', 'extract labeled 注册资本')
  const markdown = await call('browser_read', { source: 'extract', mode: 'markdown', tab: mainTab })
  check(markdown.content.includes('# 测试科技有限公司'), 'extract markdown 标题')
  const forms = await call('browser_read', { source: 'extract', mode: 'forms', tab: mainTab })
  check(forms.data?.[0]?.fields?.some(field => field.name === 'q'), 'extract forms 包含输入字段')

  step = 'browser_act type/click/select/check 并回读核验'
  const typed = await call('browser_act', { action: 'type', selector: '#q', value: '阿里巴巴', tab: mainTab })
  check(typed.verify?.ok === true, 'act type verify.ok')
  check(typed.verify?.value === '阿里巴巴', 'act type 回读 value')
  const clicked = await call('browser_act', { action: 'click', selector: '#go', tab: mainTab })
  check(clicked.snapshot?.text.includes('查询:阿里巴巴'), 'act click 更新页面')
  const selected = await call('browser_act', { action: 'select', selector: '#sel', value: 'b', tab: mainTab })
  check(
    selected.verify?.ok === true &&
      selected.verify?.value === 'b' &&
      JSON.stringify(selected.verify?.selected) === JSON.stringify(['选项B']),
    'act select 回读 value 与 label',
  )
  const checked = await call('browser_act', { action: 'check', selector: '#agree', tab: mainTab })
  check(checked.verify?.ok === true && checked.verify?.checked === true, 'act check 回读 checked')

  step = '消歧：重复文字按钮与容器限定选项'
  const duplicated = await call('browser_act', {
    action: 'click',
    text: '确认',
    container: '#containerB',
    tab: mainTab,
  })
  check(duplicated.verify?.ok === true && duplicated.snapshot?.text.includes('B'), 'container 限定重复文字按钮')
  const containerSelect = await call('browser_act', {
    action: 'select',
    selector: '.pick',
    container: '#wrapB',
    value: 'b2',
    tab: mainTab,
  })
  check(
    containerSelect.verify?.ok === true &&
      containerSelect.verify?.value === 'b2' &&
      JSON.stringify(containerSelect.verify?.selected) === JSON.stringify(['选项B2']),
    'container 限定重复选项 select（value + label）',
  )

  step = 'contenteditable 覆盖填写：不残留旧文本、保留换行'
  const richTyped = await call('browser_act', {
    action: 'type',
    selector: '#rich',
    value: '第一行\n第二行',
    tab: mainTab,
  })
  check(richTyped.verify?.ok === true, 'contenteditable type verify.ok')
  check(/逐行输入/.test(String(richTyped.message || '')), 'contenteditable 走逐行输入路径')
  const richValue = String(richTyped.verify?.value || '')
  check(richValue.includes('第一行') && richValue.includes('第二行'), 'contenteditable 两行都写入')
  check(!richValue.includes('残留文本'), 'contenteditable 覆盖后不残留旧文本')

  step = '文本多命中：优先弹出层内的选项，而不是同名的段落文字'
  const picked = await call('browser_act', { action: 'click', text: '贵州茅台', tab: mainTab })
  check(picked.target?.pickReason === '弹出层内', '文本多命中按弹出层排序')
  check(picked.snapshot?.text.includes('option-hit'), '点到的是 listbox 选项而非段落')

  step = '人机验证提示：隐藏 iframe 不误报，主页面拦截页才报'
  const cleanSnap = await call('browser_snapshot', { tab: mainTab })
  check(cleanSnap.snapshot?.captcha !== true, '隐形验证 iframe 不触发人机验证提示')
  await call('browser_open', { url: `${base}/verify`, tab: mainTab })
  const verifySnap = await call('browser_snapshot', { tab: mainTab })
  check(verifySnap.snapshot?.captcha === true, '主页面验证拦截页仍会提示')
  await call('browser_open', { url: `${base}/`, tab: mainTab })

  step = '验证码交接：识别类型 + waitForHuman 只等不代答'
  const captchaOpen = await call('browser_open', { url: `${base}/captcha`, tab: mainTab })
  check(captchaOpen.humanCheck?.detected === true, 'open 返回 humanCheck')
  check(captchaOpen.humanCheck?.kind === 'recaptcha', 'humanCheck 认出 reCAPTCHA')
  check(String(captchaOpen.message || '').includes('reCAPTCHA'), 'message 里点名验证类型')
  check(
    Array.isArray(captchaOpen.humanCheck?.steps) && captchaOpen.humanCheck.steps.some(s => s.includes('waitForHuman')),
    'humanCheck 给出 waitForHuman 下一步',
  )
  const stillStuck = await call('browser_act', { action: 'waitForHuman', timeoutMs: 3000, tab: mainTab })
  check(stillStuck.verify?.ok === false, '验证还在时 waitForHuman 不算成功')
  check(stillStuck.verify?.humanCheck?.resolved === false, 'waitForHuman 报 resolved=false')
  check(/不要尝试自动绕过|人工完成/.test(String(stillStuck.message || '')), 'waitForHuman 提示不要自动绕过')

  await call('browser_open', { url: `${base}/`, tab: mainTab })
  const cleared = await call('browser_act', { action: 'waitForHuman', timeoutMs: 5000, tab: mainTab })
  check(cleared.verify?.ok === true, '无验证码时 waitForHuman 直接通过')
  check(cleared.verify?.humanCheck?.resolved === true, 'waitForHuman 报 resolved=true')

  step = 'browser_batch 多步动作 + extract（一次调用）'
  const batched = await call('browser_act', {
    label: 'E2E 批量',
    tab: mainTab,
    steps: [
      { action: 'type', selector: '#q', value: '批量测试', label: '填写公司名' },
      { action: 'click', selector: '#go', label: '点击查询' },
      { action: 'extract', mode: 'text', selector: '#out', label: '读取结果' },
    ],
  })
  check(batched.ok === true && batched.steps.length === 3, 'batch 返回 3 步')
  check(batched.steps.every(item => item.ok), 'batch 全部步骤成功')
  check(batched.extract?.text?.includes('查询:批量测试'), 'batch extract 读到动作结果')
  check(batched.ms > 0, 'batch 返回耗时')

  let batchFailure = null
  try {
    await call('browser_act', {
      tab: mainTab,
      steps: [{ action: 'click', selector: '#go' }, { action: 'click', selector: '#not-exist-e2e' }],
    })
  } catch (error) {
    batchFailure = String(error?.message || error)
  }
  check(
    /第 2\/2 步/.test(batchFailure || '') && /已完成 1 步/.test(batchFailure || ''),
    'batch 失败即停并带回已完成步骤',
  )

  step = '显性表示：headless 不注入 HUD'
  const headlessPage = await manager.resolvePage('active', 'e2e-lead')
  const headlessHud = await headlessPage.page.evaluate(() => Boolean(document.querySelector('[data-dsh-hud]')))
  check(headlessHud === false, 'headless 模式不注入 HUD')

  step = 'browser_paginate 自动识别下一页并抓多页'
  const pagedOpened = await call('browser_open', { url: `${base}/paged?page=1`, newTab: true })
  const pagedTab = pagedOpened.page.tab
  const paged = await call('browser_paginate', {
    tab: pagedTab,
    maxPages: 5,
    mode: 'records',
    selector: '#page-items',
    itemSelector: 'li.page-item',
    fields: { title: 'h3', link: { selector: 'a', attr: 'href' } },
  })
  check(paged.totalPages === 3, 'paginate 抓到 3 页')
  check(paged.items.length === 9, 'paginate 合并 9 条')
  check(paged.stoppedReason === 'no-next', 'paginate 在无下一页时停止')
  check((paged.pages[2]?.title || '').includes('第3页'), 'paginate 第 3 页标题正确')
  check(Boolean(paged.savedPath), 'paginate 把完整结果落盘')

  const pagedLimited = await call('browser_paginate', {
    tab: pagedTab,
    maxPages: 1,
    mode: 'text',
    selector: '#page-items',
  })
  check(pagedLimited.totalPages === 1 && pagedLimited.stoppedReason === 'max-pages', 'paginate 按 maxPages 提前停止')

  step = 'browser_site 站点工具注册表（list/match/run）'
  const siteDir = config.siteToolsDir
  await fs.mkdir(siteDir, { recursive: true })
  await fs.writeFile(
    path.join(siteDir, 'local-jobs.json'),
    JSON.stringify({
      id: 'local-jobs',
      name: '本地分页列表',
      match: ['/paged'],
      tools: {
        rows: {
          description: '抓分页列表条目',
          mode: 'records',
          selector: '#page-items',
          itemSelector: 'li.page-item',
          fields: { title: 'h3' },
        },
      },
    }),
    'utf8',
  )
  const siteList = await call('browser_site', { action: 'list' })
  check(siteList.sites.some(site => site.id === 'qq-forum' && site.source === 'builtin'), 'site list 含内置 qq-forum')
  check(siteList.sites.some(site => site.id === 'local-jobs'), 'site list 含清单工具')
  const siteMatch = await call('browser_site', { action: 'match', url: `${base}/paged?page=1` })
  check(siteMatch.matches.some(site => site.id === 'local-jobs'), 'site match 命中清单站点')
  const siteRun = await call('browser_site', { action: 'run', siteId: 'local-jobs', tool: 'rows', tab: pagedTab })
  check(siteRun.count === 3, 'site run 清单工具返回 3 条')
  check(/第\d页条目/.test(JSON.stringify(siteRun.extract?.data || '')), 'site run 返回条目内容')
  let siteUnknown = ''
  try {
    await call('browser_site', { action: 'run', siteId: 'nope', tool: 'rows' })
  } catch (error) {
    siteUnknown = String(error?.message || error)
  }
  check(/没有找到站点工具/.test(siteUnknown), 'site run 未知站点给出可读错误')

  step = 'browser_screenshot'
  const shot = await call('browser_read', { source: 'screenshot', path: 'e2e-shot.png', fullPage: false, tab: mainTab })
  check(shot.bytes > 1000, `screenshot 字节数 ${shot.bytes}`)
  check(shot.path.startsWith(config.artifactDir), 'screenshot 路径位于 artifactDir')
  const stat = await fs.stat(shot.path)
  check(stat.size === shot.bytes, 'screenshot 文件实际大小一致')

  step = 'browser_network start/list/get/export'
  await call('browser_network', { action: 'start', urlPattern: '/api/', tab: mainTab })
  await call('browser_act', { action: 'click', selector: '#load', tab: mainTab })
  await new Promise(resolve => setTimeout(resolve, 800))
  const networkList = await call('browser_network', { action: 'list', tab: mainTab })
  check(networkList.entries.some(entry => entry.url.includes('/api/company')), 'network list 捕获 /api/company')
  const networkGet = await call('browser_network', { action: 'get', urlContains: '/api/company', tab: mainTab })
  check(networkGet.record?.json?.creditCode === '91310000TEST', 'network get 解析 JSON 响应')
  const har = await call('browser_network', { action: 'export', tab: mainTab })
  check(har.entryCount >= 1 && Boolean(har.harPath), 'network export 返回 HAR 路径')
  check(har.harPath.startsWith(config.artifactDir), 'HAR 路径位于 artifactDir')
  const harStat = await fs.stat(har.harPath)
  check(harStat.size > 100, 'HAR 文件非空')

  step = 'browser_fetch 快通道 + records 数组提取 + collect render=false'
  const fetched = await call('browser_fetch', { url: `${base}/api/company` })
  check(fetched.status === 200 && fetched.json?.creditCode === '91310000TEST', 'fetch 直连 JSON 接口')
  check(fetched.blocked === false, 'fetch 未误判风控')
  const cachedFetch = await call('browser_fetch', { url: `${base}/api/company` })
  check(cachedFetch.cached === true && String(cachedFetch.body).includes('91310000TEST'), 'fetch 命中内容缓存')
  const refreshedFetch = await call('browser_fetch', { url: `${base}/api/company`, refresh: true })
  check(refreshedFetch.cached !== true, 'fetch refresh 绕过缓存')
  await call('browser_open', { url: `${base}/list`, tab: mainTab })
  const records = await call('browser_read', { source: 'extract',
    mode: 'records',
    itemSelector: '.item',
    fields: {
      title: '.item-title',
      author: '.item-author',
      link: { selector: '.item-link', attr: 'href' },
    },
  })
  check(records.matches === 5 && records.data?.length === 5, 'records 一次返回 5 条')
  check(records.data[0].author === '作者1', 'records 字段相对列表项解析')
  check(String(records.data[0].link).includes('/detail'), 'records 支持 attr 取链接')
  const httpCollect = await call('browser_collect', {
    urls: [`${base}/detail?h=1`, `${base}/detail?h=2`, `${base}/detail?h=3`],
    mode: 'text',
    render: false,
    save: false,
    jobId: 'e2e-http',
  })
  check(
    httpCollect.count === 3 && httpCollect.succeeded === 3 && httpCollect.results.every(item => item.via === 'http'),
    'collect render=false 走 HTTP 快通道',
  )

  const scratchCollect = await call('browser_collect', {
    urls: [`${base}/detail?s=1`, `${base}/detail?s=2`],
    mode: 'text',
    render: false,
    scratch: true,
    save: false,
    jobId: 'e2e-scratch',
  })
  check(Boolean(scratchCollect.scratchJobId), 'collect scratch 返回 scratchJobId')
  check(scratchCollect.scratchCleared === true, 'collect scratch 结束后自动清理')
  check(scratchCollect.succeeded === 2, 'collect scratch 采集成功')
  const scratchStats = await call('browser_scratch', { action: 'stats' })
  check(Array.isArray(scratchStats.jobs), 'browser_scratch stats 返回任务列表')

  await call('browser_open', { url: `${base}/`, tab: mainTab })
  const dev = await call('browser_devtools', { action: 'capture', tab: mainTab, clean: true, keep: true, maxChars: 2000 })
  check(Boolean(dev.jobId) && dev.files.length >= 2, 'devtools capture 写入暂存区')
  check(dev.cleaned && dev.cleaned.stats.scripts >= 1, 'devtools capture 去掉脚本')
  check(String(dev.cleaned?.text || '').length > 0, 'devtools capture 返回清洗正文')
  const devManifest = await call('browser_devtools', { action: 'manifest', jobId: dev.jobId })
  check(devManifest.files.some(file => file.name.endsWith('cleaned.html')), 'devtools manifest 含 cleaned.html')
  const devClean = await call('browser_devtools', { action: 'clean', jobId: dev.jobId })
  check(Boolean(devClean.stats) && typeof devClean.text === 'string', 'devtools clean 可二次清洗')
  const devClear = await call('browser_devtools', { action: 'clear', jobId: dev.jobId })
  check(devClear.cleared === dev.jobId, 'devtools clear 删除暂存')

  step = 'browser_collect cursor 续跑（120 URL）'
  const collectUrls = Array.from({ length: 120 }, (_, index) => `${base}/detail?n=${index + 1}`)
  const collectArgs = {
    urls: collectUrls,
    mode: 'text',
    jobId: 'e2e-collect',
    save: true,
    delayMs: 0,
    concurrency: 3,
  }
  const firstCollect = await call('browser_collect', collectArgs)
  check(firstCollect.done === false, 'collect 首次未完成')
  check(
    firstCollect.nextCursor === 100,
    `collect 首次 nextCursor=100（实际 ${firstCollect.nextCursor}, count ${firstCollect.count}, done ${firstCollect.done}, stopped ${firstCollect.stoppedReason}）`,
  )
  check(firstCollect.count === 100 && firstCollect.succeeded === 100, 'collect 首次完成 100 条')
  const secondCollect = await call('browser_collect', collectArgs)
  check(secondCollect.done === true, 'collect 续跑后完成')
  check(secondCollect.count === 20 && secondCollect.succeeded === 20, 'collect 续跑完成剩余 20 条')
  const thirdCollect = await call('browser_collect', collectArgs)
  check(thirdCollect.count === 0 && thirdCollect.done === true, 'collect 第三次不重复处理')
  const checkpoint = JSON.parse(await fs.readFile(thirdCollect.checkpointPath, 'utf8'))
  check(checkpoint.doneUrls.length === 120, 'collect checkpoint doneUrls=120')
  check(Boolean(thirdCollect.savedPath), 'collect 保存结果 JSON')

  step = 'browser_workspace create/join/status 与 reader 写拒绝'
  const workspace = await call('browser_workspace', { action: 'create', label: 'e2e 工作区' })
  check(Boolean(workspace.workspace?.id) && workspace.workspace.role === 'writer', 'workspace create 返回 writer 工作区')
  const workspaceId = workspace.workspace.id
  const wsOpened = await call('browser_open', {
    url: `${base}/detail`,
    newTab: true,
    workspaceId,
  })
  check(Boolean(wsOpened.page?.tab), 'open 到工作区标签页')
  const wsTab = wsOpened.page.tab
  const claimed = await call('browser_tabs', { action: 'claim', tab: wsTab })
  check(claimed.claimed === wsTab, 'browser_tabs claim 绑定工作区')
  const joined = await call('browser_workspace', { action: 'join', workspaceId, role: 'reader' }, 'e2e-reader')
  check(joined.workspace.members.length === 2, 'workspace join 增加 reader 成员')
  const workspaceStatus = await call('browser_workspace', { action: 'status' })
  check(
    workspaceStatus.workspace?.id === workspaceId && workspaceStatus.workspace?.role === 'writer',
    'workspace status 报告角色',
  )

  let readerDenied = false
  try {
    await call('browser_act', { action: 'click', selector: '#go', tab: wsTab }, 'e2e-reader')
  } catch (error) {
    readerDenied = /只读成员|reader|不能对标签页/.test(String(error?.message || error))
  }
  check(readerDenied, 'reader 写操作被拒绝')

  const closedWorkspace = await call('browser_workspace', { action: 'close', workspaceId, closeTabs: true })
  check(closedWorkspace.workspaceId === workspaceId, 'workspace close 返回 id')
  check(closedWorkspace.closedTabs.includes(wsTab), 'workspace closeTabs 关闭工作区标签页')

  step = 'browser_show 静默/非静默切换'
  const showStatus = await call('browser_show', { action: 'status' })
  check(showStatus.visibility === 'headless' && showStatus.headless === true, 'show status 报告 headless')
  const toWindow = await call('browser_show', { action: 'set', visibility: 'window', restoreTabs: false })
  check(toWindow.changed === true && toWindow.visibility === 'window', 'show set 切到 window')

  step = '显性表示：window 模式注入 HUD 且快照不污染'
  const hudOpened = await call('browser_open', { url: base, newTab: true })
  const hudTab = hudOpened.page.tab
  await call('browser_act', {
    action: 'type',
    selector: '#q',
    value: '角标',
    label: '窗口模式角标',
    tab: hudTab,
  })
  const hudPage = await manager.resolvePage(hudTab, 'e2e-lead')
  const hudInfo = await hudPage.page.evaluate(() => {
    const host = document.querySelector('[data-dsh-hud]')
    if (!host) return null
    return {
      shadow: Boolean(host.shadowRoot),
      text: host.shadowRoot?.querySelector('.txt')?.textContent || '',
    }
  })
  check(Boolean(hudInfo), 'window 模式注入 HUD')
  check(hudInfo?.shadow === true, 'HUD 使用 Shadow DOM 隔离样式')
  check((hudInfo?.text || '').includes('窗口模式角标'), 'HUD 显示动作 label')
  const hudSnapshot = await call('browser_snapshot', { tab: hudTab })
  check(!hudSnapshot.snapshot.text.includes('窗口模式角标'), '快照不包含 HUD 文本')

  const shown = await call('browser_show', { action: 'show' })
  check(shown.shown === true, 'show 把窗口拉到前台')
  const hidden = await call('browser_show', { action: 'hide' })
  check(hidden.shown === false, 'hide 把窗口移出屏幕')
  const bounds = await call('browser_show', { action: 'status' })
  check(bounds.visibility === 'window' && bounds.bounds?.left <= -1000, 'status 报告窗口已移出屏幕')
  const backToHeadless = await call('browser_show', { action: 'set', visibility: 'headless', restoreTabs: false })
  check(backToHeadless.visibility === 'headless', 'show set 切回 headless')

  step = 'browser_status / browser_tabs 最终状态'
  const status = await call('browser_status')
  check(status.loaded === true && status.connected === true, 'browser_status loaded/connected')
  check(status.tabs.length >= 1, 'browser_status 返回标签页')
  const tabs = await call('browser_tabs', { action: 'list' })
  check(tabs.tabs.length >= 1, 'browser_tabs list 返回标签页')
} catch (error) {
  if (isSpawnBlocked(error)) {
    skipped = true
    console.log('')
    console.log('E2E SKIPPED: browser spawn blocked by sandbox')
    console.log(`原因：${error?.message || error}`)
  } else {
    failed = true
    console.error('')
    console.error(`E2E FAILED at step: ${step}`)
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
  console.log('E2E RESULT SKIPPED (browser spawn blocked by sandbox; 真实浏览器路径未验证)')
  process.exit(0)
}
console.log(`E2E RESULT ${failed ? 'FAIL' : 'PASS'} (${assertions} assertions)`)
process.exit(failed ? 1 : 0)
