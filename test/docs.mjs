import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const read = file => fs.readFile(path.join(root, file), 'utf8')

const pkg = JSON.parse(await read('package.json'))
const version = String(pkg.version)
const readme = await read('README.md')
const readmeEn = await read('README.en.md')
const toolsDoc = await read('docs/tools.md')
const changelog = await read('CHANGELOG.md')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  if (!ok) console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
}

check('package.json version 是 semver', /^\d+\.\d+\.\d+$/.test(version), version)
check('README.md 状态徽章与版本一致', readme.includes(`status-${version}`), `期望 status-${version}`)
check('README.md 声明 20 个工具', readme.includes('20 个工具'))
check('README.en.md 声明 20 tools', readmeEn.includes('20 tools'))
check('README.en.md 徽章与版本一致', readmeEn.includes(`status-${version}`))
check('docs/tools.md 声明 20 个工具', toolsDoc.includes('20 个工具'))
check('CHANGELOG 含当前版本小节', changelog.includes(`— ${version}`), `期望 — ${version}`)
check('npm scripts.test 存在', pkg.scripts?.test === 'node test/unit.mjs')
check('npm scripts.verify:docs 存在', pkg.scripts?.['verify:docs'] === 'node test/docs.mjs')

const failed = checks.filter(item => !item.ok)
console.log(`DOCS RESULT ${checks.length - failed.length}/${checks.length} PASS`)
process.exit(failed.length > 0 ? 1 : 0)
