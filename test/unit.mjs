import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, expandPath } from '../lib/config.js'
import { WorkspaceStore } from '../lib/workspace.js'
import { TabLockManager } from '../lib/locks.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { parseLabeledText, cleanLabeledValue } from '../lib/extract.js'
import { NetworkRecorder } from '../lib/network.js'
import { parseSsrPosts, parseFeedApi, tinyIdOfFeed, bknFromSkey } from '../lib/adapters/qq-forum.js'
import { collectUrls } from '../lib/collect.js'
import { cleanHtml, cleanText, extractTitle } from '../lib/clean.js'
import { cleanFrontend } from '../lib/devtools.js'
import { ScratchStore } from '../lib/scratch.js'
import { registerBrowserTools } from '../lib/tools.js'
import { BrowserManager } from '../lib/manager.js'
import { isRecoverableError, launchHint } from '../lib/host.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const tmpRoot = path.join(here, '.tmp')
const suiteStarted = Date.now()

// ---------------------------------------------------------------------------
// 极简 runner：顺序执行、记录 PASS/FAIL、失败继续跑完并设置退出码。
// ---------------------------------------------------------------------------

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

function assertChinese(message, pattern) {
  assert.match(String(message), pattern)
  assert.ok(/[\u4e00-\u9fa5]/.test(String(message)), `错误信息应包含中文：${message}`)
}

function fakeResponse({
  url = 'http://local.test/api/company',
  status = 200,
  type = 'xhr',
  requestHeaders = { accept: 'application/json' },
  responseHeaders = { 'content-type': 'application/json; charset=utf-8', 'content-length': '24' },
  body = '{"creditCode":"91310000TEST"}',
  timing = null,
} = {}) {
  const request = {
    resourceType: () => type,
    headers: () => ({ ...requestHeaders }),
    method: () => 'GET',
    timing: () => timing,
    redirectedFrom: () => null,
  }
  return {
    request: () => request,
    url: () => url,
    status: () => status,
    headers: () => ({ ...responseHeaders }),
    body: async () => Buffer.from(body, 'utf8'),
  }
}

function fakeNetworkPage() {
  const page = new EventEmitter()
  page.url = () => 'http://local.test/'
  return page
}

function makeCollectPage(onGoto) {
  const page = {
    closed: false,
    currentUrl: 'about:blank',
    isClosed() {
      return this.closed
    },
    url() {
      return this.currentUrl
    },
    async title() {
      return 'Fake 页面'
    },
    frames() {
      return [page]
    },
    mainFrame() {
      return page
    },
    async evaluate() {
      return { text: `正文 ${page.currentUrl}`, matches: 1, html: '<html></html>' }
    },
    async goto(url) {
      if (onGoto) await onGoto(url, page)
      page.currentUrl = url
    },
    async waitForLoadState() {},
    async close() {
      page.closed = true
    },
    opener() {
      return null
    },
  }
  return page
}

function makeCollectManager({ artifactDir, onGoto }) {
  let seq = 0
  const created = []
  return {
    created,
    config: { artifactDir },
    context: null,
    async createPage() {
      seq += 1
      const page = makeCollectPage(onGoto)
      created.push(page)
      return { page, tabId: `t${seq}` }
    },
    async saveJson(value, { prefix = 'collect' } = {}) {
      await fs.mkdir(artifactDir, { recursive: true })
      const file = path.join(artifactDir, `${prefix}-${seq}-${Date.now()}.json`)
      await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8')
      return file
    },
  }
}

function validateSchema(schema, where, errors) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    errors.push(`${where} 不是对象 schema`)
    return
  }
  const allowed = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  if (!allowed.includes(schema.type)) errors.push(`${where}.type 非法：${schema.type}`)
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) errors.push(`${where}.enum 必须是非空数组`)
  }
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) {
    errors.push(`${where} minimum > maximum`)
  }
  if (schema.type === 'object') {
    if (schema.properties !== undefined && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
      errors.push(`${where}.properties 必须是对象`)
      return
    }
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required)) errors.push(`${where}.required 必须是数组`)
      else {
        for (const key of schema.required) {
          if (!schema.properties || !(key in schema.properties)) {
            errors.push(`${where}.required 引用了不存在的属性：${key}`)
          }
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      validateSchema(child, `${where}.${key}`, errors)
    }
    if (schema.additionalProperties !== undefined && ![true, false].includes(schema.additionalProperties)) {
      errors.push(`${where}.additionalProperties 必须是布尔值或 schema`)
    }
  }
  if (schema.type === 'array') {
    if (!schema.items) errors.push(`${where}.items 缺失`)
    else validateSchema(schema.items, `${where}[]`, errors)
  }
}

// ---------------------------------------------------------------------------
// resolveConfig
// ---------------------------------------------------------------------------

test('resolveConfig 硬性默认值与 headless 兼容映射', () => {
  const config = resolveConfig({})
  assert.equal(config.visibility, 'headless')
  assert.equal(config.headless, true)
  assert.equal(config.idleCloseMs, 0)
  assert.equal(config.watchdogIntervalMs, 30000)
  assert.equal(config.autoRelaunch, true)
  assert.equal(config.maxTabs, 24)
  assert.equal(config.allowEval, false)
  assert.equal(config.allowAbsoluteArtifacts, false)
  assert.equal(config.mode, 'launch')
  assert.equal(config.channel, 'msedge')
  assert.ok(path.isAbsolute(config.userDataDir))
  assert.ok(path.isAbsolute(config.artifactDir))
  assert.ok(path.isAbsolute(config.downloadsDir))

  assert.equal(resolveConfig({ headless: false }).visibility, 'window')
  assert.equal(resolveConfig({ headless: true }).visibility, 'headless')
  assert.equal(resolveConfig({ visibility: 'window', headless: true }).visibility, 'window')
  assert.equal(resolveConfig({ visibility: 'offscreen' }).visibility, 'offscreen')
  assert.equal(resolveConfig({ visibility: '不存在的值', headless: false }).visibility, 'window')
  assert.equal(resolveConfig({ visibility: '不存在的值' }).visibility, 'headless')
})

