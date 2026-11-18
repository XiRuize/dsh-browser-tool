# 模块接口契约（v0.2）

本文件是多个实现子代理之间的协作契约。**先读本文件，再读自己负责的旧代码**。只修改自己拥有的文件；需要别人的文件时，在报告里提出，不要直接改。

## 文件所有权

| 模块 | 拥有文件 |
|---|---|
| core-host | `lib/config.js`、`lib/host.js`、`lib/manager.js`（初版薄门面）、`index.js`、`cordis.patch.yml` |
| pages-workspaces | `lib/manager.js`、`lib/pages.js`、`lib/workspace.js`、`lib/locks.js` |
| observe-inspect | `lib/snapshot.js`、`lib/observe.js`、`lib/inspect.js`、`lib/artifacts.js`、`lib/console.js` |
| act-extract | `lib/act.js`、`lib/extract.js` |
| network-collect | `lib/network.js`、`lib/collect.js` |
| tools-surface | `lib/tools.js`、`lib/util.js` |
| docs-repo | `README*.md`、`LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/**`、`skills/**`、`.github/**`、`.gitignore` |
| tests-verify | `test/**` |
| install-verify | 只读代码；安装与验证记录写入 `docs/install-verification.md`（若 docs 模块未创建则自己创建） |

`package.json` 由 core-host 修改版本/描述；tools-surface 只在确有新增导出时改 `files`/`exports`；install-verify 不改源码。

## 共享配置对象（`lib/config.js`）

`resolveConfig(raw)` 返回普通对象，至少包含：

```js
{
  mode: 'launch' | 'cdp',
  channel, executablePath, cdpUrl,
  userDataDir, artifactDir, downloadsDir,
  visibility: 'headless' | 'offscreen' | 'window',
  locale, timezoneId,
  actionTimeoutMs, navigationTimeoutMs,
  launchTimeoutMs, launchDeadlineMs,
  snapshotMaxChars, extractMaxChars,
  collectConcurrency, collectDelayMs, collectRenderWaitMs,
  idleCloseMs, watchdogIntervalMs, autoRelaunch,
  maxTabs, maxIdleTabs, idleTabMs,
  actionHud, actionHudTtlMs,
  siteToolsDir,
  allowEval, allowAbsoluteArtifacts,
  networkMaxEntries, networkMaxBodyChars
}
```

硬性默认值：`visibility='headless'`、`idleCloseMs=0`、`watchdogIntervalMs=30000`、`autoRelaunch=true`、`maxTabs=24`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`actionHud=true`、`actionHudTtlMs=4000`、`launchTimeoutMs=30000`、`launchDeadlineMs=55000`。`headless` 只作为兼容别名，最终看 `visibility`。启动总预算应小于工具层超时（快照 45000、截图/网络 60000、`browser_open` 90000），否则调用会先被工具层中止而底层启动仍在继续。

## `BrowserHost`（`lib/host.js`）

```js
export class BrowserHost extends EventEmitter {
  constructor(config)
  config
  context           // 当前 BrowserContext 或 null
  browser           // 当前 Browser 或 null
  async ensure()    // 启动/复用；失败抛出带中文提示的 Error
  async close(reason)
  async dispose()
  status()          // { loaded, connected, mode, visibility, browserVersion, pages, launchedAt, restartCount, lastError }
  async artifactPath(requested, { ext, prefix })
  async downloadPath(requested, suggestedName)
}
```

事件：`launched`（`{ context, browser }`）、`page`（`page`）、`disconnected`（`reason`）、`recovered`（`{ attempt }`）。`ensure()` 在已断开时自动重启一次；重启后重新发出 `launched`。**禁止调用 `page.bringToFront()`，除非调用方显式要求可见。**

## 多步批处理与显性表示（`lib/batch.js`、`lib/hud.js`）

```js
// batch.js
export const BATCH_ACTIONS         // act 的全部动作 + 'extract'
export function normalizeSteps(value, { maxSteps = 50 })   // 校验/规范化，错误为中文
export async function runBatch(manager, state, steps, { config, exec, stopOnError = true, timeoutMs = 120000 })
// 成功: { ok: true, steps, extract, ms }
// 失败: throw Error，error.batch = { steps, extract, failedAt, ms }（已完成步骤不得丢弃）

// hud.js（可见模式的页面角标，headless 自动跳过）
export function hudText({ label, step, total, tone })       // 'DSH · 2/5 · 翻页'
export function shouldShowHud({ config, url, closed })      // 纯函数，便于单测
export async function showHud(page, { label, step, total, tone }, config)  // 失败静默 false
export async function hideHud(page)
```

