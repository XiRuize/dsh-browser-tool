import fs from 'node:fs/promises'
import path from 'node:path'

import { collectQqForum } from './adapters/qq-forum.js'
import { boundExtractResult, extractPage } from './extract.js'
import { isRecord, toInt } from './util.js'

/**
 * 站点工具注册表（借鉴 nuwa-browser 的 `site.runTool`）。
 *
 * 两类来源：
 * 1. 内置适配器：把原来写死在工具里的站点逻辑（QQ 论坛）收进注册表；
 * 2. 声明式清单：`<siteToolsDir>/<id>.json`，只描述匹配规则与提取方式，
 *    不需要写代码，适合「同一类列表页反复采」的场景。
 *
 * 清单示例：
 * {
 *   "id": "example-hr",
 *   "name": "示例招聘",
 *   "match": ["hr.example.com", "/jobs/"],
 *   "tools": {
 *     "list": {
 *       "description": "抓招聘列表",
 *       "url": "https://hr.example.com/jobs",
 *       "mode": "records",
 *       "selector": "#job-list",
 *       "itemSelector": ".job-item",
 *       "fields": { "title": "h3", "link": { "selector": "a", "attr": "href" } }
 *     }
 *   }
 * }
 */

export const BUILTIN_SITES = Object.freeze([
  {
    id: 'qq-forum',
    name: 'QQ 论坛（腾讯频道）',
    match: ['pd.qq.com'],
    source: 'builtin',
    tools: {
      collect: {
        description: '采集频道帖子：默认 SSR 快通道，可走 GetChannelTimelineFeeds 游标翻页。',
        args: ['guild', 'limit', 'paginate', 'watch', 'concurrency', 'keywords', 'discover', 'sections', 'api'],
        run: (manager, args) => collectQqForum(manager, args),
      },
    },
  },
])

const TOOL_SPEC_KEYS = ['url', 'mode', 'selector', 'container', 'itemSelector', 'labels', 'fields', 'maxChars', 'offset', 'limit']

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function normalizeMatch(value) {
  if (!Array.isArray(value)) return []
  return value
    .map(item => String(item ?? '').trim())
    .filter(Boolean)
}

/** 匹配规则：`/re/` 形式按正则，其余按不区分大小写的子串。 */
export function matchUrl(url, site) {
  const target = String(url || '')
  if (!target) return false
  for (const rule of normalizeMatch(site?.match)) {
    if (rule.length > 2 && rule.startsWith('/') && rule.endsWith('/')) {
      try {
        if (new RegExp(rule.slice(1, -1), 'i').test(target)) return true
      } catch {
        continue
      }
    } else if (target.toLowerCase().includes(rule.toLowerCase())) {
      return true
    }
  }
  return false
}

function normalizeToolSpec(raw) {
  if (!isRecord(raw)) return null
  const spec = {}
  for (const key of TOOL_SPEC_KEYS) {
    if (raw[key] !== undefined) spec[key] = raw[key]
  }
  if (spec.url !== undefined) spec.url = String(spec.url)
  if (spec.mode !== undefined) spec.mode = String(spec.mode)
  if (spec.mode === 'records' && !spec.itemSelector) return null
  return spec
}

/**
 * 校验清单。返回 { site } 或 { errors }（不抛错，交给调用方汇总）。
 */
