/**
 * 拦截识别（0.9）。
 *
 * 目标不是“绕过”，而是把「被拦」与「网络错误」分开，并给出可执行的下一步：
 * - HTTP 403/429/503 + 安全页特征 → blocked
 * - Security Page / NCGR / F5 / Just a moment / Access Denied → blocked
 * - DNS/TLS/超时 → 不是 blocked，保持原错误语义
 */

const TEXT_PATTERNS = [
  { re: /Security Page/i, reason: '门户安全页（Security Page）' },
  { re: /\bNCGR\b/i, reason: '沙特 NCGR 网关拦截页' },
  { re: /Just a moment\.\.\./i, reason: 'Cloudflare 人机验证' },
  { re: /Attention Required! \| Cloudflare/i, reason: 'Cloudflare 拦截' },
  { re: /Access Denied/i, reason: 'Access Denied' },
  { re: /F5 Networks|BIG-IP/i, reason: 'F5 反爬拦截' },
  { re: /请求被拒绝|访问被拒绝|访问受限/, reason: '中文访问拒绝页' },
]

const HEADER_HINTS = [
  { header: 'cf-mitigated', reason: 'Cloudflare 挑战' },
  { header: 'x-application-context', reason: 'F5/安全网关' },
]

/** 判断响应是否被拦截；返回 {blocked, reason, kind}。纯函数。 */
export function detectBlock({ status = 0, headers = {}, body = '', extraPatterns = [] } = {}) {
  const text = String(body || '').slice(0, 20000)
  const patterns = [...TEXT_PATTERNS]
  for (const pattern of extraPatterns || []) {
    if (!pattern) continue
    try {
      patterns.push({ re: new RegExp(String(pattern), 'i'), reason: `命中自定义拦截特征：${pattern}` })
    } catch {
      /* 非法正则忽略 */
    }
  }

  for (const { re, reason } of patterns) {
    if (re.test(text)) return { blocked: true, reason, kind: 'body' }
  }
  for (const hint of HEADER_HINTS) {
    if (headers && headers[hint.header]) return { blocked: true, reason: hint.reason, kind: 'header' }
  }
  if (status === 409 && /bot|robot|captcha|challenge/i.test(text)) {
    return { blocked: true, reason: '疑似机器人校验（409）', kind: 'status' }
  }
  if (status === 403 || status === 429 || status === 503) {
    return {
      blocked: true,
      reason: `HTTP ${status}（限流/拒绝访问）`,
      kind: 'status',
    }
  }
  return { blocked: false, reason: '', kind: '' }
}

/** 针对 blocked 的中文下一步建议。 */
export function blockHint(reason = '', engine = '') {
  const tips = []
  if (engine !== 'curl') tips.push('换 engine=curl（浏览器 TLS 栈 + 绕系统代理）')
  if (engine !== 'playwright') tips.push('换 engine=playwright（复用登录 Cookie）')
  tips.push('用 browser_open 走可见窗口人工过验证/登录')
  tips.push('必要时用 mode=cdp 接管已登录浏览器')
  return `${reason ? `拦截原因：${reason}。` : ''}建议：${tips.join('；')}。`
}
