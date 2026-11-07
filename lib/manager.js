import fs from 'node:fs/promises'
import path from 'node:path'
import {
  clamp,
  ensureDir,
  firstLine,
  normalizeUrl,
  safeName,
  sleep,
  timestampName,
} from './util.js'

const PAGE_TITLE_TIMEOUT_MS = 1200

export class BrowserManager {
  constructor(config) {
    this.config = config
    this.context = null
    this.browser = null
    this.launching = null
    this.closing = false
    this.closedReason = ''
    this.pageByTab = new Map()
    this.tabByPage = new Map()
    this.activeByAgent = new Map()
    this.activeTabId = null
    this.tabSeq = 0
    this.pending = 0
    this.idleTimer = null
    this.refsByPage = new WeakMap()
    this.dialogsByPage = new WeakMap()
    this.recordersByPage = new WeakMap()
    this.lastErrorByPage = new WeakMap()
  }

  async run(operation) {
    this.begin()
    try {
      return await operation()
    } finally {
      this.end()
    }
  }

  begin() {
    this.pending += 1
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  end() {
    this.pending = Math.max(0, this.pending - 1)
    this.scheduleIdleClose()
  }

  scheduleIdleClose() {
    const idleMs = Number(this.config.idleCloseMs) || 0
    if (idleMs <= 0 || this.pending > 0 || !this.context) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending === 0) void this.close('idle')
    }, idleMs)
    this.idleTimer.unref?.()
  }

  async ensure() {
    if (this.context) return this.context
    if (this.launching) return this.launching
    this.launching = this.#launch().finally(() => {
      this.launching = null
    })
    return this.launching
  }

  async #launch() {
    if (this.closing) throw new Error('浏览器正在关闭，请稍后重试。')
    await ensureDir(this.config.userDataDir)
    await ensureDir(this.config.artifactDir)
    await ensureDir(this.config.downloadsDir)

    let chromium
    try {
      ;({ chromium } = await import('playwright-core'))
    } catch (error) {
      throw new Error(
        `无法加载 playwright-core：${error instanceof Error ? error.message : String(error)}。` +
          '请在插件目录执行 pnpm install --prod 后重试。',
      )
    }

    try {
      if (this.config.mode === 'cdp') {
        if (!this.config.cdpUrl) {
          throw new Error('mode=cdp 时必须配置 cdpUrl，例如 http://127.0.0.1:9222。')
        }
        this.browser = await chromium.connectOverCDP(this.config.cdpUrl, { timeout: 20000 })
        this.context = this.browser.contexts()[0]
        if (!this.context) {
          throw new Error('已连接 CDP，但没有可用的浏览器上下文。请确认浏览器已打开至少一个窗口。')
        }
      } else {
        const launchOptions = {
          headless: Boolean(this.config.headless),
          viewport: this.config.headless ? { width: 1440, height: 900 } : null,
          locale: this.config.locale || 'zh-CN',
          timezoneId: this.config.timezoneId || 'Asia/Shanghai',
          colorScheme: 'light',
          acceptDownloads: true,
          downloadsPath: this.config.downloadsDir,
          slowMo: 0,
          args: [
            '--no-first-run',
            '--no-default-browser-check',
            ...(this.config.headless ? [] : ['--start-maximized']),
          ],
        }
        if (this.config.executablePath) {
          launchOptions.executablePath = this.config.executablePath
        } else {
          launchOptions.channel = this.config.channel || 'msedge'
        }
        this.context = await chromium.launchPersistentContext(this.config.userDataDir, launchOptions)
        this.browser = this.context.browser()
      }

      this.context.on('page', page => this.#onNewPage(page))
      this.context.on('close', () => {
        if (!this.closing) this.#markDisconnected('浏览器窗口已关闭')
      })
      this.browser?.on('disconnected', () => {
        if (!this.closing) this.#markDisconnected('浏览器连接已断开')
      })

      for (const page of this.context.pages()) {
        this.#registerPage(page, { activate: false })
      }
      if (!this.#activeState()) {
        await this.createPage({ activate: true })
      } else {
        this.activeTabId = this.#activeState()?.tabId ?? this.activeTabId
      }
      this.closedReason = ''
      return this.context
    } catch (error) {
      try {
        await this.context?.close()
      } catch {
        /* ignore */
      }
      try {
        await this.browser?.close()
      } catch {
        /* ignore */
      }
      this.context = null
      this.browser = null
      this.pageByTab.clear()
      this.tabByPage.clear()
      this.activeTabId = null

      const message = error instanceof Error ? error.message : String(error)
      let hint = ''
      if (/msedge|Chromium distribution|executable doesn't exist|ENOENT/i.test(message)) {
        hint =
          ' 未找到可用的 Edge/Chromium。可安装 Microsoft Edge，或在插件配置里把 channel 改为 chrome，' +
          '也可以设置 executablePath 指向浏览器可执行文件。'
      } else if (/ProcessSingleton|SingletonLock|profile|user data directory|正在使用/i.test(message)) {
        hint =
          ' 浏览器配置目录可能被另一个 Edge 进程占用。请关闭由本工具打开的浏览器窗口后重试；' +
          '也可以换一个 userDataDir，或使用 mode=cdp 连接已启动的浏览器。'
      } else if (/ECONNREFUSED|connectOverCDP|websocket/i.test(message)) {
        hint =
          ' 无法连接 CDP。请先用 --remote-debugging-port=9222 启动 Edge/Chrome，' +
          '并在配置里填写对应的 cdpUrl。'
      }
      throw new Error(`浏览器启动失败：${message}.${hint}`)
    }
  }

  #markDisconnected(reason) {
    this.closedReason = reason
    this.context = null
    this.browser = null
    this.pageByTab.clear()
    this.tabByPage.clear()
    this.activeByAgent.clear()
    this.activeTabId = null
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  #onNewPage(page) {
    const opener = page.opener()
    const openerState = opener ? this.tabByPage.get(opener) : null
    const owner = openerState?.owner ?? null
    const state = this.#registerPage(page, { owner, activate: false })
    if (owner) {
      this.activeByAgent.set(owner, state.tabId)
      this.activeTabId = state.tabId
    }
  }

  #registerPage(page, { activate = false, owner = null } = {}) {
    const existing = this.tabByPage.get(page)
    if (existing) {
      if (owner && !existing.owner) existing.owner = owner
      if (activate) this.#activate(existing)
      return existing
    }
    const tabId = `t${++this.tabSeq}`
    const state = { tabId, page, owner: owner ?? null, createdAt: Date.now(), lastWarning: '' }
    this.pageByTab.set(tabId, page)
    this.tabByPage.set(page, state)

    page.on('close', () => {
      this.pageByTab.delete(tabId)
      this.tabByPage.delete(page)
      for (const [agentId, activeTab] of this.activeByAgent) {
        if (activeTab === tabId) this.activeByAgent.delete(agentId)
      }
      if (this.activeTabId === tabId) {
        const next = this.pageByTab.keys().next().value ?? null
        this.activeTabId = next
      }
    })
    page.on('dialog', dialog => {
      this.dialogsByPage.set(page, {
        type: dialog.type(),
        message: dialog.message(),
        at: Date.now(),
      })
      const action = dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()
      action.catch(() => {})
    })
    page.on('pageerror', error => {
      this.lastErrorByPage.set(page, {
        message: String(error?.message ?? error),
        at: Date.now(),
      })
    })
    page.on('console', message => {
      if (message.type() !== 'error') return
      this.lastErrorByPage.set(page, { message: message.text(), at: Date.now() })
    })

    if (activate) this.#activate(state)
    return state
  }

  #activate(state) {
    this.activeTabId = state.tabId
    if (state.owner) this.activeByAgent.set(state.owner, state.tabId)
  }

  #activeState(agentId) {
    const agentTab = agentId ? this.activeByAgent.get(agentId) : null
    if (agentTab && this.pageByTab.has(agentTab)) {
      const page = this.pageByTab.get(agentTab)
      if (!page.isClosed()) return this.tabByPage.get(page)
    }
    if (this.activeTabId && this.pageByTab.has(this.activeTabId)) {
      const page = this.pageByTab.get(this.activeTabId)
      if (!page.isClosed()) return this.tabByPage.get(page)
    }
    for (const page of this.pageByTab.values()) {
      if (!page.isClosed()) return this.tabByPage.get(page)
    }
    return null
  }

  async resolvePage(tab, agentId) {
    await this.ensure()
    let page = null
    if (tab && tab !== 'active') {
      const wanted = String(tab).replace(/^#/, '')
      page = this.pageByTab.get(wanted) ?? null
      if (!page) {
        for (const candidate of this.pageByTab.values()) {
          if (candidate.isClosed()) continue
          if (candidate.url().includes(wanted)) {
            page = candidate
            break
          }
        }
      }
      if (!page || page.isClosed()) {
        const available = [...this.pageByTab.keys()].join(', ') || '(无)'
        throw new Error(`未找到标签页 ${tab}。当前标签页：${available}。可先调用 browser_tabs 查看。`)
      }
    } else {
      const state = this.#activeState(agentId)
      page = state?.page ?? (await this.createPage({ activate: true, owner: agentId })).page
    }
    if (!page || page.isClosed()) {
      page = (await this.createPage({ activate: true, owner: agentId })).page
    }
    const state = this.tabByPage.get(page)
    if (agentId) {
      if (!state.owner) state.owner = agentId
      this.activeByAgent.set(agentId, state.tabId)
      if (!this.activeTabId) this.activeTabId = state.tabId
    }
    return state
  }

  async createPage({ activate = false, owner = null } = {}) {
    const context = await this.ensure()
    let page
    try {
      page = await context.newPage()
    } catch (error) {
      throw new Error(`新建标签页失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const state = this.#registerPage(page, { activate, owner })
    if (activate) {
      this.#activate(state)
      await page.bringToFront().catch(() => {})
    }
    return state
  }

  async open({ url, tab, newTab = false, focus = true, agentId } = {}) {
    const context = await this.ensure()
    if (!context) throw new Error('浏览器上下文不可用。')
    let state
    if (tab && tab !== 'active') {
      state = await this.resolvePage(tab, agentId)
    } else {
      const active = this.#activeState(agentId)
      if (newTab || !active) {
        state = await this.createPage({ activate: true, owner: agentId })
      } else {
        state = await this.resolvePage(undefined, agentId)
      }
    }
    if (agentId) {
      if (!state.owner) state.owner = agentId
      this.activeByAgent.set(agentId, state.tabId)
    }
    this.activeTabId = state.tabId

    let warning = ''
    if (url) {
      warning = await this.navigate(state.page, url)
      state.lastWarning = warning
    }
    if (focus && !this.config.headless) {
      await state.page.bringToFront().catch(() => {})
    }
    return state
  }

  async navigate(page, url) {
    const target = normalizeUrl(url)
    if (!target) return ''
    const timeout = Number(this.config.navigationTimeoutMs) || 45000
    let warning = ''
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const current = page.url()
      if (/Timeout/i.test(message) && current && current !== 'about:blank') {
        warning = `页面在 ${timeout}ms 内未触发 DOMContentLoaded，已继续读取当前页面。`
      } else if (/ERR_ABORTED/i.test(message) && current && current !== 'about:blank') {
        warning = '页面导航被中断，但当前页面已有内容。'
      } else {
        throw new Error(`打开页面失败：${target}。${message}`)
      }
    }
    await sleep(450)
    await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {})
    return warning
  }

  async pageInfo(state) {
    const page = state.page
    let title = ''
    try {
      title = await Promise.race([page.title(), sleep(PAGE_TITLE_TIMEOUT_MS).then(() => '')])
    } catch {
      title = ''
    }
    return {
      tab: state.tabId,
      url: page.url(),
      title: firstLine(title, 200),
      active: this.activeTabId === state.tabId,
    }
  }

  listPages() {
    return [...this.pageByTab.entries()]
      .filter(([, page]) => !page.isClosed())
      .map(([tabId, page]) => ({ tabId, page }))
  }

  async listTabs(agentId) {
    const active = this.#activeState(agentId)
    const tabs = []
    for (const { tabId, page } of this.listPages()) {
      const state = this.tabByPage.get(page)
      let title = ''
      try {
        title = await Promise.race([page.title(), sleep(PAGE_TITLE_TIMEOUT_MS).then(() => '')])
      } catch {
        title = ''
      }
      tabs.push({
        tab: tabId,
        url: page.url(),
        title: firstLine(title, 160),
        active: tabId === active?.tabId,
        owner: state?.owner ?? null,
      })
    }
    return tabs
  }

  adoptPage(tabId, agentId) {
    const page = this.pageByTab.get(tabId)
    if (!page || page.isClosed()) return null
    const state = this.tabByPage.get(page)
    if (!state) return null
    if (agentId && !state.owner) state.owner = agentId
    if (agentId) this.activeByAgent.set(agentId, tabId)
    this.activeTabId = tabId
    return state
  }

  async switchTab(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    if (agentId) this.activeByAgent.set(agentId, state.tabId)
    this.activeTabId = state.tabId
    if (!this.config.headless) await state.page.bringToFront().catch(() => {})
    return state
  }

  async closeTab(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    const tabId = state.tabId
    await state.page.close().catch(() => {})
    this.pageByTab.delete(tabId)
    this.tabByPage.delete(state.page)
    if (this.activeTabId === tabId) {
      this.activeTabId = this.pageByTab.keys().next().value ?? null
    }
    for (const [agent, activeTab] of this.activeByAgent) {
      if (activeTab === tabId) this.activeByAgent.delete(agent)
    }
    return tabId
  }

  setRefs(page, refs) {
    this.refsByPage.set(page, refs)
  }

  getRefs(page) {
    return this.refsByPage.get(page) ?? new Map()
  }

  takeDialog(page) {
    const dialog = this.dialogsByPage.get(page)
    if (!dialog) return null
    if (Date.now() - dialog.at > 15000) {
      this.dialogsByPage.delete(page)
      return null
    }
    this.dialogsByPage.delete(page)
    return dialog
  }

  lastError(page) {
    const error = this.lastErrorByPage.get(page)
    if (!error) return null
    if (Date.now() - error.at > 30000) return null
    return error
  }

  getRecorder(page) {
    return this.recordersByPage.get(page) ?? null
  }

  setRecorder(page, recorder) {
    this.recordersByPage.set(page, recorder)
  }

  async artifactPath(requested, { ext = '.png', prefix = 'shot' } = {}) {
    await ensureDir(this.config.artifactDir)
    if (requested) {
      const resolved = path.isAbsolute(requested)
        ? requested
        : path.resolve(this.config.artifactDir, requested)
      const withExt = path.extname(resolved) ? resolved : `${resolved}${ext}`
      await ensureDir(path.dirname(withExt))
      return withExt
    }
    const safePrefix = safeName(prefix, 'artifact')
    return path.join(this.config.artifactDir, timestampName(safePrefix, ext))
  }

  async downloadPath(requested, suggestedName) {
    await ensureDir(this.config.downloadsDir)
    if (requested) {
      const resolved = path.isAbsolute(requested)
        ? requested
        : path.resolve(this.config.downloadsDir, requested)
      await ensureDir(path.dirname(resolved))
      return resolved
    }
    const ext = path.extname(suggestedName || '') || ''
    const base = path.basename(suggestedName || timestampName('download', ext), ext)
    return path.join(this.config.downloadsDir, `${safeName(base, 'download')}${ext}`)
  }

  async saveText(text, { requested, prefix = 'extract', ext = '.txt' } = {}) {
    const filePath = await this.artifactPath(requested, { ext, prefix })
    await fs.writeFile(filePath, text, 'utf8')
    return filePath
  }

  async saveJson(value, { requested, prefix = 'collect' } = {}) {
    const filePath = await this.artifactPath(requested, { ext: '.json', prefix })
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
    return filePath
  }

  async close(reason = 'manual') {
    if (this.closing) return
    this.closing = true
    this.closedReason = reason
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const context = this.context
    const browser = this.browser
    this.context = null
    this.browser = null
    try {
      if (this.config.mode === 'cdp') {
        // Never close the user's existing tabs when attached over CDP.
        if (browser) await browser.close()
      } else if (context) {
        await context.close()
      }
    } catch {
      /* ignore */
    }
    this.pageByTab.clear()
    this.tabByPage.clear()
    this.activeByAgent.clear()
    this.activeTabId = null
    this.closing = false
  }

  async dispose() {
    await this.close('plugin dispose')
  }
}
