# @future/dsh-browser-tool

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的浏览器操作插件：一个可长期驻留、默认后台静默的真实 Edge / Chromium 浏览器，加上面向「浏览 → 定位 → 提取 → 存证 → 批处理」的工具面。

![status](https://img.shields.io/badge/status-0.8.0%20published-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![runtime](https://img.shields.io/badge/runtime-Node.js%2020%2B%20%7C%2022-339933)

> **0.8.0（提速版）**：工具面 23 → 18，每请求 schema 27.8KB → 21.0KB（≈8.7k → 6.6k tokens，−24%）；新增内容缓存（命中 0–2ms）与精简回包（`detail=compact`）。
>
> **破坏性变更**：`browser_observe` / `browser_inspect` / `browser_extract` / `browser_screenshot` → **`browser_read`**；`browser_batch` → **`browser_act.steps`**；`browser_forum` → **`browser_site`**。迁移见下文「0.8 迁移」。版本演进见 [`CHANGELOG.md`](CHANGELOG.md)。

## 定位

这不是另一个「LLM 自己开浏览器」的黑盒 Agent。浏览器里的每一步，都由当前模型通过工具调用显式完成：

1. 先读实际状态：`browser_snapshot`（可操作结构）或 `browser_read`（分层观测 / 深层检查 / 提取）；
2. 按容器、文本、`@eN` 引用或 CSS selector 定位；
3. 执行动作（`browser_act`，单步或 `steps` 多步）；
4. 回读核验（动作返回真实 `value` / `checked` / URL / 元素存在性）；
5. 需要留痕时落盘（截图、全文、JSON、HAR）；
6. **最终提交 / 提交表单 / 交卷永远留给人**——插件不自动提交，也不绕过验证码。

这套流程借用了 [`chrome-quiz-copilot`](https://github.com/Ruoyu-Tianyi/chrome-quiz-copilot) 的核心思想，并泛化为通用的浏览器调研与分段协作流程（见 [`skills/browser-field-ops/SKILL.md`](skills/browser-field-ops/SKILL.md)）。

## 快速开始

```js
// 1) 打开：只要跳转、不要首屏快照
browser_open { url: "https://example.com/list", snapshot: false }

// 2) 定位：先做局部快照，再按 @eN 操作
browser_snapshot { selector: "#list", maxElements: 80 }
browser_act { action: "click", ref: "@e3", label: "翻到第 2 页" }

// 3) 读取：提取 + 精简回包（records 默认只回前 20 条）
browser_read { source: "extract", mode: "records", selector: "#list", itemSelector: "li", fields: { title: "h3" } }

// 4) 一次调用跑多步：跳转 → 点击 → 提取
browser_act { steps: [
  { action: "goto", url: "https://example.com/list" },
  { action: "click", selector: "a.next" },
  { action: "extract", mode: "records", itemSelector: "li", fields: { title: "h3" } }
] }

// 5) 重复取数：fetch 默认走内容缓存；refresh:true 强制刷新
browser_fetch { url: "https://api.example.com/quote" }
```

## 0.8 迁移（旧 → 新）

| 0.7 用法 | 0.8 写法 |
|---|---|
| `browser_observe { layers }` | `browser_read { source: "observe", layers }` |
| `browser_inspect { mode }` | `browser_read { source: "inspect", mode }` |
| `browser_extract { mode }` | `browser_read { source: "extract", mode }` |
| `browser_screenshot { path }` | `browser_read { source: "screenshot", path }` |
| `browser_batch { steps }` | `browser_act { steps }` |
| `browser_forum { guild }` | `browser_site { action: "run", siteId: "qq-forum", tool: "collect", args: { guild } }` |
| 动作的 button/drag/files… | `browser_act { action, options: { … } }` |

## 与 DSH 社区的关系

- 本插件是 DSH Host 插件，通过 `ctx.tools.register` 暴露工具，不修改 DSH 本体。
- 目标是把方案整理成可开源、可被 DSH 社区复用的 bundle：MIT 许可、双语文档、安全声明、测试与 CI。
- 与官方 `browserUse` 服务的关系：采用**可选注册**——服务存在时注册 provider 名，失败则降级并记录 warning，不硬依赖（提案见 [`docs/upstream-proposal.md`](docs/upstream-proposal.md)）。
- 包名暂时保留 `@future/dsh-browser-tool` 以兼容当前 profile；社区发布时的中性包名建议写在同一份提案里。
- 已知事实：DSH 内置侧边栏浏览器是用户侧呈现（不注册工具、不发 Session 事件），Desktop 默认也未开 `--remote-debugging-port`。要接内置浏览器，现实路径是「侧边栏嵌入展示 + 可选 CDP 端口」，详见 [`docs/architecture.md`](docs/architecture.md)。

## 核心能力

### 默认静默

- `visibility` 默认 `headless`：不弹窗、不抢焦点。
- 永远不调用 `page.bringToFront()`，除非调用方显式要求可见。
- 需要人工登录 / 验证码时，用 `visibility=window` 临时切到可见，由人完成，再切回后台。

### 长时运行与崩溃恢复

- `idleCloseMs` 默认 `0`：空闲不自动关闭。
- 30 秒 watchdog（`watchdogIntervalMs=30000`）检测连接与标签页健康。
- `autoRelaunch=true`：浏览器断开后，下一次工具调用自动重启一次，并返回 `recovered` 提示。
- 启动预算收敛：单次 30s、总预算 55s（`launchTimeoutMs` / `launchDeadlineMs`），失败会先清理残留 profile 再重试。
- 登录态保存在独立 `userDataDir`，关浏览器不丢 Cookie。

### 多子代理工作区

- `browser_workspace` 支持 `create` / `join` / `status` / `grant` / `handoff` / `close`。
- 角色分 `reader` / `writer`：reader 只能观测与提取，写动作会被拒绝。
- 每个标签页有稳定 ID 与 owner；同一标签页的写操作串行（per-tab `read` / `write` 锁），不同标签页可并行。
- 租约带过期时间；交接（handoff）时写摘要，避免重复操作。

### 统一读取与内容缓存

- `browser_read` 一个入口四个通道：`observe`（structure/text/visual/network/console/meta）、`inspect`（dom/css/a11y/box/resources/scripts/storage/console/performance）、`extract`（text/links/tables/labeled/structured/records/markdown/images/forms）、`screenshot`。
- 局部读取优先：`selector` / `ref` 限定范围；`detail=compact`（默认）只回摘要（records 前 20 条、text 截 4000 字符），全文落盘到 `savedPath`。
- `browser_fetch` 默认走内容缓存（仅 GET 2xx 文本/JSON；带 Authorization 或 `no-store` 不缓存），命中返回 `cached:true` 与 `ageMs`；`refresh:true` 强制刷新。`browser_read` 的缓存是 opt-in（`cache:true`），避免页面变化后读旧数据。
- 缓存有 TTL（默认 1h）与容量上限（默认 512MB），超限按 mtime 淘汰最旧条目。

### 一次调用做更多

- `browser_act.steps`：1–50 步顺序执行（act 全部动作 + `extract` + `goto`），失败默认停止并带回已完成步骤。
- `browser_paginate`：自动识别「下一页」并一次抓 N 页（默认 5，上限 20），无下一页 / 无变化提前停止，records 自动合并。
- `browser_site`：站点工具注册表（`list` / `match` / `run`），内置 `qq-forum`，也可用 `<siteToolsDir>/*.json` 声明式清单扩展。
- 可见模式（`window` / `offscreen`）下，`label` 会显示为页面角落的 HUD 角标（Shadow DOM，不进快照）。

## 安装

插件以 bundle 形式安装，源码目录就是本仓库。安装动作通过 DSH 的 `plugin_manager` 完成（写入当前 profile 的 bundle 组合）。

### 通过 Plugin Manager 安装本地目录

在 DSH 会话中让主代理执行（等价于 `plugin_manager install_bundle`）：

```text
plugin_manager install_bundle target=C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool
```

安装前先安装依赖（本地目录安装会链接源码，依赖必须在源码目录可见）：

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
& $node $pnpm install --prod --ignore-scripts
```

本机使用 Edge，通过 Playwright `channel: msedge` 启动，不需要额外下载 Chromium：

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

安装完成后，profile 的 Cordis 组合中应出现 `browser-tool` 条目；若工具列表没有 `browser_*`，见 [`docs/installation.md`](docs/installation.md) 与 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

## 性能（0.8.0）

同机本地页基准（`npm run test:perf`，headless、关闭 HUD）：

| 操作 | 改前 | 改后 |
|---|---|---|
| 工具 schema（每请求固定） | 27,794 B | **20,993 B（≈6,560 tokens，−24%）** |
| `browser_act` scroll / click | 443 / 422ms | **~220 / ~240ms** |
| `browser_snapshot` 限定 selector（无交互元素） | 330ms | **15ms** |
| `browser_paginate` 3 页 | 577ms | **~490ms（约 160ms/页）** |
| `browser_act` steps（goto+extract） | — | **~60ms** |
| `browser_read` 截图（视口 / 整页） | 150 / 540ms | 113 / 485ms |
| `browser_fetch` 缓存命中 | — | **0–2ms**（首次 26ms–5s） |

要点：`browser_act` 默认 auto 快照（scroll/hover/wait 不再背 8KB 快照）；`browser_snapshot` 支持 `selector` 局部定位与「未变化只回一行」；`browser_open` 支持 `snapshot:false`；`browser_act.steps` 一次调用完成「跳转 → 操作 → 提取」。唯一躲不掉的固定成本是 Edge 冷启动 3–5s，浏览器常驻后不再发生。完整记录见 [`docs/performance.md`](docs/performance.md)。

## 配置

配置写在 bundle 的 `cordis.patch.yml`，由插件在 `apply(ctx, rawConfig)` 中通过 `lib/config.js` 的 `resolveConfig` 归一化；插件**不导出 `Config` / `ConfigSchema`**，Loader 直接把原始 config 交给 `apply`。下表是当前版本的默认值：

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `launch` | `launch` 启动独立 profile；`cdp` 连接已启动的浏览器 |
| `channel` | `msedge` | Playwright 通道：`msedge` / `chrome` / `chromium` |
| `executablePath` | 空 | 浏览器 exe 绝对路径；设置后忽略 `channel` |
| `cdpUrl` | 空 | `mode=cdp` 时的地址，例如 `http://127.0.0.1:9222` |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | 默认目录的根；一般不用改 |
| `userDataDir` | `~/.dsh/browser-tool/profile` | 登录态 / Cookie 持久化目录 |
| `artifactDir` | `~/.dsh/browser-tool/artifacts` | 截图、全文、采集 JSON、HAR |
| `downloadsDir` | `~/.dsh/browser-tool/downloads` | 下载文件 |
| `visibility` | `headless` | `headless` / `offscreen` / `window`；`headless` 仅作兼容别名 |
| `locale` | `zh-CN` | 浏览器 locale |
| `timezoneId` | `Asia/Shanghai` | 时区 |
| `actionTimeoutMs` | `15000` | 单步动作超时 |
| `navigationTimeoutMs` | `45000` | 页面导航超时 |
| `launchTimeoutMs` | `30000` | 单次浏览器启动超时（`launchPersistentContext`） |
| `launchDeadlineMs` | `55000` | 启动+全部重试的总预算，应小于工具层超时（快照 45s / 截图 60s / `browser_open` 90s） |
| `navigateSettleMs` | `60` | 导航后短沉降，替代固定 sleep(450)；SPA 需要时调大 |
| `navigateWaitSelector` | 空 | 导航后等待某选择器出现（适合必须水合的 SPA） |
| `collectRetries` | `2` | 单条导航/请求重试次数 |
| `collectPageReuse` | `true` | 采集 worker 复用常驻标签页 |
| `fetchTimeoutMs` | `30000` | HTTP 快通道超时 |
| `fetchRetries` | `2` | HTTP 快通道重试次数 |
| `snapshotMaxChars` | `12000` | 快照字符预算 |
| `extractMaxChars` | `30000` | 提取返回上限（超出落盘） |
| `collectConcurrency` | `4` | 批量采集并发，最大 8 |
| `collectDelayMs` | `0` | 批量采集每条间隔（命中风控自动退避） |
| `collectRenderWaitMs` | `250` | 采集渲染等待（选择器就绪优先） |
| `idleCloseMs` | `0` | 空闲自动关闭；`0` 表示不自动关 |
| `watchdogIntervalMs` | `30000` | 健康检查间隔 |
| `autoRelaunch` | `true` | 断开后自动重启 |
| `maxTabs` | `24` | 标签页上限 |
| `maxIdleTabs` | `8` | 空闲标签页上限 |
| `idleTabMs` | `600000` | 空闲页回收阈值（10 分钟） |
| `actionHud` | `true` | 可见模式（window/offscreen）下是否在页面角落显示操作角标；headless 永远不显示 |
| `actionHudTtlMs` | `4000` | 角标自动消失时间（500–30000） |
| `siteToolsDir` | `~/.dsh/browser-tool/site-tools` | 站点工具清单目录（`*.json`，内置适配器始终可用） |
| `cacheEnabled` | `true` | 是否启用内容缓存 |
| `cacheDir` | `~/.dsh/browser-tool/cache` | 内容缓存目录 |
| `cacheTtlMs` | `3600000` | 缓存 TTL（默认 1 小时） |
| `cacheMaxBytes` | `536870912` | 缓存总容量上限（默认 512MB，超限按最旧淘汰） |
| `allowEval` | `false` | 是否允许 `browser_read`（source=inspect）的 `eval` 模式 |
| `allowAbsoluteArtifacts` | `false` | 是否允许产物写到 `artifactDir` 之外的绝对路径 |
| `networkMaxEntries` | `80` | 网络记录条数上限 |
| `networkMaxBodyChars` | `120000` | 单条响应体上限 |

当前仓库的 `cordis.patch.yml` 只写与默认不同的常用项，其余由 `resolveConfig` 补齐：

```yaml
- insert:
    - id: browser-tool
      name: '@future/dsh-browser-tool'
      config:
        mode: launch
        channel: msedge
        visibility: headless
        idleCloseMs: 0
        watchdogIntervalMs: 30000
        autoRelaunch: true
```

默认目录在 `~/.dsh/browser-tool/` 下，不再硬编码任何 Desktop 路径。若要沿用旧版本的登录态（例如原来指向 `Desktop/未来/浏览器操作工具/runtime/profile`），必须显式配置 `userDataDir`，否则会使用新的空 profile。

## 工具清单（18 个）

完整参数、返回结构与错误语义见 [`docs/tools.md`](docs/tools.md)。

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 / 复用标签页，静默返回快照；`focus` 默认 false；`snapshot:false` 只为跳转、`snapshotSelector` 只扫局部 |
| `browser_snapshot` | 可操作结构快照（带 `@eN`），支持 `selector` / `maxElements` 局部快速定位；相同快照只回一行 |
| `browser_read` | 统一读取：observe 分层 / inspect 深层 / extract 提取 / screenshot 截图；支持 `cache` / `refresh` / `detail=compact` |
| `browser_act` | 单步动作（click/type/press/scroll/…）或 `steps` 多步（≤50 步，含 extract/goto）；默认回读核验；`label` 显示角标 |
| `browser_paginate` | 自动识别「下一页」并一次抓 N 页（默认 5，上限 20）；无下一页 / 无变化提前停止，records 合并 |
| `browser_site` | 站点工具注册表：`list` / `match` / `run`；内置 `qq-forum`，清单来自 `<siteToolsDir>/*.json` |
| `browser_fetch` | HTTP 快通道：复用登录 Cookie/UA 直连，不渲染；默认走内容缓存，命中标注 `cached` |
| `browser_collect` | urls 最多 200、单次处理 100；页面复用 + 并发 8 + JSONL 增量检查点；`render=false` 走快通道 |
| `browser_network` | start / stop / list / get / clear / export(HAR) |
| `browser_tabs` | list / switch / close / claim / release |
| `browser_workspace` | create / join / status / grant / handoff / close；status 只报告当前活动工作区 |
| `browser_show` | 静默 / 非静默切换：headless / offscreen / window，show 拉到前台、hide 移出屏幕 |
| `browser_capture` | F12 式抓页面 HTML 到暂存区 → 清洗 → 返回（默认删中间文件） |
| `browser_devtools` | 前端工作流：capture/clean/manifest/clear，抓 HTML+CSS+JS 清单并清洗 |
| `browser_scratch` | 暂存区 stats / list / read / clear |
| `browser_download` | 按 URL 下载（共享 cookie）或点击元素下载 |
| `browser_status` | 扁平诊断对象：浏览器 / 标签页 / 锁 / 工作区 / 最近错误 |
| `browser_close` | 关闭浏览器、释放目录锁，保留登录态 |

> 以上为代码已实现；`test/unit.mjs`、`test/e2e.mjs` 与 GitHub Actions CI 已覆盖主要路径，真实站点 WAF / 验证码仍属未覆盖风险（见「已知限制」与 [`docs/performance.md`](docs/performance.md)）。

## 仓库结构

```text
browser-tool/
├─ index.js                 # 插件入口：apply(ctx, rawConfig)
├─ cordis.patch.yml         # bundle patch 示例
├─ package.json             # 依赖、npm scripts 与 dsh.bundle 声明
├─ lib/
│  ├─ config.js             # 配置归一化（含 cache / scratch / fetch / 采集默认值）
│  ├─ host.js               # 浏览器启动 / 静默切换 / watchdog / 恢复
│  ├─ manager.js            # 管理器门面：页面池、工作区、锁、可见性
│  ├─ pages.js              # 标签页与 owner
│  ├─ workspace.js          # 工作区 / 租约 / ACL
│  ├─ locks.js              # per-tab 读写锁
│  ├─ snapshot.js           # 快照与引用
│  ├─ observe.js            # 分层观测
│  ├─ inspect.js            # 深层前端检查
│  ├─ extract.js            # 提取（含 records 数组模式）
│  ├─ cache.js              # 内容缓存（内容寻址 + TTL/容量淘汰）
│  ├─ act.js                # 动作与回读核验
│  ├─ batch.js              # 多步执行（act.steps 的后端）
│  ├─ paginate.js           # 自动识别下一页 + 一次抓 N 页
│  ├─ site-tools.js         # 站点工具注册表（内置适配器 + 声明式清单）
│  ├─ hud.js                # 可见模式下的页面操作角标（Shadow DOM）
│  ├─ artifacts.js          # 产物库与 manifest
│  ├─ network.js            # 网络捕获（含请求体）
│  ├─ collect.js            # 可续跑批处理 + 暂存区 + 工作页复用
│  ├─ fetch.js              # HTTP 快通道（Cookie/UA/Referer）
│  ├─ scratch.js            # 临时暂存区（TTL/容量清理）
│  ├─ clean.js              # HTML/文本清洗
│  ├─ devtools.js           # F12 式抓取与清洗
│  ├─ adapters/qq-forum.js  # QQ 论坛适配器（游标分页 + bkn）
│  ├─ tools.js              # 工具注册（18 个工具）
│  └─ util.js               # 工具函数
├─ docs/
│  ├─ MODULE-CONTRACT.md    # 实现子代理之间的接口契约
│  ├─ architecture.md       # 分层架构与生命周期
│  ├─ tools.md              # 工具参考
│  ├─ performance.md        # 性能基线与提速记录
│  ├─ subagents.md          # 多子代理协作指南
│  ├─ installation.md       # 安装与 profile 排查
│  ├─ troubleshooting.md    # 常见问题
│  ├─ upstream-proposal.md  # 面向 DSH 社区的提案
│  └─ install-verification.md # 0.2.0 安装验收历史记录
├─ skills/
│  ├─ browser-field-ops/    # Agent Skill：浏览器分段协作流程
│  └─ qq-forum/             # Agent Skill：QQ 论坛采集
├─ examples/site-tools/     # browser_site 清单示例（放到 siteToolsDir 即生效）
├─ scripts/qq-forum/        # 一次性运营脚本（不进 CI）
├─ test/                    # unit / e2e / perf / docs / bench
├─ .github/                 # CI 与 issue / PR 模板
├─ LICENSE
├─ SECURITY.md
├─ CONTRIBUTING.md
└─ CHANGELOG.md
```

## 安全边界

- **输入**：只接受 `http(s)` URL；网页内容一律视为不可信数据，不作为指令执行。
- **eval**：默认关闭；开启需要配置 `allowEval: true` 并在任务中显式说明。
- **产物**：默认只能写入 `artifactDir`；绝对路径越界会被拒绝。
- **登录态**：独立 profile；不默认连接用户日常浏览器，复用需显式 CDP。
- **缓存**：只缓存 GET 2xx 文本/JSON；带 Authorization 或 `no-store` 不缓存；默认不含敏感响应。
- **不做的事**：没有 stealth 反检测、没有验证码识别 / 绕过、没有自动提交 / 自动交卷、没有隐藏式批量抓取绕过站点限速。
- **高风险操作**（下载、上传、跨站写操作）应在任务说明中由人确认。

详见 [`SECURITY.md`](SECURITY.md)。

## 已知限制

- 依赖本机 Edge / Chromium；没有浏览器时 `browser_open` 会报错并提示安装或设置 `executablePath`。
- 同一 `userDataDir` 不能被两个浏览器进程同时占用；多实例需要各自独立目录 / 端口。
- 部分站点严格检测 headless，需 `offscreen` 或 `window` 兜底，仍可能遇到 WAF。
- Canvas、封闭 Shadow DOM、纯视觉内容无法可靠结构化，用截图与网络兜底。
- 多个子代理共享同一 Chromium context，标签页与内存需要上限和回收。
- Windows 下 `offscreen` 窗口仍可能出现在任务栏；默认用 `headless`。
- 缓存按 URL + 提取规格寻址，不感知服务端内容变化；需要新鲜数据时用 `refresh:true` 或较短 `cacheTtlMs`。
- 工具面以 18 个 `browser_*` 工具为准；接口契约见 [`docs/MODULE-CONTRACT.md`](docs/MODULE-CONTRACT.md)，版本演进见 [`CHANGELOG.md`](CHANGELOG.md)。

## 验证命令

Windows PowerShell 与本机 Node 路径：

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 语法检查
& $node --check .\index.js
Get-ChildItem .\lib, .\test -Filter *.js -Recurse | ForEach-Object { & $node --check $_.FullName }
Get-ChildItem .\test -Filter *.mjs -Recurse | ForEach-Object { & $node --check $_.FullName }

# 无浏览器单测 + 文档一致性
& $node .\test\unit.mjs
& $node .\test\docs.mjs

# 延迟基线（含缓存命中与 schema 体积）
& $node .\test\perf.mjs

# 需要本机 Edge 的实机测试（不在 CI 中运行）
$env:DSH_BROWSER_E2E = '1'; & $node .\test\e2e.mjs
```

CI 做语法检查、无浏览器单测与文档一致性检查，见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)；真实 Edge 的 E2E 需本机设置 `DSH_BROWSER_E2E=1` 后运行 `node test/e2e.mjs`。

## 开源许可

[MIT](LICENSE) © 2026 DSH Browser Tool contributors
