/**
 * 人机验证（验证码 / 滑块 / 真人确认）的识别与交接。
 *
 * 边界（见 SECURITY.md，不变）：**不识别验证码答案、不自动点击验证码、不做 stealth 绕过**。
 * 这里解决的是另一半问题——识别出来之后「怎么有效地交给人」：
 * 说清是什么验证、窗口在不在人眼前、下一步该跑哪个命令、以及等人做完后自动继续。
 *
 * 对外只有四件事：
 * - classifyHumanCheck({...})：纯函数，按 iframe 域名 / 页面文字 / 标题判定类型；
 * - humanCheckInPage：注入页面执行的探测函数（自己找验证码容器、iframe、文字）；
 * - describeHumanCheck({...})：纯函数，生成给人看/给模型看的交接说明与下一步命令；
 * - waitForHumanClear(page, {...})：轮询直到验证消失或超时，绝不代答。
 */

/** 页面文字里出现这些字样就当作「可能有真人验证」。 */
export const HUMAN_CHECK_TEXT_RE =
  /验证码|人机验证|安全验证|滑动验证|拖动滑块|滑块验证|点击图片|请完成验证|验证你是人类|完成验证|verify you are human|i'm not a robot|are you a robot|captcha/i

/** 第三方验证组件的域名特征 → 类型与展示名。顺序即优先级。 */
const KIND_RULES = [
  {
    kind: 'cloudflare-turnstile',
    label: 'Cloudflare Turnstile 真人确认',
    re: /challenges\.cloudflare\.com|turnstile/i,
    note: '通常只需勾选「我是人类」，有时会自动通过。',
  },
  {
    kind: 'hcaptcha',
    label: 'hCaptcha 人机验证',
    re: /hcaptcha\.com|hcaptcha\.net/i,
    note: '常见为图片点选（例如选出路灯、斑马线）。',
  },
  {
    kind: 'recaptcha',
    label: 'reCAPTCHA 人机验证',
    re: /recaptcha|google\.com\/recaptcha|gstatic\.com\/recaptcha/i,
    note: '可能是「我不是机器人」勾选，也可能是九宫格图片点选。',
  },
  {
    kind: 'geetest',
    label: '极验滑块验证',
    re: /geetest|captcha\.geetest|gt\.js/i,
    note: '拖动滑块把拼图缺口补上。',
  },
  {
    kind: 'aliyun',
    label: '阿里云滑块验证',
    re: /nc\.alicdn\.com|captcha\.aliyun|aliyun\.com\/captcha/i,
    note: '按住滑块拖到最右端。',
  },
  {
    kind: 'tencent',
    label: '腾讯防水墙验证',
    re: /turing\.qq\.com|captcha\.qq\.com|ssl\.captcha\.qq\.com/i,
    note: '可能是滑块或点选。',
  },
  {
    kind: 'slider',
    label: '滑块/拼图验证',
    re: /拖动滑块|滑动验证|滑块验证|拼图|点击图片|九宫格|请完成验证|选择所有/i,
    note: '拖动滑块补上缺口，或点选指定图片。',
  },
  {
    kind: 'slider',
    label: '滑块/拼图验证',
    re: /slider|captcha/i,
    note: '拖动滑块完成拼图。',
  },
]

const KIND_BY_NAME = new Map(KIND_RULES.map(rule => [rule.kind, rule]))

/**
 * 纯函数：按 iframe 地址、页面文字、标题判定验证类型。
 * @param {{frameUrls?: string[], text?: string, title?: string}} input
 * @returns {{kind: string, label: string, note: string, evidence: string[]} | null}
 */
export function classifyHumanCheck({ frameUrls = [], text = '', title = '' } = {}) {
  const urls = (Array.isArray(frameUrls) ? frameUrls : []).filter(Boolean)
  const haystacks = [
    ...urls.map(url => ({ where: 'iframe', value: String(url) })),
    { where: 'text', value: String(text || '') },
    { where: 'title', value: String(title || '') },
  ]

  for (const rule of KIND_RULES) {
    const hit = haystacks.find(item => rule.re.test(item.value))
    if (hit) {
      const target = urlForDisplay(hit.value)
      return {
        kind: rule.kind,
        label: rule.label,
        note: rule.note,
        evidence: [`${hit.where === 'iframe' ? 'iframe 域名' : hit.where === 'title' ? '页面标题' : '页面文字'}：${target}`],
      }
    }
  }

  if (HUMAN_CHECK_TEXT_RE.test(String(text || '')) || HUMAN_CHECK_TEXT_RE.test(String(title || ''))) {
    const matched = String(text || '').match(HUMAN_CHECK_TEXT_RE)?.[0] || String(title || '')
    return {
      kind: 'unknown',
      label: '疑似人机验证 / 访问限制',
      note: '未识别出具体验证组件，可能还需要登录或等待风控冷却。',
      evidence: [`页面文字：${matched}`],
    }
  }
  return null
}

