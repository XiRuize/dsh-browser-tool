import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { collectUrls } from '../lib/collect.js'
import { resolveConfig } from '../lib/config.js'

function argValue(name, fallback) {
  const prefix = `--${name}=`
  const hit = process.argv.find(arg => arg.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1]
  }
  return fallback
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

const base = argValue('url', 'https://pd.qq.com/g/iloveswufe')
const count = Math.max(1, Number(argValue('n', '20')) || 20)
const concurrency = Math.max(1, Math.min(Number(argValue('concurrency', '4')) || 4, 8))
const delayMs = Math.max(0, Number(argValue('delay', '0')) || 0)
const render = argValue('render', 'true') !== 'false'
const mode = argValue('mode', 'text')
const label = argValue('label', 'bench')

const urls = Array.from({ length: count }, (_, index) =>
  index === 0 ? base : `${base}${base.includes('?') ? '&' : '?'}bench=${index}`,
)

const profileDir = path.join(os.tmpdir(), `dsh-bench-${process.pid}`)
const config = resolveConfig({
  userDataDir: profileDir,
  artifactDir: path.join(profileDir, 'artifacts'),
  downloadsDir: path.join(profileDir, 'downloads'),
  visibility: 'headless',
  collectConcurrency: concurrency,
  collectDelayMs: delayMs,
  collectRenderWaitMs: 250,
  idleCloseMs: 0,
})
const manager = new BrowserManager(config)

const startedAt = Date.now()
let result
try {
  await manager.ensure()
  result = await collectUrls(
    manager,
    {
      urls,
      mode,
      render,
      concurrency,
      delayMs,
      save: false,
      jobId: `bench-${label}`,
      deadlineMs: 300000,
    },
    config,
  )
} finally {
  await manager.dispose().catch(() => {})
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

const elapsed = result.results.map(item => Number(item.elapsedMs) || 0)
const wall = Date.now() - startedAt
const summary = {
  label,
  render,
  count,
  concurrency,
  delayMs,
  succeeded: result.succeeded,
  failed: result.failed,
  blocked: result.blocked,
  wallMs: wall,
  throughputPerSec: Number(((result.count / wall) * 1000).toFixed(2)),
  p50Ms: percentile(elapsed, 50),
  p95Ms: percentile(elapsed, 95),
  avgMs: elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length) : 0,
  avgChars: result.results.length
    ? Math.round(result.results.reduce((sum, item) => sum + (Number(item.chars) || 0), 0) / result.results.length)
    : 0,
  blocked: result.blocked,
}

console.log(JSON.stringify(summary, null, 2))
console.log(
  `${label}: ${summary.count} 条 / ${(wall / 1000).toFixed(1)}s ｜ ${summary.throughputPerSec} 条/秒 ｜ ` +
    `P50 ${summary.p50Ms}ms ｜ P95 ${summary.p95Ms}ms ｜ 失败 ${summary.failed}`,
)
for (const item of result.results.filter(entry => !entry.ok).slice(0, 5)) {
  console.log(`FAIL ${item.url} ｜ ${item.error}`)
}
process.exitCode = summary.failed > 0 ? 2 : 0
