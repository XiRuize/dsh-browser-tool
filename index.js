import os from 'node:os'
import path from 'node:path'
import { BrowserManager } from './lib/manager.js'
import { registerBrowserTools } from './lib/tools.js'

export const name = 'browser-tool'
export const inject = ['tools']

function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

// Kept as documentation for available fields. The Loader requires a
// schemastery validator for `Config`; this plugin resolves defaults itself and
// accepts the profile patch's raw config, so it deliberately exports no Config.
export const ConfigSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: {
      type: 'string',
      enum: ['launch', 'cdp'],
      default: 'launch',
      description: 'launch = 由本工具启动独立 Edge profile；cdp = 连接已启动的浏览器。',
    },
    channel: {
      type: 'string',
      default: 'msedge',
      description: 'Playwright 浏览器通道，例如 msedge、chrome、chromium。',
    },
    executablePath: {
      type: 'string',
      description: '浏览器可执行文件的绝对路径；设置后忽略 channel。',
    },
    cdpUrl: {
      type: 'string',
      description: 'mode=cdp 时的 CDP 地址，例如 http://127.0.0.1:9222。',
    },
    userDataDir: {
      type: 'string',
      description: '持久化登录态的浏览器配置目录。',
    },
    headless: {
      type: 'boolean',
      default: false,
      description: '是否无头运行。企查查等需要人工验证的站点建议保持 false。',
    },
    locale: { type: 'string', default: 'zh-CN' },
    timezoneId: { type: 'string', default: 'Asia/Shanghai' },
    actionTimeoutMs: {
      type: 'integer',
      default: 15000,
      minimum: 1000,
      maximum: 180000,
    },
    navigationTimeoutMs: {
      type: 'integer',
      default: 45000,
      minimum: 5000,
      maximum: 180000,
    },
    snapshotMaxChars: {
      type: 'integer',
      default: 12000,
      minimum: 1000,
      maximum: 30000,
    },
    extractMaxChars: {
      type: 'integer',
      default: 30000,
      minimum: 1000,
      maximum: 200000,
    },
    collectConcurrency: {
      type: 'integer',
      default: 2,
      minimum: 1,
      maximum: 4,
    },
    collectDelayMs: {
      type: 'integer',
      default: 800,
      minimum: 0,
      maximum: 10000,
    },
    collectRenderWaitMs: {
      type: 'integer',
      default: 700,
      minimum: 200,
      maximum: 10000,
    },
    idleCloseMs: {
      type: 'integer',
      default: 900000,
      minimum: 0,
      maximum: 86400000,
    },
    artifactDir: {
      type: 'string',
      description: '截图、提取全文、批量采集 JSON 的保存目录。',
    },
    downloadsDir: {
      type: 'string',
      description: '浏览器下载文件的保存目录。',
    },
    networkMaxEntries: {
      type: 'integer',
      default: 80,
      minimum: 1,
      maximum: 500,
    },
    networkMaxBodyChars: {
      type: 'integer',
      default: 120000,
      minimum: 1000,
      maximum: 1000000,
    },
  },
}

function expandHome(value) {
  const text = String(value || '')
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2))
  return text
}

function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const base = path.join(home, 'browser-tool')
  return {
    mode: config.mode === 'cdp' ? 'cdp' : 'launch',
    channel: String(config.channel || 'msedge'),
    executablePath: expandHome(config.executablePath),
    cdpUrl: String(config.cdpUrl || ''),
    userDataDir: path.resolve(expandHome(config.userDataDir) || path.join(base, 'profile')),
    artifactDir: path.resolve(expandHome(config.artifactDir) || path.join(base, 'artifacts')),
    downloadsDir: path.resolve(expandHome(config.downloadsDir) || path.join(base, 'downloads')),
    headless: config.headless === true,
    locale: String(config.locale || 'zh-CN'),
    timezoneId: String(config.timezoneId || 'Asia/Shanghai'),
    actionTimeoutMs: positiveInt(config.actionTimeoutMs, 15000, 1000, 180000),
    navigationTimeoutMs: positiveInt(config.navigationTimeoutMs, 45000, 5000, 180000),
    snapshotMaxChars: positiveInt(config.snapshotMaxChars, 12000, 1000, 30000),
    extractMaxChars: positiveInt(config.extractMaxChars, 30000, 1000, 200000),
    collectConcurrency: positiveInt(config.collectConcurrency, 2, 1, 4),
    collectDelayMs: positiveInt(config.collectDelayMs, 800, 0, 10000),
    collectRenderWaitMs: positiveInt(config.collectRenderWaitMs, 700, 200, 10000),
    idleCloseMs: positiveInt(config.idleCloseMs, 900000, 0, 86400000),
    networkMaxEntries: positiveInt(config.networkMaxEntries, 80, 1, 500),
    networkMaxBodyChars: positiveInt(config.networkMaxBodyChars, 120000, 1000, 1000000),
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const manager = new BrowserManager(config)
  ctx.effect(() => () => manager.dispose())
  registerBrowserTools(ctx, manager, config)
}