function urlForDisplay(raw) {
  const value = String(raw)
  if (!/^https?:/i.test(value)) return value.slice(0, 120)
  try {
    const url = new URL(value)
    return `${url.host}${url.pathname}`.slice(0, 120)
  } catch {
    return value.slice(0, 120)
  }
}

/**
 * 纯函数：生成交接说明。
 * @param {{detection?: object|null, visibility?: string, url?: string}} input
 */
export function describeHumanCheck({ detection = null, visibility = 'headless', url = '' } = {}) {
  if (!detection) return { detected: false }
  const canSeeWindow = visibility === 'window' || visibility === 'offscreen'
  const steps = []
  if (canSeeWindow) {
    steps.push('调用 browser_show({action:"show"}) 把窗口带到前台，请人完成验证。')
  } else {
    steps.push('当前是 headless，人看不到窗口：调用 browser_show({action:"set", visibility:"window"}) 重启到可见模式（登录态保留）。')
    steps.push(`重启后调用 browser_open("${url || '原 URL'}") 回到同一页，再请人完成验证。`)
  }
  steps.push('调用 browser_act({action:"waitForHuman", timeoutMs:120000}) 等人做完；验证消失后动作会自动继续。')
  steps.push('不要自动点击验证码、不要伪装指纹；验证一直不过时先停下，把情况报给用户。')

  return {
    detected: true,
    kind: detection.kind,
    label: detection.label,
    note: detection.note,
    evidence: detection.evidence,
    canSeeWindow,
    visibility,
    steps,
    waitTool: 'browser_act',
    waitAction: 'waitForHuman',
  }
}

/**
 * 注入页面执行的探测函数（必须自包含，不能引用模块作用域变量）。
 * 只读，不点任何东西。
 */
export function humanCheckInPage() {
  const text = String(document.body?.innerText || '')
    .replace(/\s+/g, ' ')
    .slice(0, 4000)
  const frameUrls = []
  for (const frame of document.querySelectorAll('iframe')) {
    const src = frame.getAttribute?.('src') || ''
    if (src) frameUrls.push(src)
  }
  const markers = []
  const selector = [
    '[id*="captcha" i]',
    '[class*="captcha" i]',
    '[id*="verify" i][role="dialog"]',
    '[data-testid*="captcha" i]',
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="turnstile" i]',
    'iframe[src*="geetest" i]',
  ].join(',')
  try {
    for (const node of Array.from(document.querySelectorAll(selector)).slice(0, 5)) {
      markers.push(String(node.id || node.className || node.tagName || '').slice(0, 60))
    }
  } catch {
    /* 选择器不支持时退化为只判文字 */
  }
  return { text, frameUrls, markers, title: document.title || '', url: location.href }
}

/**
 * 在页面里探测一次人机验证。
 * @param {import('playwright-core').Page} page
 */
export async function detectHumanCheck(page) {
  if (!page || page.isClosed?.()) return { detected: false }
  let raw = null
  try {
    raw = await page.evaluate(humanCheckInPage)
  } catch {
    return { detected: false }
  }
  const detection = classifyHumanCheck({
    frameUrls: raw.frameUrls || [],
    text: raw.text || '',
    title: raw.title || '',
  })
  if (!detection) return { detected: false }
  return {
    detected: true,
    ...detection,
    markers: raw.markers || [],
    url: raw.url || page.url?.() || '',
  }
}

/**
 * 等人工完成验证：轮询到验证消失为止。**不代答、不点击验证码**。
 * @param {import('playwright-core').Page} page
 * @param {{timeoutMs?: number, intervalMs?: number, onTick?: (info: object) => void}} options
 * @returns {Promise<{resolved: boolean, elapsedMs: number, attempts: number, last: object|null}>}
 */
export async function waitForHumanClear(page, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000)
  const intervalMs = Math.max(250, Number(options.intervalMs) || 1500)
  const started = Date.now()
  let attempts = 0
  let last = null
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    last = await detectHumanCheck(page)
    options.onTick?.(last)
    if (!last.detected) {
      return { resolved: true, elapsedMs: Date.now() - started, attempts, last: null }
    }
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)))
  }
  return { resolved: false, elapsedMs: Date.now() - started, attempts, last }
}

export function humanCheckKindLabel(kind) {
  return KIND_BY_NAME.get(String(kind || ''))?.label || '人机验证'
}