test('resolveConfig 启动预算默认值、上下界与工具层超时对齐', () => {
  const config = resolveConfig({})
  assert.equal(config.launchTimeoutMs, 30000)
  assert.equal(config.launchDeadlineMs, 55000)
  // 必须比常见工具超时（快照 45s / 截图与网络 60s / browser_open 90s）更早结束，
  // 否则调用会被工具层先中止，而底层 launch 还在跑。
  assert.ok(config.launchDeadlineMs < 60000, '总预算应小于 60s 工具超时')
  assert.ok(config.launchDeadlineMs <= 90000, '总预算应小于 browser_open 的 90s')
  assert.ok(config.launchTimeoutMs <= config.launchDeadlineMs, '单次超时不应超过总预算')

  assert.equal(resolveConfig({ launchTimeoutMs: 999999 }).launchTimeoutMs, 180000)
  assert.equal(resolveConfig({ launchTimeoutMs: 1 }).launchTimeoutMs, 5000)
  assert.equal(resolveConfig({ launchTimeoutMs: '不是数字' }).launchTimeoutMs, 30000)
  assert.equal(resolveConfig({ launchDeadlineMs: 999999 }).launchDeadlineMs, 300000)
  assert.equal(resolveConfig({ launchDeadlineMs: 1 }).launchDeadlineMs, 10000)
})

// 真实报错样本（2026-11-14 22:53 实机抓到）：启动超时的 Call log 里必然带 msedge.exe 路径。
const LAUNCH_TIMEOUT_MESSAGE =
  '浏览器启动失败：browserType.launchPersistentContext: Timeout 180000ms exceeded.\n' +
  'Call log:\n' +
  '  - <launching> C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe ' +
  '--disable-field-trial-config --headless --user-data-dir=C:\\Users\\x\\.dsh\\browser-tool\\profile ' +
  '--remote-debugging-pipe about:blank\n' +
  '  - <launched> pid=27252\n' +
  '  - [pid=27252][err] [27252:35660:1114/225012.869:ERROR:components\\edge_auth\\edge_auth_errors.cc:540] ' +
  'EDGE_IDENTITY: Get Default OS Account failed'

test('launchHint：启动超时不得误报「未找到可用的 Edge」', () => {
  const hint = launchHint(LAUNCH_TIMEOUT_MESSAGE)
  assert.match(hint, /启动超时/)
  assert.match(hint, /占用/)
  assert.doesNotMatch(hint, /未找到可用的 Edge/)
  assert.doesNotMatch(hint, /请安装 Microsoft Edge/)
})

