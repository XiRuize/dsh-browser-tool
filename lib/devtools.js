import { cleanHtml } from './clean.js'

/**
 * F12 式前端工作流：抓取 → 暂存 → 清洗。
 *
 * 抓取阶段只做“搬运”：把页面的 HTML、内联样式、样式表链接、脚本清单、meta
 * 写进暂存区，返回清单；清洗阶段在文件层做，不把整页 HTML 塞回模型上下文。
 */

/** 采集当前页面前端信息（在页面内执行）。 */
export function collectFrontendInPage({ selector, maxInlineScripts = 20, maxInlineChars = 4000 } = {}) {
  const root = selector ? document.querySelector(selector) : document.documentElement
  const html = root ? root.outerHTML : ''
  const inlineStyles = []
  const styleLinks = []
  for (const sheet of [...document.styleSheets]) {
    if (sheet.href) {
      styleLinks.push(sheet.href)
      continue
    }
    try {
      const rules = [...(sheet.cssRules || [])].map(rule => rule.cssText).join('\n')
      if (rules) inlineStyles.push(rules.slice(0, 200000))
    } catch {
      /* 跨域样式表读不到规则，只跳过 */
    }
  }
  const scripts = [...document.scripts]
  const scriptSrc = scripts.map(script => script.src).filter(Boolean)
  const inlineScripts = scripts
    .filter(script => !script.src && script.textContent)
    .slice(0, maxInlineScripts)
    .map(script => script.textContent.slice(0, maxInlineChars))
  const meta = {
    url: location.href,
    title: document.title,
    charset: document.characterSet,
    viewport: document.querySelector('meta[name="viewport"]')?.content || '',
    generators: [...document.querySelectorAll('meta[name="generator"]')].map(node => node.content),
  }
  return {
    html,
    inlineStyles,
    styleLinks,
    scriptSrc,
    inlineScripts,
    meta,
    counts: {
      elements: document.querySelectorAll('*').length,
      scripts: scripts.length,
      inlineScripts: scripts.filter(script => !script.src).length,
      styleSheets: document.styleSheets.length,
      links: document.querySelectorAll('a[href]').length,
      images: document.querySelectorAll('img').length,
    },
  }
}

/**
 * 清洗前端代码：去掉脚本、样式、注释、内联事件和埋点属性，输出干净 HTML + 文本。
 */
export function cleanFrontend(html, options = {}) {
  const {
    dropScripts = true,
    dropStyles = true,
    dropComments = true,
    dropHandlers = true,
    dropTracking = true,
    keepLinks = false,
  } = options
  const stats = { scripts: 0, styles: 0, comments: 0, handlers: 0, tracking: 0 }
  let out = String(html || '')

  if (dropComments) {
    out = out.replace(/<!--[\s\S]*?-->/g, () => {
      stats.comments += 1
      return ''
    })
  }
  if (dropScripts) {
    out = out.replace(/<script\b[\s\S]*?<\/script>/gi, () => {
      stats.scripts += 1
      return ''
    })
  }
  if (dropStyles) {
    out = out
      .replace(/<style\b[\s\S]*?<\/style>/gi, () => {
        stats.styles += 1
        return ''
      })
      .replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, () => {
        stats.styles += 1
        return ''
      })
  }
  if (dropHandlers) {
    out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
      stats.handlers += 1
      return ''
    })
  }
  if (dropTracking) {
    out = out.replace(/\sdata-(?:track|analytics|ga|tag)[\w-]*\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, () => {
      stats.tracking += 1
      return ''
    })
  }

  const text = cleanHtml(out, { keepLinks })
  return { html: out.trim(), text, stats, bytes: Buffer.byteLength(out, 'utf8') }
}

/**
 * 抓取页面 → 写入暂存区 → 返回清单。
 * @returns {Promise<{jobId: string, files: Array, counts: object, meta: object}>}
 */
export async function captureFrontend(page, scratch, { jobId, selector = '', maxInlineScripts = 20 } = {}) {
  const raw = await page.evaluate(collectFrontendInPage, { selector, maxInlineScripts })
  if (!raw?.html) {
    throw new Error(selector ? `未找到匹配 selector 的元素：${selector}` : '页面没有可捕获的 HTML。')
  }
  const files = []
  const push = async (name, content) => {
    const written = await scratch.put(jobId, name, content)
    files.push({ name, bytes: written.bytes, path: written.path })
    return written
  }

  await push('page.html', raw.html)
  if (raw.inlineStyles.length) await push('styles.css', raw.inlineStyles.join('\n\n/* --- */\n\n'))
  await push(
    'scripts.json',
    JSON.stringify({ src: raw.scriptSrc, inline: raw.inlineScripts }, null, 2),
  )
  await push('meta.json', JSON.stringify({ ...raw.meta, counts: raw.counts }, null, 2))

  return {
    jobId,
    files,
    counts: raw.counts,
    meta: raw.meta,
    styleLinks: raw.styleLinks,
    scriptSrcCount: raw.scriptSrc.length,
  }
}
