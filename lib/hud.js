/**
 * 页面内「Agent 操作指示器」（HUD）。
 *
 * 设计参考 nuwa-browser 的「显性表示」：agent 在隔离空间里操作时，人应该能直接
 * 看见它在做什么，而不是等最后读一串日志。因此：
 *
 * - 只在可见模式（`window` / `offscreen`）注入；`headless` 下完全跳过，保持静默；
 * - 用 Shadow DOM 隔离样式，宿主元素带 `data-dsh-hud`，快照/提取都会忽略它；
 * - 任何失败都静默返回 false：HUD 绝不能阻塞或影响真实动作。
 */

export const HUD_HOST_ID = '__dsh_agent_hud__'
export const HUD_ATTRIBUTE = 'data-dsh-hud'

const HUD_TTL_DEFAULT_MS = 4000
const HUD_TTL_MIN_MS = 500
const HUD_TTL_MAX_MS = 30000
const HUD_PAINT_TIMEOUT_MS = 1200

/** 合成一行可读文案，例如 `DSH · 2/5 · 点击 下一页`。 */
export function hudText({ label = '', step = 0, total = 0, tone = 'running' } = {}) {
  const parts = ['DSH']
  if (total > 1) parts.push(`${Math.max(1, Math.min(step, total))}/${total}`)
  const text = String(label || '').trim().slice(0, 80)
  if (text) parts.push(text)
  else if (tone === 'error') parts.push('操作失败')
  return parts.join(' · ')
}

/** 当前配置/页面是否应该出现 HUD。纯函数，便于测试。 */
export function shouldShowHud({ config = {}, url = '', closed = false } = {}) {
  if (closed) return false
  if (config?.actionHud === false) return false
  if (String(config?.visibility || 'headless') === 'headless') return false
  return /^https?:/i.test(String(url || ''))
}

function withDeadline(promise, ms) {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    Promise.resolve(promise)
      .then(value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value !== false)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(false)
      })
  })
}

function paintHud(payload) {
  try {
    const doc = document
    let host = doc.getElementById(payload.id)
    if (!host) {
      host = doc.createElement('div')
      host.id = payload.id
      host.setAttribute(payload.attribute, '1')
      host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none;'
      const shadow = host.attachShadow({ mode: 'open' })
      shadow.innerHTML =
        '<style>' +
        '.wrap{position:relative;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}' +
        '.box{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:10px;' +
        'background:rgba(17,24,39,.92);color:#e5e7eb;box-shadow:0 6px 18px rgba(0,0,0,.35);max-width:min(70vw,520px)}' +
        '.dot{width:8px;height:8px;border-radius:50%;background:#60a5fa;flex:0 0 auto}' +
        '.txt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(64vw,480px)}' +
        '.bar{position:absolute;left:0;bottom:-3px;height:3px;border-radius:2px;background:#3b82f6;transition:width .18s}' +
        '</style>' +
        '<div class="wrap"><div class="box"><span class="dot"></span><span class="txt"></span></div><div class="bar"></div></div>'
      doc.documentElement.appendChild(host)
    }
    const shadow = host.shadowRoot
    if (!shadow) return false
    const dot = shadow.querySelector('.dot')
    const txt = shadow.querySelector('.txt')
    const bar = shadow.querySelector('.bar')
    if (!dot || !txt || !bar) return false
    dot.style.background = payload.tone === 'error' ? '#f87171' : payload.tone === 'ok' ? '#34d399' : '#60a5fa'
    txt.textContent = payload.text
    const pct = payload.total > 0 ? Math.max(0, Math.min(100, Math.round((payload.step / payload.total) * 100))) : 0
    bar.style.width = `${pct}%`
    bar.style.display = payload.total > 1 ? 'block' : 'none'
    if (host.__dshHudTimer) clearTimeout(host.__dshHudTimer)
    host.__dshHudTimer = payload.ttl > 0 ? setTimeout(() => { try { host.remove() } catch {} }, payload.ttl) : null
    return true
  } catch {
    return false
  }
}

function removeHud(selector) {
  try {
    const el = document.querySelector(selector)
    if (el) el.remove()
    return true
  } catch {
    return false
  }
}

/**
 * 在页面角落显示/更新操作指示器。
 * @param {object} page Playwright Page
 * @param {{label?:string, step?:number, total?:number, tone?:'running'|'ok'|'error'}} options
 * @param {object} config resolveConfig() 结果（读取 actionHud / actionHudTtlMs / visibility）
 * @returns {Promise<boolean>} 是否真的画上去了
 */
export async function showHud(page, options = {}, config = {}) {
  try {
    if (!page || typeof page.evaluate !== 'function' || page.isClosed?.()) return false
    if (!shouldShowHud({ config, url: page.url?.() || '' })) return false
    const step = Number(options.step) || 0
    const total = Number(options.total) || 0
    const ttlRaw = Number(config?.actionHudTtlMs)
    const ttl = Number.isFinite(ttlRaw)
      ? Math.min(HUD_TTL_MAX_MS, Math.max(HUD_TTL_MIN_MS, Math.round(ttlRaw)))
      : HUD_TTL_DEFAULT_MS
    const payload = {
      id: HUD_HOST_ID,
      attribute: HUD_ATTRIBUTE,
      text: hudText({ label: options.label, step, total, tone: options.tone }),
      tone: options.tone || 'running',
      step,
      total,
      ttl,
    }
    return await withDeadline(page.evaluate(paintHud, payload), HUD_PAINT_TIMEOUT_MS)
  } catch {
    return false
  }
}

/** 主动移除指示器（页面关闭/导航后元素自然消失，这里用于收尾）。 */
export async function hideHud(page) {
  try {
    if (!page || typeof page.evaluate !== 'function' || page.isClosed?.()) return false
    return await withDeadline(page.evaluate(removeHud, `#${HUD_HOST_ID}`), HUD_PAINT_TIMEOUT_MS)
  } catch {
    return false
  }
}
