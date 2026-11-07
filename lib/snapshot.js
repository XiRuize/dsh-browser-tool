import { truncate } from './util.js'

/**
 * Runs inside one frame. It only touches that frame's document, so same-origin
 * and cross-origin frames can be snapshotted uniformly by Playwright.
 */
function snapshotInPage({ startSeq, maxElements, interactiveOnly, frameLabel, isMain, assignRefs }) {
  const lines = []
  const refs = []
  const notices = []
  let seq = startSeq
  const NAME_MAX = 160
  const captchaRe =
    /验证码|人机验证|安全验证|滑动验证|拖动滑块|滑块验证|访问受限|访问被阻断|异常访问|访问过于频繁|请稍后再试|请求过于频繁|安全威胁|405错误|WAF|verify you are human|captcha/i
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim()
  const cut = (value, max) => {
    const text = norm(value)
    return text.length > max ? `${text.slice(0, max - 1)}…` : text
  }

  const skipTags = new Set([
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'video',
    'audio',
    'object',
    'embed',
    'meta',
    'link',
    'head',
    'title',
    'br',
    'hr',
  ])
  const interactiveRoles = new Set([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'slider',
    'spinbutton',
    'treeitem',
  ])

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false
    if (el.hidden) return false
    const style = getComputedStyle(el)
    if (style.display === 'none') return false
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
    if (style.opacity === '0') return false
    if (style.display === 'contents') return true
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    return true
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().toLowerCase().split(/\s+/)[0]
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'summary') return 'button'
    if (tag === 'img') return 'img'
    if (tag === 'iframe') return 'iframe'
    if (tag === 'form') return 'form'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'header') return 'banner'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'dialog') return 'dialog'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'checkbox') return 'checkbox'
      if (type === 'radio') return 'radio'
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button'
      if (type === 'search') return 'searchbox'
      if (type === 'range') return 'slider'
      if (type === 'number') return 'spinbutton'
      return 'textbox'
    }
    return 'generic'
  }

  function nameOf(el) {
    const root = el.getRootNode()
    const byIds = el
      .getAttribute('aria-labelledby')
      ?.split(/\s+/)
      .map(id => {
        try {
          return root.getElementById?.(id)?.innerText || document.getElementById(id)?.innerText || ''
        } catch {
          return ''
        }
      })
      .join(' ')
    const labels =
      el.labels && el.labels.length
        ? [...el.labels]
            .map(label => label.innerText)
            .join(' ')
        : ''
    let name =
      el.getAttribute('aria-label') ||
      byIds ||
      labels ||
      el.getAttribute('alt') ||
      el.getAttribute('title') ||
      el.getAttribute('placeholder') ||
      ''
    if (!name && el.tagName === 'SELECT') {
      name = el.options?.[el.selectedIndex]?.text || ''
    }
    if (!name) name = el.innerText || el.textContent || ''
    if (!name && el.tagName === 'INPUT') name = el.value || ''
    return cut(name, NAME_MAX)
  }

  function valueOf(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase()
      if (type === 'password' || type === 'file') return ''
      if (['checkbox', 'radio', 'submit', 'button', 'reset', 'image'].includes(type)) return ''
      return cut(el.value || '', 90)
    }
    if (tag === 'textarea') return cut(el.value || '', 90)
    if (tag === 'select') {
      const selected = [...(el.selectedOptions || [])].map(option => option.text).join(', ')
      return cut(selected, 90)
    }
    if (el.isContentEditable) return cut(el.innerText || '', 90)
    return ''
  }

  function stateFlags(el) {
    const flags = []
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') flags.push('disabled')
    if (el.checked) flags.push('checked')
    if (el.readOnly) flags.push('readonly')
    if (el.required) flags.push('required')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) flags.push(`expanded=${expanded}`)
    const selected = el.getAttribute('aria-selected')
    if (selected) flags.push(`selected=${selected}`)
    const pressed = el.getAttribute('aria-pressed')
    if (pressed) flags.push(`pressed=${pressed}`)
    const current = el.getAttribute('aria-current')
    if (current && current !== 'false') flags.push(`current=${current}`)
    if (el.multiple) flags.push('multiple')
    return flags
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')?.trim().toLowerCase().split(/\s+/)[0]
    if (tag === 'a') return el.hasAttribute('href') || role === 'link' || el.tabIndex >= 0
    if (['button', 'select', 'textarea', 'summary'].includes(tag)) return true
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase() !== 'hidden'
    if (el.isContentEditable) return true
    if (role && interactiveRoles.has(role)) return true
    if (el.hasAttribute('onclick')) return true
    if (el.hasAttribute('tabindex') && el.tabIndex >= 0) return true
    return false
  }

  function isSemantic(el) {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute('role')?.trim().toLowerCase().split(/\s+/)[0]
    if (/^h[1-6]$/.test(tag)) return true
    if (['main', 'nav', 'header', 'footer', 'form', 'dialog'].includes(tag)) return true
    if (['heading', 'alert', 'dialog', 'status', 'tabpanel', 'navigation', 'main'].includes(role)) return true
    if (tag === 'section' && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) return true
    return false
  }

  function addInteractive(el, frameChain) {
    if (seq - startSeq >= maxElements) return false
    seq += 1
    const ref = `e${seq}`
    el.setAttribute('data-dsh-ref', ref)
    const role = roleOf(el)
    const name = nameOf(el)
    let line = `@${ref} [${role}] ${name || '(未命名)'}`
    const value = valueOf(el)
    if (value) line += ` value="${value}"`
    const flags = stateFlags(el)
    if (flags.length) line += ` (${flags.join(', ')})`
    if (el.tagName === 'A') {
      const href = el.getAttribute('href')
      if (href) line += ` -> ${cut(href, 120)}`
    }
    if (frameLabel) line += ` [frame ${frameLabel}]`
    lines.push(line)
    refs.push({
      ref,
      role,
      name: cut(name, 120),
      frameChain,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
    })
    return true
  }

  function addSemantic(el, frameLabel) {
    const tag = el.tagName.toLowerCase()
    const text = cut(el.innerText || el.textContent || '', 220)
    if (!text) return
    if (/^h[1-6]$/.test(tag)) {
      lines.push(`H${tag[1]} ${text}${frameLabel ? ` [frame ${frameLabel}]` : ''}`)
    } else {
      lines.push(`<${roleOf(el)}> ${text}${frameLabel ? ` [frame ${frameLabel}]` : ''}`)
    }
  }

  function walk(el, frameChain) {
    if (!el || el.nodeType !== 1) return
    if (seq - startSeq >= maxElements) return
    const tag = el.tagName.toLowerCase()
    if (skipTags.has(tag)) return
    if (el.getAttribute('aria-hidden') === 'true') return
    if (!isVisible(el)) return
    if (tag === 'iframe') {
      const src = el.getAttribute('src') || ''
      if (src && !src.startsWith('about:')) {
        lines.push(`FRAME ${cut(el.getAttribute('title') || el.getAttribute('name') || src, 160)}`)
      }
      return
    }
    if (isInteractive(el)) {
      if (assignRefs) addInteractive(el, frameChain)
    } else if (!interactiveOnly && isSemantic(el)) {
      addSemantic(el, frameLabel)
    }
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) walk(child, frameChain)
    }
    for (const child of el.children) walk(child, frameChain)
  }

  function clear(root) {
    // Keep data-dsh-frame: it is the chain used by frameLocator to reach this
    // frame. The outer capture pass clears both markers before reassigning.
    for (const el of root.querySelectorAll('[data-dsh-ref]')) {
      el.removeAttribute('data-dsh-ref')
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) clear(el.shadowRoot)
    }
  }

  try {
    clear(document)
  } catch {
    /* ignore */
  }

  const body = document.body
  if (body) {
    for (const child of body.children) walk(child, [])
  }
  if (seq === startSeq) {
    lines.push(interactiveOnly ? '(未发现可交互元素)' : '(未发现可交互或语义元素)')
  }

  const visibleText = norm(body?.innerText || body?.textContent || '')
  const preview = visibleText.length > 420 ? `${visibleText.slice(0, 419)}…` : visibleText
  const iframeCount = document.querySelectorAll('iframe').length
  if (iframeCount > 0 && isMain) notices.push(`页面含 ${iframeCount} 个 iframe，已按可访问性分别读取`)

  return {
    lines,
    refs,
    count: seq - startSeq,
    textPreview: preview,
    captcha: captchaRe.test(visibleText) || captchaRe.test(document.title || ''),
    scroll: {
      y: Math.round(window.scrollY),
      height: Math.max(document.documentElement?.scrollHeight || 0, body?.scrollHeight || 0),
      viewport: window.innerHeight,
    },
    notices,
    frameLabel,
  }
}

