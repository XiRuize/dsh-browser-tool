import { ArtifactStore } from './artifacts.js'
import { inspectPage } from './inspect.js'
import { captureSnapshot } from './snapshot.js'

const LAYERS = new Set(['structure', 'text', 'visual', 'network', 'console', 'meta'])

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function resolvePageAndState(manager, state, args = {}) {
  if (state?.page) return { page: state.page, state }
  if (state && typeof state.isClosed === 'function') {
    return { page: state, state: { page: state, tabId: args.tab ?? null } }
  }
  throw new Error('observeLayers 需要一个标签页状态（含 page）或 Playwright Page。')
}

function normalizeLayers(value) {
  let requested = []
  if (Array.isArray(value)) requested = value
  else if (typeof value === 'string' && value.trim()) requested = value.split(/[\s,]+/)
  if (!requested.length) requested = ['structure']
  const seen = new Set()
  const layers = []
  for (const item of requested) {
    const layer = String(item ?? '').trim().toLowerCase()
    if (!layer || seen.has(layer)) continue
    if (!LAYERS.has(layer)) {
      throw new Error(`不支持的观测层：${layer}。可选：${[...LAYERS].join('、')}。`)
    }
    seen.add(layer)
    layers.push(layer)
  }
  return layers.length ? layers : ['structure']
}

function refTarget(manager, page, ref) {
  const key = String(ref ?? '').trim().replace(/^@/, '')
  if (!key) return null
  const entry = manager?.getRefs?.(page)?.get(key)
  if (!entry) {
    throw new Error(`引用 @${key} 不存在或已失效。页面可能已变化，请重新调用 browser_snapshot 或 browser_observe。`)
  }
  let locator = page
  for (const frameSelector of entry.frameChain || []) {
    locator = locator.frameLocator(frameSelector)
  }
  return locator.locator(`[data-dsh-ref="${key}"]`).first()
}

function elementTarget(manager, page, args) {
  if (args.ref) return refTarget(manager, page, args.ref)
  if (args.selector) return page.locator(String(args.selector)).first()
  return null
}

function artifactSummary(meta, layer) {
  return {
    layer,
    kind: meta.kind || 'artifact',
    path: meta.path,
    bytes: meta.bytes,
    sha256: meta.sha256 || '',
    id: meta.id || null,
    ...(meta.width != null ? { width: meta.width } : {}),
    ...(meta.height != null ? { height: meta.height } : {}),
  }
}

async function boundEntries(layer, entries, { maxChars, store, url, tabId }) {
  let used = 0
  const kept = []
  for (const entry of entries) {
    const size = JSON.stringify(entry).length + 1
    if (kept.length > 0 && used + size > maxChars) break
    kept.push(entry)
    used += size
    if (used > maxChars) break
  }
  if (kept.length === entries.length) {
    return { entries: kept, truncated: false, artifact: null }
  }
  try {
    const meta = await store.saveJson(entries, {
      kind: layer,
      prefix: `observe-${layer}`,
      layer,
      url,
      tabId,
    })
    return { entries: kept, truncated: true, savedPath: meta.path, artifact: meta }
  } catch (error) {
    return { entries: kept, truncated: true, saveError: errorMessage(error) }
  }
}

/**
 * 分层观测入口。
 *
 * @param {object} manager BrowserManager（可选：getRefs/getRecorder/getConsole/pageInfo）
 * @param {{page: object, tabId?: string}} state
 * @param {object} args { layers, selector, ref, offset, limit, maxChars, save, format }
 * @param {object} config resolveConfig() 结果
 */
