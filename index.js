import { resolveConfig } from './lib/config.js'
import { BrowserManager } from './lib/manager.js'
import { registerBrowserTools } from './lib/tools.js'

export const name = 'browser-tool'
export const inject = ['tools']

function loggerOf(ctx) {
  try {
    if (typeof ctx?.logger === 'function') return ctx.logger('browser-tool')
    return ctx?.logger ?? null
  } catch {
    return null
  }
}

function warn(ctx, message) {
  try {
    loggerOf(ctx)?.warn?.(message)
  } catch {
    /* 日志失败不应影响工具注册 */
  }
}

/**
 * 可选注册 DSH browserUse provider。
 *
 * 当前 profile 不一定安装 browserUse 服务，因此这里只做尽力而为的注册：
 * 缺失或注册失败时仅记录 warning，绝不影响浏览器工具本身的注册与使用。
 */
function registerBrowserUse(ctx) {
  try {
    const browserUse = typeof ctx?.get === 'function' ? ctx.get('browserUse') : null
    if (!browserUse || typeof browserUse.register !== 'function') return
    const result = browserUse.register('dsh-browser-tool')
    if (result && typeof result.then === 'function') {
      result.catch(error => {
        warn(ctx, `browserUse 注册失败，已跳过（不影响浏览器工具）：${error?.message ?? error}`)
      })
    }
  } catch (error) {
    warn(ctx, `browserUse 注册失败，已跳过（不影响浏览器工具）：${error?.message ?? error}`)
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const manager = new BrowserManager(config)

  ctx.effect(() => () => manager.dispose())
  registerBrowserUse(ctx)
  registerBrowserTools(ctx, manager, config)
}
