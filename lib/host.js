import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'

const ARTIFACT_MANIFEST_HINT = '如需把产物写到任意绝对路径，请在插件配置中显式设置 allowAbsoluteArtifacts: true。'

// Chromium 对同名 switch 采用「后写覆盖前写」，因此不能简单追加第二个
// --disable-features，否则会覆盖 Playwright 默认禁用项（其中
// DestroyProfileOnBrowserClose 关系到持久化登录态能否保留）。
// 这里合并 playwright-core 1.64.1 的默认列表与长时运行需要的遮挡窗口节流。
// 升级 playwright-core 时需同步该列表。
const PLAYWRIGHT_DISABLED_FEATURES = [
  'AvoidUnnecessaryBeforeUnloadCheckSync',
  'DestroyProfileOnBrowserClose',
  'DialMediaRouteProvider',
  'GlobalMediaControls',
  'HttpsUpgrades',
  'LensOverlay',
  'MediaRouter',
  'PaintHolding',
  'ThirdPartyStoragePartitioning',
  'BlockOriginHeaderModificationOnRedirect',
  'AvoidCorsURLLoaderRestartOnRedirect',
  'Translate',
  'AutoDeElevate',
  'OptimizationHints',
  'NetworkTimeServiceQuerying',
  'AimEnabled',
  'msForceBrowserSignIn',
  'msEdgeUpdateLaunchServicesPreferredVersion',
  'CalculateNativeWinOcclusion',
]


function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
  return dir
}

function safeFileName(input, fallback = 'artifact') {
  const value = String(input ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80)
  return value || fallback
}

