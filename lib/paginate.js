import { createHash } from 'node:crypto'

import { performAction } from './act.js'
import { runExtractStep } from './batch.js'
import { showHud } from './hud.js'
import { isRecord, sleep, toInt } from './util.js'

/**
 * 翻页原语（借鉴 nuwa-browser 的「一次脚本跑完一个采集流程」）：
 * 在当前列表页上自动找到「下一页」，点过去、抓内容、再找下一页，直到
 * 页数用完、没有下一页、或点了没变化为止。全程一次工具调用。
 */

export const PAGINATE_MAX_PAGES = 20
export const PAGINATE_DEFAULT_PAGES = 5
export const PAGINATE_DEFAULT_WAIT_MS = 8000
export const PAGINATE_MAX_TIMEOUT_MS = 290000

const EXTRACT_KEYS = ['mode', 'selector', 'container', 'itemSelector', 'labels', 'fields', 'maxChars', 'offset', 'limit']

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 校验并归一化分页参数；错误信息直接可读，便于模型改参数重试。 */
export function normalizePaginateOptions(args = {}) {
  const input = isRecord(args) ? args : {}
  const maxPages = toInt(input.maxPages, PAGINATE_DEFAULT_PAGES, 1, PAGINATE_MAX_PAGES)
  const waitMs = toInt(input.waitMs, PAGINATE_DEFAULT_WAIT_MS, 500, 30000)
  const timeoutMs = toInt(input.timeoutMs, 120000, 5000, PAGINATE_MAX_TIMEOUT_MS)

  const extract = {}
  for (const key of EXTRACT_KEYS) {
    if (input[key] !== undefined) extract[key] = input[key]
  }
  if (extract.mode !== undefined) extract.mode = String(extract.mode)
  if (extract.mode === 'records' && !extract.itemSelector) {
    throw new Error('mode=records 时必须提供 itemSelector，例如 "li.item"。')
  }

  let next = null
  if (input.next !== undefined && input.next !== null && input.next !== '') {
    if (typeof input.next === 'string') next = { selector: input.next }
    else if (isRecord(input.next)) {
      next = { ...input.next }
      for (const key of Object.keys(next)) {
        if (next[key] === undefined || next[key] === null) delete next[key]
      }
      if (!next.selector && !next.ref && !next.text) {
        throw new Error('next 为对象时必须包含 selector / ref / text 之一。')
      }
    } else {
      throw new Error('next 只能是选择器字符串，或 { selector | ref | text, container?, nth? } 对象。')
    }
  }

  return { maxPages, waitMs, timeoutMs, extract, next, waitSelector: String(input.waitSelector || ''), save: input.save !== false }
}

/** 粗略判断提取结果里有多少条（records/links 取数组长度）。 */
export function countExtract(extract) {
  if (!extract) return 0
  if (Array.isArray(extract.data)) return extract.data.length
  const text = extract.text ?? extract.dataText ?? ''
  return text ? 1 : 0
}

function hashText(text) {
  return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 12)
}

async function pageText(page) {
  try {
    return await page.evaluate(() => (document.body?.innerText || '').slice(0, 4000))
  } catch {
    return ''
  }
}

