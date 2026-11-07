import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, safeName, timestampName } from './util.js'

const MANIFEST_NAME = 'manifest.jsonl'
const MAX_NAME = 80

function normalizeExt(ext, fallback = '.txt') {
  const value = String(ext || fallback).trim()
  if (!value) return fallback
  return value.startsWith('.') ? value : `.${value}`
}

function isInside(baseDir, target) {
  const relative = path.relative(baseDir, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function nextId() {
  return `a-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

/** 从 PNG/JPEG 头里读取尺寸；读不出时返回 null，不影响图片本身。 */
export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null
  // PNG: signature 8 bytes + IHDR length/type 8 bytes，宽高在 16..23。
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    try {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    } catch {
      return null
    }
  }
  // JPEG: 扫描 SOFn 段。
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = buffer[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = buffer.readUInt16BE(offset + 2)
      if (length < 2) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        try {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          }
        } catch {
          return null
        }
      }
      offset += 2 + length
    }
  }
  return null
}

/**
 * 产物仓库（observe/inspect 共用）。
 *
 * - 相对路径一律解析到 `config.artifactDir` 内，并拒绝 `..` 越界。
 * - `config.allowAbsoluteArtifacts !== true` 时拒绝任何绝对路径。
 * - 写入采用 tmp + rename，最后追加 manifest.jsonl 一行。
 */
export class ArtifactStore {
  constructor(config = {}) {
    this.config = config || {}
    const fallback = path.join(os.homedir(), '.dsh', 'browser-tool', 'artifacts')
    this.baseDir = path.resolve(String(this.config.artifactDir || fallback))
    this.manifestFile = path.join(this.baseDir, MANIFEST_NAME)
  }

  /** manifest.jsonl 的绝对路径。 */
  get manifestPath() {
    return this.manifestFile
  }

  /**
   * 解析产物路径。requested 为空时按时间戳生成文件名。
   * @param {string} [requested]
   * @param {{ext?: string, prefix?: string, fallbackExt?: string}} [opts]
   * @returns {Promise<string>}
   */
  async path(requested, { ext = '.txt', prefix = 'artifact', fallbackExt } = {}) {
    await ensureDir(this.baseDir)
    const extName = normalizeExt(ext, fallbackExt || '.txt')
    const text = String(requested ?? '').trim()
    if (!text) {
      return path.join(this.baseDir, timestampName(safeName(prefix, 'artifact'), extName))
    }

    const absolute = path.isAbsolute(text)
    if (absolute && this.config.allowAbsoluteArtifacts !== true) {
      throw new Error(
        `产物路径越界：拒绝使用绝对路径 ${text}。请传相对路径，或在插件配置中显式设置 allowAbsoluteArtifacts: true。`,
      )
    }

    let resolved
    if (absolute) {
      const dir = path.dirname(path.resolve(text))
      resolved = path.join(dir, safeName(path.basename(text), `artifact${extName}`))
    } else {
      resolved = path.resolve(this.baseDir, text)
      if (!isInside(this.baseDir, resolved)) {
        throw new Error(`产物路径越出了配置目录 ${this.baseDir}：${text}。`)
      }
      const relative = path.relative(this.baseDir, resolved)
      const parts = relative.split(path.sep).filter(Boolean)
      if (parts.length === 0) {
        resolved = path.join(this.baseDir, timestampName(safeName(prefix, 'artifact'), extName))
      } else {
        const safeParts = parts.map(part => safeName(part, 'artifact').slice(0, MAX_NAME))
        resolved = path.join(this.baseDir, ...safeParts)
      }
    }

    if (!path.extname(resolved)) resolved += extName
    await ensureDir(path.dirname(resolved))
    return resolved
  }

  async #write(filePath, buffer, meta = {}) {
    const target = path.resolve(filePath)
    if (this.config.allowAbsoluteArtifacts !== true && !isInside(this.baseDir, target)) {
      throw new Error(`产物路径越出了配置目录 ${this.baseDir}：${target}。`)
    }
    await ensureDir(path.dirname(target))
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    const tmp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`
    try {
      await fs.writeFile(tmp, payload)
      await fs.rename(tmp, target)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw error
    }
    return this.record({
      ...meta,
      kind: meta.kind || 'artifact',
      path: target,
      bytes: payload.length,
      sha256: meta.sha256 || sha256(payload),
    })
  }

  /** 写入 UTF-8 文本并记录 manifest。 */
  async saveText(text, opts = {}) {
    const filePath = await this.path(opts.requested ?? opts.path, {
      ext: opts.ext || '.txt',
      prefix: opts.prefix || 'text',
    })
    return this.#write(filePath, Buffer.from(String(text ?? ''), 'utf8'), {
      ...opts,
      kind: opts.kind || 'text',
    })
  }

  /** 写入 JSON（2 空格缩进），返回 manifest 条目。 */
  async saveJson(value, opts = {}) {
    let text
    try {
      text = JSON.stringify(value, null, 2)
    } catch (error) {
      text = JSON.stringify({ error: `JSON 序列化失败：${error instanceof Error ? error.message : String(error)}` })
    }
    return this.saveText(text, { ...opts, ext: opts.ext || '.json', kind: opts.kind || 'json' })
  }

  /** 写入任意二进制 buffer。 */
  async saveBuffer(buffer, opts = {}) {
    const filePath = await this.path(opts.requested ?? opts.path, {
      ext: opts.ext || '.bin',
      prefix: opts.prefix || 'buffer',
    })
    return this.#write(filePath, buffer, { ...opts, kind: opts.kind || 'buffer' })
  }

  /**
   * 截图保存。element 传入 Playwright Locator 时截取元素，否则截取页面。
   * @returns {Promise<{path:string,width:number|null,height:number|null,bytes:number,fullPage:boolean,sha256:string,id:string}>}
   */
  async saveScreenshot(page, opts = {}) {
    const format = String(opts.format || '').toLowerCase() === 'jpeg' || String(opts.format || '').toLowerCase() === 'jpg'
      ? 'jpeg'
      : 'png'
    const ext = format === 'jpeg' ? '.jpg' : '.png'
    const filePath = await this.path(opts.requested ?? opts.path, {
      ext,
      prefix: opts.prefix || 'shot',
    })
    const screenshotOptions = {
      type: format,
      timeout: opts.timeout,
      animations: opts.animations || 'disabled',
    }
    if (opts.fullPage) screenshotOptions.fullPage = true
    const element = opts.element || null
    const buffer = element
      ? await element.screenshot({ ...screenshotOptions, fullPage: undefined })
      : await page.screenshot(screenshotOptions)
    const size = imageSize(buffer)
    const meta = await this.#write(filePath, buffer, {
      ...opts,
      kind: opts.kind || 'screenshot',
    })
    return {
      ...meta,
      width: size?.width ?? null,
      height: size?.height ?? null,
      fullPage: Boolean(opts.fullPage) && !element,
    }
  }

  /** 追加一条 manifest 记录。 */
  async record(meta = {}) {
    await ensureDir(this.baseDir)
    const known = {
      id: meta.id || nextId(),
      kind: meta.kind || 'artifact',
      path: meta.path ? path.resolve(String(meta.path)) : '',
      bytes: Number(meta.bytes) || 0,
      sha256: meta.sha256 || '',
      url: meta.url || '',
      tabId: meta.tabId ?? null,
      createdAt: meta.createdAt || new Date().toISOString(),
    }
    const extras = { ...meta }
    for (const key of Object.keys(known)) delete extras[key]
    const entry = { ...known, ...extras }
    await fs.appendFile(this.manifestFile, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  }
}
