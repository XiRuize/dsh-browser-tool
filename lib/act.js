import { existsSync, statSync } from 'node:fs'
import { clamp, raceAbort, sleep } from './util.js'

/**
 * v0.2 动作执行层。
 *
 * 设计原则（借鉴 chrome-quiz-copilot）：
 * 1. 先读实际状态，再操作；
 * 2. 操作后回读目标/表单/URL/对话框/新标签页，而不是仅凭 click 成功就宣称状态变更；
 * 3. 定位支持 ref/@eN、selector、text、container + nth，重复匹配显式报告；
 * 4. 默认静默：绝不调用 page.bringToFront()。
 *
 * 返回 { message, action, target, verify, pageChanged, warning?, matchCount?, chosenIndex? }
 */

const ACTIONS = new Set([
  'click',
  'type',
  'press',
  'scroll',
  'select',
  'check',
  'uncheck',
  'hover',
  'drag',
  'upload',
  'back',
  'forward',
  'reload',
  'wait',
  'waitFor',
  'dialog',
])

const WAIT_STATES = new Set(['attached', 'visible', 'hidden', 'detached'])
const BUTTONS = new Set(['left', 'right', 'middle'])
const TARGET_ACTIONS = new Set([
  'click',
  'type',
  'select',
  'check',
  'uncheck',
  'hover',
  'upload',
  'drag',
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function intValue(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(Math.round(number), min, max)
}

function timeoutOf(args, config) {
  const fallback = Number(config?.actionTimeoutMs) || 15000
  return intValue(args?.timeoutMs, fallback, 1000, 180000)
}

function assertNotAborted(exec) {
  if (exec?.signal?.aborted) throw new Error('操作已取消。')
}

function pageOf(state) {
  const page = state?.page ?? state
  if (!page || typeof page.locator !== 'function' || typeof page.url !== 'function') {
    throw new Error('动作执行需要一个可用的标签页页面对象（state.page）。')
  }
  return page
}

function refKey(value) {
  return String(value ?? '').trim().replace(/^@/, '')
}

function frameScopeFor(page, entry) {
  let scope = page
  for (const frameSelector of entry?.frameChain || []) {
    scope = scope.frameLocator(frameSelector)
  }
  return scope
}

function refLocator(manager, page, rawRef) {
  const key = refKey(rawRef)
  const entry = manager?.getRefs?.(page)?.get?.(key)
  if (!entry) {
    throw new Error(`引用 @${key} 不存在或已失效。页面可能已变化，请重新调用 browser_snapshot。`)
  }
  const scope = frameScopeFor(page, entry)
  return { locator: scope.locator(`[data-dsh-ref="${key}"]`), entry, key }
}

function isRefLike(manager, page, value) {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  if (raw.startsWith('@')) return true
  const key = refKey(raw)
  if (!/^e\d+$/.test(key)) return false
  return Boolean(manager?.getRefs?.(page)?.has?.(key))
}

async function safeCount(locator, label) {
  try {
    return await locator.count()
  } catch (error) {
    throw new Error(`${label}无效或无法执行：${errorMessage(error)}`)
  }
}

/** 解析 container：selector 或 ref；多匹配时拒绝静默跨容器操作。 */
async function resolveContainer(manager, page, container, { allowMissing = false } = {}) {
  const raw = String(container ?? '').trim()
  if (!raw) return null
  let locator
  let kind = 'selector'
  if (isRefLike(manager, page, raw)) {
    kind = 'ref'
    locator = refLocator(manager, page, raw).locator
  } else {
    try {
      locator = page.locator(raw)
    } catch (error) {
      throw new Error(`container 选择器无效：${raw}。${errorMessage(error)}`)
    }
  }
  let count
  try {
    count = await locator.count()
  } catch (error) {
    throw new Error(`container 定位失败：${raw}。${errorMessage(error)}`)
  }
  if (count === 0) {
    if (allowMissing) return locator.first()
    throw new Error(`container 未匹配到任何元素：${raw}。请先确认容器 selector 或 ref 是否正确。`)
  }
  if (count > 1 && !allowMissing) {
    throw new Error(
      `container 匹配到 ${count} 个元素：${raw}。为避免跨容器误点，请改用更精确的 selector 或 ref 限定容器。`,
    )
  }
  return locator.first()
}

/**
 * 解析动作目标。
 * 支持 ref/@eN（含 frameChain）、selector、text（getByText + exact）、container、nth。
 * allowMissing=true 时（waitFor hidden/detached）允许 0 匹配，不抛错。
 */
async function resolveTarget(manager, page, args, { forText = false, allowMissing = false } = {}) {
  const nth = intValue(args.nth, 0, 0, 9999)
  const containerRaw = String(args.container ?? '').trim()
  const scope = containerRaw ? await resolveContainer(manager, page, containerRaw, { allowMissing }) : null

  const refRaw = String(args.ref ?? '').trim()
  if (refRaw) {
    const { locator, entry, key } = refLocator(manager, page, refRaw)
    const count = await safeCount(locator, `引用 @${key} `)
    if (count === 0 && !allowMissing) {
      throw new Error(`引用 @${key} 已失效（元素不在页面中）。请重新调用 browser_snapshot。`)
    }
    const chosenIndex = count > 0 ? Math.min(nth, count - 1) : 0
    return {
      locator: locator.nth(chosenIndex),
      label: `@${key}${entry.name ? ` ${entry.name}` : ''}`,
      matchCount: count,
      chosenIndex,
      by: 'ref',
      container: containerRaw || null,
    }
  }

  const selector = String(args.selector ?? '').trim()
  const text = String(args.text ?? '').trim()

  if (selector) {
    const base = scope || page
    let locator
    try {
      locator = base.locator(selector)
    } catch (error) {
      throw new Error(`选择器无效：${selector}。${errorMessage(error)}`)
    }
    const count = await safeCount(locator, `选择器 ${selector} `)
    if (count === 0 && !allowMissing) {
      throw new Error(
        containerRaw
          ? `container ${containerRaw} 内未找到匹配 selector 的元素：${selector}。`
          : `未找到匹配 selector 的元素：${selector}。请检查选择器，或先调用 browser_snapshot 获取 ref。`,
      )
    }
    if (!allowMissing && nth >= count) {
      throw new Error(`selector 匹配 ${count} 个元素，nth=${nth} 超出范围（nth 从 0 开始）。`)
    }
    const chosenIndex = count > 0 ? Math.min(nth, count - 1) : 0
    const suffix = count > 1 ? `（匹配 ${count} 个，使用第 ${chosenIndex + 1} 个）` : ''
    return {
      locator: locator.nth(chosenIndex),
      label: `selector ${selector}${suffix}`,
      matchCount: count,
      chosenIndex,
      by: 'selector',
      container: containerRaw || null,
    }
  }

  if (forText && text) {
    const base = scope || page
    let locator
    try {
      locator = base.getByText(text, { exact: args.exact === true })
    } catch (error) {
      throw new Error(`文本定位失败：${text}。${errorMessage(error)}`)
    }
    const count = await safeCount(locator, `文本 "${text}" `)
    if (count === 0 && !allowMissing) {
      throw new Error(
        containerRaw
          ? `container ${containerRaw} 内未找到包含文本 "${text}" 的元素。`
          : `未找到包含文本 "${text}" 的元素。可改用 ref/selector，或设置 container 限定范围。`,
      )
    }
    if (!allowMissing && nth >= count) {
      throw new Error(`文本 "${text}" 匹配 ${count} 个元素，nth=${nth} 超出范围（nth 从 0 开始）。`)
    }
    const chosenIndex = count > 0 ? Math.min(nth, count - 1) : 0
    const suffix = count > 1 ? `（匹配 ${count} 个，使用第 ${chosenIndex + 1} 个）` : ''
    const scopeHint = containerRaw ? `（限定 container ${containerRaw}）` : ''
    return {
      locator: locator.nth(chosenIndex),
      label: `文本 "${text}"${suffix}${scopeHint}`,
      matchCount: count,
      chosenIndex,
      by: 'text',
      container: containerRaw || null,
    }
  }

  throw new Error(
    '这个动作需要一个 ref、selector 或（点击/文本定位时）text 来定位元素。先调用 browser_snapshot 获取 ref。',
  )
}

/** 在页面内读取元素状态；必须自包含，不能引用模块作用域变量。 */
function elementStateInPage(node) {
  const tag = node.tagName ? String(node.tagName).toLowerCase() : ''
  const type = String(node.getAttribute?.('type') || '').toLowerCase()
  const state = {
    tag,
    type,
    value: null,
    checked: null,
    selected: [],
    disabled: false,
    aria: {},
  }
  try {
    if (tag === 'input') {
      if (type === 'password') state.value = node.value ? '***' : ''
      else if (type === 'file') state.value = node.value ? String(node.value).split(/[\\/]/).pop() : ''
      else if (type !== 'checkbox' && type !== 'radio') state.value = node.value ?? ''
      if (type === 'checkbox' || type === 'radio') state.checked = Boolean(node.checked)
    } else if (tag === 'textarea') {
      state.value = node.value ?? ''
    } else if (tag === 'select') {
      state.value = node.value ?? ''
      state.selected = [...(node.selectedOptions || [])].slice(0, 20).map(option => ({
        value: option.value ?? '',
        label: String(option.label ?? option.text ?? '').replace(/\s+/g, ' ').trim(),
      }))
    } else if (node.isContentEditable) {
      state.value = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    }
    if (typeof node.checked === 'boolean') state.checked = node.checked
    state.disabled = Boolean(node.disabled)
    const ariaNames = [
      'aria-checked',
      'aria-selected',
      'aria-expanded',
      'aria-pressed',
      'aria-disabled',
      'aria-label',
      'aria-labelledby',
      'aria-valuenow',
      'aria-current',
      'role',
    ]
    for (const name of ariaNames) {
      const value = node.getAttribute?.(name)
      if (value !== null && value !== undefined) state.aria[name] = String(value)
    }
    if (state.disabled || state.aria['aria-disabled'] === 'true') state.disabled = true
  } catch {
    /* 页面内读取失败时退化为已有字段 */
  }
  return state
}

/** 回读元素状态；目标失效/导航/重渲染时不抛错，写入 notes。 */
async function readElement(locator, notes = []) {
  const result = {
    exists: false,
    visible: false,
    value: null,
    checked: null,
    selected: null,
    aria: {},
    tag: null,
    type: '',
    disabled: false,
    error: null,
  }
  if (!locator) return result
  let count = 0
  try {
    count = await locator.count()
  } catch (error) {
    result.error = errorMessage(error)
    notes.push(`回读目标失败（页面可能已导航或重渲染）：${result.error}`)
    return result
  }
  if (count === 0) return result
  result.exists = true
  try {
    result.visible = await locator.first().isVisible({ timeout: Math.min(1000, 2000) })
  } catch {
    result.visible = false
  }
  try {
    const data = await locator.first().evaluate(elementStateInPage)
    result.value = data?.value ?? null
    result.checked = data?.checked ?? null
    result.selected = Array.isArray(data?.selected) ? data.selected : null
    result.aria = data?.aria && typeof data.aria === 'object' ? data.aria : {}
    result.tag = data?.tag || null
    result.type = data?.type || ''
    result.disabled = Boolean(data?.disabled)
  } catch (error) {
    result.error = errorMessage(error)
    notes.push(`回读目标状态时元素已失效（页面可能已导航或重渲染）：${result.error}`)
  }
  return result
}

async function readPageMeta(page) {
  let url = ''
  let title = ''
  try {
    url = page.url()
  } catch {
    url = ''
  }
  try {
    title = await page.title()
  } catch {
    title = ''
  }
  return { url, title }
}

function contextPages(page) {
  try {
    return page.context?.()?.pages?.() ?? []
  } catch {
    return []
  }
}

/** 通过 opener 检测本动作触发的新标签页；真正的接管由 manager 的 page 事件负责。 */
async function detectNewTab(page, beforePages) {
  await sleep(150)
  const current = contextPages(page)
  if (current.length <= beforePages.length) return { opened: false, url: '', title: '' }
  for (const candidate of current) {
    if (beforePages.includes(candidate)) continue
    try {
      const opener = await candidate.opener()
      if (opener === page) {
        let title = ''
        try {
          title = await candidate.title()
        } catch {
          title = ''
        }
        let url = ''
        try {
          url = candidate.url()
        } catch {
          url = ''
        }
        return { opened: true, url, title }
      }
    } catch {
      /* opener 不可读时忽略 */
    }
  }
  return { opened: false, url: '', title: '' }
}

function targetInfo(target) {
  if (!target) return null
  return {
    label: target.label,
    by: target.by,
    container: target.container || null,
    matchCount: target.matchCount ?? null,
    chosenIndex: target.chosenIndex ?? 0,
  }
}

function summaryOfSelected(selected) {
  if (!Array.isArray(selected)) return ''
  return selected
    .map(item => (typeof item === 'string' ? item : item?.label ?? item?.value ?? ''))
    .filter(Boolean)
    .slice(0, 5)
    .join('、')
}

function completionSuffix(action, verify) {
  if (!verify) return ''
  const bits = []
  if (verify.urlChanged) bits.push('URL 已变化')
  if (verify.titleChanged) bits.push('标题已变化')
  if (verify.newTab) bits.push('已打开新标签页')
  if (verify.dialog) bits.push(`出现 ${verify.dialog.type || '未知'} 对话框`)
  if (action === 'type' && verify.value !== null && verify.value !== undefined) {
    bits.push(`回读 value=${JSON.stringify(verify.value).slice(0, 140)}`)
  }
  if ((action === 'check' || action === 'uncheck') && verify.checked !== null) {
    bits.push(`回读 checked=${verify.checked}`)
  }
  if (action === 'select' && Array.isArray(verify.selected)) {
    bits.push(`回读选中=${summaryOfSelected(verify.selected) || '(空)'}`)
  }
  if (!verify.ok) {
    bits.push(`核验未通过（${verify.notes.join('；') || '状态与预期不一致'}）`)
  } else if (action === 'click' && verify.exists) {
    bits.push('目标仍存在')
  }
  return bits.length ? ` 回读核验：${bits.join('；')}。` : ''
}

/**
 * 执行一个动作并回读核验。
 *
 * @param {object} manager BrowserManager（getRefs/takeDialog；可选）
 * @param {{page: object, tabId?: string}|object} state 标签页状态或 Page
 * @param {object} args 动作参数
 * @param {object} config resolveConfig() 结果
 * @param {{signal?: AbortSignal}} exec 执行上下文
 */
export async function performAction(manager, state, args = {}, config = {}, exec = null) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  const page = pageOf(state)
  const rawAction = String(args.action || '').trim().toLowerCase()
  const action = rawAction === 'waitfor' ? 'waitFor' : rawAction
  if (!ACTIONS.has(action)) {
    throw new Error(
      `不支持的 action：${action || '(空)'}。可用：${[...ACTIONS].join('、')}。`,
    )
  }
  const timeout = timeoutOf(args, config)
  const verifyEnabled = args.verify !== false
  const notes = []
  const before = verifyEnabled ? await readPageMeta(page) : { url: '', title: '' }
  const beforePages = verifyEnabled ? contextPages(page) : []

  let target = null
  let dragDestination = null
  let message = ''
  let warning = ''
  let waitSucceeded = true
  let handledDialog = null
  let responseInfo = null

  const recordDialog = info => {
    if (info && !handledDialog) handledDialog = info
  }

  // 可选：在会触发对话框的动作前挂一次性处理器（args.dialog = accept|dismiss）。
  const preDialogMode =
    args.dialog === 'accept' || args.dialog === 'dismiss'
      ? args.dialog
      : args.dialogAction === 'accept' || args.dialogAction === 'dismiss'
        ? args.dialogAction
        : ''
  let preDialogHandler = null
  if (preDialogMode && action !== 'dialog') {
    preDialogHandler = dialog => {
      recordDialog({
        type: typeof dialog.type === 'function' ? dialog.type() : String(dialog.type?.() || ''),
        message: typeof dialog.message === 'function' ? dialog.message() : '',
      })
      const settle = preDialogMode === 'accept' ? dialog.accept() : dialog.dismiss()
      Promise.resolve(settle).catch(() => {
        /* manager 的事件钩子可能已自动处理同一个对话框 */
      })
    }
    try {
      page.once('dialog', preDialogHandler)
    } catch (error) {
      preDialogHandler = null
      notes.push(`注册对话框处理器失败：${errorMessage(error)}`)
    }
  }

  assertNotAborted(exec)

  switch (action) {
    case 'click': {
      target = await resolveTarget(manager, page, args, { forText: true })
      await target.locator.waitFor({ state: 'visible', timeout })
      await target.locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {})
      assertNotAborted(exec)
      await target.locator.click({
        timeout,
        button: BUTTONS.has(args.button) ? args.button : 'left',
        clickCount: intValue(args.clickCount, 1, 1, 3),
        modifiers: Array.isArray(args.modifiers) ? args.modifiers.map(String).filter(Boolean) : [],
      })
      message = `已点击 ${target.label}。`
      break
    }

    case 'type': {
      target = await resolveTarget(manager, page, args)
      if (typeof args.value !== 'string') {
        throw new Error('action=type 时必须提供 value 字符串。')
      }
      await target.locator.waitFor({ state: 'visible', timeout })
      await target.locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {})
      const clearFirst = args.clear !== false
      let fillValue = args.value
      if (!clearFirst) {
        let current = ''
        try {
          current = await target.locator.inputValue({ timeout: Math.min(timeout, 3000) })
        } catch {
          current = ''
        }
        fillValue = `${current}${args.value}`
      }
      assertNotAborted(exec)
      await target.locator.fill(fillValue, { timeout })
      message = `已填写 ${target.label}（${clearFirst ? '覆盖' : '追加'}）。`
      if (args.submit) {
        assertNotAborted(exec)
        await target.locator.press('Enter', { timeout })
        message += ' 已按 Enter 提交。'
      }
      break
    }

    case 'press': {
      const key = String(args.key || '').trim()
      if (!key) throw new Error('action=press 时必须提供 key，例如 Enter、PageDown、Control+A。')
      assertNotAborted(exec)
      await page.keyboard.press(key, { timeout })
      message = `已按下 ${key}。`
      break
    }

    case 'scroll': {
      const direction = ['up', 'down', 'left', 'right'].includes(args.direction) ? args.direction : 'down'
      const amount = intValue(args.amount, 640, 40, 6000)
      const times = intValue(args.times, 1, 1, 20)
      if (args.ref || args.selector || args.text) {
        target = await resolveTarget(manager, page, args, { forText: true })
        assertNotAborted(exec)
        await target.locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {})
        message = `已将 ${target.label} 滚动到可视区域。`
      } else {
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        for (let index = 0; index < times; index += 1) {
          assertNotAborted(exec)
          await page.mouse.wheel(dx, dy)
          await sleep(120)
        }
        const label =
          direction === 'up' ? '上' : direction === 'down' ? '下' : direction === 'left' ? '左' : '右'
        message = `已向${label}滚动 ${amount * times}px。`
      }
      break
    }

    case 'select': {
      target = await resolveTarget(manager, page, args)
      if (typeof args.value !== 'string') {
        throw new Error('action=select 时必须提供 value（选项的 value 或显示文本）。')
      }
      await target.locator.waitFor({ state: 'visible', timeout })
      assertNotAborted(exec)
      try {
        await target.locator.selectOption(args.value, { timeout })
      } catch (firstError) {
        try {
          await target.locator.selectOption({ label: args.value }, { timeout })
        } catch (secondError) {
          throw new Error(
            `选择选项失败：${args.value}。${errorMessage(secondError) || errorMessage(firstError)}`,
          )
        }
      }
      message = `已选择 ${target.label} 的选项“${args.value}”。`
      break
    }

    case 'check':
    case 'uncheck': {
      target = await resolveTarget(manager, page, args)
      await target.locator.waitFor({ state: 'visible', timeout })
      assertNotAborted(exec)
      await target.locator[action]({ timeout })
      message = `已${action === 'check' ? '勾选' : '取消勾选'} ${target.label}。`
      break
    }

    case 'hover': {
      target = await resolveTarget(manager, page, args)
      await target.locator.waitFor({ state: 'visible', timeout })
      assertNotAborted(exec)
      await target.locator.hover({ timeout })
      message = `已悬停在 ${target.label}。`
      break
    }

    case 'drag': {
      const spec = args.drag && typeof args.drag === 'object' ? args.drag : null
      const specFrom = value => {
        if (value === null || value === undefined) return null
        if (typeof value === 'string') {
          const text = value.trim()
          if (!text) return null
          return isRefLike(manager, page, text) ? { ref: text } : { selector: text }
        }
        if (typeof value === 'object' && !Array.isArray(value)) return { ...value }
        return null
      }
      const sourceArgs = spec
        ? specFrom(spec.from)
        : args.sourceRef || args.sourceSelector || args.sourceText
          ? { ref: args.sourceRef, selector: args.sourceSelector, text: args.sourceText }
          : null
      const destinationArgs = spec
        ? specFrom(spec.to)
        : args.targetRef || args.targetSelector || args.targetText
          ? { ref: args.targetRef, selector: args.targetSelector, text: args.targetText }
          : null
      if (!sourceArgs || !destinationArgs) {
        throw new Error(
          'action=drag 需要源与目标：sourceRef/sourceSelector + targetRef/targetSelector，或 drag={from,to}。',
        )
      }
      target = await resolveTarget(manager, page, sourceArgs, { forText: true })
      dragDestination = await resolveTarget(manager, page, destinationArgs, { forText: true })
      await target.locator.waitFor({ state: 'visible', timeout })
      await dragDestination.locator.waitFor({ state: 'visible', timeout })
      assertNotAborted(exec)
      await target.locator.dragTo(dragDestination.locator, { timeout })
      message = `已将 ${target.label} 拖拽到 ${dragDestination.label}。`
      break
    }

    case 'upload': {
      target = await resolveTarget(manager, page, args)
      const rawFiles = args.files === null || args.files === undefined
        ? []
        : Array.isArray(args.files)
          ? args.files
          : [args.files]
      const files = rawFiles.map(item => String(item ?? '').trim()).filter(Boolean)
      if (files.length === 0) {
        throw new Error('action=upload 时必须提供 files 字符串数组（本地文件路径）。')
      }
      for (const file of files) {
        let stat = null
        try {
          stat = existsSync(file) ? statSync(file) : null
        } catch {
          stat = null
        }
        if (!stat || !stat.isFile()) {
          throw new Error(`上传文件不存在或不是普通文件：${file}。请传入本机可访问的绝对路径或工作目录相对路径。`)
        }
      }
      assertNotAborted(exec)
      await target.locator.setInputFiles(files, { timeout })
      message = `已向 ${target.label} 选择 ${files.length} 个文件。`
      break
    }

    case 'back': {
      assertNotAborted(exec)
      const result = await page.goBack({ waitUntil: 'domcontentloaded', timeout })
      if (result === null || result === undefined) {
        warning = '当前标签页没有可后退的历史记录。'
        message = '没有可后退的历史记录。'
      } else {
        message = '已后退。'
      }
      break
    }

    case 'forward': {
      assertNotAborted(exec)
      const result = await page.goForward({ waitUntil: 'domcontentloaded', timeout })
      if (result === null || result === undefined) {
        warning = '当前标签页没有可前进的历史记录。'
        message = '没有可前进的历史记录。'
      } else {
        message = '已前进。'
      }
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
      await raceAbort(sleep(ms), exec?.signal, '等待')
      message = `已等待 ${ms}ms。`
      break
    }

    case 'waitFor': {
      const stateName = WAIT_STATES.has(args.state) ? args.state : 'visible'
      if (args.urlPattern) {
        const pattern = String(args.urlPattern)
        let matcher = pattern
        if (!/[*?]/.test(pattern)) {
          try {
            matcher = new RegExp(pattern)
          } catch {
            matcher = pattern
          }
        }
        assertNotAborted(exec)
        await page.waitForURL(matcher, { timeout })
        message = `已等待 URL 匹配：${pattern}。`
      } else if (args.responseUrl) {
        const needle = String(args.responseUrl)
        assertNotAborted(exec)
        const response = await page.waitForResponse(
          candidate => String(candidate.url?.() || '').includes(needle),
          { timeout },
        )
        responseInfo = {
          url: String(response?.url?.() || ''),
          status: typeof response?.status === 'function' ? response.status() : null,
        }
        message = `已等待响应：${responseInfo.url}（状态 ${responseInfo.status ?? '?'}）。`
      } else if (args.ref || args.selector || args.text) {
        target = await resolveTarget(manager, page, args, { forText: true, allowMissing: true })
        assertNotAborted(exec)
        try {
          await target.locator.waitFor({ state: stateName, timeout })
        } catch (error) {
          waitSucceeded = false
          throw new Error(
            `等待 ${target.label} 进入 ${stateName} 状态超时（${timeout}ms）：${errorMessage(error)}`,
          )
        }
        message = `已等待 ${target.label} 进入 ${stateName} 状态。`
      } else {
        throw new Error(
          'action=waitFor 需要 ref/selector/text，或 urlPattern，或 responseUrl 之一来指定等待条件。',
        )
      }
      break
    }

    case 'dialog': {
      const mode =
        args.dialogAction === 'accept' || args.dialogAction === 'dismiss'
          ? args.dialogAction
          : args.value === 'accept' || args.value === 'dismiss'
            ? args.value
            : args.accept === false
              ? 'dismiss'
              : 'accept'
      let recorded = null
      try {
        recorded = manager?.takeDialog?.(page) ?? null
      } catch {
        recorded = null
      }
      if (recorded) {
        recordDialog({ type: recorded.type || '', message: recorded.message || '' })
        message =
          `检测到对话框（${recorded.type || '未知'}）：${recorded.message || ''}。` +
          `页面事件已自动处理；如需自定义接受/关闭，请在触发动作时传 dialog="${mode}"。`
      } else {
        waitSucceeded = false
        warning = '未检测到待处理对话框。'
        message =
          '当前没有待处理的对话框。dialog 动作只能报告最近出现的对话框；' +
          '如需接受/关闭由某个动作触发的对话框，请在同一个动作参数里设置 dialog="accept" 或 "dismiss"。'
      }
      break
    }

    default:
      throw new Error(`不支持的 action：${action}。`)
  }

  assertNotAborted(exec)

  // 动作未触发对话框时移除一次性监听，避免污染后续动作。
  if (preDialogHandler && typeof page.off === 'function') {
    try {
      page.off('dialog', preDialogHandler)
    } catch {
      /* ignore */
    }
  }

  if (
    ['click', 'type', 'press', 'select', 'check', 'uncheck', 'drag', 'upload', 'back', 'forward', 'reload'].includes(
      action,
    ) &&
    typeof page.waitForLoadState === 'function'
  ) {
    await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {})
  }

  await sleep(120)

  if (!handledDialog && typeof manager?.takeDialog === 'function') {
    try {
      const recorded = manager.takeDialog(page)
      if (recorded) recordDialog({ type: recorded.type || '', message: recorded.message || '' })
    } catch {
      /* 对话框读取失败不影响动作结果 */
    }
  }
  if (preDialogMode && handledDialog) {
    message += ` 已${preDialogMode === 'accept' ? '接受' : '关闭'}对话框（${handledDialog.type || '未知'}）：${handledDialog.message || ''}`
  }

  const newTab = verifyEnabled ? await detectNewTab(page, beforePages) : { opened: false, url: '', title: '' }
  const after = verifyEnabled ? await readPageMeta(page) : { url: '', title: '' }

  let verify = null
  if (verifyEnabled) {
    verify = {
      ok: true,
      exists: null,
      visible: null,
      value: null,
      checked: null,
      selected: null,
      aria: {},
      urlChanged: after.url !== before.url,
      titleChanged: after.title !== before.title,
      dialog: handledDialog
        ? { type: handledDialog.type || '', message: handledDialog.message || '' }
        : null,
      newTab: Boolean(newTab.opened),
      notes,
    }
    if (newTab.opened && newTab.url) verify.newTabUrl = newTab.url
    if (responseInfo) verify.response = responseInfo

    if (target && TARGET_ACTIONS.has(action)) {
      const stateRead = await readElement(target.locator, notes)
      verify.exists = stateRead.exists
      verify.visible = stateRead.visible
      verify.value = stateRead.value
      verify.checked = stateRead.checked
      verify.selected = stateRead.selected
      verify.aria = stateRead.aria
      if (!stateRead.exists) {
        verify.ok = false
        notes.push('回读时目标已不在页面中（可能触发了导航、关闭或重渲染）。')
      } else if (!stateRead.visible) {
        verify.ok = false
        notes.push('回读时目标不可见。')
      }
      if (stateRead.error) verify.ok = false
      if (stateRead.disabled) notes.push('目标当前处于 disabled 状态，操作可能未生效。')
      if (target.matchCount > 1) {
        notes.push(`共匹配 ${target.matchCount} 个元素，已使用第 ${target.chosenIndex + 1} 个（chosenIndex=${target.chosenIndex}）。`)
      }

      if (action === 'type') {
        const expected = typeof args.value === 'string' ? args.value : ''
        if (stateRead.type === 'password') {
          if (!stateRead.exists) verify.ok = false
        } else if (String(stateRead.value ?? '') !== expected) {
          verify.ok = false
          notes.push(
            `回读 value 与期望不一致：实际 ${JSON.stringify(String(stateRead.value ?? '').slice(0, 120))}，` +
              `期望 ${JSON.stringify(expected.slice(0, 120))}。`,
          )
        }
      } else if (action === 'check' || action === 'uncheck') {
        const expected = action === 'check'
        if (stateRead.checked !== expected) {
          verify.ok = false
          notes.push(
            `回读 checked=${stateRead.checked === null ? '(不可读)' : stateRead.checked}，期望 ${expected}。` +
              '元素可能被禁用、不是可勾选控件，或表单逻辑已重置状态。',
          )
        }
      } else if (action === 'select') {
        const expected = typeof args.value === 'string' ? args.value : ''
        const selected = Array.isArray(stateRead.selected)
          ? stateRead.selected.map(item => (typeof item === 'string' ? item : item?.label ?? item?.value ?? ''))
          : []
        verify.selected = selected
        if (selected.length === 0) {
          verify.ok = false
          notes.push('回读时没有选中项。')
        } else if (
          !stateRead.selected.some(item => {
            if (typeof item === 'string') return item === expected
            return item?.value === expected || item?.label === expected || String(item?.label || '').includes(expected)
          })
        ) {
          verify.ok = false
          notes.push(`回读选中项为 ${selected.map(item => `“${item}”`).join('、')}，未包含期望的“${expected}”。`)
        }
      } else if (action === 'drag' && dragDestination) {
        const destinationState = await readElement(dragDestination.locator, notes)
        if (!destinationState.exists) {
          verify.ok = false
          notes.push('回读时拖拽目标已不在页面中。')
        }
      } else if (action === 'upload') {
        if (stateRead.value === null || stateRead.value === '') {
          notes.push('文件输入框没有可回读的文件名；请结合页面提示确认上传是否已接受。')
        }
      }
    } else if (action === 'waitFor') {
      if (!waitSucceeded) verify.ok = false
      if (target) {
        const stateRead = await readElement(target.locator, notes)
        verify.exists = stateRead.exists
        verify.visible = stateRead.visible
      }
    } else if (action === 'dialog') {
      verify.ok = Boolean(handledDialog)
      if (!handledDialog) notes.push('没有检测到对话框。')
    }
  }

  message += completionSuffix(action, verify)

  const result = {
    message,
    action,
    target: targetInfo(target),
    verify,
    pageChanged: Boolean(
      verify
        ? verify.urlChanged || verify.titleChanged || verify.newTab
        : after.url !== before.url || after.title !== before.title || newTab.opened,
    ),
  }
  if (target) {
    result.matchCount = target.matchCount
    result.chosenIndex = target.chosenIndex
  }
  if (dragDestination) result.destination = targetInfo(dragDestination)
  if (warning) result.warning = warning
  return result
}

/** 兼容别名：tools-surface 可直接以 performAction 语义调用。 */
export const doAction = performAction
