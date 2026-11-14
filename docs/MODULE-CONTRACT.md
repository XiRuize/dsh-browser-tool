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
  allowEval, allowAbsoluteArtifacts,
  networkMaxEntries, networkMaxBodyChars
}
```

硬性默认值：`visibility='headless'`、`idleCloseMs=0`、`watchdogIntervalMs=30000`、`autoRelaunch=true`、`maxTabs=24`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`launchTimeoutMs=30000`、`launchDeadlineMs=55000`。`headless` 只作为兼容别名，最终看 `visibility`。启动总预算应小于工具层超时（快照 45000、截图/网络 60000、`browser_open` 90000），否则调用会先被工具层中止而底层启动仍在继续。

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
