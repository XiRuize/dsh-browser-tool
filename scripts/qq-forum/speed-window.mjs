import path from 'node:path'

import { BrowserManager } from '../../lib/manager.js'
import { collectUrls } from '../../lib/collect.js'
import { resolveConfig } from '../../lib/config.js'

const profile = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-tool', 'profile')
const artifact = process.env.DSH_BROWSER_ARTIFACTS || path.join(os.homedir(), '.dsh', 'browser-tool', 'artifacts')
const visibility = process.argv[2] === 'headless' ? 'headless' : 'window'
const render = process.argv[3] !== 'false'

const urls = [
  'https://pd.qq.com/g/iloveswufe?subc=714966807',
  'https://pd.qq.com/g/iloveswufe?subc=654210383',
  'https://pd.qq.com/g/iloveswufe?subc=5749913',
  'https://pd.qq.com/g/iloveswufe?subc=634804985',
  'https://pd.qq.com/g/iloveswufe?subc=5750838',
  'https://pd.qq.com/g/iloveswufe?subc=741041212',
  'https://pd.qq.com/g/iloveswufe?subc=716737185',
  'https://pd.qq.com/g/iloveswufe?subc=662315276',
  'https://pd.qq.com/g/iloveswufe?subc=38984169',
  'https://pd.qq.com/g/iloveswufe?subc=38984591',
  'https://pd.qq.com/g/iloveswufe?subc=495011466',
  'https://pd.qq.com/g/iloveswufe?subc=38984057',
  'https://pd.qq.com/g/iloveswufe?subc=718991315',
]

const config = resolveConfig({
  userDataDir: profile,
  artifactDir: artifact,
  downloadsDir: path.join(artifact, 'downloads'),
  visibility,
  collectConcurrency: 4,
  collectDelayMs: 0,
  collectRenderWaitMs: 250,
})
const manager = new BrowserManager(config)
const startedAt = Date.now()
let result
try {
  await manager.ensure()
  result = await collectUrls(
    manager,
    { urls, mode: 'html', render, concurrency: 4, delayMs: 0, save: false, jobId: `speed-${visibility}-${render}-${Date.now()}` },
    config,
  )
} finally {
  await manager.dispose().catch(() => {})
}

const wall = Date.now() - startedAt
const per = result.results.map(item => Number(item.elapsedMs) || 0).sort((a, b) => a - b)
const p = q => per[Math.min(per.length - 1, Math.max(0, Math.ceil((q / 100) * per.length) - 1))] || 0
console.log(
  JSON.stringify(
    {
      visibility,
      render,
      count: result.count,
      succeeded: result.succeeded,
      failed: result.failed,
      wallMs: wall,
      throughputPerSec: Number(((result.count / wall) * 1000).toFixed(2)),
      p50Ms: p(50),
      p95Ms: p(95),
      avgChars: Math.round(result.results.reduce((sum, item) => sum + (Number(item.chars) || 0), 0) / result.results.length),
    },
    null,
    2,
  ),
)
