import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { extractPage } from './extract.js'
import { NetworkRecorder } from './network.js'
import { captureSnapshot } from './snapshot.js'
import { firstLine, normalizeUrl, sleep, truncate } from './util.js'

const PER_CALL_LIMIT = 20
const MAX_URLS = 100
const DEFAULT_MAX_CHARS = 8000
const DEFAULT_DEADLINE_MS = 120000
const MAX_DEADLINE_MS = 300000
const ALLOWED_MODES = new Set(['text', 'html', 'links', 'tables', 'labeled', 'structured'])
const ALLOWED_LAYERS = new Set(['text', 'structure', 'visual', 'network'])
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
 * 可续跑批量采集（v0.2）。
 *
 * - 后台标签页 + worker 池，不调用 bringToFront。
 * - 每个 URL 只处理一次，结果实时写入原子 checkpoint。
 * - 单次最多处理 20 条；超过时返回 nextCursor，调用方带同一 urls 继续。
 * - deadlineMs 或 exec.signal 触发时先落 checkpoint，再返回已完成的局部结果。
 *
 * @param {object} manager BrowserManager 门面
 * @param {object} args 采集参数
 * @param {object} config resolveConfig() 结果
 * @param {{signal?: AbortSignal, agent?: {id?: string}}} [exec]
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
    throw new Error(`不支持的提取模式：${mode}。可用：text、html、links、tables、labeled、structured。`)
  }
  if (mode === 'labeled') {
    const labels = Array.isArray(opts.labels) ? opts.labels.filter(label => typeof label === 'string' && label.trim()) : []
    if (labels.length === 0) throw new Error('mode=labeled 时必须提供 labels 数组。')
  }
  if (mode === 'structured') {
    if (!opts.fields || typeof opts.fields !== 'object' || Array.isArray(opts.fields)) {
      throw new Error('mode=structured 时必须提供 fields 对象。')
    }
  }

  const spec = buildSpec({ ...opts, mode })
  const perItemChars = intValue(opts.maxChars, DEFAULT_MAX_CHARS, 500, 50000)
  const limit = intValue(opts.limit, 200, 1, 1000)
  spec.limit = limit
  const concurrency = intValue(opts.concurrency, cfg.collectConcurrency || 2, 1, 4)
  const delayMs = intValue(opts.delayMs, cfg.collectDelayMs ?? 800, 0, 10000)
  const deadlineMs = intValue(opts.deadlineMs, DEFAULT_DEADLINE_MS, 100, MAX_DEADLINE_MS)
  const layers = normalizeLayers(opts.layers)
  const save = opts.save !== false
  const jobId = safeToken(opts.jobId || deriveJobId(urls, mode, opts.selector)) || 'collect'
  const checkpointPath = resolveCheckpointPath(
    opts.checkpointPath,
    artifactDirOf(cfg, manager),
    jobId,
  )

  const argsSnapshot = {
    urls: [...urls],
    mode,
    selector: opts.selector || '',
    labels: Array.isArray(opts.labels) ? opts.labels : [],
    fields: opts.fields && typeof opts.fields === 'object' ? opts.fields : {},
    maxChars: perItemChars,
    limit,
    concurrency,
    delayMs,
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
      deadlineMs,
      layers: [...layers],
    }
  }

  const checkpointLoadWarning = loaded.error ? `读取旧检查点失败（已新建）：${loaded.error}` : null
  let checkpointError = null
  let writeChain = Promise.resolve()
  function queueCheckpoint() {
    const payload = buildCheckpoint()
    writeChain = writeChain.then(async () => {
      try {
        await writeJsonAtomic(checkpointPath, payload)
        checkpointError = null
      } catch (error) {
        checkpointError = errorMessage(error)
      }
    })
    return writeChain
  }

  queueCheckpoint()
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
    queueCheckpoint()
  }

  async function processItem(item) {
    const { index, url } = item
    const itemStarted = Date.now()

    const beforeDelay = stopReason()
    if (beforeDelay) return { status: 'stopped', reason: beforeDelay }
    if (delayMs > 0) {
      const delayed = await sleepInterruptible(delayMs, stopReason)
      if (delayed) return { status: 'stopped', reason: delayed }
    }
    const beforePage = stopReason()
    if (beforePage) return { status: 'stopped', reason: beforePage }

    let state = null
    let page = null
    let recorder = null
    const artifacts = {}
    let result = null
    let stopped = false

    try {
      state = await manager.createPage({ activate: false })
      page = state?.page || null
      if (!page) throw new Error('manager.createPage 没有返回页面对象。')

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
      if (beforeNav) {
        stopped = true
        return { status: 'stopped', reason: beforeNav }
      }

      const target = normalizeUrl(url)
      await page.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: Number(cfg.navigationTimeoutMs) || 45000,
      })
      const renderWaitMs = Math.max(0, Number(cfg.collectRenderWaitMs) || 700)
      if (renderWaitMs > 0) await sleep(renderWaitMs)
      if (typeof page.waitForLoadState === 'function') {
        await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {})
      }

      const extracted = await extractPage(page, spec)
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
          artifacts.structure = await structureLayer(page, state?.tabId, perItemChars)
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
        preview: firstLine(String(rawText), 500),
        chars: String(rawText).length,
        truncated:
          Boolean(extracted.truncated) ||
          boundedData.truncated ||
          String(rawText).length > perItemChars,
        error: null,
        artifacts,
        elapsedMs: Date.now() - itemStarted,
      }
    } catch (error) {
      if (stopped) return { status: 'stopped', reason: stopReason() || 'deadline' }
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
        elapsedMs: Date.now() - itemStarted,
      }
    } finally {
      if (recorder) {
        try {
          recorder.stop()
        } catch {
          /* ignore */
        }
      }
      await closePageAndPopups(manager, page)
    }

    if (stopped) return { status: 'stopped', reason: stopReason() || 'deadline' }
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
        elapsedMs: Date.now() - itemStarted,
      }
    }
    recordResult(index, url, result)
    return { status: result.ok ? 'done' : 'failed' }
  }

  async function worker() {
    while (true) {
      const reason = stopReason()
      if (reason) {
        markStopped(reason)
        return
      }
      const item = queue.shift()
      if (!item) return
      const outcome = await processItem(item)
      if (outcome.status === 'stopped') {
        markStopped(outcome.reason || stopReason() || 'deadline')
        return
      }
    }
  }

  const workerCount = Math.min(concurrency, queue.length)
  if (workerCount > 0) {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  await writeChain
  if (checkpointError) {
    throw new Error(`采集检查点写入失败 ${checkpointPath}：${checkpointError}`)
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
    layers: [...layers],
    duplicates,
    invalidUrls,
    note,
  }
}
