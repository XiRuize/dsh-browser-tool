/**
 * 内容清洗：把暂存区里的原始 HTML 变成可读文本。
 *
 * 不引入解析库，按块处理（先把 <script>/<style>/注释整段去掉，再去标签、解实体、
 * 折叠空白），内存里只保留当前块，适合几百 KB 到几 MB 的页面。
 */

const BLOCK_TAGS =
  'p|div|section|article|header|footer|nav|aside|li|tr|br|h[1-6]|table|ul|ol|dl|dd|dt|pre|blockquote|form|fieldset'

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
}

function decode(text) {
  let value = String(text || '')
  for (const [entity, replacement] of Object.entries(ENTITIES)) {
    value = value.split(entity).join(replacement)
  }
  value = value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  return value
}

export function extractTitle(html) {
  const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html || ''))
  return match ? decode(match[1]).replace(/\s+/g, ' ').trim() : ''
}

/** HTML → 纯文本。脚本、样式、注释、内联事件等一律丢弃。 */
export function cleanHtml(html, { keepLinks = false, maxChars = 200_000 } = {}) {
  let text = String(html || '')
  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')

  text = text.replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
  if (keepLinks) {
    text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const clean = String(label).replace(/<[^>]+>/g, ' ').trim()
      return clean ? `${clean} <${href}>` : ` <${href}>`
    })
  }
  text = text.replace(/<[^>]+>/g, ' ')
  text = decode(text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…(已截断)`
  return text
}

/** 纯文本归一：折叠空白、去掉重复空行。 */
export function cleanText(text, { maxChars = 200_000 } = {}) {
  let value = String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (value.length > maxChars) value = `${value.slice(0, maxChars)}\n…(已截断)`
  return value
}

/** 流式清洗：按块回调，避免一次把超大页面读进模型上下文。 */
export function streamClean(text, { chunkSize = 64 * 1024 } = {}) {
  const raw = String(text || '')
  const chunks = []
  for (let offset = 0; offset < raw.length; offset += chunkSize) {
    chunks.push(raw.slice(offset, offset + chunkSize))
  }
  return chunks
}
