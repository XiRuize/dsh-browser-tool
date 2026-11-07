# @future/dsh-browser-tool

给 DeepSeek Harness 的 Host 工具插件：一个带持久化登录态的真实 Edge/Chromium 浏览器，以及面向“浏览—定位—提取—存证—批处理”的工具面。

这不是另一个 LLM 浏览器 Agent。浏览器里的每一步由当前模型通过工具调用完成：先拿页面快照和 `@eN` 引用，再点按/填写；需要大段内容时用提取工具，而不是把整页塞回上下文。

## 工具

| 工具 | 用途 |
|---|---|
| `browser_open` | 打开 URL、复用标签页、把窗口带到前台；返回快照。不传 `url` 就是“聚焦当前页” |
| `browser_snapshot` | 可操作快照：链接、按钮、输入框、标题、iframe，带 `@e1` 引用 |
| `browser_act` | `click` / `type` / `press` / `scroll` / `select` / `check` / `hover` / `back` / `forward` / `reload` / `wait` |
| `browser_extract` | `text` / `html` / `links` / `tables` / `labeled` / `structured`；过长自动落盘 |
| `browser_screenshot` | 页面/元素截图，返回绝对路径与尺寸，可用 `read_image` 查看 |
| `browser_tabs` | `list` / `switch` / `close`，标签页有稳定 `t1`、`t2` 编号 |
| `browser_network` | 捕获 XHR/fetch 响应，读前端接口返回的 JSON |
| `browser_collect` | 同一套提取在最多 20 个 URL 上并发执行，结果保存 JSON |
| `browser_download` | 直接按 URL 下载（共享 cookie），或点击元素等待浏览器下载 |
| `browser_close` | 关闭浏览器、释放配置目录锁；登录态仍保留在 profile 中 |

## 安装

插件已经在当前桌面 profile 安装并激活。源码位置：

```text
未来/浏览器操作工具/dsh-browser-tool
```

手工重装（在 DSH 里通过 Plugin Manager 安装本地 bundle 目录）：

```text
C:\Users\生升\Desktop\未来\浏览器操作工具\dsh-browser-tool
```

安装前先装依赖（本地目录安装会直接链接源码，依赖需在源码目录可见）：

```powershell
node <bundled-node> <bundled-pnpm> install --prod --ignore-scripts
```

本机使用 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，通过 Playwright `channel: msedge` 启动，不需要额外下载 Chromium。

## 配置

配置写在 bundle 的 `cordis.patch.yml`。当前值：

```yaml
- insert:
    - id: browser-tool
      name: '@future/dsh-browser-tool'
      config:
        mode: launch
        channel: msedge
        headless: false
        userDataDir: 'C:/Users/生升/Desktop/未来/浏览器操作工具/runtime/profile'
        artifactDir: 'C:/Users/生升/Desktop/未来/浏览器操作工具/runtime/artifacts'
        downloadsDir: 'C:/Users/生升/Desktop/未来/浏览器操作工具/runtime/downloads'
        idleCloseMs: 900000
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `mode` | `launch` | `launch` 启动独立 profile；`cdp` 连接已启动的浏览器 |
| `channel` | `msedge` | Playwright 通道：`msedge` / `chrome` / `chromium` |
| `executablePath` | 空 | 浏览器 exe 绝对路径；设置后忽略 `channel` |
| `cdpUrl` | 空 | `mode=cdp` 时的地址，例如 `http://127.0.0.1:9222` |
| `userDataDir` | `%DSH_HOME%/browser-tool/profile` | 登录态/Cookie 的持久化目录 |
| `headless` | `false` | 需要人工登录/验证码时必须为 false |
| `artifactDir` | `%DSH_HOME%/browser-tool/artifacts` | 截图、全文、采集 JSON |
| `downloadsDir` | `%DSH_HOME%/browser-tool/downloads` | 下载文件 |
| `actionTimeoutMs` | `15000` | 单步动作超时 |
| `navigationTimeoutMs` | `45000` | 页面导航超时 |
| `snapshotMaxChars` | `12000` | 快照上限 |
| `extractMaxChars` | `30000` | 提取返回上限（超出落盘） |
| `collectConcurrency` | `2` | 批量采集默认并发，最大 4 |
| `collectDelayMs` | `800` | 批量采集每条间隔 |
| `idleCloseMs` | `900000` | 空闲 15 分钟后自动关闭；0 表示不自动关 |
| `networkMaxEntries` | `80` | 网络记录条数上限 |
| `networkMaxBodyChars` | `120000` | 单条响应体上限 |