function chainForFrame(frame, page, frameIds) {
  const chain = []
  let cursor = frame
  while (cursor && cursor !== page.mainFrame()) {
    const id = frameIds.get(cursor)
    if (!id) break
    chain.unshift(`[data-dsh-frame="${id}"]`)
    cursor = cursor.parentFrame()
  }
  return chain
}

export async function captureSnapshot(page, tabId, options = {}) {
  if (page.isClosed()) throw new Error('标签页已关闭，无法生成快照。')
  const maxChars = options.maxChars ?? 12000
  const maxElements = options.maxElements ?? 260
  const interactiveOnly = Boolean(options.interactiveOnly)

  let title = ''
  try {
    title = await page.title()
  } catch {
    title = ''
  }
  const frames = page.frames()
  const frameIds = new Map()
  let frameSeq = 0
  for (const frame of frames) {
    if (frame === page.mainFrame()) continue
    frameIds.set(frame, `fr${++frameSeq}`)
  }

  // Clear stale markers before assigning the new frame chain.
  for (const frame of frames) {
    try {
      await frame.evaluate(() => {
        const clear = root => {
          for (const el of root.querySelectorAll('[data-dsh-ref], [data-dsh-frame]')) {
            el.removeAttribute('data-dsh-ref')
            el.removeAttribute('data-dsh-frame')
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) clear(el.shadowRoot)
          }
        }
        clear(document)
      })
    } catch {
      /* detached frame */
    }
  }

  for (const [frame, id] of frameIds) {
    try {
      const handle = await frame.frameElement()
      await handle.evaluate((el, frameId) => el.setAttribute('data-dsh-frame', frameId), id)
    } catch {
      /* detached frame */
    }
  }

  const combined = []
  const allRefs = []
  const notices = new Set()
  let captcha = false
  let textPreview = ''
  let total = 0
  let scroll = { y: 0, height: 0, viewport: 0 }

  for (const frame of frames) {
    if (total >= maxElements) break
    const isMain = frame === page.mainFrame()
    const frameLabel = isMain ? '' : frameIds.get(frame)?.replace('fr', 'f') ?? ''
    const chain = isMain ? [] : chainForFrame(frame, page, frameIds)
    const chainOk = isMain || chain.length > 0
    try {
      const result = await frame.evaluate(snapshotInPage, {
        startSeq: total,
        maxElements: Math.max(0, maxElements - total),
        interactiveOnly,
        frameLabel,
        isMain,
        assignRefs: chainOk,
      })
      if (!isMain) {
        combined.push('')
        combined.push(`--- frame ${frameLabel} ${frame.url()} ---`)
      }
      combined.push(...result.lines)
      if (chainOk) {
        allRefs.push(
          ...result.refs.map(ref => ({
            ...ref,
            frameChain: chain,
          })),
        )
      } else {
        notices.add(`frame ${frameLabel} 的 iframe 定位链不可用，已跳过其中的可点击引用`)
      }
      total += result.count
      for (const notice of result.notices) notices.add(notice)
      captcha ||= result.captcha
      if (isMain) {
        textPreview = result.textPreview
        scroll = result.scroll
      }
    } catch (error) {
      if (!isMain) {
        combined.push('', `--- frame ${frameLabel} ${frame.url()} (无法读取) ---`)
      }
      notices.add(`部分 frame 无法读取：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const header = [
    `页面：${title || '(无标题)'}`,
    `URL：${page.url()}`,
    `标签：${tabId} ｜ 滚动：${scroll.y}/${scroll.height} ｜ 可交互：${allRefs.length} ｜ frame：${Math.max(0, frames.length - 1)}`,
  ]
  if (captcha) {
    header.push('注意：检测到人机验证/访问限制字样。请在浏览器窗口中手动完成验证，不要尝试自动绕过。')
  }
  for (const notice of notices) header.push(`提示：${notice}`)
  if (textPreview) header.push(`文本预览：${textPreview}`)

  let text = `${header.join('\n')}\n\n${combined.join('\n')}`.trim()
  const bounded = truncate(text, maxChars, '\n…(快照已截断，可用 browser_extract 读取完整文本)')
  text = bounded.text
  if (allRefs.length >= maxElements) {
    text += `\n(元素数量达到上限 ${maxElements}，可用更精确的 browser_extract 或滚动后重新快照)`
  }

  const refMap = new Map(allRefs.map(ref => [ref.ref, ref]))
  return {
    text,
    refs: allRefs,
    refMap,
    count: allRefs.length,
    frames: Math.max(0, frames.length - 1),
    captcha,
    scroll,
    title,
    url: page.url(),
    tabId,
    truncated: bounded.truncated,
  }
}
