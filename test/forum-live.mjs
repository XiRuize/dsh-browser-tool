import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { BrowserManager } from '../lib/manager.js'
import { collectQqForum } from '../lib/adapters/qq-forum.js'
import { resolveConfig } from '../lib/config.js'

const guild = process.argv[2] || 'iloveswufe'
const limit = Number(process.argv[3] || 120)
const profileDir = path.join(os.tmpdir(), `dsh-forum-${process.pid}`)
const config = resolveConfig({
  userDataDir: profileDir,
  artifactDir: path.join(profileDir, 'artifacts'),
  downloadsDir: path.join(profileDir, 'downloads'),
  visibility: 'headless',
})
const manager = new BrowserManager(config)

const startedAt = Date.now()
let result
try {
  await manager.ensure()
  result = await collectQqForum(manager, {
    guild,
    limit,
    discover: true,
    onProgress: progress => {
      if (progress.section && progress.via === 'ssr') process.stderr.write('.')
    },
  })
} finally {
  await manager.dispose().catch(() => {})
  await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {})
}

const wall = Date.now() - startedAt
const withTinyId = result.posts.filter(post => post.author_tinyid).length
console.log(
  JSON.stringify(
    {
      guild,
      wallMs: wall,
      total: result.posts.length,
      withTinyId,
      discovered: result.stats.discovered ?? 0,
      requests: result.stats.requests,
      failed: result.stats.failed,
      duplicates: result.stats.duplicates,
      sections: result.sections.map(section => `${section.section}:${section.added}/${section.fetched}`),
    },
    null,
    2,
  ),
)
for (const post of result.posts.slice(0, 8)) {
  console.log(`- [${post.section}] ${post.author_nick} (${post.author_tinyid}) | ${post.posted_at} | ${post.text.slice(0, 40)}`)
}
process.exitCode = result.posts.length >= limit * 0.8 ? 0 : 2
