import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { BrowserHost } from './host.js'
import { TabRegistry } from './pages.js'
import { WorkspaceStore, normalizeTabKey } from './workspace.js'
import { TabLockManager } from './locks.js'
import { ScratchStore } from './scratch.js'
import { ensureDir, firstLine, normalizeUrl, settlePage, sleep } from './util.js'

const CONSOLE_RING_SIZE = 100
const AUDIT_LOG_SIZE = 200
const PERSIST_DEBOUNCE_MS = 300

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 浏览器门面（v0.2）。
 *
 * 生命周期委托给 BrowserHost；标签页注册、工作区、ACL、读写锁和状态持久化
 * 分别由 pages.js / workspace.js / locks.js 承担。本文件保留旧 API 签名，
 * 并新增多代理协作 API，供 tools-surface 接入。
 *
 * 默认静默：除配置 visibility=window 且调用方显式要求 focus 外，
 * 不会调用 page.bringToFront()。
 */
export class BrowserManager extends EventEmitter {
  constructor(config) {
    super()
    this.config = config || {}
    this.host = new BrowserHost(this.config)
    this.closing = false
    this.disposed = false
    this.closedReason = ''

    this.pending = 0
    this.idleTimer = null
    this.tabSweepTimer = null
    this.persistTimer = null

    this.refsByPage = new WeakMap()
    this.dialogsByPage = new WeakMap()
    this.recordersByPage = new WeakMap()
    this.lastErrorByPage = new WeakMap()
    this.consoleByPage = new WeakMap()
    this.pageHooks = new WeakSet()

    this.auditLog = []
    this.lastEviction = null
    this.lastPersistError = null

    this.scratch = new ScratchStore({
      dir: this.config.scratchDir,
      ttlMs: this.config.scratchTtlMs,
      maxBytes: this.config.scratchMaxBytes,
    })
    this.store = new WorkspaceStore(this.config)
    this.restored = this.store.restored
    this.restoredAt = this.store.restoredAt
    this.restoreWarning = this.store.loadWarning

    this.locks = new TabLockManager({
      timeoutMs: Math.max((Number(this.config.actionTimeoutMs) || 15000) * 2, 30000),
    })
    this.pages = new TabRegistry({
      config: this.config,
      host: this.host,
      store: this.store,
      canEvict: state => this.#canEvict(state),
      onEvict: event => this.#onEvict(event),
      onChanged: () => this.#schedulePersist(),
      onPageRegistered: page => this.#attachPageHooks(page),
    })

    this.host.on('launched', () => {
      this.closedReason = ''
      this.#startTabSweep()
    })
    this.host.on('disconnected', reason => {
      this.closedReason = reason
      this.#stopTabSweep()
    })
  }

  get context() {
    return this.host.context
  }

  get browser() {
    return this.host.browser
  }

  get statePath() {
    return this.store.statePath
  }

