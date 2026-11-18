import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { ensureDir } from './util.js'

/**
 * 内容缓存（0.8）：按「URL + 提取规格」内容寻址，减少重复抓取与重复解析。
 *
 * - 命中直接返回，附带 `cached:true` 与 `ageMs`；`refresh:true` 可强制绕过；
 * - TTL 与总容量双上限，写满时按 mtime 淘汰最旧条目；
 * - 只缓存 GET 的 2xx 文本/JSON，且不缓存带 Authorization 的请求与 `no-store` 响应。
 */

export const CACHE_TTL_DEFAULT_MS = 60 * 60 * 1000
export const CACHE_MAX_BYTES_DEFAULT = 512 * 1024 * 1024
const CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024
const CACHE_PRUNE_INTERVAL_MS = 60 * 1000

function hashOf(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/** 稳定序列化：对象键排序，避免同义 spec 生成不同 key。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

export class ContentCache {
  constructor(config = {}) {
    this.dir = String(config.cacheDir || '')
    this.ttlMs = Math.max(1000, Number(config.cacheTtlMs) || CACHE_TTL_DEFAULT_MS)
    this.maxBytes = Math.max(1024 * 1024, Number(config.cacheMaxBytes) || CACHE_MAX_BYTES_DEFAULT)
    this.enabled = config.cacheEnabled !== false && Boolean(this.dir)
    this.lastPruneAt = 0
    this.hits = 0
    this.misses = 0
    this.writes = 0
    this.pruned = 0
  }

  /** 生成缓存键：kind + url + 规格。 */
  key(kind, url, spec = {}) {
    return hashOf(`${kind}\n${url}\n${stableStringify(spec)}`)
  }

  pathOf(key) {
    return path.join(this.dir, key.slice(0, 2), `${key}.json`)
  }

  async get(key) {
    if (!this.enabled) return null
    try {
      const raw = await fs.readFile(this.pathOf(key), 'utf8')
      const entry = JSON.parse(raw)
      const ageMs = Date.now() - Number(entry.fetchedAt || 0)
      if (!entry.body && entry.body !== '') return null
      if (ageMs > (Number(entry.ttlMs) || this.ttlMs)) {
        this.misses += 1
        return null
      }
      this.hits += 1
      return { ...entry, ageMs }
    } catch {
      this.misses += 1
      return null
    }
  }

  async put(key, { body, url = '', kind = '', spec = {}, meta = {} } = {}) {
    if (!this.enabled) return false
    const text = String(body ?? '')
    if (Buffer.byteLength(text, 'utf8') > CACHE_MAX_ENTRY_BYTES) return false
    try {
      await ensureDir(path.join(this.dir, key.slice(0, 2)))
      const entry = {
        key,
        url,
        kind,
        specHash: hashOf(stableStringify(spec)),
        fetchedAt: Date.now(),
        ttlMs: this.ttlMs,
        ...meta,
        body: text,
      }
      await fs.writeFile(this.pathOf(key), JSON.stringify(entry), 'utf8')
      this.writes += 1
      void this.prune().catch(() => {})
      return true
    } catch {
      return false
    }
  }

  /** 按容量淘汰：不会删除仍在 TTL 内的条目？会——容量优先，最旧先删。 */
  async prune({ force = false } = {}) {
    if (!this.enabled) return { removed: 0, keep: 0 }
    const now = Date.now()
    if (!force && now - this.lastPruneAt < CACHE_PRUNE_INTERVAL_MS) return { removed: 0, keep: 0 }
    this.lastPruneAt = now
    const entries = []
    let total = 0
    const walk = async dir => {
      let items = []
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) await walk(full)
        else if (item.isFile() && item.name.endsWith('.json')) {
          try {
            const stat = await fs.stat(full)
            entries.push({ full, size: stat.size, mtimeMs: stat.mtimeMs })
            total += stat.size
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(this.dir)
    let removed = 0
    if (total > this.maxBytes) {
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const entry of entries) {
        if (total <= this.maxBytes * 0.9) break
        try {
          await fs.rm(entry.full, { force: true })
          total -= entry.size
          removed += 1
        } catch {
          /* ignore */
        }
      }
    }
    this.pruned += removed
    return { removed, keep: entries.length - removed, bytes: total }
  }

  async clear() {
    if (!this.enabled) return { removed: 0 }
    let removed = 0
    const walk = async dir => {
      let items = []
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) await walk(full)
        else if (item.isFile()) {
          try {
            await fs.rm(full, { force: true })
            removed += 1
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(this.dir)
    return { removed }
  }

  async stats() {
    let bytes = 0
    let files = 0
    const walk = async dir => {
      let items = []
      try {
        items = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = path.join(dir, item.name)
        if (item.isDirectory()) await walk(full)
        else if (item.isFile()) {
          try {
            bytes += (await fs.stat(full)).size
            files += 1
          } catch {
            /* ignore */
          }
        }
      }
    }
    await walk(this.dir)
    return {
      enabled: this.enabled,
      dir: this.dir,
      files,
      bytes,
      maxBytes: this.maxBytes,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      pruned: this.pruned,
    }
  }
}

/** 是否值得缓存：GET、2xx、文本/JSON、未被 no-store 标记。 */
export function cacheableResponse({ method = 'GET', status = 200, headers = {}, body = '', requestHeaders = {} } = {}) {
  if (String(method).toUpperCase() !== 'GET') return false
  if (status < 200 || status >= 300) return false
  if (requestHeaders.authorization || requestHeaders.Authorization) return false
  const cacheControl = String(headers['cache-control'] || headers['Cache-Control'] || '').toLowerCase()
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false
  if (body === '' || body === undefined || body === null) return false
  return Buffer.byteLength(String(body), 'utf8') <= CACHE_MAX_ENTRY_BYTES
}
