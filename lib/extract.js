import { truncate } from './util.js'

const MAX_RAW_CHARS = 500000
const MAX_MARKDOWN_CHARS = 500000

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// 页面内提取函数。每个函数必须自包含（序列化后在 frame 中执行）。
// ---------------------------------------------------------------------------

function textInFrame({ selector }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { text: '', matches: 0, truncated: false }
  const matches = selector ? document.querySelectorAll(selector).length : 1
  let text = root.innerText || root.textContent || ''
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = text.length > 500000
  if (truncated) text = text.slice(0, 500000)
  return { text, matches, truncated }
}

function htmlInFrame({ selector }) {
  const root = selector ? document.querySelector(selector) : document.documentElement
  if (!root) return { html: '', matches: 0, truncated: false }
  const matches = selector ? document.querySelectorAll(selector).length : 1
  const html = root.outerHTML || ''
  return {
    html: html.slice(0, 500000),
    matches,
    truncated: html.length > 500000,
  }
}

function linksInFrame({ selector, limit }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { links: [], matches: 0 }
  const seen = new Set()
  const links = []
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.href || anchor.getAttribute('href') || ''
    const text = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim()
    const key = `${href}\u0000${text}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({
      text: text.slice(0, 300),
      href,
      title: (anchor.getAttribute('title') || '').slice(0, 200),
    })
    if (links.length >= limit) break
  }
  return { links, matches: root.querySelectorAll('a[href]').length }
}

function tablesInFrame({ selector, limit }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { tables: [], matches: 0 }
  const nodes = [...root.querySelectorAll('table')].slice(0, limit)
  const tables = nodes.map(table => {
    const rows = [...table.rows].slice(0, 300).map(row =>
      [...row.cells].slice(0, 30).map(cell => (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()),
    )
    const headerRow = table.tHead?.rows?.[0]
    const headerCells = headerRow
      ? [...headerRow.cells].map(cell => (cell.innerText || '').trim())
      : rows[0] && rows[0].length > 0
        ? null
        : []
    return {
      caption: (table.caption?.innerText || '').replace(/\s+/g, ' ').trim(),
      headers: headerCells,
      rows,
    }
  })
  return { tables, matches: root.querySelectorAll('table').length }
}

function structuredInFrame({ selector, fields }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { values: {}, matches: 0 }
  const values = {}
  for (const [key, raw] of Object.entries(fields || {})) {
    const def = typeof raw === 'string' ? { selector: raw } : raw || {}
    if (!def.selector) {
      values[key] = null
      continue
    }
    let elements
    try {
      elements = [...root.querySelectorAll(def.selector)]
    } catch {
      throw new Error(`字段 ${key} 的 CSS selector 无效：${def.selector}`)
    }
    const selected = def.all ? elements : elements.slice(0, 1)
    const read = el => {
      if (def.attr) {
        if ((def.attr === 'href' || def.attr === 'src') && el[def.attr]) return el[def.attr]
        return el.getAttribute(def.attr)
      }
      return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    }
    const mapped = selected.map(read).filter(value => value !== null && value !== undefined)
    const cleaned = def.all ? mapped.slice(0, 200).map(value => String(value).slice(0, 1000)) : mapped[0] ?? null
    values[key] = typeof cleaned === 'string' ? cleaned.slice(0, 20000) : cleaned
  }
  return { values, matches: Object.keys(fields || {}).length }
}

function markdownInFrame({ selector }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) {
    return { markdown: '', matches: 0, selectorMatches: 0, rootFound: false, truncated: false }
  }
  const selectorMatches = selector ? document.querySelectorAll(selector).length : 1
  const lines = []
  const skip = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'iframe',
    'object',
    'embed',
    'head',
    'meta',
    'link',
    'title',
    'br',
    'hr',
  ])
  const normalize = value =>
    String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .trim()

  const inline = node => {
    if (!node) return ''
    if (node.nodeType === 3) return String(node.nodeValue || '').replace(/\s+/g, ' ')
    if (node.nodeType !== 1) return ''
    const tag = node.tagName.toLowerCase()
    if (skip.has(tag)) return ''
    if (tag === 'br') return '\n'
    if (tag === 'img') {
      const alt = normalize(node.getAttribute('alt') || '')
      const src = node.currentSrc || node.src || node.getAttribute('src') || ''
      if (!src || String(src).startsWith('data:')) return alt
      return `![${alt}](${src})`
    }
    if (tag === 'code') return `\`${normalize(node.innerText || node.textContent || '')}\``
    const inner = [...node.childNodes].map(inline).join('')
    if (tag === 'a') {
      const href = node.href || node.getAttribute('href') || ''
      const text = normalize(inner)
      if (!text) return ''
      return href ? `[${text}](${href})` : text
    }
    if (tag === 'strong' || tag === 'b') return `**${normalize(inner)}**`
    if (tag === 'em' || tag === 'i') return `*${normalize(inner)}*`
    return inner
  }

  const push = value => {
    const text = String(value ?? '').trim()
    if (text) lines.push(text)
  }

  const table = node => {
    const rows = [...(node.rows || [])].slice(0, 300)
    if (!rows.length) return
    const matrix = rows.map(row =>
      [...row.cells].slice(0, 30).map(cell =>
        normalize(cell.innerText || cell.textContent || '')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' '),
      ),
    )
    const width = Math.max(...matrix.map(row => row.length), 0)
    if (!width) return
    const pad = row => {
      const copy = [...row]
      while (copy.length < width) copy.push('')
      return copy
    }
    const header = pad(matrix[0])
    push(`| ${header.join(' | ')} |`)
    push(`| ${header.map(() => '---').join(' | ')} |`)
    for (let index = 1; index < matrix.length; index += 1) {
      push(`| ${pad(matrix[index]).join(' | ')} |`)
    }
  }

  const blockTags = new Set([
    'body',
    'html',
    'div',
    'section',
    'article',
    'main',
    'header',
    'footer',
    'nav',
    'aside',
    'form',
    'details',
    'summary',
    'li',
    'dl',
    'dt',
    'dd',
    'figure',
    'figcaption',
    'fieldset',
    'legend',
  ])

  function walk(node, depth) {
    if (!node || node.nodeType !== 1) return
    const tag = node.tagName.toLowerCase()
    if (skip.has(tag)) return

    if (/^h[1-6]$/.test(tag)) {
      const text = normalize(inline(node))
      if (text) push(`${'#'.repeat(Number(tag[1]))} ${text}`)
      return
    }
    if (tag === 'p') {
      const text = normalize(inline(node))
      if (text) push(text)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      let index = 0
      for (const child of node.children) {
        const childTag = child.tagName.toLowerCase()
        if (childTag !== 'li') continue
        index += 1
        const marker = tag === 'ol' ? `${index}. ` : '- '
        const nested = []
        const parts = []
        for (const item of child.childNodes) {
          if (item.nodeType === 1 && ['ul', 'ol'].includes(item.tagName.toLowerCase())) {
            nested.push(item)
            continue
          }
          const value = inline(item)
          if (value) parts.push(value)
        }
        const text = normalize(parts.join(' '))
        if (text) push(`${'  '.repeat(depth)}${marker}${text}`)
        for (const sub of nested) walk(sub, depth + 1)
      }
      return
    }
    if (tag === 'table') {
      table(node)
      return
    }
    if (tag === 'pre') {
      const text = String(node.innerText || node.textContent || '').replace(/\n+$/, '')
      if (text.trim()) push('```\n' + text + '\n```')
      return
    }
    if (tag === 'blockquote') {
      const text = normalize(node.innerText || node.textContent || '')
      if (text) push(text.split(/\n+/).map(line => `> ${line}`).join('\n'))
      return
    }
    if (tag === 'hr') {
      push('---')
      return
    }
    if (tag === 'a' || tag === 'img' || tag === 'span' || tag === 'label' || tag === 'strong' || tag === 'em' || tag === 'code' || tag === 'b' || tag === 'i') {
      const text = normalize(inline(node))
      if (text) push(text)
      return
    }
    if (blockTags.has(tag)) {
      const hasElementChildren = node.children && node.children.length > 0
      if (hasElementChildren) {
        for (const child of node.childNodes) walk(child, depth)
      } else {
        const text = normalize(inline(node))
        if (text) push(text)
      }
      return
    }
    // 未知标签：有元素子节点则递归，否则按内联文本输出。
    if (node.children && node.children.length > 0) {
      for (const child of node.childNodes) walk(child, depth)
    } else {
      const text = normalize(inline(node))
      if (text) push(text)
    }
  }

  walk(root, 0)
  let markdown = lines
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const truncated = markdown.length > 500000
  if (truncated) markdown = markdown.slice(0, 500000)
  return { markdown, matches: selectorMatches, selectorMatches, rootFound: true, truncated }
}

