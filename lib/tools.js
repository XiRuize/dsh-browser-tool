import fs from 'node:fs/promises'
import {
  boundExtractResult,
  extractPage,
} from './extract.js'
import { NetworkRecorder } from './network.js'
import { captureSnapshot } from './snapshot.js'
import {
  clamp,
  firstLine,
  formatBytes,
  jsonPretty,
  normalizeUrl,
  sleep,
} from './util.js'

const BLOCK_RE =
  /验证码|人机验证|安全验证|滑动验证|拖动滑块|访问受限|访问被阻断|异常访问|访问过于频繁|请求过于频繁|安全威胁|405错误|WAF|captcha/i

function objectArgs(args) {
  return args && typeof args === 'object' && !Array.isArray(args) ? args : {}
}

function intValue(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

function assertNotAborted(exec) {
  if (exec?.signal?.aborted) throw new Error('操作已取消。')
}

function timeoutOf(args, config, fallback = 60000) {
  return intValue(args.timeoutMs, config.actionTimeoutMs || fallback, 1000, 180000)
}

function tabParam(description = '目标标签页 ID（如 t1）。省略时使用当前会话的活动标签页。') {
  return { type: 'string', description }
}

function requiredTab(action) {
  if (!action) throw new Error('必须提供 tab。可先调用 browser_tabs 查看标签页。')
  return action
}

function snapshotTail(value) {
  const parts = []
  if (value.message) parts.push(value.message)
  if (value.warning) parts.push(`提示：${value.warning}`)
  if (value.dialog) parts.push(`对话框（${value.dialog.type}）：${value.dialog.message}`)
  if (value.snapshot?.text) parts.push(value.snapshot.text)
  return parts.join('\n\n')
}

async function resolveTarget(manager, page, args, { forText = false } = {}) {
  const ref = String(args.ref ?? '').replace(/^@/, '')
  if (ref) {
    const entry = manager.getRefs(page).get(ref)
    if (!entry) {
      throw new Error(`引用 @${ref} 不存在或已失效。页面可能已变化，请重新调用 browser_snapshot。`)
    }
    let locator = page
    for (const frameSelector of entry.frameChain || []) {
      locator = locator.frameLocator(frameSelector)
    }
    const target = locator.locator(`[data-dsh-ref="${ref}"]`)
    const count = await target.count().catch(() => 0)
    if (count === 0) {
      throw new Error(`引用 @${ref} 已失效（元素不在页面中）。请重新调用 browser_snapshot。`)
    }
    return {
      locator: target.first(),
      label: `@${ref}${entry.name ? ` ${entry.name}` : ''}`,
      count,
    }
  }
  if (args.selector) {
    const target = page.locator(String(args.selector))
    const count = await target.count().catch(() => 0)
    if (count === 0) throw new Error(`未找到匹配 selector 的元素：${args.selector}`)
    return { locator: target.first(), label: `selector ${args.selector}`, count }
  }
  if (forText && args.text) {
    const target = page.getByText(String(args.text), { exact: false })
    const count = await target.count().catch(() => 0)
    if (count === 0) throw new Error(`未找到包含文本 "${args.text}" 的元素。`)
    return { locator: target.first(), label: `文本 "${args.text}"`, count }
  }
  throw new Error('这个动作需要一个 ref、selector 或（点击时）text 来定位元素。先调用 browser_snapshot 获取 ref。')
}

async function snapshotForTool(manager, state, config, { maxChars, interactiveOnly = false } = {}) {
  const options = {
    maxChars: maxChars ?? Math.min(config.snapshotMaxChars || 12000, 12000),
    maxElements: 280,
    interactiveOnly,
  }
  let snapshot = await captureSnapshot(state.page, state.tabId, options)
  if (snapshot.count === 0 && !state.page.isClosed()) {
    // New tabs and client-rendered login pages often need one more beat.
    await sleep(750)
    snapshot = await captureSnapshot(state.page, state.tabId, options)
  }
  manager.setRefs(state.page, snapshot.refMap)
  const { refMap: _refMap, ...publicSnapshot } = snapshot
  return publicSnapshot
}

async function settleAndSnapshot(manager, page, state, config, exec, message, beforeTabs = []) {
  assertNotAborted(exec)
  await sleep(320)
  await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
  const agentId = exec?.agent?.id
  const newPages = manager.listPages().filter(entry => !beforeTabs.includes(entry.tabId))
  if (newPages.length > 0) {
    for (const entry of newPages) manager.adoptPage(entry.tabId, agentId)
    manager.adoptPage(newPages[newPages.length - 1].tabId, agentId)
  }
  const active = await manager.resolvePage('active', agentId)
  const dialog = manager.takeDialog(page) || (active.page !== page ? manager.takeDialog(active.page) : null)
  if (active.tabId !== state.tabId) {
    message = `${message} 已切换到新标签页 ${active.tabId}。`
  }
  const snapshot = await snapshotForTool(manager, active, config, {
    maxChars: Math.min(config.snapshotMaxChars || 12000, 8000),
  })
  return {
    ok: true,
    message,
    page: await manager.pageInfo(active),
    snapshot,
    dialog,
    warning: active.lastWarning || '',
  }
}

async function doAction(page, manager, args, config, exec) {
  const action = String(args.action || '').toLowerCase()
  const timeout = timeoutOf(args, config)
  let message = ''
  let target = null

  if (['click', 'type', 'select', 'check', 'uncheck', 'hover'].includes(action)) {
    target = await resolveTarget(manager, page, args, { forText: action === 'click' })
  }

  switch (action) {
    case 'click': {
      assertNotAborted(exec)
      await target.locator.waitFor({ state: 'visible', timeout })
      await target.locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {})
      await target.locator.click({
        timeout,
        button: ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left',
        clickCount: intValue(args.clickCount, 1, 1, 3),
        modifiers: Array.isArray(args.modifiers) ? args.modifiers.filter(Boolean) : [],
      })
      message = `已点击 ${target.label}${target.count > 1 ? `（匹配 ${target.count} 个，使用第一个）` : ''}。`
      break
    }
    case 'type': {
      assertNotAborted(exec)
      if (typeof args.value !== 'string') throw new Error('action=type 时必须提供 value 字符串。')
      await target.locator.waitFor({ state: 'visible', timeout })
      await target.locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {})
      await target.locator.fill(args.value, { timeout })
      message = `已填写 ${target.label}。`
      if (args.submit) {
        await target.locator.press('Enter', { timeout })
        message += ' 已按 Enter 提交。'
      }
      break
    }
    case 'press': {
      assertNotAborted(exec)
      const key = String(args.key || '').trim()
      if (!key) throw new Error('action=press 时必须提供 key，例如 Enter、PageDown、Control+A。')
      await page.keyboard.press(key, { timeout })
      message = `已按下 ${key}。`
      break
    }
    case 'scroll': {
      assertNotAborted(exec)
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down'
      const amount = intValue(args.amount, 640, 40, 6000)
      const times = intValue(args.times, 1, 1, 20)
      if (args.ref || args.selector) {
        const element = await resolveTarget(manager, page, args)
        await element.locator.scrollIntoViewIfNeeded({ timeout })
        message = `已将 ${element.label} 滚动到可视区域。`
      } else {
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        for (let index = 0; index < times; index += 1) {
          await page.mouse.wheel(dx, dy)
          await sleep(120)
        }
        message = `已向${direction === 'up' ? '上' : direction === 'down' ? '下' : direction === 'left' ? '左' : '右'}滚动 ${amount * times}px。`
      }
      break
    }
    case 'select': {
      assertNotAborted(exec)
      if (typeof args.value !== 'string') throw new Error('action=select 时必须提供 value（选项的 value 或显示文本）。')
      try {
        await target.locator.selectOption(args.value, { timeout })
      } catch {
        await target.locator.selectOption({ label: args.value }, { timeout })
      }
      message = `已选择 ${target.label} 的选项“${args.value}”。`
      break
    }
    case 'check':
    case 'uncheck': {
      assertNotAborted(exec)
      await target.locator[action]({ timeout })
      message = `已${action === 'check' ? '勾选' : '取消勾选'} ${target.label}。`
      break
    }
    case 'hover': {
      assertNotAborted(exec)
      await target.locator.hover({ timeout })
      message = `已悬停在 ${target.label}。`
      break
    }
    case 'back': {
      assertNotAborted(exec)
      await page.goBack({ waitUntil: 'domcontentloaded', timeout })
      message = '已后退。'
      break
    }
    case 'forward': {
      assertNotAborted(exec)
      await page.goForward({ waitUntil: 'domcontentloaded', timeout })
      message = '已前进。'
      break
    }
    case 'reload': {
      assertNotAborted(exec)
      await page.reload({ waitUntil: 'domcontentloaded', timeout })
      message = '已刷新页面。'
      break
    }
    case 'wait': {
      const ms = intValue(args.ms, 1000, 100, 30000)
      await page.waitForTimeout(ms)
      message = `已等待 ${ms}ms。`
      break
    }
    default:
      throw new Error(
        `不支持的 action：${action || '(空)'}。可用：click、type、press、scroll、select、check、uncheck、hover、back、forward、reload、wait。`,
      )
  }
  return message
}

