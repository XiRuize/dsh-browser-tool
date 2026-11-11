import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractPage } from './extract.js'
import { NetworkRecorder } from './network.js'
import { captureSnapshot } from './snapshot.js'
import { cleanHtml } from './clean.js'
import { firstLine, normalizeUrl, settlePage, sleep, truncate, waitForText } from './util.js'

const PER_CALL_LIMIT = 100
const MAX_URLS = 200
const DEFAULT_MAX_CHARS = 8000
const DEFAULT_DEADLINE_MS = 120000
const MAX_DEADLINE_MS = 300000
const ALLOWED_MODES = new Set(['text', 'html', 'links', 'tables', 'labeled', 'structured', 'records', 'markdown'])
const ALLOWED_LAYERS = new Set(['text', 'structure', 'visual', 'network'])
const RETRYABLE_RE =
  /Timeout|timed out|ERR_ABORTED|ERR_CONNECTION|ECONNRESET|EPIPE|socket hang up|IncompleteRead|net::ERR_/i
const BLOCK_RE =
  /验证码|人机验证|安全验证|访问被拒|访问受限|安全威胁|WAF|captcha|异常访问|请求过于频繁/i

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function intValue(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function safeToken(value) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64)
}

function deriveJobId(urls, mode, selector) {
  const digest = crypto
    .createHash('sha1')
    .update(JSON.stringify([urls, mode, selector || '']))
    .digest('hex')
    .slice(0, 12)
  return `collect-${digest}`
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function safePageUrl(page) {
  try {
    return page?.url?.() || ''
  } catch {
    return ''
  }
}

function normalizeLayers(input) {
  if (input === undefined || input === null) return new Set()
  const list = Array.isArray(input) ? input : [input]
  const layers = new Set()
  for (const item of list) {
    const layer = String(item ?? '').trim().toLowerCase()
    if (!layer) continue
    if (!ALLOWED_LAYERS.has(layer)) {
      throw new Error(`不支持的 layers 项：${layer}。可用：text、structure、visual、network。`)
    }
    layers.add(layer)
  }
  return layers
}

function buildSpec(args) {
  return {
    mode: args.mode || 'text',
    selector: args.selector,
    labels: args.labels,
    fields: args.fields,
    itemSelector: args.itemSelector,
    limit: args.limit,
    includeFrames: Boolean(args.includeFrames),
  }
}

function artifactDirOf(config, manager) {
  return (
    config?.artifactDir ||
    manager?.config?.artifactDir ||
    path.resolve(process.cwd(), 'artifacts')
  )
}

function resolveCheckpointPath(requested, artifactDir, jobId) {
  if (requested) {
    const text = String(requested)
    return path.isAbsolute(text) ? path.resolve(text) : path.resolve(artifactDir, text)
  }
  return path.join(artifactDir, 'jobs', jobId, 'checkpoint.json')
}

async function readCheckpoint(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    return { value: JSON.parse(text), error: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null, error: null }
    return { value: null, error: errorMessage(error) }
  }
}

/** 读取增量 JSONL；用于崩溃后补齐最后几条结果。 */
async function readJournal(filePath) {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const results = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.url === 'string') results.push(parsed)
      } catch {
        /* 半行写入忽略 */
      }
    }
    return results
  } catch {
    return []
  }
}

