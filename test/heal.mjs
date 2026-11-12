import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'

/**
 * Windows 回归：模拟“上次崩溃留下 msedge 占着 profile”，验证启动自愈。
 * 默认跳过；设置 DSH_BROWSER_HEAL=1 后运行。
 */
const enabled = process.env.DSH_BROWSER_HEAL === '1'
if (process.platform !== 'win32' || !enabled) {
  console.log('HEAL SKIPPED: 仅在 Windows 且 DSH_BROWSER_HEAL=1 时运行')
  process.exit(0)
}

const edge = process.env.DSH_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
if (!fs.existsSync(edge)) {
  console.log(`HEAL SKIPPED: 未找到 Edge（${edge}）`)
  process.exit(0)
}

const profile = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-tool', 'profile')
const config = resolveConfig({ visibility: 'headless', userDataDir: profile })
fs.mkdirSync(profile, { recursive: true })

const stale = spawn(edge, [`--user-data-dir=${profile}`, 'about:blank'], {
  detached: true,
  stdio: 'ignore',
})
stale.unref()
await new Promise(resolve => setTimeout(resolve, 2500))
console.log('stale process started, lockfile =', fs.existsSync(path.join(profile, 'lockfile')))

const manager = new BrowserManager(config)
const started = Date.now()
let ok = false
try {
  await manager.ensure()
  ok = Boolean(manager.context)
  console.log(`HEAL OK ${Date.now() - started}ms`)
} catch (error) {
  console.error('HEAL FAIL', error?.message || error)
} finally {
  await manager.dispose().catch(() => {})
}

process.exit(ok ? 0 : 1)