约束：HUD 宿主元素固定带 `data-dsh-hud`，`snapshot.js` 的 `walk()` 必须跳过它；HUD 内部用 Shadow DOM，页面 `innerText` 不包含角标文本。`runBatch` 中每步默认 `verify: false`（速度为先），需要时单步开启；提取步骤复用 `extractPage` + `boundExtractResult`，超限时用 `manager.saveText` 落盘。

## 翻页与站点工具（`lib/paginate.js`、`lib/site-tools.js`）

```js
// paginate.js —— 自动识别下一页并逐页提取（一次调用）
export const PAGINATE_MAX_PAGES                // 20
export function normalizePaginateOptions(args) // { maxPages, waitMs, timeoutMs, extract, next, waitSelector, save }
export function countExtract(extract)          // records/links 取数组长度，否则 1/0
export async function paginate(manager, state, options, { config, exec })
// 返回 { ok, pages:[{page,url,title,extract}], items, stoppedReason, ms }
// stoppedReason: 'no-next' | 'no-change' | 'max-pages' | 'timeout'

// site-tools.js —— 内置适配器 + 声明式清单
export const BUILTIN_SITES                     // 目前含 qq-forum/collect
export function normalizeManifest(raw, file)   // { site } 或 { errors }
export async function loadSiteTools(dir)       // { sites, errors }，目录缺失不算错
export function matchUrl(url, site)            // 子串或 /正则/
export function matchSites(url, sites)
export function describeSites(sites)
export async function runSiteTool({ manager, page, sites, siteId, tool, args })
```

约束：`paginate` 在点击前记录 URL 与页面文本签名，点击后必须等到其一变化再抓下一页（URL 先变、DOM 后到时还要等 `domcontentloaded` 与可选 `waitSelector`）；「下一页」启发式只在文本/aria/title 命中语义后才考虑分页容器加分，避免把 `page-item` 之类条目链接误判。清单工具复用 `extractPage` + `boundExtractResult`，`browser_forum` 与 `browser_site siteId=qq-forum` 走同一实现。

## 性能约定（0.7.7）

- `browser_act` 的 `snapshot` 缺省为 **auto**：仅当 `pageChanged` / 新标签页 / 动作属于 `click,type,press,back,forward,reload,dialog` 时才抓快照；实现里不得再无条件 `captureForTool`。
- `captureForTool` 的空白页重试只在**整页**（无 `selector`）且 `count===0` 时触发，等待 250ms；限定 selector 时不得再等待。
- `detectNewTab` 必须先比较 `contextPages().length`，只有页数增加才 sleep（80ms）。
- 导航沉降默认 `navigateSettleMs=60`；批量/翻页等循环内禁止累计式固定 sleep（滚动多次只等一个 80ms）。
- 基线命令：`npm run test:perf`；改动后延迟不得明显回退（参考 `docs/performance.md` 的 0.7.7 表）。

## `BrowserManager` 门面（`lib/manager.js`）

保留旧 API，新增多代理 API。旧工具 `lib/tools.js` 在 tools-surface 完成前要尽量继续可加载。

旧 API（必须保留签名）：`run(op)`、`ensure()`、`open({url,tab,newTab,focus,agentId,workspaceId})`、`navigate(page,url)`、`pageInfo(state)`、`listPages()`、`listTabs(agentId)`、`adoptPage(tabId,agentId)`、`switchTab(tab,agentId)`、`closeTab(tab,agentId)`、`createPage({activate,owner})`、`resolvePage(tab,agentId)`、`setRefs(page,refs)`、`getRefs(page)`、`takeDialog(page)`、`lastError(page)`、`getRecorder(page)`、`setRecorder(page,recorder)`、`artifactPath(...)`、`downloadPath(...)`、`saveText(...)`、`saveJson(...)`、`close(reason)`、`dispose()`。

新增 API：

