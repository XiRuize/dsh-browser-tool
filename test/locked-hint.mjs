import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { BrowserManager } from '../lib/manager.js'
import { resolveConfig } from '../lib/config.js'

/**
 * Windows 回归：profile 真被占用时，错误提示必须指向「配置目录被占用」，
 * 而不是误报「未找到可用的 Edge/Chromium」。
 *
 * 做法：用一个独立的 Edge 占住 profile，再用 junction 让插件配置的路径与
 * 占位进程命令行里的路径不同（`#cleanupStaleProfile` 按命令行路径匹配，
 * 因此不会误杀占位进程），从而稳定复现真实的 ProcessSingleton 冲突。
 *
 * 默认跳过；设置 DSH_BROWSER_LOCKCHECK=1 后运行。
 */
const enabled = process.env.DSH_BROWSER_LOCKCHECK === '1'
if (process.platform !== 'win32' || !enabled) {
  console.log('LOCKCHECK SKIPPED: 仅在 Windows 且 DSH_BROWSER_LOCKCHECK=1 时运行')
  process.exit(0)
}

const { chromium } = await import('playwright-core')
const stamp = Date.now()
const realDir = path.join(os.tmpdir(), `bt-lock-real-${stamp}`)
const linkDir = path.join(os.tmpdir(), `bt-lock-link-${stamp}`)
fs.mkdirSync(realDir, { recursive: true })

let ok = false
let holder = null
let manager = null
try {
  holder = await chromium.launchPersistentContext(realDir, {
    headless: true,
    channel: process.env.DSH_BROWSER_CHANNEL || 'msedge',
    timeout: 45000,
  })
  const linked = spawnSync('cmd', ['/c', 'mklink', '/J', linkDir, realDir], { encoding: 'utf8' })
  if (linked.status !== 0) throw new Error(`创建 junction 失败：${linked.stderr || linked.stdout}`)

  manager = new BrowserManager(resolveConfig({ userDataDir: linkDir, visibility: 'headless' }))
  const started = Date.now()
  try {
    await manager.ensure()
    console.error('LOCKCHECK FAIL: 占位进程在场时不应该启动成功')
  } catch (error) {
    const elapsed = Date.now() - started
    const message = String(error?.message ?? error)
    const pointsAtLock = /配置目录可能被另一个/.test(message)
    const noFalseMissing = !/未找到可用的 Edge/.test(message)
    // 必须在工具层 90s 超时之前返回确定错误。
    const fastEnough = elapsed < 60000
    console.log(`LOCKCHECK ${elapsed}ms  lock=${pointsAtLock} noFalseMissing=${noFalseMissing} fast=${fastEnough}`)
    if (!pointsAtLock || !noFalseMissing || !fastEnough) {
      console.error(message.slice(0, 600))
    }
    ok = pointsAtLock && noFalseMissing && fastEnough
  }
} catch (error) {
  console.error('LOCKCHECK FAIL', error?.message || error)
} finally {
  await manager?.dispose().catch(() => {})
  await holder?.close().catch(() => {})
  spawnSync('cmd', ['/c', 'rmdir', linkDir], { encoding: 'utf8' })
  fs.rmSync(realDir, { recursive: true, force: true })
}

console.log(ok ? 'LOCKCHECK OK' : 'LOCKCHECK FAILED')
process.exit(ok ? 0 : 1)