test('launchHint：只有真正缺可执行文件时才提示安装 Edge', () => {
  const missing = launchHint(
    "browserType.launchPersistentContext: Executable doesn't exist at C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  )
  assert.match(missing, /未找到可用的 Edge/)

  const distribution = launchHint("Chromium distribution 'msedge' is not found at C:\\Program Files (x86)")
  assert.match(distribution, /未找到可用的 Edge/)
})

test('launchHint：exitCode=21 与 profile 占用各自给出对应建议', () => {
  const exit21 = launchHint(
    '浏览器启动失败：browserType.launchPersistentContext: Target page, context or browser has been closed\n' +
      'Browser logs:\n<launching> C:\\msedge.exe --user-data-dir=C:\\p\n<process did exit: exitCode=21, signal=null>',
  )
  assert.match(exit21, /exitCode=21/)
  assert.match(exit21, /msedge/)

  const singleton = launchHint(
    "browserType.launchPersistentContext: ProcessSingleton: C:\\Users\\x\\.dsh\\browser-tool\\profile is already in use",
  )
  assert.match(singleton, /配置目录可能被另一个/)
  assert.doesNotMatch(singleton, /未找到可用的 Edge/)
})

test('isRecoverableError：启动超时算可恢复，未知错误不算', () => {
  assert.equal(isRecoverableError(new Error('Timeout 180000ms exceeded.')), true)
  assert.equal(isRecoverableError(LAUNCH_TIMEOUT_MESSAGE), true)
  assert.equal(isRecoverableError(new Error('Target page, context or browser has been closed')), true)
  assert.equal(isRecoverableError(new Error('browser has been closed')), true)
  assert.equal(isRecoverableError(new Error('ECONNRESET')), true)
  // 参数/配置类错误不该触发自愈重试。
  assert.equal(isRecoverableError(new Error('mode=cdp 时必须配置 cdpUrl')), false)
  assert.equal(isRecoverableError(new Error('visibility 只能是 headless / offscreen / window')), false)
})

test('resolveConfig 展开 ~、$DSH_HOME 与环境变量', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = tmpRoot
    const viaEnv = resolveConfig({ artifactDir: '$DSH_HOME/custom-artifacts' })
    assert.equal(viaEnv.artifactDir, path.resolve(tmpRoot, 'custom-artifacts'))

    const viaTilde = resolveConfig({ userDataDir: '~/browser-tool-unit-profile' })
    assert.equal(viaTilde.userDataDir, path.join(os.homedir(), 'browser-tool-unit-profile'))

    const viaDshHome = resolveConfig({ dshHome: '~/.dsh-unit-home' })
    assert.ok(viaDshHome.userDataDir.startsWith(path.join(os.homedir(), '.dsh-unit-home')))

    assert.equal(expandPath('~', {}), os.homedir())
    assert.equal(expandPath('%UNIT_A%/${UNIT_B}/$UNIT_C', { UNIT_A: 'a', UNIT_B: 'b', UNIT_C: 'c' }), 'a/b/c')
    assert.equal(expandPath('$MISSING_UNIT_VAR/x', {}), '$MISSING_UNIT_VAR/x')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

// ---------------------------------------------------------------------------
// WorkspaceStore / 多代理 ACL / 持久化
// ---------------------------------------------------------------------------

test('WorkspaceStore create/join/grant/handoff/close 与 reader-writer ACL', () => {
  const userDataDir = path.join(tmpRoot, 'workspace-acl', 'profile')
  const store = new WorkspaceStore({ userDataDir, workspaceLeaseMs: 60_000 })
  const workspace = store.createWorkspace('alice', { label: '单元测试工作区' })
  assert.ok(workspace.id.startsWith('ws-'))
  assert.equal(workspace.ownerAgent, 'alice')
  assert.equal(workspace.role, 'writer')
  assert.equal(workspace.members.length, 1)

  const joined = store.joinWorkspace('bob', workspace.id, { role: 'reader' })
  assert.equal(joined.role, 'reader')
  assert.equal(joined.members.length, 2)

  assert.throws(() => store.joinWorkspace('bob', workspace.id), /已经是工作区/)
  assert.throws(
    () => store.joinWorkspace('carol', workspace.id, { role: 'owner' }),
    /工作区角色无效/,
  )

  const internal = store.workspaces.get(workspace.id)
  assert.throws(() => store.assertWriter(internal, 'bob'), /只读成员|reader/)
  assert.throws(() => store.grantWorkspace('bob', workspace.id, { agentId: 'carol', role: 'writer' }), /只读成员|reader/)

  const granted = store.grantWorkspace('alice', workspace.id, { agentId: 'bob', role: 'writer' })
  assert.equal(granted.members.find(member => member.agentId === 'bob').role, 'writer')
  assert.equal(store.roleOf(workspace.id, 'bob'), 'writer')

  store.addTab(workspace.id, 't1')
  const handoff = store.handoff('alice', { workspaceId: workspace.id, tab: '1', toAgent: 'bob', note: '交接摘要' })
  assert.equal(handoff.tabId, 't1')
  assert.equal(handoff.to, 'bob')
  assert.equal(internal.tabs.has('t1'), true)

  const leases = store.leasesOf(workspace.id)
  assert.equal(leases.length, 1)
  assert.equal(leases[0].agentId, 'bob')
  assert.equal(leases[0].role, 'writer')
  assert.ok(leases[0].expiresAt > leases[0].renewedAt, '租约应带到期时间')
  assert.equal(leases[0].expiresAt - leases[0].renewedAt, 60_000)

  assert.throws(
    () => store.handoff('bob', { workspaceId: workspace.id, tab: 't1', toAgent: 'bob' }),
    /不能把标签页移交给发起者本人/,
  )
  assert.throws(() => store.closeWorkspace('bob', workspace.id), /只有工作区.*owner/)
  const closed = store.closeWorkspace('alice', workspace.id)
  assert.deepEqual(closed.tabs, ['t1'])
  assert.equal(store.workspaces.size, 0)
  assert.equal(store.workspaceForAgent('alice'), null)
})

test('WorkspaceStore 状态文件 tmp+rename 原子写入并可恢复；损坏文件降级', async () => {
  const userDataDir = path.join(tmpRoot, 'workspace-state', 'profile')
  const stateParent = path.join(path.dirname(userDataDir), 'state')
  const store = new WorkspaceStore({ userDataDir })
  assert.equal(store.statePath, path.join(stateParent, 'workspaces.json'))
  const workspace = store.createWorkspace('alice', { label: '持久化工作区' })
  store.joinWorkspace('bob', workspace.id, { role: 'reader' })
  store.addTab(workspace.id, 't1')
  store.touchLease(workspace.id, 't1', 'bob', 'reader')
  store.ensureTabSeq(7)

  const savedPath = await store.save({
    tabs: [
      {
        tabId: 't1',
        url: 'http://local.test/',
        title: '测试页',
        owner: 'bob',
        workspaceId: workspace.id,
        role: 'reader',
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
      },
    ],
  })
  assert.equal(savedPath, store.statePath)

  const raw = await fs.readFile(savedPath, 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, 1)
  assert.equal(parsed.workspaces.length, 1)
  assert.equal(parsed.tabs[0].tabId, 't1')
  const leftovers = (await fs.readdir(path.dirname(savedPath))).filter(name => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '原子写入后不应留下 tmp 文件')

  const restored = new WorkspaceStore({ userDataDir })
  assert.equal(restored.restored, true)
  assert.equal(restored.loadWarning, '')
  assert.equal(restored.workspaceForAgent('alice').id, workspace.id)
  assert.equal(restored.roleOf(workspace.id, 'bob'), 'reader')
  assert.equal(restored.tabSeq, 7)
  assert.equal(restored.leasesOf(workspace.id)[0].tabId, 't1')
  assert.equal(restored.restoredTabs.has('t1'), true)

  // 损坏状态文件：不抛错，按空状态启动并给出中文 warning。
  await fs.writeFile(restored.statePath, '{ 这不是合法 JSON', 'utf8')
  const broken = new WorkspaceStore({ userDataDir })
  assert.equal(broken.workspaces.size, 0)
  assert.match(broken.loadWarning, /不是有效 JSON/)
  assert.ok(/[\u4e00-\u9fa5]/.test(broken.loadWarning))
})

test('BrowserManager workspaceStatus 报告租约 expired 字段', async () => {
  const base = path.join(tmpRoot, 'workspace-lease')
  const manager = new BrowserManager({
    userDataDir: path.join(base, 'profile'),
    artifactDir: path.join(base, 'artifacts'),
    downloadsDir: path.join(base, 'downloads'),
    visibility: 'headless',
    idleCloseMs: 0,
  })
  try {
    const workspace = await manager.createWorkspace('alice', { label: '租约测试' })
    manager.store.addTab(workspace.id, 't1')
    manager.store.touchLease(workspace.id, 't1', 'alice', 'writer')

    let status = manager.workspaceStatus('alice')
    assert.equal(status.role, 'writer')
    assert.equal(status.leases.length, 1)
    assert.equal(status.leases[0].expired, false)
    assert.ok(status.leaseExpiresAt >= status.leases[0].expiresAt)

    manager.store.workspaces.get(workspace.id).leases.get('t1').expiresAt = Date.now() - 1000
    status = manager.workspaceStatus('alice')
    assert.equal(status.leases[0].expired, true)
  } finally {
    await manager.dispose()
  }
})

// ---------------------------------------------------------------------------
// TabLockManager
// ---------------------------------------------------------------------------

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

test('TabLockManager 同 tab 读写互斥、不同 tab 并行、FIFO', async () => {
  const locks = new TabLockManager({ timeoutMs: 5000 })
  let releaseRead
  let readStarted = false
  const read = locks.withTabLock('t1', 'read', async () => {
    readStarted = true
    await new Promise(resolve => {
      releaseRead = resolve
    })
  })
  await tick()
  assert.equal(readStarted, true)

  let writeStarted = false
  const write = locks.withTabLock('t1', 'write', async () => {
    writeStarted = true
  })
  await tick()
  assert.equal(writeStarted, false, '读锁持有时写操作不得开始')
  releaseRead()
  await Promise.all([read, write])
  assert.equal(writeStarted, true)

  // 不同 tab 并行：t3 的读操作不必等 t2 的写锁释放。
  let releaseLongWrite
  const longWrite = locks.withTabLock('t2', 'write', async () => {
    await new Promise(resolve => {
      releaseLongWrite = resolve
    })
  })
  await tick()
  let otherTabDone = false
  await locks.withTabLock('t3', 'read', async () => {
    otherTabDone = true
  })
  assert.equal(otherTabDone, true, '不同标签页应并行')
  releaseLongWrite()
  await longWrite

  // FIFO：先排队的写操作先执行。
  const order = []
  let releaseHold
  const hold = locks.withTabLock('t4', 'write', async () => {
    await new Promise(resolve => {
      releaseHold = resolve
    })
  })
  await tick()
  const first = locks.withTabLock('t4', 'write', async () => {
    order.push('first')
  })
  const second = locks.withTabLock('t4', 'write', async () => {
    order.push('second')
  })
  await tick()
  assert.deepEqual(order, [])
  releaseHold()
  await Promise.all([hold, first, second])
  assert.deepEqual(order, ['first', 'second'])
})

test('TabLockManager 超时与非法模式返回中文错误', async () => {
  const locks = new TabLockManager({ timeoutMs: 5000 })
  let releaseHold
  const hold = locks.withTabLock('t1', 'write', async () => {
    await new Promise(resolve => {
      releaseHold = resolve
    })
  })
  await tick()
  try {
    await assert.rejects(
      locks.withTabLock('t1', 'read', async () => {}, { timeoutMs: 1000 }),
      error => {
        assertChinese(error.message, /锁等待超时/)
        assert.match(error.message, /t1/)
        assert.match(error.message, /browser_status/)
        return true
      },
    )
  } finally {
    releaseHold()
    await hold
  }

  await assert.rejects(
    locks.withTabLock('t1', 'delete', async () => {}),
    error => {
      assertChinese(error.message, /锁模式无效/)
      return true
    },
  )
  await assert.rejects(locks.withTabLock('', 'read', async () => {}), /标签页 ID/)
})

// ---------------------------------------------------------------------------
// ArtifactStore
// ---------------------------------------------------------------------------

test('ArtifactStore 拒绝 .. 与越界绝对路径，记录 sha256 与 manifest JSONL', async () => {
  const artifactDir = path.join(tmpRoot, 'artifacts-basic')
  const store = new ArtifactStore({ artifactDir })
  const relative = await store.path('sub/name.txt', { ext: '.txt' })
  assert.ok(relative.startsWith(artifactDir))
  assert.ok(relative.endsWith('.txt'))

  await assert.rejects(store.path('../escape.txt'), error => {
    assertChinese(error.message, /越出|越界/)
    return true
  })
  await assert.rejects(store.path(path.join(tmpRoot, 'outside.txt')), error => {
    assertChinese(error.message, /绝对路径|越界/)
    return true
  })

  const meta = await store.saveText('hello 产物', { requested: 'note.txt', prefix: 'note' })
  const expected = createHash('sha256').update(Buffer.from('hello 产物', 'utf8')).digest('hex')
  assert.equal(meta.sha256, expected)
  assert.equal(meta.bytes, Buffer.byteLength('hello 产物', 'utf8'))
  assert.equal(meta.kind, 'text')
  assert.equal(await fs.readFile(meta.path, 'utf8'), 'hello 产物')

  const second = await store.saveJson({ ok: true }, { requested: 'data.json' })
  assert.equal(second.kind, 'json')
  assert.deepEqual(JSON.parse(await fs.readFile(second.path, 'utf8')), { ok: true })

  const lines = (await fs.readFile(store.manifestPath, 'utf8')).trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).sha256, expected)
  assert.equal(JSON.parse(lines[1]).path, second.path)

  const absoluteStore = new ArtifactStore({ artifactDir, allowAbsoluteArtifacts: true })
  const outside = path.join(tmpRoot, 'artifacts-absolute', 'allowed.txt')
  const absoluteMeta = await absoluteStore.saveText('absolute ok', { requested: outside })
  assert.equal(absoluteMeta.path, outside)
  assert.equal(await fs.readFile(outside, 'utf8'), 'absolute ok')
})