export function normalizeManifest(raw, file = '') {
  const errors = []
  if (!isRecord(raw)) return { errors: [`${file || '清单'} 不是对象`] }
  const id = String(raw.id || '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(id)) {
    errors.push(`${file || '清单'} 的 id 非法（需字母数字开头，2-64 位）：${raw.id ?? '(空)'}`)
  }
  const match = normalizeMatch(raw.match)
  if (match.length === 0) errors.push(`${file || '清单'} 缺少 match（字符串或数组）`)
  const toolsRaw = isRecord(raw.tools) ? raw.tools : null
  if (!toolsRaw) errors.push(`${file || '清单'} 缺少 tools 对象`)
  const tools = {}
  if (toolsRaw) {
    for (const [name, spec] of Object.entries(toolsRaw)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
        errors.push(`${file || '清单'} 的工具名非法：${name}`)
        continue
      }
      const normalized = normalizeToolSpec(spec)
      if (!normalized) {
        errors.push(`${file || '清单'} 的工具 ${name} 无效（mode=records 时必须给 itemSelector）`)
        continue
      }
      tools[name] = { ...normalized, description: String(spec.description || '') }
    }
    if (Object.keys(tools).length === 0) errors.push(`${file || '清单'} 没有可用的 tools`)
  }
  if (errors.length > 0) return { errors }
  return {
    site: {
      id,
      name: String(raw.name || id),
      match,
      source: 'manifest',
      file: file || null,
      tools,
    },
  }
}

/** 读取目录里的 *.json 清单；目录不存在视为空。 */
export async function loadSiteTools(dir) {
  const sites = BUILTIN_SITES.map(site => ({ ...site }))
  const errors = []
  if (!dir) return { sites, errors }
  let entries = []
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { sites, errors }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      const { site, errors: problems } = normalizeManifest(raw, entry.name)
      if (site) sites.push(site)
      if (problems) errors.push(...problems)
    } catch (error) {
      errors.push(`${entry.name} 读取失败：${errorMessage(error)}`)
    }
  }
  return { sites, errors }
}

export function findSite(sites, siteId) {
  const id = String(siteId || '').trim().toLowerCase()
  return (sites || []).find(site => String(site.id).toLowerCase() === id) || null
}

export function matchSites(url, sites) {
  return (sites || []).filter(site => matchUrl(url, site))
}

export function describeSites(sites) {
  return (sites || []).map(site => ({
    id: site.id,
    name: site.name,
    source: site.source,
    file: site.file || null,
    match: normalizeMatch(site.match),
    tools: Object.entries(site.tools || {}).map(([name, spec]) => ({
      name,
      description: spec.description || '',
      args: Array.isArray(spec.args) ? spec.args : undefined,
    })),
  }))
}

/**
 * 运行一个站点工具。
 * - 内置：交给适配器（例如 QQ 论坛采集，不需要 page）；
 * - 清单：可选先导航到 url，再按声明式 spec 提取。
 */
export async function runSiteTool({ manager, page, sites, siteId, tool, args = {} }) {
  const site = findSite(sites, siteId)
  if (!site) {
    throw new Error(`没有找到站点工具 ${siteId}。可先调用 browser_site action=list 查看可用站点。`)
  }
  const spec = site.tools?.[tool]
  if (!spec) {
    throw new Error(`站点 ${site.id} 没有工具 ${tool}。可用：${Object.keys(site.tools || {}).join('、') || '(无)'}。`)
  }
  const input = isRecord(args) ? args : {}

  if (site.source === 'builtin') {
    const result = await spec.run(manager, input)
    return { site: site.id, tool, source: site.source, result }
  }

  if (!page || page.isClosed?.()) throw new Error(`站点 ${site.id} 的 ${tool} 需要可用的标签页。`)
  if (spec.url) {
    const url = String(spec.url)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: toInt(input.timeoutMs, 45000, 5000, 180000) })
  }
  const extractSpec = {}
  for (const key of TOOL_SPEC_KEYS) {
    if (key === 'url' || spec[key] === undefined) continue
    extractSpec[key] = spec[key]
  }
  for (const key of ['offset', 'limit']) {
    if (input[key] !== undefined) extractSpec[key] = input[key]
  }
  const result = await extractPage(page, extractSpec)
  const maxChars = toInt(input.maxChars, Number(spec.maxChars) || 30000, 1000, 200000)
  const bounded = boundExtractResult(result, maxChars)
  return {
    site: site.id,
    tool,
    source: site.source,
    url: page.url(),
    mode: bounded.mode,
    count: Array.isArray(bounded.data) ? bounded.data.length : null,
    extract: bounded,
  }
}