export async function observeLayers(manager, state, args = {}, config = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {}
  const { page, state: tabState } = resolvePageAndState(manager, state, args)
  if (page.isClosed()) throw new Error('标签页已关闭，无法观测页面。')
  const effectiveConfig = config && Object.keys(config).length ? config : manager?.config || {}
  const layersRequested = normalizeLayers(args.layers)
  const tabId = tabState?.tabId ?? args.tab ?? null
  const selector = String(args.selector || '').trim()
  const maxChars = clampInt(
    args.maxChars,
    effectiveConfig.snapshotMaxChars || 12000,
    1000,
    200000,
  )
  const save = args.save === true
  const store = new ArtifactStore(effectiveConfig)
  const artifacts = []
  const seenPaths = new Set()
  const addArtifact = (meta, layer) => {
    if (!meta || !meta.path || seenPaths.has(meta.path)) return
    seenPaths.add(meta.path)
    artifacts.push(artifactSummary(meta, layer))
  }

  const layers = {}

  if (layersRequested.includes('structure')) {
    const snapshot = await captureSnapshot(page, tabId, {
      layer: 'structure',
      maxChars,
      maxElements: clampInt(args.maxElements, 280, 1, 1000),
      interactiveOnly: Boolean(args.interactiveOnly),
      selector,
      offset: args.offset,
      limit: args.limit,
    })
    if (snapshot.refMap instanceof Map) manager?.setRefs?.(page, snapshot.refMap)
    const { refMap: _refMap, ...publicSnapshot } = snapshot
    layers.structure = publicSnapshot
  }

  if (layersRequested.includes('text')) {
    const snapshot = await captureSnapshot(page, tabId, {
      layer: 'text',
      maxChars,
      selector,
      offset: args.offset,
      limit: args.limit,
    })
    const { refMap: _refMap, ...publicSnapshot } = snapshot
    layers.text = {
      ...publicSnapshot,
      text: publicSnapshot.text,
      length: publicSnapshot.length ?? publicSnapshot.text.length,
      nextCursor: publicSnapshot.nextCursor ?? null,
    }
  }

  if (layersRequested.includes('visual')) {
    const requestedFormat = String(args.format || '').toLowerCase()
    const format = ['jpeg', 'jpg'].includes(requestedFormat) || /\.jpe?g$/i.test(String(args.path || ''))
      ? 'jpeg'
      : 'png'
    const element = elementTarget(manager, page, args)
    const meta = await store.saveScreenshot(page, {
      requested: args.path,
      fullPage: Boolean(args.fullPage),
      format,
      element,
      url: page.url(),
      tabId,
      layer: 'visual',
      prefix: 'observe-view',
    })
    addArtifact(meta, 'visual')
    layers.visual = {
      path: meta.path,
      width: meta.width,
      height: meta.height,
      bytes: meta.bytes,
      fullPage: meta.fullPage,
      sha256: meta.sha256,
      id: meta.id,
      element: Boolean(element),
      selector: args.ref ? null : selector || null,
    }
  }

  if (layersRequested.includes('network')) {
    const recorder = manager?.getRecorder?.(page) ?? null
    const limit = clampInt(args.limit, 50, 1, 500)
    if (!recorder) {
      layers.network = {
        active: false,
        count: 0,
        entries: [],
        note: '当前标签页尚未开始网络捕获。请先调用 browser_network action=start，再触发页面请求；observe 不会自动 start。',
      }
    } else {
      let entries = []
      try {
        entries = recorder.list({ urlPattern: args.urlPattern, limit })
      } catch (error) {
        throw new Error(`读取网络记录失败：${errorMessage(error)}`)
      }
      const bounded = await boundEntries('network', entries, {
        maxChars,
        store,
        url: page.url(),
        tabId,
      })
      if (bounded.artifact) addArtifact(bounded.artifact, 'network')
      layers.network = {
        ...(typeof recorder.snapshot === 'function' ? recorder.snapshot() : {}),
        count: entries.length,
        entries: bounded.entries,
        truncated: bounded.truncated,
        ...(bounded.savedPath ? { savedPath: bounded.savedPath } : {}),
        ...(bounded.saveError ? { saveError: bounded.saveError } : {}),
      }
    }
  }

  if (layersRequested.includes('console')) {
    let entries = []
    try {
      entries = manager?.getConsole?.(page) ?? []
    } catch (error) {
      entries = []
      layers.console = { count: 0, entries: [], error: errorMessage(error) }
    }
    if (!layers.console) {
      const bounded = await boundEntries('console', entries, {
        maxChars,
        store,
        url: page.url(),
        tabId,
      })
      if (bounded.artifact) addArtifact(bounded.artifact, 'console')
      layers.console = {
        count: entries.length,
        entries: bounded.entries,
        truncated: bounded.truncated,
        ...(bounded.savedPath ? { savedPath: bounded.savedPath } : {}),
        ...(bounded.saveError ? { saveError: bounded.saveError } : {}),
        ...(entries.length ? {} : { note: '当前标签页没有 console/error 记录。' }),
      }
    }
  }

  if (layersRequested.includes('meta')) {
    try {
      const overview = await inspectPage(
        page,
        { mode: 'overview' },
        { config: effectiveConfig, manager, state: tabState },
      )
      const { mode: _mode, page: overviewPage, ...meta } = overview
      layers.meta = {
        title: overviewPage?.title ?? '',
        url: overviewPage?.url ?? page.url(),
        ...meta,
      }
    } catch (error) {
      layers.meta = { title: '', url: page.url(), error: errorMessage(error) }
    }
  }

  if (save) {
    for (const layer of layersRequested) {
      const value = layers[layer]
      if (!value) continue
      try {
        if (layer === 'visual') {
          // 截图在生成时已落盘并记录 manifest，无需重复保存。
          continue
        }
        if (layer === 'text') {
          let fullText = value.text
          if (value.truncated || value.nextCursor !== null || (value.length ?? 0) > value.text.length) {
            try {
              const full = await captureSnapshot(page, tabId, {
                layer: 'text',
                maxChars: 1000000,
                limit: 1000000,
                selector,
              })
              fullText = full.text
            } catch {
              /* 回溯失败时保存当前窗口文本 */
            }
          }
          const meta = await store.saveText(fullText, {
            kind: 'text',
            prefix: 'observe-text',
            layer: 'text',
            url: page.url(),
            tabId,
          })
          addArtifact(meta, 'text')
          continue
        }
        const meta = await store.saveJson(value, {
          kind: layer,
          prefix: `observe-${layer}`,
          layer,
          url: page.url(),
          tabId,
        })
        addArtifact(meta, layer)
      } catch (error) {
        const current = layers[layer]
        if (current && typeof current === 'object' && !Array.isArray(current)) {
          current.saveError = errorMessage(error)
        }
      }
    }
  }

  let nextCursor = null
  if (layers.text) nextCursor = layers.text.nextCursor ?? null
  else if (layers.structure) nextCursor = layers.structure.nextCursor ?? null

  let pageInfo = null
  if (typeof manager?.pageInfo === 'function' && tabState) {
    try {
      pageInfo = await manager.pageInfo(tabState)
    } catch {
      pageInfo = null
    }
  }
  pageInfo ||= {
    tab: tabId,
    url: page.url(),
    title: layers.structure?.title || layers.text?.title || layers.meta?.title || '',
    active: false,
  }

  const result = {
    ok: true,
    layers,
    artifacts,
    nextCursor,
    page: pageInfo,
    manifestPath: save || artifacts.length ? store.manifestPath : undefined,
  }
  return result
}
