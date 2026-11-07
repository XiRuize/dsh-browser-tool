import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { ensureDir } from './util.js'

/**
 * 多代理工作区与状态持久化。
 *
 * 数据模型（对应蓝图 ER 图）：
 * - Workspace 1..* Member：成员角色只有 reader / writer。
 * - Workspace 1..* Lease：标签页的租约，记录当前负责的代理与到期时间。
 * - Workspace 1..* Tab：标签页必须显式加入工作区后才能被工作区成员共享。
 * - Tab 1..* Observation：观测记录由其他模块负责，这里只保存标签页元数据。
 *
 * 本文件不直接操作 Playwright 页面，页面生命周期由 pages.js 负责；
 * 这里只维护可持久化的元数据，保证重启后能恢复工作区结构而不自动开页面。
 */

export const WORKSPACE_ROLES = Object.freeze(['reader', 'writer'])
export const WORKSPACE_STATE_VERSION = 1

const STATE_DIR_NAME = 'state'
const STATE_FILE_NAME = 'workspaces.json'
const DEFAULT_LEASE_MS = 10 * 60 * 1000
const MAX_AUDIT_ENTRIES = 200
const MAX_STALE_TABS = 200

function nowMs() {
  return Date.now()
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function requireAgentId(agentId, action = '执行该操作') {
  const value = stringValue(agentId)
  if (!value) throw new Error(`${action}需要 agentId（调用方代理标识）。`)
  return value
}

function normalizeRole(role, fallback = 'reader') {
  const value = String(role ?? fallback).trim().toLowerCase()
  if (!WORKSPACE_ROLES.includes(value)) {
    throw new Error(`工作区角色无效：${role ?? '(空)'}。只允许 reader 或 writer。`)
  }
  return value
}

function normalizeTabKey(tab) {
  const text = String(tab ?? '').trim().replace(/^#/, '')
  if (/^\d+$/.test(text)) return `t${text}`
  return text
}

function makeWorkspaceId() {
  const stamp = Date.now().toString(36)
  const random = Math.random().toString(36).slice(2, 8)
  return `ws-${stamp}-${random}`
}

function cloneMember(member) {
  return {
    agentId: member.agentId,
    role: member.role,
    joinedAt: member.joinedAt,
  }
}

/**
 * 工作区元数据仓库：内存模型 + 原子持久化。
 *
 * 构造函数会同步读取状态文件（文件很小），因此 `workspace()` 等只读方法
 * 可以立即返回，不需要调用方先等待异步初始化。
 */
export class WorkspaceStore {
  constructor(config = {}) {
    this.config = config || {}
    const userDataDir = stringValue(this.config.userDataDir)
    this.statePath = userDataDir
      ? path.join(path.dirname(userDataDir), STATE_DIR_NAME, STATE_FILE_NAME)
      : null
    this.leaseMs = Math.max(
      60_000,
      Number.isFinite(Number(this.config.workspaceLeaseMs))
        ? Number(this.config.workspaceLeaseMs)
        : DEFAULT_LEASE_MS,
    )

    /** @type {Map<string, object>} */
    this.workspaces = new Map()
    /** @type {Map<string, string>} agentId -> workspaceId */
    this.activeByAgent = new Map()
    /** @type {Map<string, object>} 启动时恢复但没有对应页面的标签页元数据 */
    this.restoredTabs = new Map()

    this.tabSeq = 0
    this.restored = false
    this.restoredAt = null
    this.lastSavedAt = null
    this.loadWarning = ''
    this.lastSaveError = null
    this.saveChain = Promise.resolve()
    this.#loadSync()
  }

  // ---------------------------------------------------------------------------
  // 标签页序号
  // ---------------------------------------------------------------------------

  /** 生成只增不减的标签页 ID（t1、t2……）。 */
  nextTabId() {
    this.tabSeq += 1
    return `t${this.tabSeq}`
  }

  /** 确保序号不小于给定值，避免恢复后复用旧标签页 ID。 */
  ensureTabSeq(value) {
    const number = Number(value)
    if (Number.isFinite(number) && number > this.tabSeq) {
      this.tabSeq = Math.floor(number)
    }
  }

  // ---------------------------------------------------------------------------
  // 工作区基础操作
  // ---------------------------------------------------------------------------

  /**
   * 创建工作区，调用者自动成为 writer 成员。
   * @returns {object} 工作区公开视图
   */
  createWorkspace(agentId, { label } = {}) {
    const agent = requireAgentId(agentId, '创建工作区')
    const id = makeWorkspaceId()
    const now = nowMs()
    const text = stringValue(label) || `${agent} 的工作区`
    const workspace = {
      id,
      label: text.slice(0, 120),
      ownerAgent: agent,
      createdAt: now,
      lastUsedAt: now,
      members: new Map([
        [agent, { agentId: agent, role: 'writer', joinedAt: now }],
      ]),
      leases: new Map(),
      tabs: new Set(),
      audit: [],
    }
    this.workspaces.set(id, workspace)
    this.activeByAgent.set(agent, id)
    return this.publicWorkspace(workspace, agent)
  }

  /**
   * 加入工作区。已存在成员关系时给出中文错误，而不是静默重复加入。
   */
  joinWorkspace(agentId, workspaceId, { role = 'reader' } = {}) {
    const agent = requireAgentId(agentId, '加入工作区')
    const workspace = this.requireWorkspace(workspaceId)
    const existing = workspace.members.get(agent)
    if (existing) {
      throw new Error(
        `代理 ${agent} 已经是工作区 ${workspace.id}（${workspace.label}）的成员（${existing.role}），无需重复加入。`,
      )
    }
    const normalized = normalizeRole(role, 'reader')
    const now = nowMs()
    workspace.members.set(agent, { agentId: agent, role: normalized, joinedAt: now })
    workspace.lastUsedAt = now
    if (!this.workspaceForAgent(agent)) this.activeByAgent.set(agent, workspace.id)
    return this.publicWorkspace(workspace, agent)
  }

  /**
   * 授权/变更成员角色；只有 owner 或 writer 可以操作。
   */
  grantWorkspace(agentId, workspaceId, { agentId: targetAgent, role } = {}) {
    const caller = requireAgentId(agentId, '授权工作区成员')
    const workspace = this.requireWorkspace(workspaceId)
    this.assertWriter(workspace, caller)
    const target = requireAgentId(targetAgent, '授权工作区成员时')
    const normalized = normalizeRole(role, 'reader')
    if (target === workspace.ownerAgent && normalized !== 'writer') {
      throw new Error(`不能把工作区 ${workspace.id} 的 owner（${target}）降级为 ${normalized}。`)
    }
    const existing = workspace.members.get(target)
    const now = nowMs()
    if (existing) {
      existing.role = normalized
    } else {
      workspace.members.set(target, { agentId: target, role: normalized, joinedAt: now })
    }
    workspace.lastUsedAt = now
    workspace.audit.push({
      action: 'grant',
      at: now,
      from: caller,
      to: target,
      role: normalized,
    })
    this.#trimAudit(workspace)
    return this.publicWorkspace(workspace, caller)
  }

  /**
   * 把标签页的 owner 与 writer 角色交给目标代理。
   * 页面 owner 字段由 manager 同步修改；这里负责成员角色、租约与审计。
   */
  handoff(agentId, { workspaceId, tab, toAgent, note } = {}) {
    const caller = requireAgentId(agentId, '移交标签页')
    const workspace = workspaceId
      ? this.requireWorkspace(workspaceId)
      : this.workspaceForAgent(caller)
    if (!workspace) {
      throw new Error(`代理 ${caller} 当前没有工作区，无法移交标签页。请先创建工作区或指定 workspaceId。`)
    }
    this.assertWriter(workspace, caller)
    const tabId = normalizeTabKey(tab)
    if (!tabId) throw new Error('移交标签页需要 tab 参数（例如 t1、1 或 URL 片段）。')
    if (!workspace.tabs.has(tabId)) {
      throw new Error(
        `标签页 ${tabId} 不属于工作区 ${workspace.id}（${workspace.label}）。可用标签页：${
          [...workspace.tabs].join(', ') || '(无)'
        }。`,
      )
    }
    const target = requireAgentId(toAgent, '移交标签页时')
    if (target === caller) {
      throw new Error('不能把标签页移交给发起者本人。')
    }
    const now = nowMs()
    const existing = workspace.members.get(target)
    if (existing) {
      existing.role = 'writer'
    } else {
      workspace.members.set(target, { agentId: target, role: 'writer', joinedAt: now })
    }
    workspace.leases.set(tabId, {
      tabId,
      agentId: target,
      role: 'writer',
      renewedAt: now,
      expiresAt: now + this.leaseMs,
    })
    workspace.lastUsedAt = now
    workspace.audit.push({
      action: 'handoff',
      at: now,
      tabId,
      from: caller,
      to: target,
      note: stringValue(note).slice(0, 500),
    })
    this.#trimAudit(workspace)
    return {
      workspace: this.publicWorkspace(workspace, caller),
      tabId,
      from: caller,
      to: target,
      note: stringValue(note),
    }
  }

  /**
   * 关闭工作区；只有 owner 可以关闭。返回关闭前的标签页列表，由 manager
   * 负责真正关闭页面。
   */
  closeWorkspace(agentId, workspaceId) {
    const caller = requireAgentId(agentId, '关闭工作区')
    const workspace = this.requireWorkspace(workspaceId)
    if (workspace.ownerAgent !== caller) {
      throw new Error(
        `只有工作区 ${workspace.id}（${workspace.label}）的 owner（${workspace.ownerAgent}）可以关闭它；` +
          `代理 ${caller} 的当前角色是 ${workspace.members.get(caller)?.role ?? '(非成员)'}。`,
      )
    }
    const tabs = [...workspace.tabs]
    this.workspaces.delete(workspace.id)
    for (const [agent, activeId] of this.activeByAgent) {
      if (activeId === workspace.id) this.activeByAgent.delete(agent)
    }
    for (const tabId of tabs) {
      workspace.leases.delete(tabId)
      this.restoredTabs.delete(tabId)
    }
    return {
      id: workspace.id,
      label: workspace.label,
      ownerAgent: workspace.ownerAgent,
      tabs,
    }
  }

  /**
   * 返回代理当前活动工作区；按最近使用排序。没有则返回 null，不自动创建。
   */
  workspaceForAgent(agentId) {
    const agent = stringValue(agentId)
    if (!agent) return null
    const activeId = this.activeByAgent.get(agent)
    let active = activeId ? this.workspaces.get(activeId) : null
    if (active && active.members.has(agent)) return active

    let best = null
    for (const workspace of this.workspaces.values()) {
      if (!workspace.members.has(agent)) continue
      if (!best || workspace.lastUsedAt > best.lastUsedAt) best = workspace
    }
    if (best) {
      this.activeByAgent.set(agent, best.id)
      return best
    }
    if (activeId) this.activeByAgent.delete(agent)
    return null
  }

  /** 切换代理的活动工作区（必须是成员）。 */
  setActiveWorkspace(agentId, workspaceId) {
    const agent = stringValue(agentId)
    if (!agent) return null
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    if (!workspace || !workspace.members.has(agent)) return null
    this.activeByAgent.set(agent, workspace.id)
    workspace.lastUsedAt = nowMs()
    return workspace
  }

  activeWorkspaceId(agentId) {
    return this.workspaceForAgent(agentId)?.id ?? null
  }

  requireWorkspace(workspaceId) {
    const id = stringValue(workspaceId)
    if (!id) throw new Error('需要提供 workspaceId。')
    const workspace = this.workspaces.get(id)
    if (!workspace) {
      const available = [...this.workspaces.keys()].join(', ') || '(无)'
      throw new Error(`工作区 ${id} 不存在。当前工作区：${available}。可先调用 browser_workspace create 创建工作区。`)
    }
    return workspace
  }

  assertMember(workspace, agentId) {
    const member = workspace.members.get(agentId)
    if (!member) {
      throw new Error(
        `代理 ${agentId} 不是工作区 ${workspace.id}（${workspace.label}）的成员，不能访问其中的资源。` +
          '请先加入工作区。',
      )
    }
    return member
  }

  assertWriter(workspace, agentId) {
    const member = this.assertMember(workspace, agentId)
    if (member.role !== 'writer') {
      throw new Error(
        `代理 ${agentId} 在工作区 ${workspace.id}（${workspace.label}）中是只读成员（reader），` +
          '不能执行授权、移交或写入操作。',
      )
    }
    return member
  }

  roleOf(workspaceId, agentId) {
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    if (!workspace) return null
    return workspace.members.get(agentId)?.role ?? null
  }

  touchWorkspace(workspaceId) {
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    if (!workspace) return null
    workspace.lastUsedAt = nowMs()
    return workspace
  }

  // ---------------------------------------------------------------------------
  // 工作区成员 / 标签页 / 租约
  // ---------------------------------------------------------------------------

  addTab(workspaceId, tabId) {
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    const id = stringValue(tabId)
    if (!workspace || !id) return false
    workspace.tabs.add(id)
    workspace.lastUsedAt = nowMs()
    this.restoredTabs.delete(id)
    return true
  }

  /** 移除标签页的元数据、租约与恢复记录。 */
  removeTab(tabId) {
    const id = stringValue(tabId)
    if (!id) return
    this.restoredTabs.delete(id)
    for (const workspace of this.workspaces.values()) {
      if (workspace.tabs.delete(id)) workspace.lastUsedAt = nowMs()
      workspace.leases.delete(id)
    }
  }

  /** 把启动时恢复的标签页登记为 stale（只保留元数据，不打开页面）。 */
  addStaleTab(meta) {
    if (!meta || !stringValue(meta.tabId)) return
    const tabId = stringValue(meta.tabId)
    this.restoredTabs.set(tabId, {
      tabId,
      url: typeof meta.url === 'string' ? meta.url : '',
      title: typeof meta.title === 'string' ? meta.title : '',
      owner: meta.owner ?? null,
      workspaceId: meta.workspaceId ?? null,
      role: meta.role ?? null,
      createdAt: Number(meta.createdAt) || nowMs(),
      lastUsedAt: Number(meta.lastUsedAt) || nowMs(),
      stale: true,
    })
    while (this.restoredTabs.size > MAX_STALE_TABS) {
      const oldest = this.restoredTabs.keys().next().value
      if (oldest === undefined) break
      this.restoredTabs.delete(oldest)
    }
  }

  /**
   * 续租：标记某个标签页当前由哪个代理负责，并刷新到期时间。
   * reader 角色同样可以续租，但不会因此获得写权限。
   */
  touchLease(workspaceId, tabId, agentId, role) {
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    const id = stringValue(tabId)
    const agent = stringValue(agentId)
    if (!workspace || !id || !agent) return null
    workspace.tabs.add(id)
    const now = nowMs()
    const lease = {
      tabId: id,
      agentId: agent,
      role: role === 'writer' ? 'writer' : 'reader',
      renewedAt: now,
      expiresAt: now + this.leaseMs,
    }
    workspace.leases.set(id, lease)
    workspace.lastUsedAt = now
    return lease
  }

  leasesOf(workspaceId) {
    const workspace = this.workspaces.get(String(workspaceId ?? ''))
    return workspace ? [...workspace.leases.values()] : []
  }

  // ---------------------------------------------------------------------------
  // 视图
  // ---------------------------------------------------------------------------

  publicWorkspace(workspace, agentId = null) {
    return {
      id: workspace.id,
      label: workspace.label,
      ownerAgent: workspace.ownerAgent,
      createdAt: workspace.createdAt,
      members: [...workspace.members.values()].map(cloneMember),
      tabs: [...workspace.tabs],
      lastUsedAt: workspace.lastUsedAt,
      role: agentId ? workspace.members.get(agentId)?.role ?? null : null,
    }
  }

  /** 供 browser_status 使用的精简列表，不包含租约细节之外的数据。 */
  summary() {
    return [...this.workspaces.values()].map(workspace => ({
      id: workspace.id,
      label: workspace.label,
      ownerAgent: workspace.ownerAgent,
      createdAt: workspace.createdAt,
      lastUsedAt: workspace.lastUsedAt,
      members: workspace.members.size,
      tabs: workspace.tabs.size,
      leases: workspace.leases.size,
    }))
  }

  /** 工作区审计记录（handoff/grant 等），供诊断使用。 */
  auditOf(workspaceId) {
    return [...(this.workspaces.get(String(workspaceId ?? ''))?.audit ?? [])]
  }

  #trimAudit(workspace) {
    if (workspace.audit.length > MAX_AUDIT_ENTRIES) {
      workspace.audit.splice(0, workspace.audit.length - MAX_AUDIT_ENTRIES)
    }
  }

  // ---------------------------------------------------------------------------
  // 持久化
  // ---------------------------------------------------------------------------

  /**
   * 原子写入状态文件：先写同目录 tmp 文件，再 rename 覆盖正式文件。
   * 失败时会清理 tmp，不会留下半截文件。
   *
   * @param {{tabs?: object[]}} [options] 当前活动标签页元数据
   * @returns {Promise<string|null>} 写入路径；未配置 userDataDir 时返回 null
   */
  async save({ tabs = [] } = {}) {
    if (!this.statePath) return null
    const previous = this.saveChain
    let release
    this.saveChain = new Promise(resolve => {
      release = resolve
    })
    await previous.catch(() => {})
    try {
      const payload = this.#buildStatePayload(tabs)
      await ensureDir(path.dirname(this.statePath))
      const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2, 8)}.tmp`
      try {
        await fsp.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
        await fsp.rename(tmpPath, this.statePath)
      } catch (error) {
        await fsp.unlink(tmpPath).catch(() => {})
        const wrapped = new Error(`保存工作区状态失败：${errorMessage(error)}`)
        wrapped.cause = error
        throw wrapped
      }
      this.lastSavedAt = Date.now()
      this.lastSaveError = null
      return this.statePath
    } catch (error) {
      this.lastSaveError = { message: errorMessage(error), at: Date.now() }
      throw error
    } finally {
      release()
    }
  }

  #buildStatePayload(tabs) {
    const liveTabs = []
    const liveIds = new Set()
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const tabId = stringValue(tab?.tabId)
      if (!tabId) continue
      liveIds.add(tabId)
      liveTabs.push({
        tabId,
        url: typeof tab.url === 'string' ? tab.url : '',
        title: typeof tab.title === 'string' ? tab.title : '',
        owner: tab.owner ?? null,
        workspaceId: tab.workspaceId ?? null,
        role: tab.role ?? null,
        createdAt: Number(tab.createdAt) || null,
        lastUsedAt: Number(tab.lastUsedAt) || null,
      })
    }
    const staleTabs = []
    for (const tab of this.restoredTabs.values()) {
      if (liveIds.has(tab.tabId)) continue
      staleTabs.push(tab)
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      savedAt: new Date().toISOString(),
      tabSeq: this.tabSeq,
      activeByAgent: Object.fromEntries(this.activeByAgent),
      workspaces: [...this.workspaces.values()].map(workspace => ({
        id: workspace.id,
        label: workspace.label,
        ownerAgent: workspace.ownerAgent,
        createdAt: workspace.createdAt,
        lastUsedAt: workspace.lastUsedAt,
        members: [...workspace.members.values()].map(cloneMember),
        leases: [...workspace.leases.values()].map(lease => ({ ...lease })),
        tabs: [...workspace.tabs],
        audit: workspace.audit.slice(-MAX_AUDIT_ENTRIES),
      })),
      tabs: liveTabs,
      staleTabs: staleTabs.slice(-MAX_STALE_TABS),
    }
  }

  // ---------------------------------------------------------------------------
  // 启动恢复
  // ---------------------------------------------------------------------------

  #loadSync() {
    if (!this.statePath) return
    let raw
    try {
      raw = fs.readFileSync(this.statePath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.loadWarning = `读取工作区状态失败，已按空状态启动：${errorMessage(error)}`
      }
      return
    }
    let data
    try {
      data = JSON.parse(raw)
    } catch (error) {
      this.loadWarning = `工作区状态文件不是有效 JSON，已按空状态启动：${errorMessage(error)}`
      return
    }
    try {
      this.#applyRestoredState(data)
      this.restored = true
      this.restoredAt = Date.now()
    } catch (error) {
      this.loadWarning = `恢复工作区状态失败，已忽略损坏内容：${errorMessage(error)}`
    }
  }

  #applyRestoredState(data) {
    if (!data || typeof data !== 'object') throw new Error('状态文件根节点不是对象')
    const workspaces = Array.isArray(data.workspaces) ? data.workspaces : []
    for (const raw of workspaces) {
      if (!raw || typeof raw !== 'object' || !stringValue(raw.id)) continue
      const members = new Map()
      for (const member of Array.isArray(raw.members) ? raw.members : []) {
        const agentId = stringValue(member?.agentId)
        if (!agentId) continue
        members.set(agentId, {
          agentId,
          role: member.role === 'writer' ? 'writer' : 'reader',
          joinedAt: Number(member.joinedAt) || nowMs(),
        })
      }
      const ownerAgent = stringValue(raw.ownerAgent)
      if (ownerAgent && !members.has(ownerAgent)) {
        members.set(ownerAgent, { agentId: ownerAgent, role: 'writer', joinedAt: Number(raw.createdAt) || nowMs() })
      }
      if (members.size === 0) continue
      const leases = new Map()
      for (const lease of Array.isArray(raw.leases) ? raw.leases : []) {
        const tabId = stringValue(lease?.tabId)
        const agentId = stringValue(lease?.agentId)
        if (!tabId || !agentId) continue
        leases.set(tabId, {
          tabId,
          agentId,
          role: lease.role === 'writer' ? 'writer' : 'reader',
          renewedAt: Number(lease.renewedAt) || nowMs(),
          expiresAt: Number(lease.expiresAt) || nowMs() + this.leaseMs,
        })
      }
      const tabs = new Set()
      for (const tabId of Array.isArray(raw.tabs) ? raw.tabs : []) {
        const id = stringValue(tabId)
        if (id) tabs.add(id)
      }
      const workspace = {
        id: stringValue(raw.id),
        label: stringValue(raw.label) || `${ownerAgent || '恢复'} 的工作区`,
        ownerAgent: ownerAgent || [...members.keys()][0],
        createdAt: Number(raw.createdAt) || nowMs(),
        lastUsedAt: Number(raw.lastUsedAt) || Number(raw.createdAt) || nowMs(),
        members,
        leases,
        tabs,
        audit: Array.isArray(raw.audit) ? raw.audit.slice(-MAX_AUDIT_ENTRIES) : [],
      }
      this.workspaces.set(workspace.id, workspace)
    }

    const active = data.activeByAgent
    if (active && typeof active === 'object' && !Array.isArray(active)) {
      for (const [agentId, workspaceId] of Object.entries(active)) {
        const workspace = this.workspaces.get(stringValue(workspaceId))
        if (workspace?.members.has(agentId)) this.activeByAgent.set(agentId, workspace.id)
      }
    }

    const allTabs = [
      ...(Array.isArray(data.tabs) ? data.tabs : []),
      ...(Array.isArray(data.staleTabs) ? data.staleTabs : []),
    ]
    for (const tab of allTabs) {
      if (!tab || typeof tab !== 'object') continue
      this.addStaleTab({ ...tab, stale: true })
    }

    let maxSeq = Number(data.tabSeq) || 0
    for (const tab of allTabs) {
      const match = /^t(\d+)$/.exec(stringValue(tab?.tabId))
      if (match) maxSeq = Math.max(maxSeq, Number(match[1]))
    }
    this.tabSeq = Math.max(this.tabSeq, maxSeq)
  }
}

export { normalizeTabKey, normalizeRole, requireAgentId }
