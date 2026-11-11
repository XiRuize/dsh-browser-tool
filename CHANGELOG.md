# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。本文件只记录真实发生或明确标记为「进行中」的变更，不把计划写成已发布事实。

## [未发布] — 0.7.1（文档与仓库完善）

### 变更

- 文档与工具清单同步：README、README.en、docs/tools.md、architecture 统一为 **20 个工具**，状态徽章更新为已发布版本。
- 新增 npm 脚本：`test`、`test:e2e`、`verify:docs`、`bench`、`bench:forum`。
- 新增 `test/docs.mjs` 文档一致性检查（版本号、工具数、CHANGELOG 小节、npm scripts），并接入 GitHub Actions CI。
- 清理 `scripts/qq-forum/` 下的一次性调试脚本；本地自动评论脚本加入 `.gitignore`，不再入库。
## [未发布] — 0.7.0（F12 式前端工作流，代码已落地）

### 新增

- **`browser_devtools`**：`capture` 把页面 HTML、内联样式、样式表链接、脚本清单、meta 写入暂存区并生成清单；`clean` 去掉脚本/样式/注释/内联事件/埋点属性，输出干净 HTML + 文本；`manifest` 看文件清单；`clear` 删除暂存。
- **`lib/devtools.js`**：`collectFrontendInPage`（页面内采集）、`cleanFrontend`（纯函数清洗，返回各类删除计数）、`captureFrontend`（落盘 + 清单）。

### 变更

- `ScratchStore.put` 保留原扩展名（`page.html`、`cleaned.html`），无扩展名才补 `.raw`。

### 测试

- 单测 19/19；e2e 82 assertions（新增 devtools capture/clean/manifest/clear 全链路）。
## [未发布] — 0.6.0（暂存区 + 工作页池，代码已落地）

### 新增

- **临时暂存区** `lib/scratch.js`：原始 HTML/正文先落盘到 `~/.dsh/browser-tool/scratch/<jobId>/`，清洗后再返回；默认采集结束即删（`keepScratch` 可保留），按 TTL/容量自动清理。
- **流式清洗** `lib/clean.js`：`cleanHtml` 去脚本/样式/注释、解实体、折叠空白；`cleanText` 归一纯文本；`streamClean` 按块切分，避免整页进入上下文。
- **`browser_capture`**：F12 式抓取当前页（或 selector 范围）→ 写入暂存区 → 清洗 → 返回标题/正文 → 默认删除中间文件。
- **`browser_scratch`**：stats / list / read / clear 管理暂存区。
- **`browser_collect` 新参数**：`scratch`、`keepScratch`、`clean`。

### 修复

- **多 URL 反复开关标签页**：新增 manager 工作页池（`acquireWorkerPage` / `releaseWorkerPage`），采集跨调用复用同一批页面，不再每条 URL 建页/关页，显著减少 about:blank 堆积；`close()` 统一回收。
## [未发布] — 0.5.0（QQ 论坛分页算法，代码已落地）

### 新增

- **`browser_forum` 分页**：`paginate:true` 走 `GetChannelTimelineFeeds` 游标，每版块可到 100+ 条；`concurrency` 控制并行版块数（1–6）。
- **动态 bkn**：从 Cookie 里的 `p_skey/skey` 现算 `g_tk`（djb2），5 分钟缓存；命中 150/403 自动刷新重试，不再依赖抄来的常量。
- **可见翻页**：`watch:true` 在窗口里真实滚动加载（约 0.4s/条），便于人工验收；与 `paginate` 共用同一套输出。
- **自适应退避**：429/5xx/网络错误按指数退避 + 抖动重试；`stats.backoffs` 可观测。
- **按版块增量落盘**：每个版块完成即写 `qq-forum-<版块>.json`，中断不丢已采数据。
- **启动自愈**：Windows 下启动失败（exitCode 21 / profile 占用）自动清理残留 msedge 与 lockfile 后重试；`dispose()` 也会清理。

### 实测

- 14 个版块 × 100 条：**1237 条 / 15.6s / 113 请求 / 79 条每秒**，100% 带作者 tiny_id。
- 可见滚动翻页：二手 100 条 / 18 次滚动 / 40s。
## [未发布] — 0.4.0（静默/非静默切换，代码已落地）

### 新增