export function registerBrowserTools(ctx, manager, config) {
  const tools = []

  function defineTool(definition) {
    const tool = {
      name: definition.name,
      description: definition.description,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: definition.properties || {},
        required: definition.required || [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: definition.render(value) }],
      },
      timeoutMs: definition.timeoutMs || 60000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const parsed = objectArgs(args)
        try {
          return await manager.run(() => definition.execute(parsed, exec))
        } catch (error) {
          if (exec?.signal?.aborted) throw new Error('操作已取消。')
          throw error
        }
      },
    }
    tools.push(tool)
    ctx.effect(() => ctx.tools.register(tool))
  }

  defineTool({
    name: 'browser_open',
    description:
      '打开 URL 并复用持久化的登录态；不传 url 时只把当前标签页带到前台。返回当前页面的快照（含可点击引用）。遇到登录、短信或人机验证时，浏览器窗口会保持打开，请让用户手动完成后继续。',
    properties: {
      url: { type: 'string', description: '要打开的 http(s) 地址；省略则只聚焦当前标签页。' },
      tab: tabParam(),
      newTab: { type: 'boolean', description: '为 true 时新建标签页，默认复用当前标签页。' },
      focus: { type: 'boolean', description: '为 true（默认）时把浏览器窗口带到前台。' },
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      const state = await manager.open({
        url: args.url,
        tab: args.tab,
        newTab: args.newTab,
        focus: args.focus !== false,
        agentId: exec?.agent?.id,
      })
      const snapshot = await snapshotForTool(manager, state, config, {
        maxChars: config.snapshotMaxChars || 12000,
      })
      return {
        ok: true,
        message: args.url ? `已打开 ${state.page.url()}。` : `当前标签页 ${state.tabId}。`,
        page: await manager.pageInfo(state),
        snapshot,
        warning: state.lastWarning || '',
      }
    },
    render: value => snapshotTail(value),
  })

  defineTool({
    name: 'browser_snapshot',
    description:
      '把当前页面压缩成带 @e1 引用的可操作快照（链接、按钮、输入框、标题、iframe），用于决定下一步点击/填写。快照会重建引用，旧引用随即失效。',
    properties: {
      tab: tabParam(),
      interactiveOnly: { type: 'boolean', description: '只列出可交互元素，省略标题和语义区块。' },
      maxChars: { type: 'integer', description: '快照最大字符数，默认使用配置值。', minimum: 1000, maximum: 30000 },
    },
    timeoutMs: 45000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const snapshot = await snapshotForTool(manager, state, config, {
        maxChars: args.maxChars || config.snapshotMaxChars,
        interactiveOnly: Boolean(args.interactiveOnly),
      })
      return {
        ok: true,
        page: await manager.pageInfo(state),
        snapshot,
      }
    },
    render: value => value.snapshot.text,
  })

  defineTool({
    name: 'browser_act',
    description:
      '对页面执行一个动作：click、type、press、scroll、select、check、uncheck、hover、back、forward、reload、wait。优先用 browser_snapshot 得到的 ref，也可用 CSS selector。动作完成后自动返回新快照。',
    properties: {
      action: {
        type: 'string',
        description: '要执行的动作。',
        enum: [
          'click',
          'type',
          'press',
          'scroll',
          'select',
          'check',
          'uncheck',
          'hover',
          'back',
          'forward',
          'reload',
          'wait',
        ],
      },
      tab: tabParam(),
      ref: { type: 'string', description: '快照中的引用，例如 e12 或 @e12。' },
      selector: { type: 'string', description: 'CSS selector；没有 ref 时使用。' },
      text: { type: 'string', description: 'click 时按可见文本定位（ref/selector 都没有时使用）。' },
      value: { type: 'string', description: 'type 要填写的文本；select 要选择的选项 value 或文本。' },
      key: { type: 'string', description: 'press 的按键，例如 Enter、Escape、PageDown、Control+A。' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'scroll 方向，默认 down。' },
      amount: { type: 'integer', description: 'scroll 每次滚动像素，默认 640。', minimum: 40, maximum: 6000 },
      times: { type: 'integer', description: 'scroll 次数，默认 1。', minimum: 1, maximum: 20 },
      submit: { type: 'boolean', description: 'type 后是否按 Enter 提交。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'click 的鼠标键，默认 left。' },
      clickCount: { type: 'integer', description: 'click 次数，默认 1。', minimum: 1, maximum: 3 },
      modifiers: {
        type: 'array',
        items: { type: 'string' },
        description: 'click 时按住的修饰键，例如 ["Control"]。',
      },
      ms: { type: 'integer', description: 'wait 的毫秒数，默认 1000。', minimum: 100, maximum: 30000 },
      timeoutMs: { type: 'integer', description: '动作超时毫秒数，默认使用配置值。', minimum: 1000, maximum: 180000 },
    },
    required: ['action'],
    timeoutMs: 90000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const beforeTabs = manager.listPages().map(entry => entry.tabId)
      const message = await doAction(state.page, manager, args, config, exec)
      return settleAndSnapshot(manager, state.page, state, config, exec, message, beforeTabs)
    },
    render: value => snapshotTail(value),
  })

  defineTool({
    name: 'browser_extract',
    description:
      '从当前页面提取信息：text（正文）、html、links（链接）、tables（表格）、labeled（按“标签：值”抽取）、structured（按 CSS 字段抽取）。适合读取企查查公司详情、公告正文和列表；内容过长时自动保存完整文件并返回 savedPath。',
    properties: {
      tab: tabParam(),
      mode: {
        type: 'string',
        enum: ['text', 'html', 'links', 'tables', 'labeled', 'structured'],
        description: '提取模式，默认 text。labeled 适合企查查详情页的“统一社会信用代码：…”字段。',
      },
      selector: { type: 'string', description: '限定提取范围的 CSS selector；省略则使用整页/body。' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'labeled 模式的标签列表，例如 ["统一社会信用代码","法定代表人","注册资本","成立日期","地址"]。',
      },
      fields: {
        type: 'object',
        additionalProperties: true,
        description:
          'structured 模式的字段映射，例如 {"公司名称":"h1","统一社会信用代码":".credit-code"}。值可以是 selector 或 {selector, attr, all}。',
      },
      maxChars: {
        type: 'integer',
        description: '返回内容的最大字符数，默认使用配置值。',
        minimum: 1000,
        maximum: 200000,
      },
      limit: { type: 'integer', description: 'links/tables 的最大返回条数，默认 200。', minimum: 1, maximum: 1000 },
      includeFrames: { type: 'boolean', description: 'text 模式下是否合并 iframe 中的文本，默认 false。' },
    },
    timeoutMs: 90000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const result = await extractPage(state.page, {
        mode: args.mode,
        selector: args.selector,
        labels: args.labels,
        fields: args.fields,
        limit: args.limit,
        includeFrames: Boolean(args.includeFrames),
      })
      const maxChars = intValue(args.maxChars, config.extractMaxChars || 30000, 1000, 200000)
      const bounded = boundExtractResult(result, maxChars)
      let savedPath = null
      if (result.truncated || bounded.truncated) {
        const full = result.content ?? JSON.stringify(result.data, null, 2)
        savedPath = await manager.saveText(full, {
          prefix: 'extract',
          ext: result.content ? '.txt' : '.json',
        })
      }
      return {
        ...bounded,
        data: bounded.data && JSON.stringify(bounded.data).length > 200000 ? null : bounded.data,
        savedPath,
        page: await manager.pageInfo(state),
      }
    },
    render: value => {
      const header = `提取：${value.mode} ｜ ${value.page?.title || ''} ｜ ${value.page?.url || value.url || ''}`
      const body = value.content ?? value.dataText ?? ''
      const footer = [
        value.truncated ? '（内容已截断）' : '',
        value.savedPath ? `完整内容：${value.savedPath}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return [header, body, footer].filter(Boolean).join('\n\n')
    },
  })

  defineTool({
    name: 'browser_screenshot',
    description:
      '截取当前页面或某个元素的 PNG/JPEG 截图，保存到 artifacts 目录并返回绝对路径、尺寸和字节数。适合留存企查查页面证据；可用 read_image 查看截图。',
    properties: {
      tab: tabParam(),
      fullPage: { type: 'boolean', description: '是否截取整页（含滚动区域），默认 false。' },
      ref: { type: 'string', description: '只截取某个快照引用对应的元素。' },
      selector: { type: 'string', description: '只截取 CSS selector 对应的元素。' },
      path: { type: 'string', description: '文件名或绝对路径；相对路径基于 artifacts 目录。' },
      format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png。' },
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const page = state.page
      const format = args.format || (String(args.path || '').toLowerCase().endsWith('.jpg') ? 'jpeg' : 'png')
      const ext = format === 'jpeg' ? '.jpg' : '.png'
      const filePath = await manager.artifactPath(args.path, { ext, prefix: 'shot' })
      const timeout = timeoutOf(args, config)
      let element = null
      if (args.ref || args.selector) {
        const target = await resolveTarget(manager, page, args)
        element = target.label
        await target.locator.screenshot({ path: filePath, type: format, timeout, animations: 'disabled' })
      } else {
        await page.screenshot({
          path: filePath,
          type: format,
          fullPage: Boolean(args.fullPage),
          timeout,
          animations: 'disabled',
        })
      }
      const stat = await fs.stat(filePath)
      let width = null
      let height = null
      if (format === 'png') {
        try {
          const buffer = await fs.readFile(filePath)
          width = buffer.readUInt32BE(16)
          height = buffer.readUInt32BE(20)
        } catch {
          /* ignore */
        }
      }
      return {
        ok: true,
        path: filePath,
        bytes: stat.size,
        width,
        height,
        element,
        fullPage: Boolean(args.fullPage) && !element,
        page: await manager.pageInfo(state),
      }
    },
    render: value =>
      [
        `截图已保存：${value.path}`,
        `尺寸：${value.width ?? '?'}×${value.height ?? '?'} ｜ ${formatBytes(value.bytes)} ｜ ${value.element ? `元素 ${value.element}` : value.fullPage ? '整页' : '视口'}`,
        `页面：${value.page?.title || ''} ｜ ${value.page?.url || ''}`,
        '可用 read_image 查看该文件。',
      ].join('\n'),
  })

  defineTool({
    name: 'browser_tabs',
    description: '列出、切换或关闭浏览器标签页。每个标签页有稳定的 t1/t2 编号，快照和动作都通过 tab 指定标签页。',
    properties: {
      action: { type: 'string', enum: ['list', 'switch', 'close'], description: '标签页操作。' },
      tab: { type: 'string', description: 'switch/close 的目标标签页 ID 或 URL 片段；close 省略时关闭当前标签页。' },
    },
    required: ['action'],
    timeoutMs: 30000,
    async execute(args, exec) {
      const agentId = exec?.agent?.id
      if (args.action === 'list') {
        const tabs = await manager.listTabs(agentId)
        return { ok: true, action: 'list', tabs }
      }
      if (args.action === 'switch') {
        const state = await manager.switchTab(requiredTab(args.tab), agentId)
        return { ok: true, action: 'switch', page: await manager.pageInfo(state), tabs: await manager.listTabs(agentId) }
      }
      if (args.action === 'close') {
        const closed = await manager.closeTab(args.tab || 'active', agentId)
        return { ok: true, action: 'close', closed, tabs: await manager.listTabs(agentId) }
      }
      throw new Error(`不支持的 action：${args.action}。可用：list、switch、close。`)
    },
    render: value => {
      if (value.action === 'switch') {
        return `已切换到 ${value.page.tab}：${value.page.title}\n${value.page.url}`
      }
      if (value.action === 'close') {
        return `已关闭标签页 ${value.closed}。\n\n${value.tabs.map(tabLine).join('\n')}`
      }
      return value.tabs.length ? value.tabs.map(tabLine).join('\n') : '(没有打开的标签页)'
    },
  })

  defineTool({
    name: 'browser_network',
    description:
      '捕获页面发出的 XHR/fetch 响应（JSON 接口等），用于读取企查查等站点由前端调用的结构化数据。先 start，再触发页面请求，然后 list/get。只保存在本机内存。',
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'list', 'get', 'clear'], description: '网络捕获操作。' },
      tab: tabParam(),
      urlPattern: { type: 'string', description: '可选的正则表达式，只记录 URL 匹配的响应。' },
      resourceTypes: {
        type: 'array',
        items: { type: 'string' },
        description: '要记录的资源类型，默认 ["xhr","fetch"]；也可加 document、script。',
      },
      maxEntries: { type: 'integer', description: '最多保留的响应条数，默认 80。', minimum: 1, maximum: 500 },
      id: { type: 'string', description: 'get 时指定记录 ID（如 n3）。' },
      urlContains: { type: 'string', description: 'get 时按 URL 片段取最近一条记录。' },
      maxChars: { type: 'integer', description: 'get 返回体的最大字符数，默认 50000。', minimum: 1000, maximum: 200000 },
    },
    required: ['action'],
    timeoutMs: 60000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const page = state.page
      let recorder = manager.getRecorder(page)
      if (!recorder) {
        recorder = new NetworkRecorder(page, {
          maxEntries: config.networkMaxEntries || 80,
          maxBodyChars: config.networkMaxBodyChars || 120000,
        })
        manager.setRecorder(page, recorder)
      }
      if (args.action === 'start') {
        if (args.urlPattern) {
          try {
            // Validate early so the tool reports a useful error.
            new RegExp(args.urlPattern, 'i')
          } catch (error) {
            throw new Error(`urlPattern 不是有效正则：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        recorder.start({
          urlPattern: args.urlPattern,
          resourceTypes: args.resourceTypes,
          maxEntries: args.maxEntries,
        })
        return { ok: true, action: 'start', recorder: recorder.snapshot(), page: await manager.pageInfo(state) }
      }
      if (args.action === 'stop') {
        recorder.stop()
        return { ok: true, action: 'stop', recorder: recorder.snapshot() }
      }
      if (args.action === 'clear') {
        recorder.clear()
        return { ok: true, action: 'clear', recorder: recorder.snapshot() }
      }
      if (args.action === 'list') {
        const entries = recorder.list({ urlPattern: args.urlPattern, limit: args.maxEntries || 100 })
        return { ok: true, action: 'list', recorder: recorder.snapshot(), entries }
      }
      if (args.action === 'get') {
        const record = await recorder.get({
          id: args.id,
          urlContains: args.urlContains,
          maxChars: args.maxChars,
        })
        return { ok: true, action: 'get', record }
      }
      throw new Error(`不支持的 action：${args.action}。可用：start、stop、list、get、clear。`)
    },
    render: value => {
      if (value.action === 'list') {
        if (!value.entries.length) {
          return `当前没有网络记录（${value.recorder.active ? '正在捕获' : '未开始捕获'}）。先执行 start，再触发页面请求。`
        }
        const lines = value.entries.map(
          entry => `${entry.id} ${entry.status} ${entry.method} ${entry.type} ${entry.url}${entry.bodyBytes ? ` (${entry.bodyBytes} B)` : ''}`,
        )
        return [`网络记录 ${value.entries.length} 条（${value.recorder.active ? '捕获中' : '已停止'}）：`, ...lines].join('\n')
      }
      if (value.action === 'get') {
        const record = value.record
        const body = record.json !== null ? JSON.stringify(record.json, null, 2) : record.body
        const bounded = jsonPretty(body, 40000)
        return [
          `${record.id} ${record.status} ${record.method} ${record.url}`,
          `Content-Type：${record.contentType || '(未知)'} ｜ ${record.bodyBytes} B`,
          record.bodyError ? `读取错误：${record.bodyError}` : '',
          bounded.text,
        ]
          .filter(Boolean)
          .join('\n')
      }
      return `网络捕获：${value.action} ｜ 记录 ${value.recorder.count} 条 ｜ ${value.recorder.active ? '进行中' : '已停止'}`
    },
  })

  defineTool({
    name: 'browser_collect',
    description:
      '对一组 URL 并行执行同一套提取（text/links/tables/labeled/structured），共享当前登录态。适合从已得到的企查查公司详情链接批量取数；默认并发 2、每条之间延迟 800ms，结果保存为 JSON 文件。',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: '要采集的 URL 列表，最多 20 条。',
      },
      mode: {
        type: 'string',
        enum: ['text', 'html', 'links', 'tables', 'labeled', 'structured'],
        description: '每个页面使用的提取模式，默认 text；labeled 适合批量公司详情字段。',
      },
      selector: { type: 'string', description: '限定提取范围的 CSS selector。' },
      labels: {
        type: 'array',
        items: { type: 'string' },
        description: 'labeled 模式的标签列表。',
      },
      fields: {
        type: 'object',
        additionalProperties: true,
        description: 'structured 模式的字段映射。',
      },
      maxChars: {
        type: 'integer',
        description: '每个结果保留的最大字符数，默认 8000。',
        minimum: 500,
        maximum: 50000,
      },
      limit: { type: 'integer', description: 'links/tables 每页最大条数，默认 200。', minimum: 1, maximum: 1000 },
      concurrency: { type: 'integer', description: '并发标签页数，默认 2，最大 4。', minimum: 1, maximum: 4 },
      delayMs: { type: 'integer', description: '每条开始前的延迟毫秒数，默认 800。', minimum: 0, maximum: 10000 },
      includeFrames: { type: 'boolean', description: 'text 模式下是否合并 iframe 文本。' },
      save: { type: 'boolean', description: '是否把完整结果写成 JSON 文件，默认 true。' },
    },
    required: ['urls'],
    timeoutMs: 300000,
    async execute(args, exec) {
      const urls = Array.isArray(args.urls) ? args.urls.filter(url => typeof url === 'string' && url.trim()) : []
      if (urls.length === 0) throw new Error('urls 至少需要一个 URL。')
      if (urls.length > 20) throw new Error('urls 最多 20 条；请拆成多批，避免给站点造成压力。')
      const concurrency = intValue(args.concurrency, config.collectConcurrency || 2, 1, 4)
      const delayMs = intValue(args.delayMs, config.collectDelayMs || 800, 0, 10000)
      const perItemChars = intValue(args.maxChars, 8000, 500, 50000)
      const spec = {
        mode: args.mode || 'text',
        selector: args.selector,
        labels: args.labels,
        fields: args.fields,
        limit: args.limit,
        includeFrames: Boolean(args.includeFrames),
      }
      const results = new Array(urls.length)
      let cursor = 0
      const startedAt = Date.now()

      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= urls.length) return
          const url = urls[index]
          if (index > 0 && delayMs > 0) await sleep(delayMs)
          let page = null
          try {
            const state = await manager.createPage({ activate: false })
            page = state.page
            await page.goto(normalizeUrl(url), {
              waitUntil: 'domcontentloaded',
              timeout: config.navigationTimeoutMs || 45000,
            })
            await sleep(Math.max(350, Number(config.collectRenderWaitMs) || 700))
            const extracted = await extractPage(page, spec)
            const title = extracted.title || ''
            const rawText =
              extracted.content ??
              (extracted.data !== null && extracted.data !== undefined
                ? JSON.stringify(extracted.data, null, 2)
                : '')
            const blocked = BLOCK_RE.test(`${title}\n${rawText.slice(0, 3000)}`)
            let data = extracted.content ?? extracted.data
            if (typeof data === 'string') {
              data = data.slice(0, perItemChars)
            } else if (data !== null && data !== undefined && JSON.stringify(data).length > perItemChars) {
              data = rawText.slice(0, perItemChars)
            }
            results[index] = {
              url: page.url(),
              ok: true,
              title: firstLine(title, 180),
              blocked,
              data,
              preview: firstLine(rawText, 500),
              truncated: rawText.length > perItemChars,
              chars: rawText.length,
            }
          } catch (error) {
            results[index] = {
              url,
              ok: false,
              title: '',
              blocked: false,
              error: error instanceof Error ? error.message : String(error),
            }
          } finally {
            if (page && !page.isClosed()) {
              try {
                for (const candidate of manager.context?.pages() || []) {
                  if (candidate !== page && candidate.opener() === page) await candidate.close().catch(() => {})
                }
              } catch {
                /* ignore */
              }
              await page.close().catch(() => {})
            }
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, () => worker()))
      const ok = results.filter(item => item.ok).length
      const payload = {
        createdAt: new Date().toISOString(),
        spec,
        concurrency,
        delayMs,
        results,
      }
      const savedPath = args.save === false ? null : await manager.saveJson(payload, { prefix: 'collect' })
      return {
        ok: true,
        count: results.length,
        succeeded: ok,
        failed: results.length - ok,
        blocked: results.filter(item => item.blocked).length,
        elapsedMs: Date.now() - startedAt,
        savedPath,
        results,
      }
    },
    render: value => {
      const lines = [`批量采集 ${value.count} 条：成功 ${value.succeeded}，失败 ${value.failed}，疑似验证/限制 ${value.blocked}`]
      for (const item of value.results) {
        if (item.ok) {
          lines.push(`- OK ${item.title || '(无标题)'} ｜ ${item.url}${item.blocked ? ' ｜ 疑似验证' : ''}`)
          if (item.preview) lines.push(`  ${item.preview}`)
        } else {
          lines.push(`- FAIL ${item.url} ｜ ${item.error}`)
        }
      }
      if (value.savedPath) lines.push(`完整结果：${value.savedPath}`)
      return lines.join('\n')
    },
  })

  defineTool({
    name: 'browser_download',
    description:
      '下载文件：直接抓取一个 URL（共享浏览器 cookie），或点击页面元素并等待浏览器下载。文件保存到 downloads 目录并返回路径。',
    properties: {
      tab: tabParam(),
      url: { type: 'string', description: '直接下载的 http(s) 地址；与 ref/selector 二选一。' },
      ref: { type: 'string', description: '触发下载的页面元素引用。' },
      selector: { type: 'string', description: '触发下载的 CSS selector。' },
      path: { type: 'string', description: '保存文件名或绝对路径；相对路径基于 downloads 目录。' },
      timeoutMs: { type: 'integer', description: '等待下载的超时毫秒数。', minimum: 1000, maximum: 180000 },
    },
    timeoutMs: 180000,
    async execute(args, exec) {
      const state = await manager.resolvePage(args.tab, exec?.agent?.id)
      const page = state.page
      const timeout = timeoutOf(args, config, 60000)
      if (args.url) {
        const url = normalizeUrl(args.url)
        const response = await manager.context.request.get(url, { timeout })
        if (!response.ok()) throw new Error(`下载失败：HTTP ${response.status()} ${url}`)
        const body = await response.body()
        const urlPath = (() => {
          try {
            return decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
          } catch {
            return ''
          }
        })()
        const target = await manager.downloadPath(args.path, urlPath || 'download')
        await fs.writeFile(target, body)
        return {
          ok: true,
          path: target,
          bytes: body.length,
          filename: urlPath,
          url,
          mode: 'request',
        }
      }
      const target = await resolveTarget(manager, page, args)
      const downloadPromise = page.waitForEvent('download', { timeout })
      await target.locator.click({ timeout })
      const download = await downloadPromise
      const suggested = download.suggestedFilename()
      const filePath = await manager.downloadPath(args.path, suggested)
      await download.saveAs(filePath)
      const stat = await fs.stat(filePath)
      return {
        ok: true,
        path: filePath,
        bytes: stat.size,
        filename: suggested,
        url: download.url(),
        mode: 'browser',
      }
    },
    render: value =>
      [
        `下载完成：${value.path}`,
        `文件：${value.filename || '(未知)'} ｜ ${formatBytes(value.bytes)}`,
        `来源：${value.url}`,
      ].join('\n'),
  })

  defineTool({
    name: 'browser_close',
    description: '关闭本工具启动的浏览器并释放配置目录锁。持久化登录态仍保留在 userDataDir 中，下次打开会复用。',
    properties: {},
    timeoutMs: 30000,
    async execute() {
      await manager.close('tool')
      return { ok: true, message: '浏览器已关闭，登录态已保留。' }
    },
    render: value => value.message,
  })

  return tools
}

function tabLine(tab) {
  return `${tab.active ? '▶' : ' '} ${tab.tab} ｜ ${tab.title || '(无标题)'} ｜ ${tab.url}`
}
