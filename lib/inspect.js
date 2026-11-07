import { ArtifactStore } from './artifacts.js'
import { truncate } from './util.js'

const MODES = new Set([
  'overview',
  'dom',
  'html',
  'css',
  'a11y',
  'box',
  'resources',
  'scripts',
  'storage',
  'console',
  'performance',
  'eval',
])

const DEFAULT_CSS_PROPERTIES = [
  'color',
  'background',
  'font-size',
  'display',
  'position',
  'width',
  'height',
  'overflow',
  'z-index',
  'visibility',
  'opacity',
]

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function configOf(context) {
  if (context?.config && typeof context.config === 'object') return context.config
  if (
    context &&
    typeof context === 'object' &&
    !Array.isArray(context) &&
    ('artifactDir' in context || 'allowEval' in context || 'extractMaxChars' in context)
  ) {
    return context
  }
  return {}
}

function maxCharsOf(args, context) {
  const config = configOf(context)
  return clampInt(
    args?.maxChars,
    config.inspectMaxChars || config.extractMaxChars || 30000,
    1000,
    200000,
  )
}

function storeOf(context) {
  return new ArtifactStore(configOf(context))
}

async function pageMeta(page, context) {
  let title = ''
  try {
    title = await Promise.race([
      page.title(),
      new Promise(resolve => setTimeout(() => resolve(''), 1200)),
    ])
  } catch {
    title = ''
  }
  return {
    title: String(title || '').replace(/\s+/g, ' ').slice(0, 200),
    url: page.url(),
    tab: context?.state?.tabId ?? context?.tabId ?? null,
  }
}

async function limitText(text, context, { maxChars, kind, prefix, url, tabId }) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return { text: value, truncated: false }
  const bounded = truncate(value, maxChars)
  try {
    const meta = await storeOf(context).saveText(value, {
      kind: kind || 'inspect-text',
      prefix: prefix || 'inspect',
      url,
      tabId,
    })
    return { text: bounded.text, truncated: true, savedPath: meta.path, artifact: meta }
  } catch (error) {
    return { text: bounded.text, truncated: true, saveError: errorMessage(error) }
  }
}

async function limitJson(value, context, { maxChars, kind, prefix, url, tabId }) {
  const text = JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return { saved: null, truncated: false }
  try {
    const meta = await storeOf(context).saveJson(value, {
      kind: kind || 'inspect-json',
      prefix: prefix || 'inspect',
      url,
      tabId,
    })
    return { saved: meta, truncated: true }
  } catch (error) {
    return { saved: null, truncated: true, saveError: errorMessage(error) }
  }
}

// ---------------------------------------------------------------------------
// 页面内读取函数
// ---------------------------------------------------------------------------

function overviewInPage() {
  const safe = fn => {
    try {
      return fn()
    } catch {
      return null
    }
  }
  const resources = safe(() => performance.getEntriesByType('resource')) || []
  const frameworks = []
  safe(() => {
    const w = window
    if (w.__NEXT_DATA__) frameworks.push('Next.js')
    if (w.__NUXT__) frameworks.push('Nuxt')
    if (w.React || w.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot]')) {
      frameworks.push('React')
    }
    if (w.Vue || w.__VUE__ || document.querySelector('[data-v-app]')) frameworks.push('Vue')
    if (w.ng || document.querySelector('[ng-version]')) frameworks.push('Angular')
    if (document.querySelector('[class*="svelte-"]')) frameworks.push('Svelte')
    if (w.jQuery?.fn?.jquery) frameworks.push(`jQuery ${w.jQuery.fn.jquery}`)
  })
  return {
    lang: document.documentElement.lang || navigator.language || '',
    charset: document.characterSet || '',
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    scroll: {
      y: Math.round(window.scrollY),
      x: Math.round(window.scrollX),
      height: Math.max(
        document.documentElement?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
      ),
      viewport: window.innerHeight,
    },
    counts: {
      frames: document.querySelectorAll('iframe,frame').length,
      resources: resources.length,
      scripts: document.scripts.length,
      forms: document.forms.length,
      images: document.images.length,
      links: document.links.length,
      tables: document.querySelectorAll('table').length,
      headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length,
      domNodes: document.getElementsByTagName('*').length,
    },
    generator: document.querySelector('meta[name="generator"]')?.content || '',
    frameworks,
  }
}