- **`browser_show`**：运行中切换 `headless` / `offscreen` / `window`；`show` 用 CDP `Browser.setWindowBounds` 把窗口拉到前台，`hide` 移回屏幕外；`set` 通过重启上下文切换有头/无头并保留登录态、按需恢复标签页 URL。
- 工具面 16 → **17** 个。

## [未发布] — 0.3.0（性能优化，代码已落地）

针对 QQ 论坛（腾讯频道）这类 SSR + JSON API 的重站点提速。实测（本机、20 条 URL、并发 4）：
渲染路径 P50 2.4s → **1.18s**；HTTP 快通道 P50 **0.73s**、吞吐 2.4 条/秒；
QQ 论坛适配器用 14 个版块 SSR 在 **11.8s 内归档 122 条帖子**（100% 带作者 tiny_id）。

### 新增

- **`browser_fetch`**：复用浏览器登录 Cookie / UA / Referer 的 HTTP 快通道，不渲染页面；命中 JS 挑战或 401/403/429 时标记 `blocked` 并提示回落渲染。
- **`browser_forum`**：站点适配器，采集腾讯频道帖子。默认 3 个版块；`discover=true` 时渲染一次频道页自动发现全部版块 `subc`；按帖子 id 反解作者 `tiny_id` 去重，支持关键词过滤与 JSON 分页配置。
- **`records` 提取模式**：`itemSelector` + `fields` 一次返回整页列表数组（`browser_extract` 与 `browser_collect` 均支持）。
- **`lib/adapters/qq-forum.js`** 与 `skills/qq-forum/SKILL.md`。
- **`lib/fetch.js`**：User-Agent 归一（去掉 Headless 标记）、同源 Referer、指数退避重试、挑战页识别。
- **`test/bench.mjs`**（P50/P95/吞吐基准）与 **`test/forum-live.mjs`**（真实论坛验收）。

### 变更

- **导航**：`manager.navigate` 去掉固定 `sleep(450)` + 2.5s `waitForLoadState`，改为 `navigateSettleMs`（默认 120ms）+ 可选 `navigateWaitSelector`。
- **采集管道**：worker 复用常驻标签页；并发默认 4（最大 8）；`delayMs` 默认 0 并在命中风控时自动退避；单条导航失败重试（`collectRetries`）；`render=false` 走 HTTP 快通道并在挑战页时自动回落渲染。
- **检查点**：全量重写改为「JSONL 增量追加 + 1s 防抖快照 + 结束落盘」，续跑时用 JSONL 补齐快照落后的结果。
- **上限**：`browser_collect` 单次 20 → **100** 条，`urls` 100 → **200** 条。
- **网络记录**：`NetworkRecorder` 增加 `requestBody` 捕获，HAR 导出包含 `request.postData`。
- **工具面**：14 → **16** 个工具（新增 `browser_fetch`、`browser_forum`）。

### 兼容性

- 旧工具名、旧参数键、`@eN` 引用语义不变；新增参数全部可选。
- `collectConcurrency` 默认 2→4、`collectDelayMs` 800→0、`collectRenderWaitMs` 700→250，如需旧行为显式配置即可回退。

## [未发布] — 0.2.0（代码已落地）

`0.2.0` 三项目标：静默长时运行、深层前端检查、多子代理协作。代码已实现；真实 Edge 端到端验收与 GitHub 发布仍待完成。

### 已实现（代码）

