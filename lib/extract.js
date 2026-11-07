import { truncate } from './util.js'

const MAX_RAW_CHARS = 500000

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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanLabeledValue(value) {
  return String(value ?? '')
    .replace(/\s*复制\s*$/g, '')
    .replace(/\s*更多\s*\d*\s*$/g, '')
    .replace(/\s*展开\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseLabeledText(text, labels) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const result = {}
  for (const label of labels) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s*[:：]\\s*(.*)$`)
    let value = null
    for (let index = 0; index < lines.length; index += 1) {
      // Table rows often use tabs: "登记状态\t存续\t成立日期\t1986-05-14".
      const cells = lines[index].split(/\t+/).map(cell => cell.trim())
      if (cells.length > 1) {
        const cellIndex = cells.findIndex(cell => cell === label || cell === `${label}：` || cell === `${label}:`)
        if (cellIndex >= 0 && cells[cellIndex + 1]) {
          value = cleanLabeledValue(cells[cellIndex + 1])
          if (value) break
        }
      }
      const match = lines[index].match(pattern)
      if (!match) continue
      value = cleanLabeledValue(match[1])
      if (!value) {
        for (let next = index + 1; next < Math.min(index + 4, lines.length); next += 1) {
          const candidate = lines[next]
          if (/[:：]\s*$/.test(candidate)) break
          if (/^[-—]+$/.test(candidate)) continue
          value = cleanLabeledValue(candidate)
          if (value) break
        }
      }
      break
    }
    result[label] = value || null
  }
  return result
}

export async function extractPage(page, options = {}) {
  if (page.isClosed()) throw new Error('标签页已关闭，无法提取内容。')
  const mode = options.mode || 'text'
  const selector = options.selector || ''
  const limit = Math.max(1, Math.min(Number(options.limit) || 200, 1000))
  const includeFrames = Boolean(options.includeFrames)
  const frames = includeFrames ? page.frames() : [page.mainFrame()]
  const frameResults = []
  let title = ''
  try {
    title = await page.title()
  } catch {
    title = ''
  }

  if (mode === 'text' || mode === 'html') {
    for (const frame of frames) {
      try {
        const result =
          mode === 'text'
            ? await frame.evaluate(textInFrame, { selector })
            : await frame.evaluate(htmlInFrame, { selector })
        if (mode === 'text' && !result.text) continue
        if (mode === 'html' && !result.html) continue
        frameResults.push({
          frame,
          ...result,
        })
      } catch (error) {
        if (frame === page.mainFrame()) {
          throw new Error(
            `提取失败：${error instanceof Error ? error.message : String(error)}。请检查 selector 是否有效。`,
          )
        }
      }
    }
    if (frameResults.length === 0) {
      throw new Error(selector ? `未找到匹配 selector 的元素：${selector}` : '页面没有可提取的文本。')
    }
    const content = frameResults
      .map((entry, index) => {
        const label =
          index === 0
            ? ''
            : `--- frame ${entry.frame.url()} ---\n`
        return `${label}${mode === 'text' ? entry.text : entry.html}`
      })
      .join('\n\n')
    return {
      mode,
      url: page.url(),
      title,
      content,
      data: null,
      matches: frameResults.reduce((sum, entry) => sum + (entry.matches || 0), 0),
      truncated: content.length > MAX_RAW_CHARS || frameResults.some(entry => entry.truncated),
      meta: { frameCount: page.frames().length - 1, includeFrames },
    }
  }

  const main = page.mainFrame()
  let result
  if (mode === 'links') {
    result = await main.evaluate(linksInFrame, { selector, limit })
    return {
      mode,
      url: page.url(),
      title,
      content: null,
      data: result.links,
      matches: result.matches,
      truncated: result.matches > result.links.length,
      meta: { returned: result.links.length, limit },
    }
  }
  if (mode === 'tables') {
    result = await main.evaluate(tablesInFrame, { selector, limit })
    return {
      mode,
      url: page.url(),
      title,
      content: null,
      data: result.tables,
      matches: result.matches,
      truncated: result.matches > result.tables.length,
      meta: { returned: result.tables.length, limit },
    }
  }
  if (mode === 'labeled') {
    const labels = Array.isArray(options.labels) ? options.labels.filter(label => typeof label === 'string' && label.trim()) : []
    if (labels.length === 0) throw new Error('mode=labeled 时必须提供 labels 数组，例如 ["统一社会信用代码","法定代表人"]。')
    const textResult = await main.evaluate(textInFrame, { selector: options.selector || '' })
    const values = parseLabeledText(textResult.text, labels)
    return {
      mode,
      url: page.url(),
      title,
      content: null,
      data: values,
      matches: Object.values(values).filter(value => value !== null).length,
      truncated: false,
      meta: { labels, requested: labels.length },
    }
  }
  if (mode === 'structured') {
    if (!options.fields || typeof options.fields !== 'object' || Array.isArray(options.fields)) {
      throw new Error('mode=structured 时必须提供 fields 对象，例如 {"公司名称": "h1"}。')
    }
    result = await main.evaluate(structuredInFrame, { selector, fields: options.fields })
    return {
      mode,
      url: page.url(),
      title,
      content: null,
      data: result.values,
      matches: result.matches,
      truncated: false,
      meta: { fields: Object.keys(options.fields) },
    }
  }
  throw new Error(`不支持的提取模式：${mode}。可用：text、html、links、tables、labeled、structured。`)
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