// ---------------------------------------------------------------------------
// extract.js 纯函数
// ---------------------------------------------------------------------------

test('parseLabeledText 支持冒号、表格 tab 与换行，cleanLabeledValue 清理噪声', () => {
  const text = [
    '统一社会信用代码：91310000TEST',
    '法定代表人: 张三',
    '登记状态\t存续\t成立日期\t1986-05-14',
    '注册资本',
    '5000万元',
    '统一社会信用代码：',
    '91310000FALLBACK',
    '地址：上海市浦东新区 复制',
  ].join('\n')
  const values = parseLabeledText(text, ['统一社会信用代码', '法定代表人', '登记状态', '成立日期', '注册资本', '地址', '不存在'])
  assert.equal(values['统一社会信用代码'], '91310000TEST')
  assert.equal(values['法定代表人'], '张三')
  assert.equal(values['登记状态'], '存续')
  assert.equal(values['成立日期'], '1986-05-14')
  assert.equal(values['注册资本'], '5000万元')
  assert.equal(values['地址'], '上海市浦东新区')
  assert.equal(values['不存在'], null)

  assert.equal(cleanLabeledValue('  上海  有限公司 复制 '), '上海 有限公司')
  assert.equal(cleanLabeledValue('更多 12'), '')
  assert.equal(cleanLabeledValue('展开'), '')
  assert.equal(cleanLabeledValue(null), '')
})