- **静默默认**：`visibility=headless` 成为默认；不再默认调用 `page.bringToFront()`；`headless` 仅作兼容别名。（core-host）
- **长时与恢复**：`idleCloseMs` 默认 `0`；30 秒 watchdog；断开后下一次调用自动重启一次并返回恢复提示。（core-host）
- **配置归一化**：`lib/config.js` 统一解析默认值，加入 `maxTabs=24`、`maxIdleTabs=8`、`idleTabMs=600000`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`networkMaxEntries` 等字段；默认目录在 `~/.dsh/browser-tool/`，不再硬编码 Desktop 路径。（core-host）
- **可选 browserUse 注册**：`browserUse` 服务存在时 best-effort 注册 provider，缺失或失败只记 warning，不影响工具。（core-host）
- **多子代理工作区**：`workspace.js` / `locks.js` 提供工作区、reader/writer 角色、租约、handoff、per-tab 读写锁；`browser_workspace status` 只报告当前活动工作区。（pages-workspaces）
- **标签页管理**：稳定 `tabId`、owner、`claim` / `release`、`maxTabs` / `maxIdleTabs` 回收。（pages-workspaces）
- **分层观测**：新增 `browser_observe`，按 `structure` / `text` / `visual` / `network` / `console` / `meta` 返回，支持 `offset` / `limit` / `nextCursor`；`save` 默认 `false`，`artifacts` 为对象数组。（observe-inspect）
- **深层前端检查**：新增 `browser_inspect`（overview / dom / html / css / a11y / box / resources / scripts / storage / console / performance / eval）；`code` 是 `script` 的别名；storage 默认脱敏。（observe-inspect）
- **产物账本**：`ArtifactStore` 写入 manifest JSONL，记录类型、来源、时间、尺寸与哈希。（observe-inspect）
- **动作回读核验**：`browser_act` 默认 `verify=true`，click/type/select/check 后读回真实状态；新增 `nth` / `container` / `verify` / `waitFor` / `drag` / `upload` / `dialog`。（act-extract）
- **提取扩展**：新增 `markdown` / `images` / `forms` 模式与容器限定、字符窗口 `offset` / `limit`。（act-extract）
- **网络与采集**：`browser_network` 增加 `export`（HAR）；`browser_collect` 支持 `urls` 最多 100、单次处理 20、`jobId` / `cursor` / `deadlineMs` / checkpoint 续跑。（network-collect）
- **工具面**：14 个工具落地，新增 `browser_workspace`、`browser_status`；`browser_status` 返回扁平诊断对象；网页内容加不可信提示。（tools-surface）
- **兼容**：保留旧工具名与 `@eN` 引用语义；`browser_snapshot` 作为 `browser_observe` 的 **structure 层**兼容别名。（tools-surface）

### 待验证与发布（尚未完成）

- 真实 Edge 端到端验收：headless 打开、分层观测、动作回读、多子代理、崩溃恢复、采集续跑（由 install-verify 记录在 `docs/install-verification.md`）。
- 上游 PR 拆分与社区包名确定（见 `docs/upstream-proposal.md`）。
- GitHub 发布与远端推送。

### 文档与仓库

- 重写中文主文档，新增英文摘要 `README.en.md`。
- 新增 `SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/architecture.md`、`docs/tools.md`、`docs/subagents.md`、`docs/installation.md`、`docs/troubleshooting.md`、`docs/upstream-proposal.md`。
- 新增 Agent Skill `skills/browser-field-ops/SKILL.md`。
- 新增 GitHub Actions CI 与 issue / PR 模板。
- 新增 MIT `LICENSE`。

## [0.1.0] — 基线

首个可用版本，作为 v0.2 重构的基线提交（`chore: baseline v0.1.0 before v0.2 refactor`）。

### 已交付

- DSH bundle 入口 `index.js`，通过 `apply(ctx, rawConfig)` 注册工具。
- 持久化登录态的真实 Edge 浏览器（`playwright-core` + `channel: msedge`）。
- 10 个工具名：`browser_open`、`browser_snapshot`、`browser_act`、`browser_extract`、`browser_screenshot`、`browser_tabs`、`browser_network`、`browser_collect`、`browser_download`、`browser_close`。
- `@eN` 快照引用、跨 iframe 定位、点击/输入/选择/滚动等基础动作。
- 提取模式：`text` / `html` / `links` / `tables` / `labeled` / `structured`，超长自动落盘。
- 网络响应捕获（XHR/fetch）与批量采集（最多 20 URL，默认并发 2 + 延迟）。
- 截图与下载，产物落在独立 `artifacts` / `downloads` 目录。
- 测试脚本：`test/smoke.mjs`、`test/deep.mjs`、`test/qcc.mjs`、`test/qcc-detail.mjs`、`test/live-server.mjs`。

### 已知问题（v0.2 要解决的）

- 默认可见窗口并会抢焦点。
- `idleCloseMs` 默认 15 分钟自动关闭，长任务会中断。
- 单代理模型，没有工作区与读写权限隔离。
- 无深层前端检查（DOM/HTML/CSS/a11y/资源/存储/性能）。
- 配置默认值分散在 `index.js`，没有统一归一化。