function domInPage({ selector, depth, maxNodes, includeText, attrs }) {
  const attrNames = Array.isArray(attrs) && attrs.length
    ? attrs.map(String).slice(0, 20)
    : ['id', 'class', 'name', 'type', 'href', 'src', 'role', 'aria-label', 'data-testid', 'placeholder']
  const lines = []
  let count = 0
  let truncated = false
  let depthLimited = false
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  const cut = (value, max) => {
    const text = norm(value)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }
  const skip = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'link', 'meta'])

  const textOf = el => {
    if (!includeText) return ''
    let direct = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) direct += node.nodeValue || ''
    }
    const text = direct || el.getAttribute('aria-label') || el.getAttribute('placeholder') || ''
    return cut(text, 100)
  }

  const describe = el => {
    const tag = el.tagName.toLowerCase()
    if (skip.has(tag)) return null
    let head = tag
    const id = el.getAttribute('id')
    if (id) head += `#${cut(id, 60)}`
    const classes = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map(item => `.${cut(item, 40)}`)
      .join('')
    head += classes
    const pairs = []
    for (const name of attrNames) {
      if (name === 'id' || name === 'class') continue
      const value = el.getAttribute(name)
      if (value !== null && value !== '') pairs.push(`${name}="${cut(value, 80)}"`)
    }
    const text = textOf(el)
    return `${head}${pairs.length ? ` [${pairs.join(' ')}]` : ''}${text ? ` "${text}"` : ''}`
  }

  const walk = (el, level) => {
    if (!el || el.nodeType !== 1) return
    if (count >= maxNodes) {
      truncated = true
      return
    }
    const line = describe(el)
    if (line === null) return
    if (line) {
      lines.push(`${'  '.repeat(level)}${line}`)
      count += 1
    }
    const children = []
    if (el.shadowRoot) children.push(...el.shadowRoot.children)
    children.push(...el.children)
    if (!children.length) return
    if (level >= depth) {
      depthLimited = true
      return
    }
    for (const child of children) walk(child, level + 1)
  }

  let root = null
  try {
    root = document.querySelector(selector || 'body')
  } catch (error) {
    return { found: false, error: `selector 无效：${String(error?.message || error)}`, lines: [], count: 0 }
  }
  if (!root) return { found: false, lines: [], count: 0 }
  walk(root, 0)
  return { found: true, lines, count, truncated, depthLimited }
}

function a11yInPage({ selector, maxNodes }) {
  const rows = []
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  const roleOf = el => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().toLowerCase().split(/\s+/)[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'img') return 'img'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (type === 'submit' || type === 'button') return 'button'
      return 'textbox'
    }
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (['nav', 'main', 'header', 'footer', 'form', 'dialog'].includes(tag)) return tag
    return 'generic'
  }
  const nameOf = el => {
    const labels = el.labels ? [...el.labels].map(label => label.innerText) : []
    return norm(
      el.getAttribute('aria-label') ||
        el.getAttribute('alt') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        labels.join(' ') ||
        el.innerText ||
        '',
    ).slice(0, 160)
  }
  const walk = (el, level) => {
    if (!el || el.nodeType !== 1 || rows.length >= maxNodes) return
    if (el.getAttribute('aria-hidden') === 'true') return
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return
    const role = roleOf(el)
    if (role !== 'generic' || el.getAttribute('aria-label') || el.tagName.match(/^H[1-6]$/)) {
      rows.push({
        level,
        role,
        name: nameOf(el),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        expanded: el.getAttribute('aria-expanded'),
        checked: el.checked === true || el.getAttribute('aria-checked'),
      })
    }
    const children = []
    if (el.shadowRoot) children.push(...el.shadowRoot.children)
    children.push(...el.children)
    for (const child of children) walk(child, level + 1)
  }
  let root = null
  try {
    root = document.querySelector(selector || 'body')
  } catch (error) {
    return { rows: [], error: `selector 无效：${String(error?.message || error)}` }
  }
  if (root) walk(root, 0)
  return { rows }
}