> 插件通过 `apply(ctx, rawConfig)` 自己解析配置；不导出 `Config`，因为当前 Loader 期望 `Config` 是带 `validate()` 的 schemastery 对象。字段仍以本文和 `index.js` 的 `ConfigSchema` 为准。

### 使用已登录的真实浏览器（推荐给企查查）

独立 profile 第一次用企查查需要手动登录。若希望直接复用你日常浏览器的登录态，用 CDP：

1. 完全退出那个浏览器，再用调试端口启动（示例为 Edge）：

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\Users\生升\Desktop\未来\浏览器操作工具\runtime\cdp-profile"
```

2. 把插件配置改为：

```yaml
config:
  mode: cdp
  cdpUrl: 'http://127.0.0.1:9222'
  headless: false
```

3. 重新加载插件后调用 `browser_open`。CDP 模式下 `browser_close` 只断开连接，不关闭你已有的标签页。

## 设计要点

- **快照引用而不是 CSS/坐标**：每次快照重建 `data-dsh-ref`；动作只接受 `@eN`，引用过期会明确报错并要求重新快照。
- **跨 frame**：主文档和同源/跨域 iframe 分别快照；用 `data-dsh-frame` 链定位，`browser_act` 可直接操作 iframe 内的引用。
- **登录态是资产**：`userDataDir` 持久化；浏览器空闲关闭也不丢 Cookie。
- **批处理不抢当前页**：`browser_collect` 用后台标签页，共享同一 context 的 Cookie，默认并发 2 + 延迟。
- **证据链**：截图保存绝对路径；提取超长时保留完整文件并返回 `savedPath`；网络捕获保留接口原始响应。
- **不绕过验证**：没有 stealth 插件、验证码识别或风控绕过。遇到验证码/登录时，工具把窗口留在前台，由用户完成。

## 已知限制

- 依赖本机 Edge/Chromium；没有浏览器时 `browser_open` 会报错并给出安装/`executablePath` 提示。
- 同一 `userDataDir` 不能被两个浏览器进程同时占用。上一个进程没退干净时，关闭它或换 profile。
- 站点可能对自动化访问返回 403/405/WAF 页面。工具会把“访问被阻断/安全威胁”标进快照提示，但不会绕过。
- Canvas、封闭 Shadow DOM、纯视觉内容无法可靠快照；用截图 + 人工判断兜底。
- `browser_download` 直接 URL 模式走 `context.request`，与页面内 JS 触发的下载在少数站点上行为不同；优先点击元素模式。

## 验证

- `test/smoke.mjs`：Edge + example.com，打开、快照、提取、整页截图。
- 实机验证：`browser_open`、`browser_extract`（labeled）、`browser_screenshot`、`browser_download` 直接 URL 模式均通过。
- `test/deep.mjs`：本地 HTTP 页面，23 项断言覆盖 ref 点击、填表、iframe、表格、labeled/structured、network、截图、标签页、弹出标签、批量采集。
- `test/qcc.mjs` / `test/qcc-detail.mjs`：企查查首页与公开公司详情页的真实读取（详见项目根目录 `docs/企查查工作流.md`）。

运行测试（需要能启动本机浏览器）：

```powershell
node .\test\deep.mjs
```

测试会在插件目录的 `runtime/` 下创建临时 profile 和截图；这些目录不参与发布，安装前可删除。