function imagesInFrame({ selector, limit }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) {
    return { images: [], matches: 0, selectorMatches: 0, rootFound: false, skippedDataUrl: 0 }
  }
  const selectorMatches = selector ? document.querySelectorAll(selector).length : 1
  const nodes = root.querySelectorAll('img')
  const seen = new Set()
  const images = []
  let skippedDataUrl = 0
  for (const img of nodes) {
    const src = img.currentSrc || img.src || img.getAttribute('src') || ''
    if (!src) continue
    if (String(src).startsWith('data:')) {
      skippedDataUrl += 1
      continue
    }
    if (seen.has(src)) continue
    seen.add(src)
    const width = Number(img.naturalWidth || img.getAttribute('width') || img.width || 0) || null
    const height = Number(img.naturalHeight || img.getAttribute('height') || img.height || 0) || null
    images.push({
      src: String(src).slice(0, 4000),
      alt: String(img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      width,
      height,
      loading: String(img.getAttribute('loading') || ''),
    })
    if (images.length >= limit) break
  }
  return {
    images,
    matches: nodes.length,
    selectorMatches,
    rootFound: true,
    skippedDataUrl,
    truncated: nodes.length > images.length,
  }
}

function formsInFrame({ selector, limit, fieldLimit }) {
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) {
    return { forms: [], matches: 0, selectorMatches: 0, rootFound: false }
  }
  const selectorMatches = selector ? document.querySelectorAll(selector).length : 1
  const normalize = value =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
  const all = [...root.querySelectorAll('form')]
  const forms = all.slice(0, limit).map(form => {
    const fields = [...form.querySelectorAll('input,select,textarea')].slice(0, fieldLimit).map(field => {
      const tag = field.tagName.toLowerCase()
      const type = tag === 'input' ? String(field.getAttribute('type') || 'text').toLowerCase() : tag
      const labels =
        field.labels && field.labels.length
          ? [...field.labels].map(label => label.innerText).join(' ')
          : ''
      const label = normalize(
        labels ||
          field.getAttribute('aria-label') ||
          field.getAttribute('placeholder') ||
          field.getAttribute('title') ||
          '',
      ).slice(0, 200)
      let value = ''
      if (type === 'password' || type === 'file') {
        value = ''
      } else if (tag === 'select') {
        value = [...(field.selectedOptions || [])]
          .map(option => normalize(option.label ?? option.text ?? ''))
          .filter(Boolean)
          .join(', ')
      } else if (type === 'checkbox' || type === 'radio') {
        value = field.checked ? 'checked' : ''
      } else {
        value = field.value ?? ''
      }
      return {
        name: String(field.getAttribute('name') || ''),
        type,
        tag,
        label,
        required: Boolean(field.required),
        value: normalize(value).slice(0, 500),
      }
    })
    return {
      action: String(form.getAttribute('action') || form.action || ''),
      method: String(form.getAttribute('method') || 'get').toLowerCase(),
      name: String(form.getAttribute('name') || ''),
      id: String(form.getAttribute('id') || ''),
      fields,
    }
  })
  return {
    forms,
    matches: all.length,
    selectorMatches,
    rootFound: true,
    truncated: all.length > forms.length,
  }
}