async function waitForChange(page, before, waitMs) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(150)
    try {
      const url = page.url()
      const sig = hashText(await pageText(page))
      if (url !== before.url || sig !== before.sig) return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * 页面内「下一页」查找：rel=next 优先，其次文本/aria 启发式，最后分页容器加分。
 * 命中后给元素打 `data-dsh-next="1"`，由调用方用 Playwright 真实点击。
 */
function findNextInPage() {
  try {
    const clean = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
    const visible = el => {
      const rect = el.getBoundingClientRect()
      if (!rect.width || !rect.height) return false
      const style = getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0.05
    }
    const disabled = el =>
      el.disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      /(^|\s)(disabled|is-disabled)(\s|$)/.test(String(el.className || '')) ||
      el.getAttribute('tabindex') === '-1' ||
      getComputedStyle(el).pointerEvents === 'none'

    for (const el of document.querySelectorAll('a[rel~="next" i], area[rel~="next" i]')) {
      if (visible(el) && !disabled(el)) {
        el.setAttribute('data-dsh-next', '1')
        return { kind: 'element', by: 'rel' }
      }
    }
    const linkRel = document.querySelector('link[rel~="next" i][href]')
    if (linkRel) {
      try {
        return { kind: 'url', url: new URL(linkRel.getAttribute('href'), location.href).href, by: 'link-rel' }
      } catch {
        /* href 非法时继续走启发式 */
      }
    }

    const scored = []
    for (const el of document.querySelectorAll('a,button,[role="button"]')) {
      if (!visible(el) || disabled(el)) continue
      const text = clean(el)
      const hay = `${text} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim()
      if (!hay) continue
      if (/上一页|上页/i.test(hay) && !/下一页|next/i.test(hay)) continue
      let score = 0
      if (/^(下一页|下页|后一页|next|older|»|›|>)$/i.test(text)) score += 100
      if (/下一页/.test(hay)) score += 80
      else if (/next/i.test(hay)) score += 60
      else if (/下页|older|»|›/.test(hay)) score += 40
      // 文本/aria/title 没有命中「下一页」语义的链接一律不参与，
      // 否则分页容器里的普通条目链接（class 含 page-item 之类）会被误当成下一页。
      if (score === 0) continue
      const parent = el.parentElement
      const hint = `${parent?.className || ''} ${parent?.id || ''} ${el.closest('nav') ? 'nav' : ''}`
      if (/pag|pager|pagination|nav/i.test(hint)) score += 15
      scored.push({ el, score })
    }
    scored.sort((a, b) => b.score - a.score)
    if (!scored.length) return { kind: 'none', reason: 'no-candidate' }
    const best = scored[0].el
    best.setAttribute('data-dsh-next', '1')
    return { kind: 'element', by: 'text', text: clean(best) }
  } catch {
    return { kind: 'none', reason: 'error' }
  }
}

async function clearNextTag(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('[data-dsh-next]').forEach(el => el.removeAttribute('data-dsh-next'))
    })
  } catch {
    /* 页面已导航时忽略 */
  }
}

/**
 * 在当前列表页上连续翻页并逐页提取。
 *
 * @param {object} manager BrowserManager
 * @param {{page:object, tabId?:string}} state 标签页状态
 * @param {object} options normalizePaginateOptions() 的结果
 * @param {{config?:object, exec?:object}} [runtime]
 * @returns {Promise<{ok:true, pages:object[], items:any[], stoppedReason:string, ms:number}>}
 */
export async function paginate(manager, state, options, runtime = {}) {
  const config = runtime.config || {}
  const exec = runtime.exec || null
  const spec = options
  const page = state?.page
  if (!page || page.isClosed?.()) throw new Error('分页采集需要可用的标签页。')

  const started = Date.now()
  const deadline = started + spec.timeoutMs
  const pages = []
  const items = []
  let stoppedReason = 'max-pages'

  for (let index = 1; index <= spec.maxPages; index += 1) {
    if (exec?.signal?.aborted) throw new Error('操作已取消。')
    if (Date.now() > deadline) {
      stoppedReason = 'timeout'
      break
    }

    await showHud(page, { label: `第 ${index}/${spec.maxPages} 页`, step: index, total: spec.maxPages, tone: 'running' }, config)
    let extract
    try {
      extract = await runExtractStep(manager, page, { action: 'extract', ...spec.extract }, config)
    } catch (error) {
      if (process.env.DSH_PAG_DEBUG) {
        const title = await page.title().catch(() => '')
        console.error(`[paginate] extract failed at page ${index}: url=${page.url()} title=${title} error=${errorMessage(error)}`)
      }
      throw error
    }
    pages.push({ page: index, url: extract.url, title: extract.title, extract })
    if (Array.isArray(extract.data)) {
      for (const item of extract.data) items.push(isRecord(item) ? { ...item, page: index } : item)
    }

    if (index >= spec.maxPages) {
      stoppedReason = 'max-pages'
      break
    }

    const before = { url: page.url(), sig: hashText(await pageText(page)) }
    try {
      if (spec.next) {
        await performAction(manager, state, { action: 'click', ...spec.next, verify: false, timeoutMs: spec.waitMs }, config, exec)
      } else {
        const found = await page.evaluate(findNextInPage)
        if (!found || found.kind === 'none') {
          stoppedReason = 'no-next'
          break
        }
        if (found.kind === 'url') {
          await page.goto(found.url, { waitUntil: 'domcontentloaded', timeout: spec.waitMs }).catch(() => {})
        } else {
          await page.locator('[data-dsh-next="1"]').first().click({ timeout: spec.waitMs })
          await clearNextTag(page)
        }
      }
    } catch (error) {
      const message = errorMessage(error)
      if (/timeout|not visible|resolved to 0|waiting for locator/i.test(message)) {
        stoppedReason = 'no-next'
        break
      }
      throw new Error(`第 ${index} 页翻到下一页失败：${message}`)
    }

    const changed = await waitForChange(page, before, spec.waitMs)
    if (!changed) {
      stoppedReason = 'no-change'
      break
    }
    // URL 可能先变、DOM 后到：等页面进入可用状态再抓下一页，避免抓到半成品。
    await page.waitForLoadState?.('domcontentloaded', { timeout: Math.min(5000, spec.waitMs) }).catch(() => {})
    if (spec.waitSelector) {
      await page.waitForSelector?.(spec.waitSelector, { timeout: spec.waitMs }).catch(() => {})
    }
    await sleep(Math.max(0, Number(config.navigateSettleMs) || 120))
  }

  await showHud(page, { label: `已完成 ${pages.length} 页`, step: pages.length, total: pages.length, tone: 'ok' }, config)
  return { ok: true, pages, items, stoppedReason, ms: Date.now() - started }
}
