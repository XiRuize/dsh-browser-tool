import os from 'node:os'
import path from 'node:path'

/**
 * v0.2 配置解析。
 *
 * 设计原则：
 * - 所有字段都有明确默认值，调用方只需要关心与默认不同的项。
 * - `visibility` 是唯一的可见性来源；旧配置里的 `headless` 布尔值只作为兼容别名。
 * - 默认必须静默（headless）、长时驻留（idleCloseMs=0）、可自动恢复（autoRelaunch=true）。
 * - 产物目录统一解析为绝对路径，避免相对路径随进程工作目录漂移。
 */

export const VISIBILITIES = Object.freeze(['headless', 'offscreen', 'window'])

const DEFAULT_HOME = path.join(os.homedir(), '.dsh')

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function asBoolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  return fallback
}

/**
 * 展开 ~、$VAR、${VAR}、%VAR%，返回未解析的路径文本。
 * 不依赖第三方库，Windows/macOS/Linux 行为一致。
 */
export function expandPath(value, env = process.env) {
  let text = String(value ?? '').trim()
  if (!text) return ''
  if (text === '~') text = os.homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) {
    text = path.join(os.homedir(), text.slice(2))
  }

  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => {
    const replacement = env[name]
    return replacement === undefined ? match : replacement
  })
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const replacement = env[name]
    return replacement === undefined ? match : replacement
  })
  text = text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => {
    const replacement = env[name]
    return replacement === undefined ? match : replacement
  })
  return text
}

function resolveDir(value, fallback, env) {
  const expanded = expandPath(value, env)
  return path.resolve(expanded || fallback)
}

function pickVisibility(raw) {
  const requested = String(raw.visibility ?? '').trim().toLowerCase()
  if (VISIBILITIES.includes(requested)) return requested
  if (typeof raw.headless === 'boolean') return raw.headless ? 'headless' : 'window'
  return 'headless'
}

/**
 * @param {object} [raw] 插件配置（cordis.patch.yml 的 config 或调用方直接传入）
 * @returns {object} 完整、可直接使用的配置对象
 */
export function resolveConfig(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const env = process.env
  const home = expandPath(input.dshHome || env.DSH_HOME || env.DSH_HOME_DIR || DEFAULT_HOME, env) || DEFAULT_HOME
  const baseDir = path.join(home, 'browser-tool')
  const visibility = pickVisibility(input)

  return {
    mode: input.mode === 'cdp' ? 'cdp' : 'launch',
    channel: String(input.channel || 'msedge'),
    executablePath: expandPath(input.executablePath, env),
    cdpUrl: String(input.cdpUrl || ''),

    userDataDir: resolveDir(input.userDataDir, path.join(baseDir, 'profile'), env),
    artifactDir: resolveDir(input.artifactDir, path.join(baseDir, 'artifacts'), env),
    downloadsDir: resolveDir(input.downloadsDir, path.join(baseDir, 'downloads'), env),

    visibility,
    // 兼容旧代码读取 config.headless；新代码一律使用 visibility。
    headless: visibility === 'headless',
    locale: String(input.locale || 'zh-CN'),
    timezoneId: String(input.timezoneId || 'Asia/Shanghai'),

    actionTimeoutMs: clampInt(input.actionTimeoutMs, 15000, 1000, 180000),
    navigationTimeoutMs: clampInt(input.navigationTimeoutMs, 45000, 5000, 180000),
    // 导航后的固定等待改为可配置的“沉降时间”，默认只留 120ms 兜底。
    navigateSettleMs: clampInt(input.navigateSettleMs, 120, 0, 5000),
    // 可选：导航后等待某个选择器出现，适合必须等水合完成的 SPA。
    navigateWaitSelector: String(input.navigateWaitSelector || ''),
    snapshotMaxChars: clampInt(input.snapshotMaxChars, 12000, 1000, 30000),
    extractMaxChars: clampInt(input.extractMaxChars, 30000, 1000, 200000),

    // 批量采集：并发默认 4，条目间隔默认 0，渲染等待默认 250ms。
    collectConcurrency: clampInt(input.collectConcurrency, 4, 1, 8),
    collectDelayMs: clampInt(input.collectDelayMs, 0, 0, 10000),
    collectRenderWaitMs: clampInt(input.collectRenderWaitMs, 250, 0, 10000),
    collectRetries: clampInt(input.collectRetries, 2, 0, 5),
    collectPageReuse: asBoolean(input.collectPageReuse, true),

    // HTTP 快通道（复用登录 Cookie 直连，不渲染）。
    fetchTimeoutMs: clampInt(input.fetchTimeoutMs, 30000, 1000, 180000),
    fetchRetries: clampInt(input.fetchRetries, 2, 0, 5),

    // 临时暂存区：原始内容先落盘，清洗后再返回，最后按 TTL/容量清理。
    scratchDir: resolveDir(input.scratchDir, path.join(baseDir, 'scratch'), env),
    scratchTtlMs: clampInt(input.scratchTtlMs, 3600000, 60000, 86400000),
    scratchMaxBytes: clampInt(input.scratchMaxBytes, 536870912, 1048576, 8589934592),

    // 启动预算：单次 launchPersistentContext 的超时，以及所有重试的总预算。
    // 单次 30s 覆盖带大 profile 的冷启动；总预算 55s 必须小于常见工具层超时
    // （browser_snapshot=45s、截图/网络=60s、browser_open=90s），否则调用会被工具层
    // 先中止而底层启动仍在继续，状态机会出现「工具已失败但浏览器稍后又连上」的矛盾。
    launchTimeoutMs: clampInt(input.launchTimeoutMs, 30000, 5000, 180000),
    launchDeadlineMs: clampInt(input.launchDeadlineMs, 55000, 10000, 300000),

    // 长时运行：默认永不因空闲自动关闭；watchdog 默认 30 秒。
    idleCloseMs: clampInt(input.idleCloseMs, 0, 0, 86400000),
    watchdogIntervalMs: clampInt(input.watchdogIntervalMs, 30000, 5000, 300000),
    autoRelaunch: asBoolean(input.autoRelaunch, true),

    maxTabs: clampInt(input.maxTabs, 24, 1, 200),
    maxIdleTabs: clampInt(input.maxIdleTabs, 8, 0, 100),
    idleTabMs: clampInt(input.idleTabMs, 600000, 0, 86400000),

    // 高风险能力默认关闭，必须显式配置为 true。
    allowEval: asBoolean(input.allowEval, false),
    allowAbsoluteArtifacts: asBoolean(input.allowAbsoluteArtifacts, false),

    networkMaxEntries: clampInt(input.networkMaxEntries, 80, 1, 500),
    networkMaxBodyChars: clampInt(input.networkMaxBodyChars, 120000, 1000, 1000000),
  }
}