// ---------------------------------------------------------------------------
// labeled 文本解析（保留旧逻辑并支持多个同标签取第一个非空）
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function cleanLabeledValue(value) {
  return String(value ?? '')
    .replace(/\s*复制\s*$/g, '')
    .replace(/\s*更多\s*\d*\s*$/g, '')
    .replace(/\s*展开\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从文本中按标签抽取值。支持：
 * - 表格单元格（innerText 常用 \t 分隔）；
 * - `label：value` / `label: value`；
 * - `label` 换行后跟 value（最多向后看 4 行）；
 * - 同一标签出现多次时取第一个非空值。
 */
export function parseLabeledText(text, labels) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const result = {}
  for (const label of labels) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*(.*)$`)
    let value = null
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      // 表格行常见用 tab 分隔： "登记状态\t存续\t成立日期\t1986-05-14"。
      const cells = line.split(/\t+/).map(cell => cell.trim())
      if (cells.length > 1) {
        const cellIndex = cells.findIndex(
          cell => cell === label || cell === `${label}：` || cell === `${label}:`,
        )
        if (cellIndex >= 0) {
          for (let next = cellIndex + 1; next < cells.length; next += 1) {
            const candidate = cleanLabeledValue(cells[next])
            if (candidate) {
              value = candidate
              break
            }
          }
          if (value) break
        }
      }
      // 纯标签行 + 下一行值： "注册资本\n5000万元"。
      if (line === label || line === `${label}：` || line === `${label}:`) {
        for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
          const candidate = lines[next]
          if (pattern.test(candidate)) break
          if (/[:：]\s*$/.test(candidate)) break
          if (/^[-—]+$/.test(candidate)) continue
          const cleaned = cleanLabeledValue(candidate)
          if (cleaned) {
            value = cleaned
            break
          }
        }
        if (value) break
      }
      const match = line.match(pattern)
      if (!match) continue
      const sameLine = cleanLabeledValue(match[1])
      if (sameLine) {
        value = sameLine
        break
      }
      for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
        const candidate = lines[next]
        if (pattern.test(candidate)) break
        if (/[:：]\s*$/.test(candidate)) break
        if (/^[-—]+$/.test(candidate)) continue
        const cleaned = cleanLabeledValue(candidate)
        if (cleaned) {
          value = cleaned
          break
        }
      }
      if (value) break
      // 第一个同标签为空：继续向后寻找下一个同标签，直到找到非空值。
    }
    result[label] = value || null
  }
  return result
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function applyCharWindow(content, options) {
  const full = String(content ?? '')
  const hasOffset = options.offset !== undefined && options.offset !== null
  const hasLimit = options.limit !== undefined && options.limit !== null
  if (!hasOffset && !hasLimit) {
    return { content: full, offset: 0, limit: full.length, nextCursor: null, length: full.length }
  }
  const offset = clampInt(options.offset, 0, 0, 100000000)
  const take = clampInt(options.limit, MAX_RAW_CHARS, 1, MAX_RAW_CHARS)
  const windowText = full.slice(offset, offset + take)
  const nextCursor = offset + take < full.length ? offset + take : null
  return { content: windowText, offset, limit: take, nextCursor, length: full.length }
}

async function evaluateInFrame(frame, fn, arg, mode) {
  try {
    return await frame.evaluate(fn, arg)
  } catch (error) {
    throw new Error(`提取失败（${mode}）：${errorMessage(error)}。请检查 selector 是否有效。`)
  }
}

function notFound(selector, mode) {
  return new Error(selector ? `未找到匹配 selector 的元素：${selector}` : `页面没有可提取的${mode}内容。`)
}

function baseResult({
  mode,
  url,
  title,
  content = null,
  data = null,
  matches = 0,
  truncated = false,
  nextCursor = null,
  meta = {},
}) {
  return { mode, url, title, content, data, matches, truncated, nextCursor, meta }
}

/**
 * 从页面提取信息。
 *
 * 保留旧签名与返回字段 {mode,url,title,content,data,matches,truncated,meta}。
 * 新增 mode：markdown、images、forms；container 作为 selector 的别名；
 * text/markdown 支持 offset/limit 字符窗口并返回 nextCursor。
 */
export async function extractPage(page, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) options = {}
  if (!page || typeof page.isClosed !== 'function') {
    throw new Error('extractPage 需要一个可用的标签页页面对象。')
  }
  if (page.isClosed()) throw new Error('标签页已关闭，无法提取内容。')

  const mode = String(options.mode || 'text').trim().toLowerCase()
  const selector = String(options.selector || options.container || '').trim()
  const limit = clampInt(options.limit, 200, 1, 1000)
  const includeFrames = Boolean(options.includeFrames)
  let title = ''
  try {
    title = await page.title()
  } catch {
    title = ''
  }
  const url = page.url()

  if (mode === 'text' || mode === 'html') {
    const frames = includeFrames ? page.frames() : [page.mainFrame()]
    const frameResults = []
    for (const frame of frames) {
      try {
        const result =
          mode === 'text'
            ? await frame.evaluate(textInFrame, { selector })
            : await frame.evaluate(htmlInFrame, { selector })
        if (mode === 'text' && !result.text) continue
        if (mode === 'html' && !result.html) continue
        frameResults.push({ frame, ...result })
      } catch (error) {
        if (frame === page.mainFrame()) {
          throw new Error(`提取失败：${errorMessage(error)}。请检查 selector 是否有效。`)
        }
      }
    }
    if (frameResults.length === 0) {
      throw notFound(selector, mode === 'text' ? '文本' : 'HTML')
    }
    const fullContent = frameResults
      .map((entry, index) => {
        const label = index === 0 ? '' : `--- frame ${entry.frame.url()} ---\n`
        return `${label}${mode === 'text' ? entry.text : entry.html}`
      })
      .join('\n\n')
    const windowed = applyCharWindow(fullContent, options)
    return baseResult({
      mode,
      url,
      title,
      content: windowed.content,
      data: null,
      matches: frameResults.reduce((sum, entry) => sum + (entry.matches || 0), 0),
      truncated:
        windowed.nextCursor !== null || frameResults.some(entry => entry.truncated),
      nextCursor: windowed.nextCursor,
      meta: {
        frameCount: page.frames().length - 1,
        includeFrames,
        offset: windowed.offset,
        limit: windowed.limit,
        length: windowed.length,
        nextCursor: windowed.nextCursor,
      },
    })
  }

  const main = page.mainFrame()

  if (mode === 'markdown') {
    const result = await evaluateInFrame(main, markdownInFrame, { selector }, 'markdown')
    if (selector && result.selectorMatches === 0) throw notFound(selector, 'Markdown')
    if (!result.markdown) throw notFound(selector, 'Markdown')
    const windowed = applyCharWindow(result.markdown, options)
    return baseResult({
      mode,
      url,
      title,
      content: windowed.content,
      data: null,
      matches: result.matches,
      truncated: windowed.nextCursor !== null || Boolean(result.truncated),
      nextCursor: windowed.nextCursor,
      meta: {
        offset: windowed.offset,
        limit: windowed.limit,
        length: windowed.length,
        nextCursor: windowed.nextCursor,
        selectorMatches: result.selectorMatches,
      },
    })
  }

  if (mode === 'links') {
    const result = await evaluateInFrame(main, linksInFrame, { selector, limit }, 'links')
    if (selector && result.links.length === 0 && result.matches === 0) throw notFound(selector, '链接')
    return baseResult({
      mode,
      url,
      title,
      data: result.links,
      matches: result.matches,
      truncated: result.matches > result.links.length,
      meta: { returned: result.links.length, limit },
    })
  }

  if (mode === 'tables') {
    const result = await evaluateInFrame(main, tablesInFrame, { selector, limit }, 'tables')
    if (selector && result.matches === 0) throw notFound(selector, '表格')
    return baseResult({
      mode,
      url,
      title,
      data: result.tables,
      matches: result.matches,
      truncated: result.matches > result.tables.length,
      meta: { returned: result.tables.length, limit },
    })
  }

  if (mode === 'labeled') {
    const labels = Array.isArray(options.labels)
      ? options.labels.filter(label => typeof label === 'string' && label.trim())
      : []
    if (labels.length === 0) {
      throw new Error('mode=labeled 时必须提供 labels 数组，例如 ["统一社会信用代码","法定代表人"]。')
    }
    const textResult = await evaluateInFrame(main, textInFrame, { selector }, 'labeled')
    if (selector && textResult.matches === 0) throw notFound(selector, '文本')
    if (!textResult.text) throw notFound(selector, '文本')
    const values = parseLabeledText(textResult.text, labels)
    return baseResult({
      mode,
      url,
      title,
      data: values,
      matches: Object.values(values).filter(value => value !== null).length,
      truncated: false,
      meta: { labels, requested: labels.length, selector: selector || null },
    })
  }

  if (mode === 'structured') {
    if (!options.fields || typeof options.fields !== 'object' || Array.isArray(options.fields)) {
      throw new Error('mode=structured 时必须提供 fields 对象，例如 {"公司名称": "h1"}。')
    }
    const result = await evaluateInFrame(
      main,
      structuredInFrame,
      { selector, fields: options.fields },
      'structured',
    )
    if (selector && result.matches === 0) throw notFound(selector, '结构化字段')
    return baseResult({
      mode,
      url,
      title,
      data: result.values,
      matches: result.matches,
      truncated: false,
      meta: { fields: Object.keys(options.fields), selector: selector || null },
    })
  }

  if (mode === 'images') {
    const imageLimit = clampInt(options.limit, 300, 1, 300)
    const result = await evaluateInFrame(
      main,
      imagesInFrame,
      { selector, limit: imageLimit },
      'images',
    )
    if (selector && result.selectorMatches === 0) throw notFound(selector, '图片')
    return baseResult({
      mode,
      url,
      title,
      data: result.images,
      matches: result.matches,
      truncated: Boolean(result.truncated),
      meta: {
        returned: result.images.length,
        limit: imageLimit,
        skippedDataUrl: result.skippedDataUrl || 0,
        selector: selector || null,
      },
    })
  }

  if (mode === 'forms') {
    const formLimit = clampInt(options.limit, 200, 1, 1000)
    const fieldLimit = clampInt(options.fieldLimit, 200, 1, 1000)
    const result = await evaluateInFrame(
      main,
      formsInFrame,
      { selector, limit: formLimit, fieldLimit },
      'forms',
    )
    if (selector && result.selectorMatches === 0) throw notFound(selector, '表单')
    return baseResult({
      mode,
      url,
      title,
      data: result.forms,
      matches: result.matches,
      truncated: Boolean(result.truncated),
      meta: {
        returned: result.forms.length,
        limit: formLimit,
        fieldLimit,
        selector: selector || null,
      },
    })
  }

  throw new Error(
    `不支持的提取模式：${mode}。可用：text、html、links、tables、labeled、structured、markdown、images、forms。`,
  )
}

export function boundExtractResult(result, maxChars) {
  if (result.content) {
    const bounded = truncate(result.content, maxChars, '\n…(内容已截断，完整内容见 savedPath)')
    return { ...result, content: bounded.text, truncated: result.truncated || bounded.truncated }
  }
  if (result.data) {
    const text = JSON.stringify(result.data, null, 2)
    const bounded = truncate(text, maxChars, '\n…(数据已截断，完整内容见 savedPath)')
    return { ...result, dataText: bounded.text, truncated: result.truncated || bounded.truncated }
  }
  return result
}
