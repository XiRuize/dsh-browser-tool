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

/**
 * 可重试的启动/运行期错误：进程崩溃、连接断开、以及「进程起来了但迟迟连不上调试通道」的启动超时。
 * 超时必须算可重试，否则残留 profile 占用时插件既不清残留也不重试，只能把错误抛给上层。
 */
export function isRecoverableError(error) {
  const message = errorMessage(error)
  return /Target closed|Target page, context or browser has been closed|crash|disconnected|browser has been closed|Protocol error|ECONNRESET|EPIPE|Timeout \d+ms exceeded/i.test(
    message,
  )
}

/**
 * 把 Playwright 的启动错误翻译成对人有用的中文提示。
 *
 * 关键约束：任何启动失败的 Browser logs 里都会打印 `...\msedge.exe --...` 的完整命令行，
 * 因此**不能用裸 `msedge` 判定「没装 Edge」**——旧实现就是这么把超时误报成
 * 「未找到可用的 Edge/Chromium：请安装 Microsoft Edge」的。只有真正出现
 * 「Executable doesn't exist / Chromium distribution ... is not found / ENOENT」时才认为是缺浏览器。
 */
export function launchHint(message) {
  const text = String(message ?? '')
  if (
    /ProcessSingleton|SingletonLock|already in use|user data directory is already in use|正在使用|另一个 (?:Edge|Chrome)|profile.*(?:in use|locked)/i.test(
      text,
    )
  ) {
    return (
      ' 浏览器配置目录可能被另一个 Edge/Chrome 进程占用：请关闭占用同一 userDataDir 的浏览器，' +
      '或换一个 userDataDir，或改用 mode=cdp 连接已启动的浏览器。'
    )
  }
  if (/Target page, context or browser has been closed|exitCode=21/i.test(text)) {
    return (
      ' 浏览器启动后立即退出（exitCode=21），通常是 userDataDir 被上次崩溃留下的 msedge 进程占用。' +
      '插件会自动清理残留并重试；若持续失败，请手动结束占用该目录的 msedge 进程，或重启系统后再试。'
    )
  }
  if (/Timeout \d+ms exceeded/i.test(text)) {
    return (
      ' 浏览器进程已拉起，但没能在超时时间内建立调试连接（启动超时）：最常见原因是 userDataDir 被残留 msedge 进程占用，' +
      '其次是被安全软件/沙箱拦截。插件会清理残留后重试；若持续失败，请手动结束占用该目录的 msedge 进程，' +
      '或改用 mode=cdp 连接已启动的浏览器。'
    )
  }
  if (/EPERM|EACCES|access is denied|Access is denied|spawn .*EPERM/i.test(text)) {
    return (
      ' 浏览器进程启动被系统拒绝（EPERM/EACCES）：可能是受限沙箱、权限不足或安全软件拦截。' +
      '请在普通用户桌面会话中重试，或检查 userDataDir 与浏览器可执行文件的访问权限。'
    )
  }
  if (/Executable doesn't exist|executable doesn't exist|Chromium distribution .* is not found|ENOENT/i.test(text)) {
    return (
      ' 未找到可用的 Edge/Chromium：请安装 Microsoft Edge，或把配置 channel 改为 chrome，' +
      '也可以设置 executablePath 指向浏览器可执行文件。'
    )
  }
  if (/ECONNREFUSED|connectOverCDP|websocket|CDP/i.test(text)) {
    return (
      ' 无法连接 CDP：请先用 --remote-debugging-port=9222 启动 Edge/Chrome，' +
      '并在配置里填写对应的 cdpUrl。'
    )
  }
  if (isRecoverableError(text)) {
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
    this.cleanupWarning = null
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

  /** 切换可见性后重启：关闭当前上下文，再按新 visibility 拉起（Cookie/登录态保留在 userDataDir）。 */
  async relaunch({ visibility } = {}) {
    const next = visibility ? String(visibility).toLowerCase() : this.config.visibility
    if (!['headless', 'offscreen', 'window'].includes(next)) {
      throw new Error(`visibility 只能是 headless / offscreen / window，收到：${visibility}`)
    }
    this.config.visibility = next
    // 兼容旧字段：headless 由 visibility 派生。
    this.config.headless = next === 'headless'
    await this.close('visibility')
    return this.ensure()
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    await this.close('dispose')
    // 持久化上下文在部分 Windows 环境会残留 msedge 子进程并占住 profile，
    // 释放时顺手清掉，避免下一次启动报 exitCode=21。
    await this.#cleanupStaleProfile().catch(() => {})
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
      cleanupWarning: this.cleanupWarning ?? null,
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

  /**
   * Windows：清理占用当前 userDataDir 的残留 Edge 进程与 lockfile。
   * 只在启动失败（exitCode 21 / profile in use）时调用，避免影响用户自己的浏览器。
   */
  async #cleanupStaleProfile() {
    if (process.platform !== 'win32') return false
    try {
      const { execFileSync } = await import('node:child_process')
      const escaped = this.config.userDataDir.replace(/'/g, "''")
      const script =
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | ` +
        `Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
        `ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
      execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        timeout: 15000,
      })
      const lockfile = path.join(this.config.userDataDir, 'lockfile')
      const fsSync = await import('node:fs')
      try {
        fsSync.rmSync(lockfile, { force: true })
      } catch {
        /* ignore */
      }
      await new Promise(resolve => setTimeout(resolve, 800))
      this.cleanupWarning = null
      return true
    } catch (error) {
      // 清不掉残留进程 = 自愈失效，必须让上层看到，不能静默 return false。
      this.cleanupWarning =
        `清理占用 ${this.config.userDataDir} 的残留 msedge 进程失败：${errorMessage(error)}。` +
        '下一次启动可能仍报 exitCode=21 或启动超时，请手动结束该目录的 msedge 进程。'
      return false
    }
  }

  /**
   * 启动前预检：如果 profile 里还有 lockfile 或残留 msedge 进程（上次崩溃/强杀留下），
   * 先清干净再启动。只在当前没有活动上下文时调用。
   */
  async #prepareProfile() {
    if (process.platform !== 'win32') return false
    const fsSync = await import('node:fs')
    const lockfile = path.join(this.config.userDataDir, 'lockfile')
    const hasLock = fsSync.existsSync(lockfile)
    let hasProcess = false
    try {
      const { execFileSync } = await import('node:child_process')
      const escaped = this.config.userDataDir.replace(/'/g, "''")
      const out = execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${escaped}*' }).Count`,
        ],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      hasProcess = Number(String(out).trim()) > 0
      // 探测成功说明自愈通道可用，清掉上一次留下的告警，避免长期误导。
      this.cleanupWarning = null
    } catch (error) {
      // 探测失败会让 hasProcess 永远是 false，自愈形同虚设；记录下来供 browser_status 显示。
      hasProcess = false
      this.cleanupWarning =
        `启动前探测残留 msedge 进程失败（可能是 PowerShell 被限制或权限不足）：${errorMessage(error)}。` +
        '如果随后出现 exitCode=21 或启动超时，请手动结束占用该 userDataDir 的 msedge 进程。'
    }
    if (!hasLock && !hasProcess) return false
    return this.#cleanupStaleProfile()
  }

  async #start({ recovering }) {
    let lastError = null
    // 总启动预算：所有尝试（含 180s 默认超时）必须在这个预算内结束，
    // 否则工具层（browser_open=90s）会先中止调用，而底层 launch 还在跑。
    const deadlineMs =
      Math.max(5000, Number(this.config.launchDeadlineMs) || 55000)
    const deadline = Date.now() + deadlineMs
    const perAttempt = Math.max(5000, Number(this.config.launchTimeoutMs) || 30000)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const remaining = deadline - Date.now()
      if (attempt > 1 && remaining < 5000) break
      try {
        const timeout = Math.max(5000, Math.min(perAttempt, remaining))
        const context = await this.#launch({ timeout })
        if (recovering || attempt > 1) this.emit('recovered', { attempt })
        return context
      } catch (error) {
        lastError = error
        this.lastError = { message: errorMessage(error), at: Date.now(), kind: 'launch' }
        const canRetry =
          attempt < 3 &&
          this.config.autoRelaunch !== false &&
          Date.now() + 5000 < deadline &&
          (recovering || isRecoverableError(error))
        if (!canRetry) break
        // Windows 上「浏览器已关闭 / exitCode=21 / 启动超时」几乎都是 profile 被残留进程占用：
        // 先清残留，再清上下文，再重试。
        if (process.platform === 'win32') {
          await this.#cleanupStaleProfile().catch(() => {})
        } else {
          const message = errorMessage(error)
          if (/profile|locked|正在使用|exitCode=21|user data directory|Timeout \d+ms exceeded/i.test(message)) {
            await this.#cleanupStaleProfile().catch(() => {})
          }
        }
        await this.#cleanupTransient()
        await new Promise(resolve => setTimeout(resolve, 400 * attempt))
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

  async #launch({ timeout } = {}) {
    await ensureDir(this.config.userDataDir)
    await ensureDir(this.config.artifactDir)
    await ensureDir(this.config.downloadsDir)
    // 启动前清掉上次崩溃/强杀留下的 profile 占用（lockfile 或残留 msedge）。
    await this.#prepareProfile().catch(() => {})

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
          // 显式收紧启动超时：Playwright 默认 180s，会拖过工具层的 90s 上限。
          timeout: Math.max(5000, Number(timeout) || this.config.launchTimeoutMs || 30000),
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
      // Playwright 的 browser.version() 是同步方法，返回 string，不能调用 .catch()。
      try {
        this.browserVersion = browser ? browser.version() ?? null : null
      } catch {
        this.browserVersion = null
      }
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