// ---------------------------------------------------------------------------
// NetworkRecorder
// ---------------------------------------------------------------------------

test('NetworkRecorder 环形淘汰、默认脱敏、JSON 解析与 HAR 结构', async () => {
  const page = fakeNetworkPage()
  const recorder = new NetworkRecorder(page, { maxEntries: 2, maxBodyChars: 10000 })
  recorder.start({ urlPattern: '/api/', maxEntries: 2 })
  page.emit(
    'response',
    fakeResponse({
      url: 'http://local.test/api/1',
      requestHeaders: { cookie: 'session=secret', accept: 'application/json' },
      responseHeaders: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'session=secret',
        'content-length': '24',
      },
      body: '{"creditCode":"91310000TEST"}',
      timing: { startTime: 1000, domainLookupStart: 1000, domainLookupEnd: 1010, connectStart: 1010, connectEnd: 1020, requestStart: 1020, responseStart: 1040, responseEnd: 1060 },
    }),
  )
  page.emit(
    'response',
    fakeResponse({
      url: 'http://local.test/api/2',
      body: '{"n":2}',
      status: 200,
      requestHeaders: { cookie: 'session=secret', accept: 'application/json' },
      responseHeaders: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': 'session=secret',
        'content-length': '7',
      },
    }),
  )
  page.emit('response', fakeResponse({ url: 'http://local.test/api/3', body: '{"n":3}', status: 201 }))
  await recorder.waitForBodies(1000)

  const listed = recorder.list()
  assert.equal(listed.length, 2, '环形缓冲应只保留最近 2 条')
  assert.deepEqual(listed.map(entry => entry.id), ['n2', 'n3'])
  assert.equal(listed[0].requestHeaders.cookie, '[已脱敏]')
  assert.equal(listed[0].responseHeaders['set-cookie'], '[已脱敏]')
  assert.equal(listed[0].hasBody, true)

  const snapshot = recorder.snapshot()
  assert.equal(snapshot.count, 2)
  assert.equal(snapshot.entries.maxEntries, 2)
  assert.equal(snapshot.entries.byStatus['201'], 1)

  const record = await recorder.get({ id: 'n3' })
  assert.equal(record.status, 201)
  assert.equal(record.body, '{"n":3}')
  assert.deepEqual(record.json, { n: 3 })

  await recorder.waitForBodies(1000)
  const har = recorder.exportHar()
  assert.equal(har.log.version, '1.2')
  assert.equal(har.log.creator.name, '@future/dsh-browser-tool')
  assert.equal(har.log.pages.length, 1)
  assert.equal(har.log.entries.length, 2)
  const cookieHeader = har.log.entries[0].request.headers.find(header => header.name === 'cookie')
  assert.equal(cookieHeader.value, '[已脱敏]')
  const setCookie = har.log.entries[0].response.headers.find(header => header.name === 'set-cookie')
  assert.equal(setCookie.value, '[已脱敏]')
  assert.ok('text' in har.log.entries[1].response.content, 'includeBodies=true 应包含响应体')
  assert.equal(typeof har.log.entries[0].timings.wait, 'number')
  recorder.stop()
  assert.equal(recorder.active, false)
})

test('NetworkRecorder includeBodies=false 时跳过响应体', async () => {
  const page = fakeNetworkPage()
  const recorder = new NetworkRecorder(page, { maxEntries: 10 })
  recorder.start({ includeBodies: false })
  page.emit(
    'response',
    fakeResponse({
      url: 'http://local.test/api/body',
      requestHeaders: { authorization: 'Bearer secret' },
      body: '{"secret":true}',
    }),
  )
  await tick()
  const entry = recorder.list()[0]
  assert.equal(entry.bodySkipped, true)
  assert.equal(entry.hasBody, false)
  assert.equal(entry.requestHeaders.authorization, '[已脱敏]')
  const record = await recorder.get({ id: entry.id })
  assert.equal(record.body, '')
  assert.equal(record.json, null)

  const har = recorder.exportHar({ includeBodies: true })
  assert.equal('text' in har.log.entries[0].response.content, false)
  assert.equal(har.log.entries[0]._bodySkipped, true)
  const unredacted = recorder.exportHar({ redactSensitive: false, includeBodies: true })
  assert.equal(
    unredacted.log.entries[0].request.headers.find(header => header.name === 'authorization').value,
    'Bearer secret',
  )
})

// ---------------------------------------------------------------------------
// QQ 论坛适配器
// ---------------------------------------------------------------------------