function boxInPage({ selector }) {
  let el = null
  try {
    el = document.querySelector(selector || 'body')
  } catch (error) {
    return { found: false, error: `selector 无效：${String(error?.message || error)}` }
  }
  if (!el) return { found: false }
  const style = getComputedStyle(el)
  const rect = el.getBoundingClientRect()
  const visibility = style.visibility
  const visible =
    style.display !== 'none' &&
    visibility !== 'hidden' &&
    visibility !== 'collapse' &&
    Number(style.opacity || 1) > 0 &&
    rect.width > 0 &&
    rect.height > 0
  const inViewport =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(0, window.innerWidth - 1))
  const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(0, window.innerHeight - 1))
  let top = null
  try {
    top = document.elementFromPoint(x, y)
  } catch {
    top = null
  }
  const obscured = Boolean(
    top && top !== el && !el.contains(top) && !top.contains(el),
  )
  const describe = node => {
    if (!node) return null
    const tag = node.tagName?.toLowerCase?.() || ''
    const id = node.getAttribute?.('id') || ''
    const cls = (node.getAttribute?.('class') || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')
    return `${tag}${id ? `#${id}` : ''}${cls ? `.${cls}` : ''}`
  }
  let zIndex = style.zIndex
  if (!zIndex || zIndex === 'auto') {
    let parent = el.parentElement
    while (parent && (!zIndex || zIndex === 'auto')) {
      zIndex = getComputedStyle(parent).zIndex
      parent = parent.parentElement
    }
  }
  return {
    found: true,
    visible,
    inViewport,
    obscured,
    obscuredBy: obscured ? describe(top) : null,
    zIndex: zIndex && zIndex !== 'auto' ? Number(zIndex) : null,
    display: style.display,
    visibility,
    opacity: Number(style.opacity || 1),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      bottom: Math.round(rect.bottom),
      right: Math.round(rect.right),
    },
  }
}

function resourcesInPage() {
  return (performance.getEntriesByType('resource') || []).map(entry => ({
    name: entry.name,
    initiatorType: entry.initiatorType || '',
    duration: Math.round(entry.duration || 0),
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    decodedBodySize: entry.decodedBodySize || 0,
    startTime: Math.round(entry.startTime || 0),
  }))
}

function scriptsInPage() {
  return [...document.scripts].map((script, index) => ({
    index,
    src: script.src || '',
    id: script.id || '',
    type: script.type || '',
    async: Boolean(script.async),
    defer: Boolean(script.defer),
    module: (script.type || '').toLowerCase() === 'module',
    inlineChars: script.src ? 0 : (script.textContent || '').length,
  }))
}

async function storageInPage({ includeSecrets, limit }) {
  const read = storage => {
    const out = []
    if (!storage) return out
    const max = Math.max(1, Math.min(Number(limit) || 200, 1000))
    for (let index = 0; index < storage.length && out.length < max; index += 1) {
      const key = storage.key(index)
      if (key === null) continue
      let value = storage.getItem(key) ?? ''
      const length = value.length
      if (!includeSecrets) value = '***'
      out.push({ key: String(key).slice(0, 200), value, length })
    }
    return out
  }
  const result = {
    localStorage: read(window.localStorage),
    sessionStorage: read(window.sessionStorage),
    indexedDB: [],
  }
  try {
    const databases = await indexedDB.databases?.()
    if (Array.isArray(databases)) {
      result.indexedDB = databases.slice(0, 100).map(item => item.name || '')
    }
  } catch {
    result.indexedDB = []
  }
  return result
}