function timestampName(prefix, ext) {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${prefix}-${stamp}${ext}`
}

function normalizeExt(ext, fallback = '.png') {
  const value = String(ext || fallback).trim()
  if (!value) return fallback
  return value.startsWith('.') ? value : `.${value}`
}

function isInside(baseDir, target) {
  const relative = path.relative(baseDir, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveOutputPath(baseDir, requested, { allowAbsolute, ext, fallbackExt, prefix, kind }) {
  if (!requested) {
    const fileExt = normalizeExt(ext, fallbackExt)
    return path.join(baseDir, timestampName(safeFileName(prefix, kind), fileExt))
  }

  const text = String(requested)
  if (path.isAbsolute(text) && !allowAbsolute) {
    throw new Error(
      `${kind}路径必须是相对路径，或把 allowAbsoluteArtifacts 设为 true 后再使用绝对路径。` +
        `当前拒绝：${text}。${ARTIFACT_MANIFEST_HINT}`,
    )
  }

  const resolved = path.isAbsolute(text) ? path.resolve(text) : path.resolve(baseDir, text)
  if (!path.isAbsolute(text) && !isInside(baseDir, resolved)) {
    throw new Error(`${kind}路径越出了配置目录 ${baseDir}：${text}。${ARTIFACT_MANIFEST_HINT}`)
  }
  return path.extname(resolved) ? resolved : `${resolved}${normalizeExt(ext, fallbackExt)}`
}

function isRecoverableError(error) {
  const message = errorMessage(error)
  return /Target closed|Target page, context or browser has been closed|crash|disconnected|browser has been closed|Protocol error|ECONNRESET|EPIPE/i.test(
    message,
  )
}

function launchHint(message) {
  if (/EPERM|EACCES|access is denied|Access is denied|spawn .*EPERM/i.test(message)) {
    return (
      ' 浏览器进程启动被系统拒绝（EPERM/EACCES）：可能是受限沙箱、权限不足或安全软件拦截。' +
      '请在普通用户桌面会话中重试，或检查 userDataDir 与浏览器可执行文件的访问权限。'
    )
  }
  if (/msedge|Chromium distribution|executable doesn't exist|ENOENT|is not found|Failed to launch/i.test(message)) {
    return (
      ' 未找到可用的 Edge/Chromium：请安装 Microsoft Edge，或把配置 channel 改为 chrome，' +
      '也可以设置 executablePath 指向浏览器可执行文件。'
    )
  }
  if (/ProcessSingleton|SingletonLock|profile|user data directory|正在使用|locked|另一个/i.test(message)) {
    return (
      ' 浏览器配置目录可能被另一个 Edge/Chrome 进程占用：请关闭占用同一 userDataDir 的浏览器，' +
      '或换一个 userDataDir，或改用 mode=cdp 连接已启动的浏览器。'
    )
  }
  if (/ECONNREFUSED|connectOverCDP|websocket|CDP/i.test(message)) {
    return (
      ' 无法连接 CDP：请先用 --remote-debugging-port=9222 启动 Edge/Chrome，' +
      '并在配置里填写对应的 cdpUrl。'
    )
  }
  if (isRecoverableError(errorMessage(message))) {
    return ' 浏览器进程已退出：下一次工具调用会自动重启；若反复失败，请检查 userDataDir 权限与浏览器版本。'
  }
  return ' 请检查浏览器安装、userDataDir 权限与配置后重试。'
}

/**
 * 浏览器生命周期宿主。
 *
 * - ensure(): 启动或复用浏览器；已断开时自动重启一次。
 * - close()/dispose(): 关闭进程或断开 CDP，并清理 watchdog。
 * - status(): 供 browser_status 与诊断使用的健康快照。
 *
 * 默认静默：不调用 page.bringToFront()，也不把窗口带到前台。
 */
export class BrowserHost extends EventEmitter {
  constructor(config) {
    super()
    this.config = config
    this.context = null
    this.browser = null
    this.browserVersion = null
    this.launchedAt = null
    this.restartCount = 0
    this.lastError = null
    this.state = 'idle'
    this.launching = null
    this.launchedOnce = false
    this.closing = false
    this.disposed = false
    this.watchdogTimer = null
    this.chromiumPromise = null
  }

  async ensure() {
    if (this.disposed) {
      throw new Error('浏览器宿主已释放，无法继续使用。请重新加载插件或重启 DSH 会话。')
    }

    if (this.context) {
      let connected = true
      try {
        connected = this.browser?.isConnected?.() !== false
      } catch {
        connected = false
      }
      if (connected) return this.context
      this.#markDisconnected('浏览器连接已断开')
    }

    if (this.launching) return this.launching

    const recovering = this.launchedOnce || this.state === 'disconnected'
    if (recovering) this.restartCount += 1
    this.state = 'launching'
    this.launching = this.#start({ recovering }).finally(() => {
      this.launching = null
    })
    return this.launching
  }

  async close(reason = 'manual') {
    if (this.closing) return
    this.closing = true
    this.#stopWatchdog()

    const context = this.context
    const browser = this.browser
    this.context = null
    this.browser = null
    this.browserVersion = null
    this.state = 'closed'
    this.closedReason = reason

    try {
      if (this.config.mode === 'cdp') {
        // CDP 模式只断开连接，不关闭用户已有的浏览器进程与标签页。
        if (browser) await browser.close()
      } else if (context) {
        await context.close()
      }
    } catch (error) {
      this.lastError = {
        message: `关闭浏览器时出错（已忽略，不影响后续重启）：${errorMessage(error)}`,
        at: Date.now(),
        kind: 'close',
      }
    } finally {
      this.closing = false
    }
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.close('dispose')
    this.#stopWatchdog()
    this.removeAllListeners()
  }

  status() {
    let pages = 0
    try {
      pages = this.context?.pages?.().length ?? 0
    } catch {
      pages = 0
    }
    let connected = false
    try {
      connected = Boolean(this.browser?.isConnected?.())
    } catch {
      connected = false
    }
    return {
      loaded: Boolean(this.context),
      connected,
      mode: this.config.mode,
      visibility: this.config.visibility,
      browserVersion: this.browserVersion,
      pages,
      launchedAt: this.launchedAt,
      restartCount: this.restartCount,
      lastError: this.lastError?.message ?? null,
      lastErrorAt: this.lastError?.at ?? null,
      state: this.state,
      watchdogActive: Boolean(this.watchdogTimer),
      idleCloseMs: this.config.idleCloseMs,
    }
  }

  async artifactPath(requested, { ext = '.png', prefix = 'shot' } = {}) {
    await ensureDir(this.config.artifactDir)
    const filePath = resolveOutputPath(this.config.artifactDir, requested, {
      allowAbsolute: this.config.allowAbsoluteArtifacts === true,
      ext,
      fallbackExt: '.png',
      prefix,
      kind: '产物',
    })
    await ensureDir(path.dirname(filePath))
    return filePath
  }

  async downloadPath(requested, suggestedName) {
    await ensureDir(this.config.downloadsDir)
    if (requested) {
      const filePath = resolveOutputPath(this.config.downloadsDir, requested, {
        allowAbsolute: this.config.allowAbsoluteArtifacts === true,
        ext: path.extname(suggestedName || ''),
        fallbackExt: '',
        prefix: 'download',
        kind: '下载',
      })
      await ensureDir(path.dirname(filePath))
      return filePath
    }

    const ext = path.extname(suggestedName || '') || ''
    const base = path.basename(suggestedName || timestampName('download', ext), ext)
    return path.join(this.config.downloadsDir, `${safeFileName(base, 'download')}${ext}`)
  }

  async #start({ recovering }) {
    let lastError = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const context = await this.#launch()
        if (recovering || attempt > 1) this.emit('recovered', { attempt })
        return context
      } catch (error) {
        lastError = error
        this.lastError = { message: errorMessage(error), at: Date.now(), kind: 'launch' }
        const canRetry = attempt === 1 && this.config.autoRelaunch !== false && (recovering || isRecoverableError(error))
        if (!canRetry) break
        await this.#cleanupTransient()
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    this.state = 'disconnected'
    throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError))
  }

  async #loadChromium() {
    if (!this.chromiumPromise) {
      this.chromiumPromise = import('playwright-core')
        .then(module => module.chromium)
        .catch(error => {
          this.chromiumPromise = null
          throw new Error(
            `无法加载 playwright-core：${errorMessage(error)}。` +
              '请在插件目录执行 pnpm install --prod 后重试。',
          )
        })
    }
    return this.chromiumPromise
  }

  async #launch() {
    await ensureDir(this.config.userDataDir)
    await ensureDir(this.config.artifactDir)
    await ensureDir(this.config.downloadsDir)

    const chromium = await this.#loadChromium()
    let context = null
    let browser = null

    try {
      if (this.config.mode === 'cdp') {
        if (!this.config.cdpUrl) {
          throw new Error('mode=cdp 时必须配置 cdpUrl，例如 http://127.0.0.1:9222。')
        }
        browser = await chromium.connectOverCDP(this.config.cdpUrl, { timeout: 20000 })
        context = browser.contexts()[0]
        if (!context) {
          throw new Error(
            '已连接 CDP，但没有可用的浏览器上下文。请先在该浏览器里打开至少一个窗口，再重试。',
          )
        }
      } else {
        const headless = this.config.visibility === 'headless'
        const launchOptions = {
          headless,
          viewport: headless ? { width: 1440, height: 900 } : null,
          locale: this.config.locale || 'zh-CN',
          timezoneId: this.config.timezoneId || 'Asia/Shanghai',
          colorScheme: 'light',
          acceptDownloads: true,
          downloadsPath: this.config.downloadsDir,
          slowMo: 0,
          args: this.#launchArgs(),
        }
        if (this.config.executablePath) {
          launchOptions.executablePath = this.config.executablePath
        } else {
          launchOptions.channel = this.config.channel || 'msedge'
        }
        context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions)
        browser = context.browser()
      }

      this.context = context
      this.browser = browser
      this.browserVersion = browser ? await browser.version().catch(() => null) : null
      this.launchedAt = Date.now()
      this.launchedOnce = true
      this.state = 'ready'
      this.#attach(context, browser)
      this.#startWatchdog()
      this.emit('launched', { context, browser })
      return context
    } catch (error) {
      // 先摘掉当前引用，避免清理时触发的 close/disconnected 事件被误判为运行中断开。
      this.context = null
      this.browser = null
      this.browserVersion = null
      try {
        await context?.close()
      } catch {
        /* ignore */
      }
      try {
        await browser?.close()
      } catch {
        /* ignore */
      }
      const message = errorMessage(error)
      throw new Error(`浏览器启动失败：${message}。${launchHint(message)}`)
    }
  }

  #launchArgs() {
    const args = [
      '--no-first-run',
      '--no-default-browser-check',
      // 长时运行：避免后台标签页定时器降频、渲染进程被降级、遮挡窗口被节流。
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      `--disable-features=${PLAYWRIGHT_DISABLED_FEATURES.join(',')}`,
      '--disable-ipc-flooding-protection',
    ]
    if (this.config.visibility === 'offscreen') {
      // 有头但放到屏幕外，尽量不干扰人类开发者；--start-minimized 不支持的版本会忽略。
      args.push('--window-position=-32000,-32000', '--window-size=1440,900', '--start-minimized')
    } else if (this.config.visibility === 'window') {
      args.push('--window-size=1440,900')
    }
    return args
  }

  #attach(context, browser) {
    context.on('page', page => this.emit('page', page))
    context.on('close', () => {
      if (this.context === context && !this.closing) this.#markDisconnected('浏览器窗口已关闭')
    })
    browser?.on('disconnected', () => {
      if (this.context === context && !this.closing) this.#markDisconnected('浏览器连接已断开')
    })
  }

  #markDisconnected(reason) {
    if (!this.context && !this.browser && this.state === 'disconnected') return
    this.#stopWatchdog()
    this.context = null
    this.browser = null
    this.browserVersion = null
    this.state = 'disconnected'
    this.lastError = {
      message: `${reason}。下一次工具调用会自动重启浏览器；如反复出现，请检查 userDataDir 权限与浏览器版本。`,
      at: Date.now(),
      kind: 'disconnected',
    }
    this.emit('disconnected', reason)
  }

  #startWatchdog() {
    this.#stopWatchdog()
    const every = Math.max(5000, Number(this.config.watchdogIntervalMs) || 30000)
    this.watchdogTimer = setInterval(() => this.#checkHealth(), every)
    this.watchdogTimer.unref?.()
  }

  #stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  #checkHealth() {
    if (this.disposed || this.closing || !this.context) return
    try {
      if (this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected()) {
        this.#markDisconnected('watchdog 检测到浏览器连接已断开')
      }
    } catch (error) {
      this.#markDisconnected(`watchdog 健康检查失败：${errorMessage(error)}`)
    }
  }

  async #cleanupTransient() {
    this.#stopWatchdog()
    const context = this.context
    const browser = this.browser
    this.context = null
    this.browser = null
    this.browserVersion = null
    try {
      await context?.close()
    } catch {
      /* ignore */
    }
    try {
      await browser?.close()
    } catch {
      /* ignore */
    }
  }
}