test('qq-forum 适配器：bkn、SSR 解析、tiny_id 反解与 API 归一', () => {
  assert.equal(bknFromSkey(''), '')
  assert.match(bknFromSkey('abc123'), /^\d+$/)
  assert.equal(bknFromSkey('abc123'), bknFromSkey('abc123'))
  assert.notEqual(bknFromSkey('abc123'), bknFromSkey('abc124'))
  const feedId = 'B_bfd9f16a00280d001441152186791961150X60'
  assert.equal(tinyIdOfFeed(feedId), '144115218679196115')
  assert.equal(tinyIdOfFeed('B_notinyidX60'), '')

  const html = `
    <div class="msgBox" data-index="${feedId}" data-v-ddf1530c>
      <div class="user"><div class="game-guild-main__waterfalls__item">
        <a class="game-guild-main__short-content pointer" href="https://pd.qq.com/g/iloveswufe/post/${feedId}?subc=634804985">
          <div class="game-guild-main__short-content__info">
            <div class="user-info">
              <div class="avatar no-copy avatar--circle"><img class="img" src="https://example.com/avatar.png" alt="avatar-img"></div>
              <h3 class="nick hover-underline">momo</h3>
            </div>
            <h3 class="edit-time">13小时前</h3>
          </div>
          <div class="game-guild-main__short-content__detail"><span class="feed-detail-text">明天体测跳远找男演员</span></div>
        </a>
      </div></div>
    </div>`
  const posts = parseSsrPosts(html, { section: '全部' })
  assert.equal(posts.length, 1)
  assert.equal(posts[0].post_id, feedId)
  assert.equal(posts[0].author_tinyid, '144115218679196115')
  assert.equal(posts[0].author_nick, 'momo')
  assert.equal(posts[0].posted_at, '13小时前')
  assert.equal(posts[0].text, '明天体测跳远找男演员')
  assert.match(posts[0].link, /\/post\//)

  const apiPosts = parseFeedApi({
    data: {
      vecFeed: [
        {
          id: feedId,
          createTime: '1794234815',
          commentCount: 7,
          poster: { id: '144115218679196115', nick: 'momo', icon: { iconUrl: 'https://example.com/a.png' } },
          title: { contents: [{ type: 1, text_content: { text: '明天体测跳远找男演员' } }] },
          contents: { contents: [] },
          visitorInfo: { viewCount: 248 },
          ip_location_province: '四川',
        },
      ],
    },
  })
  assert.equal(apiPosts.length, 1)
  assert.equal(apiPosts[0].author_tinyid, '144115218679196115')
  assert.equal(apiPosts[0].view_count, 248)
  assert.equal(apiPosts[0].text, '明天体测跳远找男演员')
})

test('cleanFrontend 去脚本/样式/注释/内联事件/埋点', () => {
  const html = `<!-- c --><div onclick="x()" data-track-id="1"><script>a()</script><style>.a{}</style><link rel="stylesheet" href="/a.css"><p>正文</p></div>`
  const result = cleanFrontend(html)
  assert.equal(result.stats.scripts, 1)
  assert.equal(result.stats.styles, 2)
  assert.equal(result.stats.comments, 1)
  assert.equal(result.stats.handlers, 1)
  assert.equal(result.stats.tracking, 1)
  assert.ok(!result.html.includes('<script'))
  assert.ok(!result.html.includes('onclick'))
  assert.ok(!result.html.includes('data-track-id'))
  assert.ok(result.text.includes('正文'))
})
// ---------------------------------------------------------------------------
// clean.js / scratch.js
// ---------------------------------------------------------------------------

test('cleanHtml 去脚本样式、解实体、折叠空白', () => {
  const html = `<html><head><title>测试 标题</title><style>.a{color:red}</style></head>
    <body><script>alert(1)</script><h1>标题</h1><p>第一段 &amp; 第二段</p><div>尾巴</div></body></html>`
  const text = cleanHtml(html)
  assert.equal(extractTitle(html), '测试 标题')
  assert.ok(!text.includes('alert(1)'))
  assert.ok(!text.includes('color:red'))
  assert.ok(text.includes('标题'))
  assert.ok(text.includes('第一段 & 第二段'))
  assert.equal(cleanText('a\n\n\n b'), 'a\n\nb')
  assert.equal(cleanHtml('<p>abcdefgh</p>', { maxChars: 5 }).endsWith('…(已截断)'), true)
})

test('ScratchStore 写入/列出/读取/清理与越界拒绝', async () => {
  const dir = path.join(tmpRoot, 'scratch')
  const store = new ScratchStore({ dir, ttlMs: 60000 })
  const jobId = ScratchStore.jobId('unit')
  const written = await store.put(jobId, 'page', '<p>hello</p>')
  assert.ok(written.bytes > 0 && written.path.startsWith(dir))
  const files = await store.list(jobId)
  assert.equal(files.length, 1)
  assert.equal(await store.read(written.path), '<p>hello</p>')
  await assert.rejects(() => store.read(path.join(tmpRoot, 'outside.txt')), /拒绝读取/)
  const stats = await store.stats()
  assert.ok(stats.jobs.some(job => job.jobId === jobId))
  await store.clear(jobId)
  assert.equal((await store.list(jobId)).length, 0)
})
// ---------------------------------------------------------------------------
// collect.js
// ---------------------------------------------------------------------------

test('collectUrls 120 URL：单次上限 100 → checkpoint → cursor 续跑 20 → done，无重复', async () => {
  const artifactDir = path.join(tmpRoot, 'collect-cursor')
  const urls = Array.from({ length: 120 }, (_, index) => `http://local.test/detail?n=${index + 1}`)
  const manager = makeCollectManager({ artifactDir })
  const config = { artifactDir, collectRenderWaitMs: 1, collectDelayMs: 0, navigationTimeoutMs: 5000 }

  const first = await collectUrls(
    manager,
    { urls, mode: 'text', jobId: 'unit-collect-120', save: false, delayMs: 0, concurrency: 2 },
    config,
  )
  assert.equal(first.done, false)
  assert.equal(first.nextCursor, 100)
  assert.equal(first.count, 100)
  assert.equal(first.succeeded, 100)
  assert.equal(first.processed, 100)
  assert.equal(first.total, 120)
  assert.equal(first.remaining, 20)
  const checkpoint = JSON.parse(await fs.readFile(first.checkpointPath, 'utf8'))
  assert.equal(checkpoint.nextCursor, 100)
  assert.equal(checkpoint.doneUrls.length, 100)
  assert.equal(checkpoint.done, false)

  const second = await collectUrls(
    manager,
    { urls, mode: 'text', jobId: 'unit-collect-120', save: false, delayMs: 0, concurrency: 2 },
    config,
  )
  assert.equal(second.resumed, true)
  assert.equal(second.done, true)
  assert.equal(second.nextCursor, 120)
  assert.equal(second.count, 20)
  assert.equal(second.succeeded, 20)
  assert.deepEqual(
    second.results.map(result => result.url),
    urls.slice(100),
  )

  const third = await collectUrls(
    manager,
    { urls, mode: 'text', jobId: 'unit-collect-120', save: false, delayMs: 0, concurrency: 2 },
    config,
  )
  assert.equal(third.done, true)
  assert.equal(third.count, 0)
  assert.equal(third.nextCursor, 120)

  const allUrls = [...first.results, ...second.results, ...third.results].map(result => result.url)
  assert.equal(allUrls.length, 120)
  assert.equal(new Set(allUrls).size, 120, '续跑不得重复采集已完成 URL')
  assert.equal(second.checkpointPath, first.checkpointPath)
  // 每次调用只按并发数建页（两次调用共 4 个），不再逐条 URL 建页。
  assert.ok(manager.created.length <= 4, `复用常驻页面：创建页面数应不超过 4，实际 ${manager.created.length}`)
})

test('collectUrls 失败隔离：单条失败不影响后续且写入 checkpoint', async () => {
  const artifactDir = path.join(tmpRoot, 'collect-failure')
  const urls = [
    'http://local.test/ok-1',
    'http://local.test/fail-2',
    'http://local.test/ok-3',
  ]
  const manager = makeCollectManager({
    artifactDir,
    onGoto: async url => {
      if (url.includes('fail-2')) throw new Error('导航失败：boom')
    },
  })
  const result = await collectUrls(
    manager,
    { urls, mode: 'text', jobId: 'unit-collect-failure', save: false, delayMs: 0, concurrency: 1 },
    { artifactDir, collectRenderWaitMs: 1, collectDelayMs: 0, navigationTimeoutMs: 5000 },
  )
  assert.equal(result.done, true)
  assert.equal(result.count, 3)
  assert.equal(result.succeeded, 2)
  assert.equal(result.failed, 1)
  assert.equal(result.results.filter(item => item.ok).length, 2)
  const failed = result.results.find(item => !item.ok)
  assert.equal(failed.url, urls[1])
  assert.match(failed.error, /boom/)
  const checkpoint = JSON.parse(await fs.readFile(result.checkpointPath, 'utf8'))
  assert.equal(checkpoint.done, true)
  assert.equal(checkpoint.doneUrls.length, 3)
  assert.equal(checkpoint.failed.length, 1)
})

test('collectUrls deadline 到达时优雅返回 nextCursor 并保存 checkpoint', async () => {
  const artifactDir = path.join(tmpRoot, 'collect-deadline')
  const urls = [
    'http://local.test/slow-1',
    'http://local.test/slow-2',
    'http://local.test/slow-3',
  ]
  const manager = makeCollectManager({
    artifactDir,
    onGoto: async () => {
      await tick(140)
    },
  })
  const result = await collectUrls(
    manager,
    {
      urls,
      mode: 'text',
      jobId: 'unit-collect-deadline',
      save: false,
      delayMs: 20,
      concurrency: 1,
      deadlineMs: 100,
    },
    { artifactDir, collectRenderWaitMs: 1, collectDelayMs: 0, navigationTimeoutMs: 5000 },
  )
  assert.equal(result.done, false)
  assert.equal(result.stoppedReason, 'deadline')
  assert.ok(result.nextCursor >= 1 && result.nextCursor < urls.length, `nextCursor=${result.nextCursor}`)
  assert.ok(result.processed >= 1)
  assert.ok(result.note && /deadlineMs/.test(result.note), '应给出续跑提示')
  const checkpoint = JSON.parse(await fs.readFile(result.checkpointPath, 'utf8'))
  assert.equal(checkpoint.done, false)
  assert.equal(checkpoint.nextCursor, result.nextCursor)
  assert.ok(checkpoint.doneUrls.length >= 1)
})

// ---------------------------------------------------------------------------
// tools.js 工具面
// ---------------------------------------------------------------------------

test('tools.js 注册 20 个工具、schema 合法、并发安全分类与旧参数键齐全', () => {
  const config = resolveConfig({ artifactDir: path.join(tmpRoot, 'tools-artifacts') })
  const tools = new Map()
  const fakeCtx = {
    effect: callback => callback(),
    tools: {
      register: definition => {
        assert.equal(tools.has(definition.name), false, `重复注册：${definition.name}`)
        tools.set(definition.name, definition)
        return () => {}
      },
    },
  }
  registerBrowserTools(fakeCtx, {}, config)

  const expectedNames = [
    'browser_open',
    'browser_snapshot',
    'browser_observe',
    'browser_inspect',
    'browser_act',
    'browser_extract',
    'browser_screenshot',
    'browser_tabs',
    'browser_workspace',
    'browser_network',
    'browser_fetch',
    'browser_forum',
    'browser_show',
    'browser_scratch',
    'browser_capture',
    'browser_devtools',
    'browser_collect',
    'browser_download',
    'browser_close',
    'browser_status',
  ]
  assert.equal(tools.size, 20)
  assert.deepEqual([...tools.keys()].sort(), expectedNames.slice().sort())

  for (const [name, tool] of tools) {
    assert.equal(typeof tool.execute, 'function', `${name}.execute`)
    assert.equal(typeof tool.isConcurrencySafe, 'function', `${name}.isConcurrencySafe`)
    assert.equal(typeof tool.description, 'string', `${name}.description`)
    assert.ok(tool.description.length > 0)
    const errors = []
    validateSchema(tool.parameters, `${name}.parameters`, errors)
    if (tool.parameters.type !== 'object') errors.push(`${name}.parameters 必须是 object`)
    if (tool.parameters.additionalProperties !== false) errors.push(`${name}.parameters.additionalProperties 应为 false`)
    if (!Array.isArray(tool.parameters.required)) errors.push(`${name}.parameters.required 应为数组`)
    assert.deepEqual(errors, [], errors.join('; '))
    assert.equal(tool.output.schema.type, 'object')
    assert.equal(typeof tool.output.render, 'function')
  }

  const oldKeys = {
    browser_open: ['url', 'tab', 'newTab', 'focus'],
    browser_snapshot: ['tab', 'interactiveOnly', 'maxChars'],
    browser_observe: ['layers', 'selector', 'ref', 'offset', 'limit'],
    browser_inspect: ['mode', 'tab', 'selector', 'ref'],
    browser_act: ['action', 'tab', 'ref', 'selector', 'text', 'value', 'key', 'verify'],
    browser_extract: ['tab', 'mode', 'selector', 'labels', 'fields'],
    browser_screenshot: ['tab', 'fullPage', 'ref', 'selector', 'path'],
    browser_tabs: ['action', 'tab'],
    browser_workspace: ['action', 'workspaceId', 'label', 'role', 'toAgent', 'tab', 'note'],
    browser_network: ['action', 'tab', 'urlPattern', 'resourceTypes', 'maxEntries', 'maxBodyChars', 'id', 'urlContains', 'maxChars'],
    browser_collect: ['urls', 'mode', 'selector', 'labels', 'fields', 'maxChars', 'limit', 'concurrency', 'delayMs', 'save', 'jobId', 'cursor', 'deadlineMs', 'checkpointPath'],
    browser_fetch: ['url', 'method', 'headers', 'body', 'timeoutMs', 'retries', 'maxChars', 'save'],
    browser_forum: ['guild', 'limit', 'keywords', 'discover', 'sections', 'api', 'save'],
    browser_show: ['action', 'visibility', 'tab', 'restoreTabs'],
    browser_scratch: ['action', 'jobId', 'path', 'maxChars'],
    browser_capture: ['tab', 'selector', 'keep', 'maxChars'],
    browser_devtools: ['action', 'tab', 'selector', 'jobId', 'clean', 'keep', 'keepLinks', 'dropScripts', 'dropStyles', 'maxChars'],
    browser_download: ['tab', 'url', 'ref', 'selector', 'path'],
  }
  for (const [name, keys] of Object.entries(oldKeys)) {
    const properties = tools.get(name).parameters.properties
    for (const key of keys) assert.ok(key in properties, `${name} 缺少旧参数 ${key}`)
  }
  assert.deepEqual(tools.get('browser_close').parameters.properties, {})
  assert.deepEqual(tools.get('browser_status').parameters.properties, {})

  const safeCases = [
    ['browser_snapshot', {}, true],
    ['browser_observe', {}, true],
    ['browser_inspect', {}, true],
    ['browser_extract', {}, true],
    ['browser_fetch', {}, true],
    ['browser_forum', {}, true],
    ['browser_show', {}, true],
    ['browser_scratch', {}, true],
    ['browser_capture', {}, true],
    ['browser_devtools', {}, true],
    ['browser_screenshot', {}, true],
    ['browser_status', {}, true],
    ['browser_open', {}, false],
    ['browser_act', {}, false],
    ['browser_collect', {}, false],
    ['browser_download', {}, false],
    ['browser_close', {}, false],
    ['browser_tabs', { action: 'list' }, true],
    ['browser_tabs', { action: 'switch' }, false],
    ['browser_network', { action: 'list' }, true],
    ['browser_network', { action: 'get' }, true],
    ['browser_network', { action: 'start' }, false],
    ['browser_workspace', { action: 'status' }, true],
    ['browser_workspace', { action: 'create' }, false],
  ]
  for (const [name, args, expected] of safeCases) {
    assert.equal(tools.get(name).isConcurrencySafe(args), expected, `${name} ${JSON.stringify(args)}`)
  }
})

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function main() {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.mkdir(tmpRoot, { recursive: true })

  // TabLockManager 的超时定时器使用 unref()，避免拖住真实进程；单测里需要一个
  // 未 unref 的句柄把事件循环撑住，否则 Node 会以 unsettled top-level await 退出。
  const keepAlive = setInterval(() => {}, 250)
  let passed = 0
  const failures = []
  try {
    for (const { name, fn } of tests) {
      try {
        await fn()
        passed += 1
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push({ name, error })
        console.error(`FAIL ${name}`)
        console.error(error?.stack || error)
      }
    }
  } finally {
    clearInterval(keepAlive)
  }

  console.log('')
  console.log(`UNIT RESULT ${passed}/${tests.length} PASS, ${failures.length} FAIL, ${Date.now() - suiteStarted}ms`)
  if (failures.length) {
    console.log('失败用例：')
    for (const failure of failures) console.log(`- ${failure.name}`)
    process.exitCode = 1
  }
}

try {
  await main()
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
}