function performanceInPage() {
  const navigation = performance.getEntriesByType('navigation')?.[0] || null
  const resources = performance.getEntriesByType('resource') || []
  const byType = {}
  let transferSize = 0
  let decodedBodySize = 0
  for (const entry of resources) {
    const type = entry.initiatorType || 'other'
    byType[type] ||= { count: 0, transferSize: 0, decodedBodySize: 0 }
    byType[type].count += 1
    byType[type].transferSize += entry.transferSize || 0
    byType[type].decodedBodySize += entry.decodedBodySize || 0
    transferSize += entry.transferSize || 0
    decodedBodySize += entry.decodedBodySize || 0
  }
  return {
    navigation: navigation
      ? {
          type: navigation.type,
          startTime: Math.round(navigation.startTime || 0),
          duration: Math.round(navigation.duration || 0),
          domContentLoadedEventEnd: Math.round(navigation.domContentLoadedEventEnd || 0),
          loadEventEnd: Math.round(navigation.loadEventEnd || 0),
          responseStart: Math.round(navigation.responseStart || 0),
          transferSize: navigation.transferSize || 0,
          encodedBodySize: navigation.encodedBodySize || 0,
          decodedBodySize: navigation.decodedBodySize || 0,
        }
      : null,
    resources: {
      count: resources.length,
      transferSize,
      decodedBodySize,
      byType,
    },
    domNodes: document.getElementsByTagName('*').length,
    heap: performance.memory
      ? {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function inspectPage(page, args = {}, context = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  const mode = String(args.mode || 'overview').trim().toLowerCase()
  if (!MODES.has(mode)) {
    throw new Error(`不支持的 inspect 模式：${mode}。可选：${[...MODES].join('、')}。`)
  }
  if (page.isClosed()) throw new Error('标签页已关闭，无法检查页面。')
  const config = configOf(context)
  const maxChars = maxCharsOf(args, context)
  const info = await pageMeta(page, context)
  const base = { mode, page: info }

  if (mode === 'overview') {
    try {
      const data = await page.evaluate(overviewInPage)
      return { ...base, ...data }
    } catch (error) {
      throw new Error(`读取页面概览失败：${errorMessage(error)}`)
    }
  }

  if (mode === 'dom') {
    const selector = String(args.selector || 'body')
    const depth = clampInt(args.depth, 4, 0, 12)
    const maxNodes = clampInt(args.maxNodes || args.limit, 300, 1, 2000)
    let result
    try {
      result = await page.evaluate(domInPage, {
        selector,
        depth,
        maxNodes,
        includeText: args.includeText !== false,
        attrs: Array.isArray(args.attrs) ? args.attrs : null,
      })
    } catch (error) {
      throw new Error(`读取 DOM 失败：${errorMessage(error)}`)
    }
    if (!result.found) {
      return {
        ...base,
        selector,
        depth,
        maxNodes,
        count: 0,
        truncated: false,
        note: result.error || `selector 没有匹配到元素：${selector}`,
      }
    }
    const bounded = await limitText(result.lines.join('\n'), context, {
      maxChars,
      kind: 'inspect-dom',
      prefix: 'inspect-dom',
      url: info.url,
      tabId: info.tab,
    })
    return {
      ...base,
      selector,
      depth,
      maxNodes,
      count: result.count,
      truncated: result.truncated || bounded.truncated,
      depthLimited: result.depthLimited,
      text: bounded.text,
      savedPath: bounded.savedPath,
    }
  }

  if (mode === 'html') {
    const selector = String(args.selector || 'html')
    const fullPage = Boolean(args.fullPage)
    let html = null
    try {
      html = await page.evaluate(
        ({ sel, whole }) => {
          const target = whole ? document.documentElement : document.querySelector(sel)
          return target ? target.outerHTML : null
        },
        { sel: selector, whole: fullPage },
      )
    } catch (error) {
      throw new Error(`读取 HTML 失败：${errorMessage(error)}`)
    }
    if (html == null) throw new Error(`selector 没有匹配到元素：${selector}`)
    let bounded
    if (fullPage) {
      // fullPage 始终落盘一份完整 HTML，返回值只保留 maxChars 窗口。
      try {
        const meta = await storeOf(context).saveText(html, {
          kind: 'inspect-page',
          prefix: 'inspect-page',
          url: info.url,
          tabId: info.tab,
        })
        bounded = {
          text: truncate(html, maxChars).text,
          truncated: html.length > maxChars,
          savedPath: meta.path,
          artifact: meta,
        }
      } catch (error) {
        bounded = await limitText(html, context, {
          maxChars,
          kind: 'inspect-page',
          prefix: 'inspect-page',
          url: info.url,
          tabId: info.tab,
        })
        bounded.saveError = errorMessage(error)
      }
    } else {
      bounded = await limitText(html, context, {
        maxChars,
        kind: 'inspect-html',
        prefix: 'inspect-html',
        url: info.url,
        tabId: info.tab,
      })
    }
    return {
      ...base,
      selector: fullPage ? 'html' : selector,
      fullPage,
      length: html.length,
      html: bounded.text,
      truncated: bounded.truncated,
      savedPath: bounded.savedPath,
      ...(bounded.saveError ? { saveError: bounded.saveError } : {}),
    }
  }

  if (mode === 'css') {
    const selector = String(args.selector || 'body')
    const properties = Array.isArray(args.properties) && args.properties.length
      ? args.properties.map(String).slice(0, 40)
      : DEFAULT_CSS_PROPERTIES
    let result
    try {
      result = await page.evaluate(
        ({ sel, props }) => {
          const el = document.querySelector(sel)
          if (!el) return { found: false, count: 0, styles: {} }
          const count = document.querySelectorAll(sel).length
          const computed = getComputedStyle(el)
          const styles = {}
          for (const name of props) styles[name] = computed.getPropertyValue(name)
          return { found: true, count, styles }
        },
        { sel: selector, props: properties },
      )
    } catch (error) {
      throw new Error(`读取样式失败：${errorMessage(error)}`)
    }
    if (!result.found) {
      return { ...base, selector, properties, count: 0, styles: {}, note: 'selector 没有匹配到元素。' }
    }
    return {
      ...base,
      selector,
      properties,
      count: result.count,
      styles: result.styles,
    }
  }

  if (mode === 'a11y') {
    const selector = String(args.selector || 'body')
    let yaml = ''
    let source = 'ariaSnapshot'
    let rows = []
    try {
      const locator = page.locator(selector).first()
      if (typeof locator.ariaSnapshot !== 'function') throw new Error('当前 Playwright 版本不支持 ariaSnapshot')
      yaml = await locator.ariaSnapshot()
    } catch (snapshotError) {
      source = 'aria-attributes'
      try {
        const fallback = await page.evaluate(a11yInPage, {
          selector,
          maxNodes: clampInt(args.maxNodes, 300, 1, 2000),
        })
        rows = fallback.rows || []
        yaml = rows
          .map(row => {
            const name = row.name ? ` "${String(row.name).replace(/"/g, '\\"')}"` : ''
            const flags = [
              row.disabled ? 'disabled' : '',
              row.expanded !== null ? `expanded=${row.expanded}` : '',
              row.checked !== null ? `checked=${row.checked}` : '',
            ].filter(Boolean)
            return `${'  '.repeat(Math.min(row.level, 8))}- ${row.role}${name}${flags.length ? ` [${flags.join(', ')}]` : ''}`
          })
          .join('\n')
        if (!rows.length) yaml = fallback.error || ''
      } catch (fallbackError) {
        return {
          ...base,
          selector,
          source: 'none',
          yaml: '',
          rows: [],
          note: `ariaSnapshot 与 aria 属性回退均失败：${errorMessage(snapshotError)}；${errorMessage(fallbackError)}`,
        }
      }
    }
    const bounded = await limitText(yaml, context, {
      maxChars,
      kind: 'inspect-a11y',
      prefix: 'inspect-a11y',
      url: info.url,
      tabId: info.tab,
    })
    return {
      ...base,
      selector,
      source,
      yaml: bounded.text,
      rows,
      truncated: bounded.truncated,
      savedPath: bounded.savedPath,
    }
  }

  if (mode === 'box') {
    const selector = String(args.selector || 'body')
    let box = null
    try {
      box = await page.locator(selector).first().boundingBox({ timeout: 3000 })
    } catch {
      box = null
    }
    let details
    try {
      details = await page.evaluate(boxInPage, { selector })
    } catch (error) {
      throw new Error(`读取元素盒模型失败：${errorMessage(error)}`)
    }
    if (!details?.found) {
      return { ...base, selector, box: null, note: details?.error || 'selector 没有匹配到元素。' }
    }
    return {
      ...base,
      selector,
      box,
      ...details,
    }
  }

  if (mode === 'resources') {
    let entries
    try {
      entries = await page.evaluate(resourcesInPage)
    } catch (error) {
      throw new Error(`读取资源列表失败：${errorMessage(error)}`)
    }
    if (args.urlPattern) {
      let pattern
      try {
        pattern = new RegExp(String(args.urlPattern), 'i')
      } catch (error) {
        throw new Error(`urlPattern 正则无效：${errorMessage(error)}`)
      }
      entries = entries.filter(entry => pattern.test(entry.name))
    }
    const limit = clampInt(args.limit, 30, 1, 500)
    const byType = {}
    let transferSize = 0
    let decodedBodySize = 0
    for (const entry of entries) {
      const type = entry.initiatorType || 'other'
      byType[type] ||= { count: 0, transferSize: 0, decodedBodySize: 0 }
      byType[type].count += 1
      byType[type].transferSize += entry.transferSize
      byType[type].decodedBodySize += entry.decodedBodySize
      transferSize += entry.transferSize
      decodedBodySize += entry.decodedBodySize
    }
    const value = {
      ...base,
      count: entries.length,
      totalTransferSize: transferSize,
      totalDecodedBodySize: decodedBodySize,
      byType,
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
    }
    const limited = await limitJson(value, context, {
      maxChars,
      kind: 'inspect-resources',
      prefix: 'inspect-resources',
      url: info.url,
      tabId: info.tab,
    })
    if (limited.saved) {
      return {
        ...value,
        entries: value.entries.slice(0, Math.min(10, limit)),
        truncated: true,
        savedPath: limited.saved.path,
        note: '资源列表超过长度上限，完整 JSON 已落盘。',
      }
    }
    return value
  }

  if (mode === 'scripts') {
    let scripts
    try {
      scripts = await page.evaluate(scriptsInPage)
    } catch (error) {
      throw new Error(`读取脚本列表失败：${errorMessage(error)}`)
    }
    const limit = clampInt(args.limit, 200, 1, 2000)
    const value = {
      ...base,
      count: scripts.length,
      entries: scripts.slice(0, limit),
      truncated: scripts.length > limit,
    }
    const limited = await limitJson(value, context, {
      maxChars,
      kind: 'inspect-scripts',
      prefix: 'inspect-scripts',
      url: info.url,
      tabId: info.tab,
    })
    if (limited.saved) {
      return {
        ...value,
        entries: value.entries.slice(0, 20),
        truncated: true,
        savedPath: limited.saved.path,
        note: '脚本列表超过长度上限，完整 JSON 已落盘。',
      }
    }
    return value
  }

  if (mode === 'storage') {
    const includeSecrets = args.includeSecrets === true
    const limit = clampInt(args.limit, 200, 1, 1000)
    let cookies = []
    try {
      const browserContext = page.context()
      cookies = browserContext ? await browserContext.cookies() : []
    } catch {
      cookies = []
    }
    const totalCookies = cookies.length
    const cookieItems = cookies.slice(0, limit).map(cookie => {
      const item = {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
      }
      if (includeSecrets) item.value = cookie.value
      return item
    })
    let pageStorage
    try {
      pageStorage = await page.evaluate(storageInPage, { includeSecrets, limit })
    } catch (error) {
      throw new Error(`读取 Web Storage 失败：${errorMessage(error)}`)
    }
    const value = {
      ...base,
      redacted: !includeSecrets,
      includeSecrets,
      cookies: {
        count: totalCookies,
        items: cookieItems,
        truncated: totalCookies > cookieItems.length,
      },
      localStorage: pageStorage.localStorage,
      sessionStorage: pageStorage.sessionStorage,
      indexedDB: pageStorage.indexedDB,
      note: includeSecrets
        ? 'includeSecrets=true，已返回 cookie 与 storage 原值，请勿写入日志或公开输出。'
        : '默认脱敏：cookie 不返回值，storage value 为 "***"。',
    }
    const limited = await limitJson(value, context, {
      maxChars,
      kind: 'inspect-storage',
      prefix: 'inspect-storage',
      url: info.url,
      tabId: info.tab,
    })
    if (limited.saved) {
      return {
        ...value,
        cookies: { ...value.cookies, items: value.cookies.items.slice(0, 10), truncated: true },
        localStorage: value.localStorage.slice(0, 10),
        sessionStorage: value.sessionStorage.slice(0, 10),
        truncated: true,
        savedPath: limited.saved.path,
        note: `${value.note} 内容超过长度上限，完整 JSON 已落盘。`,
      }
    }
    return value
  }

  if (mode === 'console') {
    const manager = context?.manager
    const entries = typeof manager?.getConsole === 'function' ? manager.getConsole(page) : []
    const limit = clampInt(args.limit, 100, 1, 200)
    const value = {
      ...base,
      count: entries.length,
      entries: entries.slice(-limit),
      truncated: entries.length > limit,
      note: entries.length ? '' : '当前标签页没有 console/error 记录（记录从页面注册或本次会话开始）。',
    }
    const limited = await limitJson(value, context, {
      maxChars,
      kind: 'inspect-console',
      prefix: 'inspect-console',
      url: info.url,
      tabId: info.tab,
    })
    if (limited.saved) {
      return {
        ...value,
        entries: value.entries.slice(-20),
        truncated: true,
        savedPath: limited.saved.path,
        note: 'console 记录超过长度上限，完整 JSON 已落盘。',
      }
    }
    return value
  }

  if (mode === 'performance') {
    let data
    try {
      data = await page.evaluate(performanceInPage)
    } catch (error) {
      throw new Error(`读取性能数据失败：${errorMessage(error)}`)
    }
    const value = { ...base, ...data }
    const limited = await limitJson(value, context, {
      maxChars,
      kind: 'inspect-performance',
      prefix: 'inspect-performance',
      url: info.url,
      tabId: info.tab,
    })
    if (limited.saved) {
      return {
        ...value,
        resources: { ...value.resources, byType: {} },
        truncated: true,
        savedPath: limited.saved.path,
        note: '性能数据超过长度上限，完整 JSON 已落盘。',
      }
    }
    return value
  }

  // eval
  if (config.allowEval !== true) {
    throw new Error('任意 JS 执行默认关闭，请在插件配置中显式设置 allowEval: true')
  }
  if (typeof args.script !== 'string' || !args.script.trim()) {
    throw new Error('eval 模式需要非空 script 参数。')
  }
  let value
  try {
    value = await page.evaluate(args.script)
  } catch (error) {
    // 只返回首行消息，避免把完整堆栈或页面内部细节带出去。
    throw new Error(`页面脚本执行失败：${String(errorMessage(error)).split('\n')[0].slice(0, 400)}`)
  }
  let jsonable
  try {
    jsonable = JSON.parse(JSON.stringify(value ?? null))
  } catch {
    jsonable = String(value)
  }
  const text = JSON.stringify(value ?? null, null, 2)
  if (text.length > maxChars) {
    try {
      const meta = await storeOf(context).saveJson(value ?? null, {
        kind: 'inspect-eval',
        prefix: 'inspect-eval',
        url: info.url,
        tabId: info.tab,
      })
      return {
        ...base,
        result: null,
        truncated: true,
        savedPath: meta.path,
        note: 'eval 结果超过长度上限，完整 JSON 已落盘。',
      }
    } catch (error) {
      return {
        ...base,
        result: jsonable,
        truncated: true,
        note: `eval 结果超过长度上限且落盘失败：${errorMessage(error)}`,
      }
    }
  }
  return { ...base, result: jsonable }
}