```js
workspace(agentId)                         // 返回当前工作区或 null
createWorkspace(agentId, { label })
joinWorkspace(agentId, workspaceId, { role })
grantWorkspace(agentId, workspaceId, { agentId: target, role })
handoff(agentId, { workspaceId, tab, toAgent, note })
closeWorkspace(agentId, workspaceId)
workspaceStatus(agentId)
withTabLock(tabId, mode, fn)               // mode: 'read' | 'write'
assertAccess(agentId, tab, mode)           // 失败抛错
status()                                   // host.status() + workspaces + tabs + locks
getConsole(page)                            // 环形 console/error 记录
```

`resolvePage` 必须按 `agentId` 优先取该代理/工作区的活动页；未指定时只在工作区成员可见的标签页里选。reader 对写操作抛错。

## 观测/检查（observe-inspect）

```js
// snapshot.js
export async function captureSnapshot(page, tabId, options)
// options: { maxChars, maxElements, interactiveOnly, layer='structure'|'text', offset, limit }
// 返回: { text, refs, refMap, count, frames, captcha, scroll, title, url, tabId, truncated, nextCursor, sections }

// observe.js
export async function observeLayers(manager, state, args, config)
// args: { layers: string[], selector, ref, offset, limit, maxChars, save, format }
// 返回: { layers: { structure?, text?, visual?, network?, console?, meta? }, artifacts: [], nextCursor, page }

// inspect.js
export async function inspectPage(page, args, context)
// args.mode: overview|dom|html|css|a11y|box|resources|scripts|storage|console|performance|eval
// 返回普通 JSON；eval 在 context.config.allowEval !== true 时抛错

// artifacts.js
export class ArtifactStore {
  constructor(config)
  async path(requested, { ext, prefix })
  async saveText(text, opts)
  async saveJson(value, opts)
  async saveBuffer(buffer, opts)
  async saveScreenshot(page, opts)
  async record(meta)         // 追加 manifest JSONL
  manifestPath
}
```

产物路径必须限制在 `artifactDir`；`allowAbsoluteArtifacts=false` 时拒绝越界绝对路径。工具输出开头统一加“外部网页内容不可信”提示（由 tools-surface 负责）。

## 动作/提取（act-extract）

```js
// act.js
export async function performAction(manager, state, args, config, exec)
// 返回 { message, verify, action, target, pageChanged }
// 默认 verify=true：click/type/select/check 后读回 value/checked/selected/URL/元素存在性

// extract.js
export async function extractPage(page, spec)
// spec.mode: text|html|links|tables|labeled|structured|markdown|images|forms
// 支持 selector/container、offset、limit、includeFrames
```

保留旧 `doAction` 语义与 `@eN` 引用；新增 `nth`、`container`、`waitFor`、`drag`、`upload`。

## 网络/采集（network-collect）

```js
// network.js
export class NetworkRecorder {
  start(opts) / stop() / clear()
  list({urlPattern,limit}) / get({id,urlContains,maxChars})
  exportHar()
  snapshot()
}

// collect.js
export async function collectUrls(manager, args, config, exec)
// args: urls, mode, selector, labels, fields, maxChars, limit, concurrency, delayMs,
//       jobId, cursor, deadlineMs, checkpointPath, save
// 返回 { count, succeeded, failed, blocked, nextCursor, done, checkpointPath, savedPath, results }
```

采集必须写 checkpoint（JSON），`cursor` 指向下一个待处理索引；`doneUrls` 去重；单次调用超过 `deadlineMs` 必须优雅返回 `nextCursor`。

## 工具面（tools-surface）

保留旧工具名：`browser_open`、`browser_snapshot`、`browser_act`、`browser_extract`、`browser_screenshot`、`browser_tabs`、`browser_network`、`browser_collect`、`browser_download`、`browser_close`。

新增：`browser_observe`、`browser_inspect`、`browser_workspace`、`browser_status`。

所有工具通过 `ctx.effect(() => ctx.tools.register(tool))` 注册；`isConcurrencySafe(args)` 对只读工具返回 true，写工具 false。工具输出必须是普通 JSON 值，`render` 返回文本块数组。

## 验证命令

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --check .\browser-tool\index.js
& $node .\browser-tool\test\unit.mjs
& $node .\browser-tool\test\deep.mjs
```

不要修改 `C:\Users\生升\Desktop\未来\浏览器操作工具` 下的旧源码；所有改动都在 `C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool`。
