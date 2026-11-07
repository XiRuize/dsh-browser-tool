# 变更日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。本文件只记录真实发生或明确标记为「进行中」的变更，不把计划写成已发布事实。

## [未发布] — 0.2.0（进行中）

`0.2.0` 三项目标：静默长时运行、深层前端检查、多子代理协作。以下条目按模块列出状态。

### 进行中

- **静默默认**：`visibility=headless` 成为默认；不再默认调用 `page.bringToFront()`；`headless` 仅作兼容别名。（core-host）
- **长时与恢复**：`idleCloseMs` 默认改为 `0`；30 秒 watchdog；断开后下一次调用自动重启一次并返回恢复提示。（core-host）
- **配置归一化**：`lib/config.js` 统一解析默认值，加入 `maxTabs=24`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`networkMaxEntries` 等字段。（core-host）
- **多子代理工作区**：`workspace.js` / `locks.js` 提供工作区、reader/writer 角色、租约、handoff、per-tab 读写锁。（pages-workspaces）
- **分层观测**：新增 `browser_observe`，按 `structure` / `text` / `visual` / `network` / `console` / `meta` 返回，支持 `offset` / `limit` / `nextCursor`。（observe-inspect）
- **深层前端检查**：新增 `browser_inspect`（overview / dom / html / css / a11y / box / resources / scripts / storage / console / performance / eval）。（observe-inspect）
- **产物账本**：`ArtifactStore` 写入 manifest JSONL，记录类型、来源、时间、尺寸与哈希。（observe-inspect）
- **动作回读核验**：`browser_act` 默认 `verify=true`，click/type/select/check 后读回真实状态；新增 `nth` / `container` / `waitFor` / `drag` / `upload`。（act-extract）
- **提取扩展**：新增 `markdown` / `images` / `forms` 模式与容器限定、分段偏移。（act-extract）
- **网络与采集**：`browser_network` 增加 `export`（HAR）；`browser_collect` 增加 `jobId` / `cursor` / `checkpoint` 的可续跑批处理。（network-collect）
- **工具面**：新增 `browser_workspace`、`browser_status`；统一 `isConcurrencySafe`；网页内容加不可信提示。（tools-surface）
- **兼容**：保留旧工具名与 `@eN` 引用语义；`browser_snapshot` 作为 `browser_observe` 的兼容别名。（tools-surface）

### 计划（尚未实现）

- `maxIdleTabs` / `idleTabMs` 的空闲标签页回收执行（配置字段已加入 `lib/config.js`，回收逻辑在 pages-workspaces 中落地）。
- 上游 `browserUse` provider 的可选注册与失败降级（见 `docs/upstream-proposal.md`）。
- 上游 PR 拆分与社区包名确定。

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
