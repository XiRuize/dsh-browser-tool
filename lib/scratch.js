import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 临时暂存区：浏览器只负责把原始内容落盘，清洗/解析在文件层完成，
 * 最后按 TTL 或显式 clear 删除，避免大内容反复穿过模型上下文。
 *
 * 目录结构：
 *   <scratchDir>/<jobId>/<seq>-<name>.raw
 *   <scratchDir>/<jobId>/manifest.json
 */
export class ScratchStore {
  constructor({ dir, ttlMs = 3600_000, maxBytes = 512 * 1024 * 1024 } = {}) {
    this.dir = dir
    this.ttlMs = Math.max(60_000, Number(ttlMs) || 3600_000)
    this.maxBytes = Math.max(1_048_576, Number(maxBytes) || 512 * 1024 * 1024)
    this.seq = 0
  }

  static jobId(prefix = 'job') {
    const stamp = Date.now().toString(36)
    const rand = crypto.randomBytes(4).toString('hex')
    return `${prefix}-${stamp}-${rand}`
  }

  #jobDir(jobId) {
    const safe = String(jobId || '').replace(/[^A-Za-z0-9._-]/g, '-')
    if (!safe) throw new Error('scratch 需要合法的 jobId。')
    return path.join(this.dir, safe)
  }

  async ensure(jobId) {
    const dir = this.#jobDir(jobId)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  /** 写入一块原始内容，返回 { path, bytes }。 */
  async put(jobId, name, content) {
    const dir = await this.ensure(jobId)
    this.seq += 1
    const safeName = String(name || 'content').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)
    const file = path.join(dir, `${String(this.seq).padStart(4, '0')}-${safeName}.raw`)
    const text = String(content ?? '')
    await fs.writeFile(file, text, 'utf8')
    return { path: file, bytes: Buffer.byteLength(text, 'utf8') }
  }

  async read(filePath) {
    const resolved = path.resolve(String(filePath))
    if (!resolved.startsWith(path.resolve(this.dir) + path.sep)) {
      throw new Error(`拒绝读取暂存区之外的路径：${filePath}`)
    }
    return fs.readFile(resolved, 'utf8')
  }

  async list(jobId) {
    const dir = this.#jobDir(jobId)
    let entries = []
    try {
      entries = await fs.readdir(dir)
    } catch {
      return []
    }
    const files = []
    for (const name of entries) {
      if (name === 'manifest.json' || name.endsWith('.tmp')) continue
      const full = path.join(dir, name)
      const stat = await fs.stat(full).catch(() => null)
      if (!stat || !stat.isFile()) continue
      files.push({ name, path: full, bytes: stat.size, mtime: stat.mtimeMs })
    }
    return files.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** 一次性读出某个 job 的全部内容（清洗阶段用）。 */
  async readAll(jobId) {
    const files = await this.list(jobId)
    const chunks = []
    for (const file of files) chunks.push({ name: file.name, text: await fs.readFile(file.path, 'utf8') })
    return chunks
  }

  async clear(jobId) {
    const dir = this.#jobDir(jobId)
    await fs.rm(dir, { recursive: true, force: true })
    return { cleared: jobId }
  }

  async stats() {
    const jobs = []
    let totalBytes = 0
    let names = []
    try {
      names = await fs.readdir(this.dir)
    } catch {
      return { dir: this.dir, jobs: [], totalBytes: 0 }
    }
    for (const name of names) {
      const dir = path.join(this.dir, name)
      const stat = await fs.stat(dir).catch(() => null)
      if (!stat || !stat.isDirectory()) continue
      const files = await this.list(name)
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
      totalBytes += bytes
      jobs.push({ jobId: name, files: files.length, bytes, updatedAt: stat.mtimeMs })
    }
    return { dir: this.dir, jobs: jobs.sort((a, b) => b.updatedAt - a.updatedAt), totalBytes }
  }

  /** 清理超时任务；超过总容量时从最旧的开始删。 */
  async prune({ now = Date.now() } = {}) {
    const { jobs, totalBytes } = await this.stats()
    const removed = []
    let remaining = totalBytes
    for (const job of jobs) {
      const expired = now - job.updatedAt > this.ttlMs
      const overBudget = remaining > this.maxBytes
      if (!expired && !overBudget) continue
      await this.clear(job.jobId).catch(() => {})
      remaining -= job.bytes
      removed.push(job.jobId)
    }
    return { removed, remainingBytes: Math.max(0, remaining) }
  }
}
