import { firstLine, sleep } from './util.js'

/**
 * 稳定标签页注册表。
 *
 * 职责：
 * - 维护 tabSeq / pageByTab / tabByPage，页面关闭时清理状态。
 * - 新页面（包括 window.open 产生的页面）继承 opener 的 workspace 与 owner。
 * - 基于 agentId 过滤可见标签页，防止不同工作区串页。
 * - 标签页上限回收与空闲回收（active、工作区 owner 当前页、加锁页不会被回收）。
 *
 * 本文件不负责 ACL 判断与锁的具体实现；ACL 在 manager.assertAccess，
 * 锁在 locks.js，这里只通过 canEvict 回调避让正在加锁的页面。
 */

const PAGE_TITLE_TIMEOUT_MS = 1200

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function normalizeTabKey(tab) {
  const text = String(tab ?? '').trim().replace(/^#/, '')
  if (/^\d+$/.test(text)) return `t${text}`
  return text
}

function nowMs() {
  return Date.now()
}

export class TabRegistry {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('./host.js').BrowserHost} options.host
   * @param {import('./workspace.js').WorkspaceStore} options.store
   * @param {(state: object) => boolean} [options.canEvict]
   * @param {(event: object) => void} [options.onEvict]
   * @param {(reason: string) => void} [options.onChanged]
   * @param {(page: object, state: object) => void} [options.onPageRegistered]
   */
  constructor({ config, host, store, canEvict = null, onEvict = null, onChanged = null, onPageRegistered = null }) {
    this.config = config || {}
    this.host = host
    this.store = store
    this.canEvict = canEvict
    this.onEvict = onEvict
    this.onChanged = onChanged
    this.onPageRegistered = onPageRegistered

    this.pageByTab = new Map()
    this.tabByPage = new Map()
    this.activeByAgent = new Map()
    this.activeTabId = null
    this.lastEviction = null

    this.host.on('launched', () => this.registerExistingPages())
    this.host.on('page', page => this.#onNewPage(page))
    this.host.on('disconnected', () => this.clearTabs({ preserve: true }))
  }

  /** 兼容旧代码读取 manager.tabSeq。 */
  get tabSeq() {
    return this.store.tabSeq
  }

  get context() {
    return this.host.context
  }

  // ---------------------------------------------------------------------------
  // 页面注册
  // ---------------------------------------------------------------------------

  /** 页面对象 → 注册状态（worker 页池复用需要）。 */
  stateOf(page) {
    return this.tabByPage.get(page) || null
  }

  registerExistingPages() {
    const context = this.host.context
    if (!context) return
    for (const page of context.pages()) {
      this.#registerPage(page, { activate: false })
    }
  }

  #onNewPage(page) {
    let opener = null
    try {
      opener = page.opener()
    } catch {
      opener = null
    }
    const openerState = opener ? this.tabByPage.get(opener) : null
    const state = this.#registerPage(page, {
      activate: false,
      owner: openerState?.owner ?? null,
      workspaceId: openerState?.workspaceId ?? null,
    })
    if (state.workspaceId) {
      this.store.addTab(state.workspaceId, state.tabId)
      this.#touchLease(state, state.owner)
    }
    if (state.owner) {
      this.activeByAgent.set(state.owner, state.tabId)
      this.activeTabId = state.tabId
    }
    this.onChanged?.('page')
  }

  #registerPage(page, { activate = false, owner = null, workspaceId = null } = {}) {
    const existing = this.tabByPage.get(page)
    if (existing) {
      if (owner && !existing.owner) existing.owner = owner
      if (workspaceId && !existing.workspaceId) existing.workspaceId = workspaceId
      if (workspaceId) this.store.addTab(workspaceId, existing.tabId)
      if (activate) this.activate(existing, owner ?? existing.owner)
      return existing
    }

    const tabId = this.store.nextTabId()
    const state = {
      tabId,
      page,
      owner: owner ?? null,
      workspaceId: workspaceId ?? null,
      createdAt: nowMs(),
      lastUsedAt: nowMs(),
      title: '',
      lastWarning: '',
    }
    this.pageByTab.set(tabId, page)
    this.tabByPage.set(page, state)
    if (workspaceId) this.store.addTab(workspaceId, tabId)

    page.on('close', () => {
      this.#detachState(state)
    })

    this.onPageRegistered?.(page, state)
    if (activate) this.activate(state, owner)
    return state
  }

  // ---------------------------------------------------------------------------
  // 查询与选择
  // ---------------------------------------------------------------------------

  getState(tabId) {
    const page = this.pageByTab.get(String(tabId ?? ''))
    if (!page || page.isClosed()) return null
    return this.tabByPage.get(page) ?? null
  }

  stateOf(page) {
    return this.tabByPage.get(page) ?? null
  }

  /** 解析 tab 参数（支持 t1、1、URL 片段或状态对象）。 */
  resolveStateArg(tab) {
    if (tab && typeof tab === 'object') {
      if (tab.page && this.tabByPage.has(tab.page)) return this.tabByPage.get(tab.page)
      if (tab.tabId) return this.getState(tab.tabId)
      return null
    }
    return this.getState(normalizeTabKey(tab))
  }

  isVisible(state, agentId, workspaceId = null) {
    if (!state) return false
    const agent = String(agentId ?? '').trim()
    if (!agent) return true
    if (state.owner === agent) return true
    if (workspaceId && state.workspaceId === workspaceId) return true
    if (state.workspaceId) {
      const workspace = this.store.workspaces.get(state.workspaceId)
      return Boolean(workspace?.members.has(agent))
    }
    // 旧行为：没有工作区的无主标签页对所有代理可见。
    return !state.owner
  }

  visibleStates(agentId, workspaceId = null) {
    this.#pruneClosed()
    return [...this.tabByPage.values()].filter(state => this.isVisible(state, agentId, workspaceId))
  }

  findByParam(tab, agentId, workspaceId = null) {
    const states = this.visibleStates(agentId, workspaceId)
    return this.#matchStates(states, tab)
  }

  findInWorkspace(workspaceId, tab) {
    const id = String(workspaceId ?? '')
    const states = this.listStates().filter(state => state.workspaceId === id)
    return this.#matchStates(states, tab)
  }

  #matchStates(states, tab) {
    if (!states.length) return null
    if (tab && typeof tab === 'object') {
      const state = tab.page ? this.tabByPage.get(tab.page) : this.getState(tab.tabId ?? tab.tab)
      return state && states.includes(state) ? state : null
    }
    const key = normalizeTabKey(tab)
    if (!key || key === 'active') return null
    const exact = states.find(state => state.tabId === key)
    if (exact) return exact

    // URL 片段匹配：可见集合已按工作区/归属过滤，这里取最近使用的匹配页。
    const fragment = states
      .slice()
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      .find(state => {
        try {
          return state.page.url().includes(String(tab).replace(/^#/, ''))
        } catch {
          return false
        }
      })
    return fragment ?? null
  }

  activeState(agentId, workspaceId = null) {
    this.#pruneClosed()
    const agent = String(agentId ?? '').trim()
    const agentActive = agent ? this.activeByAgent.get(agent) : null
    let state = agentActive ? this.getState(agentActive) : null
    if (state && this.isVisible(state, agent, workspaceId)) return state

    // 优先当前工作区里最近使用的标签页。
    if (workspaceId) {
      const workspaceStates = this.visibleStates(agent, workspaceId)
        .filter(candidate => candidate.workspaceId === workspaceId)
        .sort((left, right) => right.lastUsedAt - left.lastUsedAt)
      if (workspaceStates.length > 0) return workspaceStates[0]
    }

    // 回退旧 active 标签页。
    if (this.activeTabId) {
      state = this.getState(this.activeTabId)
      if (state && this.isVisible(state, agent, workspaceId)) return state
    }

    const visible = this.visibleStates(agent, workspaceId).sort(
      (left, right) => right.lastUsedAt - left.lastUsedAt,
    )
    return visible[0] ?? null
  }

  activate(state, agentId = null) {
    if (!state) return
    this.activeTabId = state.tabId
    if (agentId) {
      this.activeByAgent.set(agentId, state.tabId)
    } else if (state.owner) {
      this.activeByAgent.set(state.owner, state.tabId)
    }
  }

  setActiveFor(agentId, tabId) {
    if (!agentId) return
    if (this.getState(tabId)) this.activeByAgent.set(agentId, tabId)
  }

  /**
   * 记录一次使用：刷新 lastUsedAt，加入工作区并续租。
   * activate=false 时只更新元数据，不改变 active 标签页（后台采集页会用到）。
   */
  touch(state, agentId = null, { activate = true } = {}) {
    if (!state) return state
    state.lastUsedAt = nowMs()
    if (agentId && !state.owner) state.owner = agentId
    if (state.workspaceId) {
      this.store.addTab(state.workspaceId, state.tabId)
      this.#touchLease(state, agentId ?? state.owner)
    }
    if (activate) {
      if (agentId) this.activeByAgent.set(agentId, state.tabId)
      if (state.owner) this.activeByAgent.set(state.owner, state.tabId)
      this.activeTabId = state.tabId
    }
    this.onChanged?.('touch')
    return state
  }

  #touchLease(state, agentId) {
    if (!state.workspaceId || !agentId) return null
    const role = this.store.roleOf(state.workspaceId, agentId)
    if (!role) return null
    return this.store.touchLease(state.workspaceId, state.tabId, agentId, role)
  }

  // ---------------------------------------------------------------------------
  // 创建 / 关闭
  // ---------------------------------------------------------------------------

  async createPage({ activate = false, owner = null, workspaceId = null } = {}) {
    const context = await this.host.ensure()
    this.#pruneClosed()
    await this.sweepIdle()
    await this.#ensureCapacity()

    let page
    try {
      page = await context.newPage()
    } catch (error) {
      throw new Error(`新建标签页失败：${errorMessage(error)}。请重试。`)
    }

    const state = this.#registerPage(page, { activate, owner, workspaceId })
    if (owner && !state.owner) state.owner = owner
    if (workspaceId) {
      this.store.addTab(workspaceId, state.tabId)
      this.#touchLease(state, owner)
    }
    if (activate) {
      this.activate(state, owner)
      if (this.#canFocus()) await page.bringToFront().catch(() => {})
    }
    this.onChanged?.('create')
    return state
  }

  async closeById(tabId, reason = 'manual') {
    const state = this.getState(tabId)
    if (!state) return null
    const id = state.tabId
    try {
      await state.page.close()
    } catch {
      /* 页面可能已经关闭，继续清理元数据 */
    }
    this.#detachState(state)
    this.onChanged?.(`close:${reason}`)
    return id
  }

  async closeState(state) {
    return this.closeById(state?.tabId)
  }

  adoptPage(tabId, agentId, workspaceId = null) {
    const state = this.getState(tabId)
    if (!state) return null
    if (agentId && !this.isVisible(state, agentId, workspaceId)) return null
    if (agentId && !state.owner) state.owner = agentId
    this.activate(state, agentId)
    this.touch(state, agentId)
    return state
  }

  #detachState(state, { keepStoreMeta = false } = {}) {
    if (!state) return
    const known = this.pageByTab.has(state.tabId) || this.tabByPage.has(state.page)
    if (!known) return
    this.pageByTab.delete(state.tabId)
    if (this.tabByPage.get(state.page) === state) this.tabByPage.delete(state.page)
    for (const [agentId, activeTab] of this.activeByAgent) {
      if (activeTab === state.tabId) this.activeByAgent.delete(agentId)
    }
    if (this.activeTabId === state.tabId) {
      this.activeTabId = this.pageByTab.keys().next().value ?? null
    }
    if (!keepStoreMeta) this.store.removeTab(state.tabId)
    this.onChanged?.('close')
  }

  /** 浏览器断开或手动关闭窗口时清理内存注册表。 */
  clearTabs({ preserve = false } = {}) {
    for (const state of [...this.tabByPage.values()]) {
      if (preserve) this.store.addStaleTab(this.#metaOf(state))
      this.#detachState(state, { keepStoreMeta: preserve })
    }
    this.pageByTab.clear()
    this.tabByPage.clear()
    this.activeByAgent.clear()
    this.activeTabId = null
    this.onChanged?.('clear')
  }

  // ---------------------------------------------------------------------------
  // 上限与空闲回收
  // ---------------------------------------------------------------------------

  async #ensureCapacity() {
    const maxTabs = Math.max(1, Number(this.config.maxTabs) || 24)
    let guard = 0
    while (this.pageByTab.size >= maxTabs && guard <= maxTabs + 2) {
      const evicted = await this.#evictOldest('maxTabs')
      if (!evicted) break
      guard += 1
    }
    if (this.pageByTab.size >= maxTabs) {
      throw new Error(
        `标签页数量已达上限 ${maxTabs}（maxTabs 配置），且没有可安全回收的闲置标签页` +
          '（active、工作区 owner 当前页或正在加锁的页面不会被关闭）。' +
          '请先关闭不用的标签页，或调大 maxTabs 后重试。',
      )
    }
  }

  /**
   * 回收超过 maxIdleTabs 的最久空闲标签页。
   * @returns {Promise<object[]>} 被回收的事件列表
   */
  async sweepIdle() {
    const idleMs = Number(this.config.idleTabMs) || 0
    const maxIdleTabs = Number(this.config.maxIdleTabs)
    if (idleMs <= 0 || !Number.isFinite(maxIdleTabs) || maxIdleTabs < 0) return []
    this.#pruneClosed()
    const now = Date.now()
    const idle = this.listStates()
      .filter(state => now - state.lastUsedAt >= idleMs && !this.#isProtected(state))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    const excess = idle.length - maxIdleTabs
    if (excess <= 0) return []
    const events = []
    for (let index = 0; index < excess; index += 1) {
      const event = await this.#evict(idle[index], 'idle', idleMs)
      if (event) events.push(event)
    }
    return events
  }

  async #evictOldest(reason) {
    this.#pruneClosed()
    const candidates = this.listStates()
      .filter(state => !this.#isProtected(state))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    if (candidates.length === 0) return null
    return this.#evict(candidates[0], reason, null)
  }

  #isProtected(state) {
    if (!state || !state.page || state.page.isClosed()) return true
    if (this.activeTabId === state.tabId) return true
    for (const activeTab of this.activeByAgent.values()) {
      if (activeTab === state.tabId) return true
    }
    if (state.workspaceId) {
      const workspace = this.store.workspaces.get(state.workspaceId)
      if (workspace && workspace.ownerAgent === state.owner) {
        const ownerActive = this.activeByAgent.get(workspace.ownerAgent)
        if (ownerActive === state.tabId || !ownerActive) return true
      }
    }
    // 正在执行或排队等待锁的标签页不回收。
    if (this.canEvict && !this.canEvict(state)) return true
    return false
  }

  async #evict(state, reason, idleMs) {
    if (!state) return null
    const tabId = state.tabId
    let url = ''
    try {
      url = state.page.url()
    } catch {
      url = ''
    }
    try {
      await state.page.close()
    } catch {
      /* 忽略关闭失败，继续清理元数据 */
    }
    this.#detachState(state)
    const event = {
      tabId,
      reason,
      url,
      workspaceId: state.workspaceId,
      at: Date.now(),
      idleMs: idleMs ?? null,
    }
    this.lastEviction = event
    this.onEvict?.(event)
    this.onChanged?.(`evict:${reason}`)
    return event
  }

  // ---------------------------------------------------------------------------
  // 信息输出
  // ---------------------------------------------------------------------------

  #pruneClosed() {
    for (const state of [...this.tabByPage.values()]) {
      if (state.page.isClosed()) this.#detachState(state)
    }
  }

  listStates() {
    this.#pruneClosed()
    return [...this.tabByPage.values()]
  }

  listPages() {
    return this.listStates().map(state => ({ tabId: state.tabId, page: state.page }))
  }

  async pageInfo(state) {
    const page = state.page
    let title = ''
    try {
      title = await Promise.race([page.title(), sleep(PAGE_TITLE_TIMEOUT_MS).then(() => '')])
    } catch {
      title = ''
    }
    state.title = firstLine(title, 160)
    return {
      tab: state.tabId,
      url: page.url(),
      title: state.title,
      active: this.activeTabId === state.tabId,
    }
  }

  async listTabs(agentId, workspaceId = null) {
    const active = this.activeState(agentId, workspaceId)
    const tabs = []
    for (const state of this.visibleStates(agentId, workspaceId)) {
      let title = ''
      try {
        title = await Promise.race([state.page.title(), sleep(PAGE_TITLE_TIMEOUT_MS).then(() => '')])
      } catch {
        title = ''
      }
      state.title = firstLine(title, 160)
      tabs.push({
        tab: state.tabId,
        url: state.page.url(),
        title: state.title,
        active: state.tabId === active?.tabId,
        owner: state.owner ?? null,
        workspaceId: state.workspaceId ?? null,
        role: this.#roleOf(state),
      })
    }
    return tabs
  }

  statusTabs() {
    this.#pruneClosed()
    return this.listStates().map(state => ({
      tab: state.tabId,
      url: state.page.url(),
      title: state.title || '',
      active: state.tabId === this.activeTabId,
      owner: state.owner ?? null,
      workspaceId: state.workspaceId ?? null,
      role: this.#roleOf(state),
      lastUsedAt: state.lastUsedAt,
    }))
  }

  tabMeta() {
    return this.listStates().map(state => this.#metaOf(state))
  }

  #metaOf(state) {
    let url = ''
    try {
      url = state.page.url()
    } catch {
      url = ''
    }
    return {
      tabId: state.tabId,
      url,
      title: state.title || '',
      owner: state.owner ?? null,
      workspaceId: state.workspaceId ?? null,
      role: this.#roleOf(state),
      createdAt: state.createdAt,
      lastUsedAt: state.lastUsedAt,
    }
  }

  #roleOf(state) {
    if (state.workspaceId) return this.store.roleOf(state.workspaceId, state.owner)
    return state.owner ? 'writer' : null
  }

  getActiveTabId() {
    return this.activeTabId
  }

  #canFocus() {
    return this.config.visibility === 'window'
  }
}