async function writeJsonAtomic(filePath, value) {
  const text = JSON.stringify(value, null, 2)
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  try {
    await fs.rename(tmp, filePath)
  } catch (error) {
    // Windows 上覆盖已存在文件时 rename 可能返回 EPERM/EEXIST。
    if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
      await fs.rm(filePath, { force: true })
      await fs.rename(tmp, filePath)
      return
    }
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

async function sleepInterruptible(ms, stopReason) {
  const end = Date.now() + Math.max(0, Number(ms) || 0)
  while (Date.now() < end) {
    const reason = stopReason()
    if (reason) return reason
    await sleep(Math.min(100, Math.max(1, end - Date.now())))
  }
  return stopReason()
}

async function closePageAndPopups(manager, page) {
  if (!page) return
  let contextPages = []
  try {
    contextPages = manager?.context?.pages?.() || []
  } catch {
    contextPages = []
  }
  for (const candidate of contextPages) {
    if (candidate === page) continue
    try {
      if (candidate.opener?.() === page) await candidate.close?.()
    } catch {
      /* ignore popup close errors */
    }
  }
  try {
    if (!page.isClosed?.()) await page.close()
  } catch {
    /* ignore page close errors */
  }
}

async function textLayer(page, maxChars) {
  const text = await page.evaluate(() => {
    const body = document.body
    const value = body ? body.innerText || body.textContent || '' : ''
    return String(value || '')
  })
  const bounded = truncate(String(text || ''), Math.max(1000, maxChars), '\n…(文本层已截断)')
  return { text: bounded.text, truncated: bounded.truncated }
}

async function structureLayer(page, tabId, maxChars) {
  const snapshot = await captureSnapshot(page, tabId, {
    layer: 'structure',
    maxChars: Math.max(1000, maxChars),
  })
  return {
    text: snapshot.text,
    count: snapshot.count,
    frames: snapshot.frames,
    captcha: snapshot.captcha,
  }
}

async function visualLayer(manager, page, jobId, index) {
  const filePath = await manager.artifactPath(undefined, {
    ext: '.png',
    prefix: `collect-${jobId}-${index + 1}`,
  })
  await page.screenshot({ path: filePath, fullPage: true })
  return filePath
}

/**
 * 克隆一条结果，避免调用方修改影响 checkpoint 中保存的对象。
 */
function cloneResult(result) {
  try {
    return structuredClone(result)
  } catch {
    try {
      return JSON.parse(JSON.stringify(result))
    } catch {
      return result
    }
  }
}

/**
 * 可续跑批量采集（v0.3 提速版）。
 *
 * 相比 v0.2：
 * - worker 复用常驻标签页，不再每条 URL 新建/销毁；
 * - 并发默认 4（最大 8），条目间隔默认 0；
 * - 导航去掉固定渲染等待，改为选择器就绪 + 短沉降；
 * - 检查点改为「JSONL 增量追加 + 周期快照」，避免每条结果全量重写；
 * - 单次上限 100 条；可选 render=false 走 HTTP 快通道（不渲染）。
 */
export async function collectUrls(manager, args, config = {}, exec = null) {
  if (!manager || typeof manager.createPage !== 'function') {
    throw new Error('collectUrls 需要有效的 BrowserManager（createPage 不可用）。')
  }
  const opts = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const cfg = config && typeof config === 'object' ? config : manager.config || {}
  const startedAt = Date.now()

  const rawUrls = Array.isArray(opts.urls) ? opts.urls : []
  const urls = []
  const seen = new Set()
  let duplicates = 0
  let invalidUrls = 0
  for (const item of rawUrls) {
    if (typeof item !== 'string') {
      invalidUrls += 1
      continue
    }
    const text = item.trim()
    if (!text) {
      invalidUrls += 1
      continue
    }
    if (seen.has(text)) {
      duplicates += 1
      continue
    }
    seen.add(text)
    urls.push(text)
  }
  if (urls.length === 0) throw new Error('urls 至少需要一个有效 URL。')
  if (urls.length > MAX_URLS) {
    throw new Error(`urls 最多 ${MAX_URLS} 条（当前去重后 ${urls.length} 条）；请拆成多批调用。`)
  }

  const mode = String(opts.mode || 'text').trim().toLowerCase()
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(
      `不支持的提取模式：${mode}。可用：text、html、links、tables、labeled、structured、records、markdown。`,
    )
  }
  if (mode === 'labeled') {
    const labels = Array.isArray(opts.labels) ? opts.labels.filter(label => typeof label === 'string' && label.trim()) : []
    if (labels.length === 0) throw new Error('mode=labeled 时必须提供 labels 数组。')
  }
  if (mode === 'structured' || mode === 'records') {
    if (!opts.fields || typeof opts.fields !== 'object' || Array.isArray(opts.fields)) {
      throw new Error(`mode=${mode} 时必须提供 fields 对象。`)
    }
  }
  if (mode === 'records' && !String(opts.itemSelector || '').trim()) {
    throw new Error('mode=records 时必须提供 itemSelector（每一条记录的容器选择器）。')
  }

  const spec = buildSpec({ ...opts, mode })
  const perItemChars = intValue(opts.maxChars, cfg.collectMaxChars || DEFAULT_MAX_CHARS, 500, 200000)
  const limit = intValue(opts.limit, 200, 1, 1000)
  spec.limit = limit
  const concurrency = intValue(opts.concurrency, cfg.collectConcurrency || 4, 1, 8)
  const delayMs = intValue(opts.delayMs, cfg.collectDelayMs ?? 0, 0, 10000)
  const render = opts.render !== false
  const retries = intValue(opts.retries, cfg.collectRetries ?? 2, 0, 5)
  const reusePages = opts.reusePages === undefined ? cfg.collectPageReuse !== false : Boolean(opts.reusePages)
  const deadlineMs = intValue(opts.deadlineMs, DEFAULT_DEADLINE_MS, 100, MAX_DEADLINE_MS)
  const layers = normalizeLayers(opts.layers)
  const save = opts.save !== false
  const useScratch = opts.scratch === true
  const keepScratch = opts.keepScratch === true
  const cleanScratch = opts.clean !== false
  const jobId = safeToken(opts.jobId || deriveJobId(urls, mode, opts.selector)) || 'collect'
  const scratchJobId =
    safeToken(opts.scratchJobId || `${jobId}-${Date.now().toString(36)}`) || `${jobId}-scratch`
  const checkpointPath = resolveCheckpointPath(
    opts.checkpointPath,
    artifactDirOf(cfg, manager),
    jobId,
  )
  const journalPath = `${checkpointPath}.jsonl`

  const argsSnapshot = {
    urls: [...urls],
    mode,
    selector: opts.selector || '',
    itemSelector: opts.itemSelector || '',
    labels: Array.isArray(opts.labels) ? opts.labels : [],
    fields: opts.fields && typeof opts.fields === 'object' ? opts.fields : {},
    maxChars: perItemChars,
    limit,
    concurrency,
    delayMs,
    render,
    includeFrames: Boolean(opts.includeFrames),
    layers: [...layers],
  }

  const loaded = await readCheckpoint(checkpointPath)
  const checkpoint = loaded.value && typeof loaded.value === 'object' ? loaded.value : null
  const checkpointUrls = Array.isArray(checkpoint?.args?.urls)
    ? checkpoint.args.urls.map(url => String(url))
    : null
  const sameUrls = Boolean(checkpointUrls && arraysEqual(checkpointUrls, urls))
  const resumed = Boolean(checkpoint && sameUrls)
  const checkpointReset = Boolean(checkpoint && !sameUrls)

  const doneSet = new Set()
  const resultsByIndex = new Map()
  const failed = []
  const failedUrls = new Set()
  let createdAt = new Date().toISOString()

  if (resumed) {
    createdAt = checkpoint.createdAt || createdAt
    for (const url of Array.isArray(checkpoint.doneUrls) ? checkpoint.doneUrls : []) {
      if (typeof url === 'string') doneSet.add(url)
    }
    for (const item of Array.isArray(checkpoint.failed) ? checkpoint.failed : []) {
      const url = String(item?.url ?? '')
      if (!url || failedUrls.has(url)) continue
      failedUrls.add(url)
      failed.push({
        url,
        error: String(item?.error ?? ''),
        at: Number(item?.at) || Date.now(),
      })
      doneSet.add(url)
    }
    for (const result of Array.isArray(checkpoint.results) ? checkpoint.results : []) {
      if (!result || typeof result !== 'object' || typeof result.url !== 'string') continue
      const index = urls.indexOf(result.url)
      if (index < 0) continue
      resultsByIndex.set(index, result)
      doneSet.add(result.url)
    }
    // 快照可能落后于 JSONL：把日志里更新的结果补回来。
    for (const result of await readJournal(journalPath)) {
      const index = urls.indexOf(result.url)
      if (index < 0 || resultsByIndex.has(index)) continue
      resultsByIndex.set(index, result)
      doneSet.add(result.url)
    }
  } else if (checkpointReset) {
    await fs.rm(journalPath, { force: true }).catch(() => {})
  }

  function computeNextCursor() {
    for (let index = 0; index < urls.length; index += 1) {
      if (!doneSet.has(urls[index])) return index
    }
    return urls.length
  }

  function buildCheckpoint() {
    const nextCursor = computeNextCursor()
    const results = [...resultsByIndex.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, result]) => result)
    return {
      jobId,
      createdAt,
      updatedAt: new Date().toISOString(),
      args: argsSnapshot,
      nextCursor,
      doneUrls: urls.filter(url => doneSet.has(url)),
      failed: failed.filter(item => urls.includes(item.url)),
      results,
      done: nextCursor >= urls.length,
      concurrency,
      delayMs,
      render,
      deadlineMs,
      layers: [...layers],
    }
  }

  const checkpointLoadWarning = loaded.error ? `读取旧检查点失败（已新建）：${loaded.error}` : null
  let checkpointError = null
  let writeChain = Promise.resolve()
  let journalChain = Promise.resolve()
  let snapshotTimer = null
  let dirty = false

  function flushSnapshot() {
    if (!dirty) return
    dirty = false
    const payload = buildCheckpoint()
    writeChain = writeChain.then(async () => {
      try {
        await writeJsonAtomic(checkpointPath, payload)
        checkpointError = null
      } catch (error) {
        checkpointError = errorMessage(error)
      }
    })
  }

  function queueCheckpoint({ immediate = false } = {}) {
    dirty = true
    if (immediate) {
      if (snapshotTimer) {
        clearTimeout(snapshotTimer)
        snapshotTimer = null
      }
      flushSnapshot()
      return writeChain
    }
    if (snapshotTimer) return writeChain
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      flushSnapshot()
    }, 1000)
    snapshotTimer.unref?.()
    return writeChain
  }

  function appendJournal(result) {
    const line = JSON.stringify(result) + '\n'
    journalChain = journalChain.then(async () => {
      try {
        await fs.mkdir(path.dirname(journalPath), { recursive: true })
        await fs.appendFile(journalPath, line, 'utf8')
      } catch {
        /* 日志失败不阻断主流程，快照仍会落盘 */
      }
    })
    return journalChain
  }

  queueCheckpoint({ immediate: true })
  await writeChain
  if (checkpointError) {
    throw new Error(`无法写入采集检查点 ${checkpointPath}：${checkpointError}`)
  }

  const requestedCursor = Number(opts.cursor)
  const checkpointCursor = Number(checkpoint?.nextCursor)
  let startCursor = Number.isFinite(requestedCursor)
    ? Math.trunc(requestedCursor)
    : resumed && Number.isFinite(checkpointCursor)
      ? Math.trunc(checkpointCursor)
      : 0
  startCursor = Math.max(0, Math.min(startCursor, urls.length))

  const queue = []
  let scan = startCursor
  while (scan < urls.length && queue.length < PER_CALL_LIMIT) {
    const url = urls[scan]
    if (!doneSet.has(url)) queue.push({ index: scan, url })
    scan += 1
  }

  const signal = exec?.signal || null
  const deadlineAt = startedAt + deadlineMs
  function stopReason() {
    if (signal?.aborted) return 'signal'
    if (Date.now() >= deadlineAt) return 'deadline'
    return null
  }

  const newResultEntries = []
  let stoppedReason = null
  let adaptiveDelayMs = delayMs
  const markStopped = reason => {
    if (!stoppedReason) stoppedReason = reason
  }

  function recordResult(index, url, result) {
    doneSet.add(url)
    resultsByIndex.set(index, result)
    newResultEntries.push({ index, result })
    if (!result.ok) {
      failed.push({ url, error: result.error || '未知错误', at: Date.now() })
      failedUrls.add(url)
    }
    appendJournal(cloneResult(result))
    queueCheckpoint()
  }

  /** 带重试的导航：只对网络类错误重试，超时重试一次并缩短等待。 */
  async function gotoWithRetry(page, target, navTimeout) {
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        await page.goto(target, {
          waitUntil: 'domcontentloaded',
          timeout: attempt === 0 ? navTimeout : Math.min(navTimeout, 15000),
        })
        return
      } catch (error) {
        lastError = error
        const message = errorMessage(error)
        const retryable = RETRYABLE_RE.test(message)
        const timeout = /Timeout|timed out/i.test(message)
        if (!retryable || attempt === retries || (timeout && attempt >= 1)) break
        await sleep(200 * (attempt + 1))
      }
    }
    throw lastError
  }

  async function collectByHttp(item, slot, fallback) {
    const { fastFetch } = await import('./fetch.js')
    const itemStarted = Date.now()
    try {
      const response = await fastFetch(manager, {
        url: item.url,
        timeoutMs: Number(cfg.fetchTimeoutMs) || 30000,
        retries,
        maxChars: perItemChars,
      })
      const body = response.body || ''
      const blocked = response.blocked || BLOCK_RE.test(`${response.title || ''}\n${body.slice(0, 3000)}`)
      let scratch = null
      let cleaned = body
      if (useScratch) {
        const raw = response.fullBody || body
        const written = await manager.scratch.put(scratchJobId, `${item.index}-http`, raw)
        scratch = { jobId: scratchJobId, path: written.path, bytes: written.bytes }
        if (cleanScratch) cleaned = cleanHtml(raw, { maxChars: perItemChars })
      }
      // 命中风控/JS 挑战：自动回落到渲染路径，保证结果可用。
      if (blocked && fallback) return fallback()
      const result = {
        url: item.url,
        finalUrl: response.finalUrl || item.url,
        ok: response.ok,
        status: response.status,
        title: response.title || '',
        blocked,
        data: cleaned,
        preview: firstLine(cleaned, 500),
        scratch,
        chars: response.bytes || body.length,
        truncated: Boolean(response.truncated),
        error: response.ok ? null : response.error || `HTTP ${response.status}`,
        artifacts: {},
        via: 'http',
        elapsedMs: Date.now() - itemStarted,
      }
      recordResult(item.index, item.url, result)
      return { status: result.ok ? 'done' : 'failed' }
    } catch (error) {
      const result = {
        url: item.url,
        finalUrl: item.url,
        ok: false,
        title: '',
        blocked: false,
        data: null,
        preview: '',
        chars: 0,
        truncated: false,
        error: errorMessage(error),
        artifacts: {},
        via: 'http',
        elapsedMs: Date.now() - itemStarted,
      }
      recordResult(item.index, item.url, result)
      return { status: 'failed' }
    }
  }

  async function processItem(item, slot, { forceRender = false } = {}) {
    if (!render && !forceRender) {
      return collectByHttp(item, slot, () => processItem(item, slot, { forceRender: true }))
    }
    const { index, url } = item
    const itemStarted = Date.now()

    const beforeDelay = stopReason()
    if (beforeDelay) return { status: 'stopped', reason: beforeDelay }
    if (adaptiveDelayMs > 0) {
      const delayed = await sleepInterruptible(adaptiveDelayMs, stopReason)
      if (delayed) return { status: 'stopped', reason: delayed }
    }
    const beforePage = stopReason()
    if (beforePage) return { status: 'stopped', reason: beforePage }

    let page = slot.page
    let recorder = null
    const artifacts = {}
    let result = null

    try {
      if (!page || page.isClosed?.()) {
        const acquired =
          typeof manager.acquireWorkerPage === 'function'
            ? await manager.acquireWorkerPage()
            : { page: (await manager.createPage({ activate: false }))?.page, state: null, reused: false }
        page = acquired.page
        if (!page) throw new Error('没有可用的工作页（acquireWorkerPage 返回空）。')
        slot.page = page
        slot.tabId = acquired.state?.tabId ?? null
      }
      // 有窗口模式下，后台标签页会被 Chromium 挂起，SPA 可能不水合；采集时置于前台保证渲染。
      if (manager.config?.visibility && manager.config.visibility !== 'headless') {
        await page.bringToFront().catch(() => {})
      }

      if (layers.has('network')) {
        try {
          recorder = new NetworkRecorder(page, {
            maxEntries: Math.min(Number(cfg.networkMaxEntries) || 80, 100),
            maxBodyChars: Math.min(Number(cfg.networkMaxBodyChars) || 120000, 50000),
          })
          recorder.start({ includeBodies: true })
        } catch (error) {
          artifacts.networkError = `网络记录启动失败：${errorMessage(error)}`
          recorder = null
        }
      }

      const beforeNav = stopReason()
      if (beforeNav) return { status: 'stopped', reason: beforeNav }

      const target = normalizeUrl(url)
      await gotoWithRetry(page, target, Number(cfg.navigationTimeoutMs) || 45000)
      await settlePage(page, {
        selector: spec.selector || '',
        settleMs: Math.max(0, Number(cfg.collectRenderWaitMs) || 250),
      })

      let extracted
      try {
        extracted = await extractPage(page, spec)
      } catch (error) {
        // 站点先回 JS 挑战页再跳转时，首轮会“没有可提取内容”：等正文出现后重试一次。
        if (!/没有可提取|未找到匹配/.test(String(error?.message || ''))) throw error
        await waitForText(page, {
          minChars: 40,
          timeoutMs: Math.max(0, Number(cfg.collectContentTimeoutMs) || 4000),
        })
        extracted = await extractPage(page, spec)
      }

      // SSR 空壳 + 客户端水合：正文很短但 HTML 很大时，给 SPA 一点时间再抽一次。
      const thin = String(extracted.content || '').trim().length < 400
      if (thin) {
        try {
          const looksLikeSpa = await page.evaluate(() => {
            const text = String(document.body?.innerText || '').trim()
            return text.length < 400 && document.documentElement.outerHTML.length > 20000
          })
          if (looksLikeSpa === true) {
            await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
            extracted = await extractPage(page, spec)
          }
        } catch {
          /* 非标准页面（测试桩）跳过 */
        }
      }
      const title = firstLine(extracted.title || '', 180)
      const rawText =
        extracted.content ??
        (extracted.data !== null && extracted.data !== undefined
          ? JSON.stringify(extracted.data, null, 2)
          : '')
      const finalUrl = safePageUrl(page)
      const resolvedFinalUrl = finalUrl && finalUrl !== 'about:blank' ? finalUrl : url
      const blocked = BLOCK_RE.test(`${title}\n${String(rawText).slice(0, 3000)}`)

      let data = extracted.content ?? extracted.data
      const dataText =
        typeof data === 'string'
          ? data
          : data !== null && data !== undefined
            ? JSON.stringify(data, null, 2)
            : ''
      const boundedData = truncate(dataText, perItemChars, '…')
      if (typeof data === 'string' || (data !== null && data !== undefined && boundedData.truncated)) {
        data = boundedData.text
      }

      let scratch = null
      if (useScratch) {
        const raw = await page.content().catch(() => '')
        if (raw) {
          const written = await manager.scratch.put(scratchJobId, `${index}-render`, raw)
          scratch = { jobId: scratchJobId, path: written.path, bytes: written.bytes }
          if (cleanScratch && (spec.mode === 'text' || spec.mode === 'html')) {
            data = cleanHtml(raw, { maxChars: perItemChars })
          }
        }
      }

      if (layers.has('text')) {
        try {
          const layer = await textLayer(page, perItemChars)
          artifacts.text = layer.text
          if (layer.truncated) artifacts.textTruncated = true
        } catch (error) {
          artifacts.textError = errorMessage(error)
        }
      }
      if (layers.has('structure')) {
        try {
          artifacts.structure = await structureLayer(page, slot.tabId, perItemChars)
        } catch (error) {
          artifacts.structureError = errorMessage(error)
        }
      }
      if (layers.has('visual')) {
        try {
          artifacts.visual = await visualLayer(manager, page, jobId, index)
        } catch (error) {
          artifacts.visualError = errorMessage(error)
        }
      }
      if (recorder) {
        try {
          await recorder.waitForBodies(2500)
          artifacts.network = {
            entries: recorder.list({ limit: 50 }),
            har: recorder.exportHar(),
          }
        } catch (error) {
          artifacts.networkError = errorMessage(error)
        } finally {
          try {
            recorder.stop()
          } catch {
            /* ignore */
          }
        }
      }

      result = {
        url,
        finalUrl: resolvedFinalUrl,
        ok: true,
        title,
        blocked,
        data,
        scratch,
        preview: firstLine(String(rawText), 500),
        chars: String(rawText).length,
        truncated:
          Boolean(extracted.truncated) ||
          boundedData.truncated ||
          String(rawText).length > perItemChars,
        error: null,
        artifacts,
        via: 'render',
        elapsedMs: Date.now() - itemStarted,
      }
    } catch (error) {
      const failedFinalUrl = safePageUrl(page)
      const finalUrl = failedFinalUrl && failedFinalUrl !== 'about:blank' ? failedFinalUrl : url
      result = {
        url,
        finalUrl,
        ok: false,
        title: '',
        blocked: false,
        data: null,
        preview: '',
        chars: 0,
        truncated: false,
        error: errorMessage(error),
        artifacts,
        via: 'render',
        elapsedMs: Date.now() - itemStarted,
      }
      if (recorder) {
        try {
          recorder.stop()
        } catch {
          /* ignore */
        }
      }
      // 页面可能已处于坏状态：丢弃这个槽位的页面，让下一条重建。
      if (page && !page.isClosed?.()) {
        await closePageAndPopups(manager, page).catch(() => {})
        slot.page = null
      }
    }

    if (!result) {
      result = {
        url,
        finalUrl: url,
        ok: false,
        title: '',
        blocked: false,
        data: null,
        preview: '',
        chars: 0,
        truncated: false,
        error: '采集未返回结果。',
        artifacts,
        via: 'render',
        elapsedMs: Date.now() - itemStarted,
      }
    }

    if (result.blocked) {
      // 命中验证/风控：后续条目自动降速，避免整批被封。
      adaptiveDelayMs = Math.min(Math.max(adaptiveDelayMs * 2, 1500), 10000)
    }
    recordResult(index, url, result)
    return { status: result.ok ? 'done' : 'failed' }
  }

  async function worker() {
    const slot = { page: null, tabId: null }
    try {
      while (true) {
        const reason = stopReason()
        if (reason) {
          markStopped(reason)
          return
        }
        const item = queue.shift()
        if (!item) return
        const outcome = await processItem(item, slot)
        if (outcome.status === 'stopped') {
          markStopped(outcome.reason || stopReason() || 'deadline')
          return
        }
      }
    } finally {
      if (slot.page) {
        if (reusePages && typeof manager.releaseWorkerPage === 'function') {
          await manager.releaseWorkerPage(slot.page, { keep: true, max: 4 }).catch(() => {})
        } else {
          await closePageAndPopups(manager, slot.page).catch(() => {})
        }
      }
      slot.page = null
    }
  }

  const workerCount = Math.min(concurrency, queue.length)
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  queueCheckpoint({ immediate: true })
  await writeChain
  await journalChain
  if (checkpointError) {
    throw new Error(`采集检查点写入失败 ${checkpointPath}：${checkpointError}`)
  }

  let scratchCleared = false
  if (useScratch && !keepScratch) {
    try {
      await manager.scratch.clear(scratchJobId)
      scratchCleared = true
    } catch {
      scratchCleared = false
    }
  }

  const sortedResults = newResultEntries
    .sort((left, right) => left.index - right.index)
    .map(entry => entry.result)
  const nextCursor = computeNextCursor()
  const done = nextCursor >= urls.length
  const cancelled = Boolean(signal?.aborted) || stoppedReason === 'signal'
  const succeeded = sortedResults.filter(result => result.ok).length
  const failedThisCall = sortedResults.filter(result => !result.ok).length
  const blocked = sortedResults.filter(result => result.blocked).length
  const processed = urls.filter(url => doneSet.has(url)).length
  const remaining = urls.length - processed
  const totalFailed = failed.filter(item => urls.includes(item.url)).length

  let note = null
  if (!done && urls.length > PER_CALL_LIMIT) {
    note = `单次最多处理 ${PER_CALL_LIMIT} 条；本次处理到 cursor=${nextCursor}，带同一 urls 列表和 cursor=${nextCursor} 继续。`
  } else if (!done && stoppedReason === 'deadline') {
    note = `本次调用达到 deadlineMs（${deadlineMs}ms），已保存检查点；带 cursor=${nextCursor} 继续。`
  } else if (!done && cancelled) {
    note = `采集已取消，已保存检查点；带 cursor=${nextCursor} 继续。`
  }

  const payload = {
    createdAt: new Date().toISOString(),
    jobId,
    checkpointPath,
    args: argsSnapshot,
    spec,
    concurrency,
    delayMs,
    render,
    deadlineMs,
    layers: [...layers],
    nextCursor,
    done,
    cancelled,
    stoppedReason,
    count: sortedResults.length,
    succeeded,
    failed: failedThisCall,
    blocked,
    total: urls.length,
    processed,
    remaining,
    totalFailed,
    results: sortedResults.map(cloneResult),
  }

  let savedPath = null
  let saveError = null
  if (save) {
    try {
      savedPath = await manager.saveJson(payload, { prefix: 'collect' })
    } catch (error) {
      saveError = errorMessage(error)
    }
  }

  return {
    ok: true,
    jobId,
    count: sortedResults.length,
    succeeded,
    failed: failedThisCall,
    blocked,
    nextCursor,
    done,
    checkpointPath,
    journalPath,
    scratchJobId: useScratch ? scratchJobId : null,
    scratchCleared,
    savedPath,
    saveError,
    results: sortedResults,
    total: urls.length,
    processed,
    remaining,
    totalFailed,
    resumed,
    checkpointReset,
    checkpointLoadWarning,
    cancelled,
    stoppedReason,
    elapsedMs: Date.now() - startedAt,
    deadlineMs,
    concurrency,
    delayMs,
    render,
    layers: [...layers],
    duplicates,
    invalidUrls,
    note,
  }
}
