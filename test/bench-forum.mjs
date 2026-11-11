import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { collectQqForum } from '../lib/adapters/qq-forum.js'
import { resolveConfig } from '../lib/config.js'

const profile = process.env.DSH_BROWSER_PROFILE || path.join(os.homedir(), '.dsh', 'browser-tool', 'profile')
const artifact = process.env.DSH_BROWSER_ARTIFACTS || path.join(os.homedir(), '.dsh', 'browser-tool', 'artifacts')
const mode = process.argv[2] || 'pilot' // pilot | full
const limit = Number(process.argv[3] || 100)
const concurrency = Number(process.argv[4] || 3)

const SECTIONS = {
  全部: '634804985',
  热门: 'hot',
  柳林: '654210383',
  光华: '714966807',
  树洞: '5749913',
  情感: '5750838',
  选课: '741041212',
  二手: '38984169',
  校宠: '716737185',
  摄影: '662315276',
  影音: '495011466',
  失物: '38984591',
  拼车: '38984057',
  防骗: '718991315',
}

const names = mode === 'full' ? Object.keys(SECTIONS) : ['二手', '光华', '柳林']
const sections = names.map(name => ({ name, subc: SECTIONS[name] }))

const config = resolveConfig({
  userDataDir: profile,
  artifactDir: artifact,
  visibility: 'headless',
})
const manager = new BrowserManager(config)
const startedAt = Date.now()
let result
try {
  await manager.ensure()
  result = await collectQqForum(manager, {
    guild: 'iloveswufe',
    sections,
    paginate: true,
    limit,
    concurrency,
  })
} finally {
  await manager.dispose().catch(() => {})
}

const wall = Date.now() - startedAt
const outDir = path.join(os.tmpdir(), `qq-forum-bench-${process.pid}`)
await fs.mkdir(outDir, { recursive: true })
await fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8').catch(() => {})

console.log(
  JSON.stringify(
    {
      mode,
      sections: sections.length,
      perSection: limit,
      total: result.posts.length,
      withTinyId: result.posts.filter(post => post.author_tinyid).length,
      requests: result.stats.requests,
      failed: result.stats.failed,
      backoffs: result.stats.backoffs || 0,
      wallMs: wall,
      perSectionMs: Math.round(wall / sections.length),
      throughputPerSec: Number(((result.posts.length / wall) * 1000).toFixed(1)),
    },
    null,
    2,
  ),
)