  /** 同步初始化已经完成，保留该方法是给需要显式等待的调用方使用。 */
  async ready() {
    return this
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
    // idleCloseMs=0 是 v0.2 的长时运行默认值：永不因空闲自动关闭。
    if (idleMs <= 0 || this.pending > 0 || !this.context) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.pending === 0) void this.close('idle')
    }, idleMs)
    this.idleTimer.unref?.()
  }

  async ensure() {
    const context = await this.host.ensure()
    this.pages.registerExistingPages()
    if (!this.scratchPrunedAt || Date.now() - this.scratchPrunedAt > 600000) {
      this.scratchPrunedAt = Date.now()
      void this.scratch.prune().catch(() => {})
    }
    return context
  }

  // ---------------------------------------------------------------------------
  // 页面与标签页（保留旧 API）
  // ---------------------------------------------------------------------------

  async resolvePage(tab, agentId) {
    await this.ensure()
    const agent = agentId ? String(agentId) : ''
    const workspace = agent ? this.store.workspaceForAgent(agent) : null
    const workspaceId = workspace?.id ?? null

    let state = null
    if (tab && tab !== 'active') {
      state = this.pages.findByParam(tab, agent, workspaceId)
      if (!state) {
        const available = this.pages
          .visibleStates(agent, workspaceId)
          .map(candidate => candidate.tabId)
          .join(', ')
        throw new Error(
          `未找到标签页 ${tab}。当前可访问标签页：${available || '(无)'}。可先调用 browser_tabs 查看。`,
        )
      }
    } else {
      state = this.pages.activeState(agent, workspaceId)
      if (!state) {
        state = await this.createPage({ activate: true, owner: agent || null, workspaceId })
      }
    }

    if (agent && !state.owner) state.owner = agent
    this.#markActive(state, agent || null)
    return state
  }

  async createPage({ activate = false, owner = null, workspaceId = null } = {}) {
    await this.ensure()
    const agent = owner ? String(owner) : null
    let targetWorkspaceId = null
    if (workspaceId) {
      const workspace = this.store.requireWorkspace(workspaceId)
      if (agent) {
        this.store.assertMember(workspace, agent)
        this.store.setActiveWorkspace(agent, workspace.id)
      }
      targetWorkspaceId = workspace.id
    } else if (agent) {
      targetWorkspaceId = this.store.workspaceForAgent(agent)?.id ?? null
    }

    const state = await this.pages.createPage({
      activate,
      owner: agent,
      workspaceId: targetWorkspaceId,
    })
    if (agent && !state.owner) state.owner = agent
    // activate=false（如批量采集）只登记元数据，不改变当前 active 标签页。
    this.pages.touch(state, agent, { activate: Boolean(activate) })
    await this.#persist()
    return state
  }

  async open({ url, tab, newTab = false, focus = true, agentId, workspaceId } = {}) {
    await this.ensure()
    const agent = agentId ? String(agentId) : null
    let workspaceIdForAgent = null
    if (workspaceId) {
      const workspace = this.store.requireWorkspace(workspaceId)
      if (agent) {
        this.store.assertMember(workspace, agent)
        this.store.setActiveWorkspace(agent, workspace.id)
      }
      workspaceIdForAgent = workspace.id
    } else if (agent) {
      workspaceIdForAgent = this.store.workspaceForAgent(agent)?.id ?? null
    }

    let state
    if (tab && tab !== 'active') {
      state = await this.resolvePage(tab, agent)
    } else {
      const active = this.pages.activeState(agent, workspaceIdForAgent)
      if (newTab || !active) {
        state = await this.createPage({
          activate: true,
          owner: agent,
          workspaceId: workspaceIdForAgent,
        })
      } else {
        state = await this.resolvePage(undefined, agent)
      }
    }

    if (agent) {
      if (!state.owner) state.owner = agent
      this.pages.setActiveFor(agent, state.tabId)
    }
    this.pages.activate(state, agent)

    let warning = ''
    if (url) {
      // 导航属于写操作：reader 必须在真正跳转前被拦住。
      this.assertAccess(agent, state, 'write')
      warning = await this.navigate(state.page, url)
      state.lastWarning = warning
    }
    // 静默默认：headless/offscreen 永不抢焦点；只有 window + 显式 focus 才置前。
    if (focus && this.#canFocus()) {
      await state.page.bringToFront().catch(() => {})
    }
    this.#markActive(state, agent)
    this.#schedulePersist()
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
      const message = errorMessage(error)
      const current = page.url()
      if (/Timeout/i.test(message) && current && current !== 'about:blank') {
        warning = `页面在 ${timeout}ms 内未触发 DOMContentLoaded，已继续读取当前页面。`
      } else if (/ERR_ABORTED/i.test(message) && current && current !== 'about:blank') {
        warning = '页面导航被中断，但当前页面已有内容。'
      } else {
        throw new Error(`打开页面失败：${target}。${message}`)
      }
    }
    // 不再固定长睡：按配置做短沉降，若配置了选择器则等它就绪。
    await settlePage(page, {
      selector: this.config.navigateWaitSelector || '',
      settleMs: this.config.navigateSettleMs ?? 120,
      timeoutMs: Math.min(Number(this.config.navigationTimeoutMs) || 10000, 10000),
    })
    return warning
  }

  async pageInfo(state) {
    return this.pages.pageInfo(state)
  }

  listPages() {
    return this.pages.listPages()
  }

  async listTabs(agentId) {
    const agent = agentId ? String(agentId) : ''
    const workspaceId = agent ? this.store.workspaceForAgent(agent)?.id ?? null : null
    return this.pages.listTabs(agent, workspaceId)
  }

  adoptPage(tabId, agentId) {
    const agent = agentId ? String(agentId) : ''
    const workspaceId = agent ? this.store.workspaceForAgent(agent)?.id ?? null : null
    const state = this.pages.adoptPage(tabId, agent, workspaceId)
    if (state) this.#schedulePersist()
    return state
  }

  async switchTab(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    this.pages.activate(state, agentId ? String(agentId) : null)
    if (this.#canFocus()) await state.page.bringToFront().catch(() => {})
    this.#schedulePersist()
    return state
  }

  async closeTab(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    // 关闭标签页属于写操作；旧的无工作区标签页不受影响。
    this.assertAccess(agentId, state, 'write')
    const tabId = state.tabId
    this.locks.releaseTab(tabId)
    await this.pages.closeById(tabId, 'tab')
    await this.#persist()
    return tabId
  }

  // ---------------------------------------------------------------------------
  // 引用、对话框、记录器与错误
  // ---------------------------------------------------------------------------

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

  getConsole(page) {
    const entries = this.consoleByPage.get(page)
    return entries ? entries.map(entry => ({ ...entry })) : []
  }

  getRecorder(page) {
    return this.recordersByPage.get(page) ?? null
  }

  setRecorder(page, recorder) {
    this.recordersByPage.set(page, recorder)
  }

  // ---------------------------------------------------------------------------
  // 工作区（新增 API）
  // ---------------------------------------------------------------------------

  /** 返回该代理当前活动工作区；没有则返回 null，不自动创建工作区。 */
  workspace(agentId) {
    const workspace = this.store.workspaceForAgent(agentId)
    if (!workspace) return null
    return this.#publicWorkspace(workspace, agentId)
  }

  async createWorkspace(agentId, { label } = {}) {
    const created = this.store.createWorkspace(agentId, { label })
    const workspace = this.store.requireWorkspace(created.id)
    await this.#persist()
    return this.#publicWorkspace(workspace, agentId)
  }

  async joinWorkspace(agentId, workspaceId, { role = 'reader' } = {}) {
    this.store.joinWorkspace(agentId, workspaceId, { role })
    const workspace = this.store.requireWorkspace(workspaceId)
    await this.#persist()
    return this.#publicWorkspace(workspace, agentId)
  }

  async grantWorkspace(agentId, workspaceId, { agentId: targetAgent, role } = {}) {
    this.store.grantWorkspace(agentId, workspaceId, { agentId: targetAgent, role })
    const workspace = this.store.requireWorkspace(workspaceId)
    await this.#persist()
    return this.#publicWorkspace(workspace, agentId)
  }

  async handoff(agentId, { workspaceId, tab, toAgent, note } = {}) {
    const caller = String(agentId ?? '').trim()
    if (!caller) throw new Error('移交标签页需要 agentId（调用方代理标识）。')
    const workspace = workspaceId
      ? this.store.requireWorkspace(workspaceId)
      : this.store.workspaceForAgent(caller)
    if (!workspace) {
      throw new Error(`代理 ${caller} 当前没有工作区，无法移交标签页。请先创建工作区或指定 workspaceId。`)
    }
    const state = this.pages.findInWorkspace(workspace.id, tab)
    const tabId = state?.tabId ?? normalizeTabKey(tab)
    if (!state && !workspace.tabs.has(tabId)) {
      throw new Error(
        `未在工作区 ${workspace.id}（${workspace.label}）中找到标签页 ${tab ?? '(空)'}。` +
          `可用标签页：${[...workspace.tabs].join(', ') || '(无)'}。`,
      )
    }
    const result = this.store.handoff(caller, {
      workspaceId: workspace.id,
      tab: tabId,
      toAgent,
      note,
    })
    if (state) {
      state.owner = result.to
      state.workspaceId = workspace.id
      this.store.addTab(workspace.id, state.tabId)
      this.store.touchLease(workspace.id, state.tabId, result.to, 'writer')
      this.store.setActiveWorkspace(result.to, workspace.id)
      this.pages.setActiveFor(result.to, state.tabId)
      this.pages.touch(state, result.to)
    } else {
      // 恢复后尚未打开的 stale 标签页也只更新元数据，不自动打开页面。
      const stale = this.store.restoredTabs.get(tabId)
      if (stale) {
        stale.owner = result.to
        stale.workspaceId = workspace.id
        stale.role = 'writer'
      }
      this.store.setActiveWorkspace(result.to, workspace.id)
    }
    await this.#persist()
    this.emit('handoff', result)
    return result
  }

  /**
   * 关闭工作区（仅 owner）。closeTabs 可为 true、单个 tab、tab 数组或 {tabs:[]}。
   */
  async closeWorkspace(agentId, workspaceId, { closeTabs = false } = {}) {
    const workspace = this.store.requireWorkspace(workspaceId)
    const ids = [...workspace.tabs]
    const requested = this.#normalizeCloseTabs(closeTabs)
    const targets = closeTabs === true ? ids : requested.filter(tabId => ids.includes(tabId))
    const result = this.store.closeWorkspace(agentId, workspaceId)

    for (const tabId of ids) {
      const state = this.pages.getState(tabId)
      if (!state) continue
      // 先解除工作区归属，未显式关闭的标签页降级为旧式独立标签页。
      state.workspaceId = null
      if (targets.includes(tabId)) {
        this.locks.releaseTab(tabId)
        await this.pages.closeById(tabId, 'workspace')
      }
    }
    await this.#persist()
    this.emit('workspaceClosed', { ...result, closedTabs: [...targets] })
    return {
      ok: true,
      workspaceId: result.id,
      label: result.label,
      closedTabs: [...targets],
      tabs: result.tabs,
    }
  }

  /** 返回成员、租约到期时间、标签页与锁摘要。 */
  workspaceStatus(agentId) {
    const agent = agentId ? String(agentId) : ''
    const workspace = agent ? this.store.workspaceForAgent(agent) : null
    if (!workspace) {
      return {
        agentId: agent || null,
        workspace: null,
        role: null,
        members: [],
        tabs: [],
        leases: [],
        locks: [],
        leaseExpiresAt: null,
        audit: [],
      }
    }
    const tabSet = new Set(workspace.tabs)
    const tabs = [...workspace.tabs].map(tabId => this.#tabView(tabId, workspace)).filter(Boolean)
    const now = Date.now()
    const leases = [...workspace.leases.values()].map(lease => ({
      ...lease,
      expired: lease.expiresAt <= now,
    }))
    const leaseExpiresAt = leases.reduce((latest, lease) => Math.max(latest, lease.expiresAt), 0) || null
    return {
      agentId: agent,
      workspace: this.#publicWorkspace(workspace, agent),
      role: workspace.members.get(agent)?.role ?? null,
      members: [...workspace.members.values()].map(member => ({ ...member })),
      tabs,
      locks: this.locks.status().filter(lock => tabSet.has(lock.tabId)),
      leases,
      leaseExpiresAt,
      audit: this.store.auditOf(workspace.id).slice(-20),
    }
  }

  // ---------------------------------------------------------------------------
  // ACL 与锁（新增 API）
  // ---------------------------------------------------------------------------

  /**
   * 校验代理对标签页的访问权限；失败抛中文错误。
   * 无 workspace 的旧式标签页兼容旧行为：请求代理视为 owner。
   * @returns {object} 标签页状态对象
   */
  assertAccess(agentId, tab, mode = 'read') {
    const accessMode = String(mode ?? 'read').trim().toLowerCase()
    if (accessMode !== 'read' && accessMode !== 'write') {
      throw new Error(`访问模式无效：${mode ?? '(空)'}。只允许 read 或 write。`)
    }
    const agent = agentId ? String(agentId).trim() : ''
    let state = this.pages.resolveStateArg(tab)
    if (!state && typeof tab === 'string' && tab !== 'active') {
      // 兼容 tab 参数传 URL 片段的情况；只在该代理可见的标签页中查找。
      const workspace = agent ? this.store.workspaceForAgent(agent) : null
      state = this.pages.findByParam(tab, agent, workspace?.id ?? null)
    }
    if (!state) {
      const key = tab && typeof tab === 'object' ? tab.tabId ?? tab.tab : tab
      throw new Error(`未找到标签页 ${key ?? '(空)'}。可先调用 browser_tabs 查看。`)
    }
    if (!agent) return state
    const workspaceId = state.workspaceId
    if (!workspaceId) return state
    const workspace = this.store.workspaces.get(workspaceId)
    // 工作区已经被删除：遗留标签页按旧式独立标签页处理，避免永久锁死。
    if (!workspace) return state
    const member = workspace.members.get(agent)
    if (!member) {
      throw new Error(
        `代理 ${agent} 不是工作区 ${workspace.id}（${workspace.label}）的成员，` +
          `不能访问标签页 ${state.tabId}。请先加入工作区。`,
      )
    }
    if (accessMode === 'write' && member.role !== 'writer') {
      throw new Error(
        `代理 ${agent} 在工作区 ${workspace.id}（${workspace.label}）中是只读成员（reader），` +
          `不能对标签页 ${state.tabId} 执行写操作。请让 owner 授予 writer 角色。`,
      )
    }
    return state
  }

  /**
   * 在标签页上持锁执行函数。同 tab 写互斥、读写互斥，不同 tab 并行。
   */
  withTabLock(tabId, mode, fn, { timeoutMs } = {}) {
    return this.locks.withTabLock(tabId, mode, fn, { timeoutMs })
  }

  // ---------------------------------------------------------------------------
  // 静默 / 非静默切换
  // ---------------------------------------------------------------------------

  /**
   * 切换可见性：
   * - headless：完全静默（无窗口，最省资源）；
   * - offscreen：有窗口但放在屏幕外，可随时 browser_show 拉到前台；
   * - window：有窗口且正常位置。
   *
   * 切换会重启浏览器上下文（Cookie/登录态保留），并按需恢复原标签页 URL。
   */
  async setVisibility(visibility, { restoreTabs = true } = {}) {
    const next = String(visibility ?? '').trim().toLowerCase()
    if (!['headless', 'offscreen', 'window'].includes(next)) {
      throw new Error(`visibility 只能是 headless / offscreen / window，收到：${visibility ?? '(空)'}`)
    }
    const current = this.config.visibility
    if (next === current && this.context) {
      return { changed: false, visibility: current, relaunched: false, restored: 0 }
    }

    const saved = []
    for (const state of this.pages.pageByTab.values()) {
      try {
        const url = state.page.url()
        if (url && url !== 'about:blank') saved.push(url)
      } catch {
        /* 页面已关闭 */
      }
    }

    this.config.visibility = next
    await this.host.relaunch({ visibility: next })
    this.pages.registerExistingPages()

    let restored = 0
    if (restoreTabs) {
      for (const url of saved.slice(0, 10)) {
        try {
          const state = await this.createPage({ activate: false })
          await this.navigate(state.page, url)
          restored += 1
        } catch {
          /* 单页恢复失败不影响整体 */
        }
      }
    }
    await this.#persist({ silent: true })
    return { changed: true, visibility: next, relaunched: true, restored, previous: current }
  }

  async #windowSession(page) {
    const session = await this.context.newCDPSession(page)
    const { windowId } = await session.send('Browser.getWindowForTarget')
    return { session, windowId }
  }

  /** 把浏览器窗口拉到屏幕前台（非静默）。headless 下需要先切换可见性。 */
  async showWindow(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    if (this.config.visibility === 'headless') {
      throw new Error(
        '当前是 headless（静默）模式，没有可显示的窗口。请先执行 browser_show {"action":"set","visibility":"offscreen"} 切换（会重启浏览器，登录态保留）。',
      )
    }
    const { session, windowId } = await this.#windowSession(state.page)
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: 120, top: 80, width: 1440, height: 900, windowState: 'normal' },
    })
    await state.page.bringToFront().catch(() => {})
    try {
      await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    } catch {
      /* 部分平台不支持二次设置 */
    }
    return { shown: true, tab: state.tabId, windowId, visibility: this.config.visibility }
  }

  /** 把窗口挪回屏幕外，恢复“非静默但不可见”。 */
  async hideWindow(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    if (this.config.visibility === 'headless') {
      return { shown: false, visibility: 'headless', message: 'headless 模式本来就没有窗口。' }
    }
    const { session, windowId } = await this.#windowSession(state.page)
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { left: -32000, top: -32000, windowState: 'normal' },
    })
    return { shown: false, tab: state.tabId, windowId, visibility: this.config.visibility }
  }

  /** 当前窗口位置/状态（用于判断是否已在屏幕上）。 */
  async windowBounds(tab, agentId) {
    const state = await this.resolvePage(tab, agentId)
    if (this.config.visibility === 'headless') {
      return { visibility: 'headless', shown: false, bounds: null }
    }
    const { session, windowId } = await this.#windowSession(state.page)
    const { bounds } = await session.send('Browser.getWindowBounds', { windowId })
    const onScreen = Number(bounds.left) > -1000
    return { visibility: this.config.visibility, shown: onScreen, windowId, bounds }
  }

  // ---------------------------------------------------------------------------
  // 工作页池（避免批量采集反复建页/关页，减少 about:blank）
  // ---------------------------------------------------------------------------

  /**
   * 取一个工作页：优先复用池里的页面，池空才新建。
   * 页面仍然注册为普通标签页，交给 maxTabs/空闲回收管理。
   */
  async acquireWorkerPage() {
    this.workerPages = this.workerPages || []
    while (this.workerPages.length > 0) {
      const page = this.workerPages.pop()
      if (page && !page.isClosed?.()) {
        return { page, state: this.pages.stateOf(page), reused: true }
      }
    }
    const state = await this.createPage({ activate: false })
    return { page: state?.page || null, state, reused: false }
  }

  /** 归还工作页；keep=false 或池满时关闭。 */
  async releaseWorkerPage(page, { keep = true, max = 4 } = {}) {
    if (!page || page.isClosed?.()) return
    this.workerPages = this.workerPages || []
    if (keep && this.workerPages.length < max) {
      this.workerPages.push(page)
      return
    }
    await page.close().catch(() => {})
  }

  async #closeWorkerPages() {
    const pages = this.workerPages || []
    this.workerPages = []
    for (const page of pages) {
      try {
        if (!page.isClosed?.()) await page.close()
      } catch {
        /* ignore */
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  status() {
    const base = this.host.status()
    const tabs = this.pages.statusTabs().map(tab => ({
      ...tab,
      locked: this.locks.isLocked(tab.tab),
    }))
    const staleTabs = [...this.store.restoredTabs.values()].map(tab => ({ ...tab }))
    return {
      ...base,
      tabs,
      activeTab: this.pages.getActiveTabId(),
      pending: this.pending,
      workspaces: this.store.summary(),
      locks: this.locks.status(),
      restored: this.restored,
      restoredAt: this.restoredAt,
      staleTabs,
      lastEviction: this.lastEviction,
      lastPersistError: this.lastPersistError?.message ?? null,
    }
  }

  // ---------------------------------------------------------------------------
  // 产物与下载
  // ---------------------------------------------------------------------------

  async artifactPath(requested, { ext = '.png', prefix = 'shot' } = {}) {
    return this.host.artifactPath(requested, { ext, prefix })
  }

  async downloadPath(requested, suggestedName) {
    return this.host.downloadPath(requested, suggestedName)
  }

  async saveText(text, { requested, prefix = 'extract', ext = '.txt' } = {}) {
    const filePath = await this.artifactPath(requested, { ext, prefix })
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, text, 'utf8')
    return filePath
  }

  async saveJson(value, { requested, prefix = 'collect' } = {}) {
    const filePath = await this.artifactPath(requested, { ext: '.json', prefix })
    await ensureDir(path.dirname(filePath))
    await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
    return filePath
  }

  // ---------------------------------------------------------------------------
  // 持久化
  // ---------------------------------------------------------------------------

  /** 立即把当前工作区与标签页元数据原子写入状态文件。 */
  async persistState() {
    return this.#persist()
  }

  async #persist({ silent = false } = {}) {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (!this.store.statePath) return null
    try {
      const filePath = await this.store.save({ tabs: this.pages.tabMeta() })
      this.lastPersistError = null
      return filePath
    } catch (error) {
      this.lastPersistError = { message: errorMessage(error), at: Date.now() }
      if (!silent) throw error
      return null
    }
  }

  #schedulePersist() {
    if (this.closing || this.disposed || this.persistTimer || !this.store.statePath) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.#persist({ silent: true })
    }, PERSIST_DEBOUNCE_MS)
    this.persistTimer.unref?.()
  }

  // ---------------------------------------------------------------------------
  // 内部协作
  // ---------------------------------------------------------------------------

  #attachPageHooks(page) {
    if (this.pageHooks.has(page)) return
    this.pageHooks.add(page)

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
      const text = errorMessage(error)
      this.lastErrorByPage.set(page, { message: text, at: Date.now() })
      this.#pushConsole(page, { type: 'pageerror', text })
    })

    page.on('console', message => {
      const text = message.text()
      this.#pushConsole(page, { type: message.type(), text })
      if (message.type() === 'error') {
        this.lastErrorByPage.set(page, { message: text, at: Date.now() })
      }
    })
  }

  #pushConsole(page, { type, text }) {
    const ring = this.consoleByPage.get(page) ?? []
    ring.push({ type, text: firstLine(text, 500), at: Date.now() })
    while (ring.length > CONSOLE_RING_SIZE) ring.shift()
    this.consoleByPage.set(page, ring)
  }

  #markActive(state, agentId) {
    if (!state) return
    if (agentId && state.workspaceId) {
      this.store.setActiveWorkspace(agentId, state.workspaceId)
    }
    this.pages.touch(state, agentId)
  }

  #canEvict(state) {
    return !this.locks.isLocked(state.tabId)
  }

  #onEvict(event) {
    this.lastEviction = event
    this.#recordAudit({ type: 'tabEvicted', ...event })
    this.emit('tabEvicted', event)
    this.#schedulePersist()
  }

  #recordAudit(event) {
    this.auditLog.push(event)
    if (this.auditLog.length > AUDIT_LOG_SIZE) {
      this.auditLog.splice(0, this.auditLog.length - AUDIT_LOG_SIZE)
    }
    this.emit('audit', event)
  }

  #startTabSweep() {
    this.#stopTabSweep()
    const idleMs = Number(this.config.idleTabMs) || 0
    if (idleMs <= 0) return
    const every = Math.max(5000, Number(this.config.watchdogIntervalMs) || 30000)
    this.tabSweepTimer = setInterval(() => {
      void this.pages.sweepIdle().catch(() => {})
    }, every)
    this.tabSweepTimer.unref?.()
  }

  #stopTabSweep() {
    if (this.tabSweepTimer) {
      clearInterval(this.tabSweepTimer)
      this.tabSweepTimer = null
    }
  }

  #publicWorkspace(workspace, agentId = null) {
    const base = this.store.publicWorkspace(workspace, agentId)
    return {
      ...base,
      tabs: base.tabs.map(tabId => this.#tabView(tabId, workspace)).filter(Boolean),
    }
  }

  #tabView(tabId, workspace) {
    const state = this.pages.getState(tabId)
    if (state) {
      let url = ''
      try {
        url = state.page.url()
      } catch {
        url = ''
      }
      return {
        tab: state.tabId,
        url,
        title: state.title || '',
        owner: state.owner ?? null,
        workspaceId: state.workspaceId ?? null,
        role: state.workspaceId ? this.store.roleOf(state.workspaceId, state.owner) : state.owner ? 'writer' : null,
        stale: false,
      }
    }
    const stale = this.store.restoredTabs.get(tabId)
    if (stale) {
      return {
        tab: tabId,
        url: stale.url || '',
        title: stale.title || '',
        owner: stale.owner ?? null,
        workspaceId: stale.workspaceId ?? workspace?.id ?? null,
        role: stale.role ?? null,
        stale: true,
      }
    }
    return {
      tab: tabId,
      url: '',
      title: '',
      owner: null,
      workspaceId: workspace?.id ?? null,
      role: null,
      stale: true,
      missing: true,
    }
  }

  #normalizeCloseTabs(closeTabs) {
    if (!closeTabs) return []
    if (closeTabs === true) return []
    if (typeof closeTabs === 'string') return [normalizeTabKey(closeTabs)]
    if (Array.isArray(closeTabs)) {
      return closeTabs.map(item => normalizeTabKey(item)).filter(Boolean)
    }
    if (typeof closeTabs === 'object' && Array.isArray(closeTabs.tabs)) {
      return closeTabs.tabs.map(item => normalizeTabKey(item)).filter(Boolean)
    }
    return []
  }

  #canFocus() {
    // 只有显式配置 visibility=window 才允许把窗口带到前台。
    return this.config.visibility === 'window'
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async close(reason = 'manual') {
    if (this.closing) return
    this.closing = true
    await this.#closeWorkerPages()
    this.closedReason = reason
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.#stopTabSweep()
    // 关闭前先保存，保证下次启动能恢复工作区成员与标签页元数据。
    await this.#persist({ silent: true })
    this.pages.clearTabs({ preserve: true })
    try {
      await this.host.close(reason)
    } finally {
      this.closing = false
    }
  }

  async dispose() {
    if (this.disposed) return
    // 先保留最后一份完整状态；之后页面关闭事件触发的防抖保存会被 disposed 拦住，
    // 避免把刚写入的工作区/租约元数据覆盖成空表。
    this.disposed = true
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.#stopTabSweep()
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    await this.#persist({ silent: true })
    await this.host.dispose()
    this.pages.clearTabs({ preserve: false })
    this.locks.clear?.()
  }
}
