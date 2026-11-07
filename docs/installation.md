# 安装（installation）

本插件是一个 DSH bundle，安装动作由 DSH 的 `plugin_manager` 完成：它把包链接进当前 profile，并把 `cordis.patch.yml` 的条目插入 Cordis 组合。

> 本文面向 `0.2.0` 目标流程；安装结果要以 `plugin_manager` 的实际返回和 `browser_status` 为准，不要把「应该安装成功」写成事实。

## 前置条件

- DSH 版本满足 `engines.dsh >= 0.2.1-rc.5`（见 `package.json`）。
- 本机有 Edge 或 Chrome。推荐 Edge：

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

- 本机 Node / pnpm 路径（示例）：

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
```

## 安装步骤

### 1. 安装依赖

本地目录安装会链接源码树，依赖必须在源码目录可见：

```powershell
Set-Location 'C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool'
& $node $pnpm install --prod --ignore-scripts
```

验证：

```powershell
Test-Path .\node_modules\playwright-core\package.json
```

### 2. 通过 Plugin Manager 安装 bundle

在当前 DSH 会话中执行（等价于工具调用）：

```text
plugin_manager action=install_bundle target=C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool
```

- 如果提示构建脚本需要批准，确认包名后再批准；本插件依赖只有 `playwright-core`，通常无需额外构建。
- 返回 `application=applied` 表示已写入 profile；如果返回 `nextStep`，按提示重启 GUI 或重新加载插件。

### 3. 确认 profile 组合包含浏览器插件

```text
plugin_manager action=list_plugins
```

应看到类似条目（id 可能因 profile 而异）：

```text
@future/dsh-browser-tool  enabled  bundle  browser-tool
```

若没有，或工具列表里没有 `browser_*`：

1. 检查 profile 的 Cordis 组合（通常在 `~/.dsh/profiles/<profile>/` 下的 `cordis.patch.yml` 或组合文件）是否含 `browser-tool` 条目；
2. 检查 `package.json` 的 `dsh.bundle.patch` 是否指向存在的 `cordis.patch.yml`；
3. 检查 DSH 版本是否满足 `engines.dsh`；
4. 重装一次 bundle，或重启 GUI 后再看。

> **已知问题**：当前桌面 profile 的 bundle 组合里曾缺少浏览器插件条目，导致工具列表没有 `browser_*`。这属于安装/组合问题，不是工具实现问题。安装新 bundle 会替换现有的 `@future/dsh-browser-tool` 链接，重装前确认没有别的进程占用该目录。

### 4. 自检

安装后调用：

```json
{ "tool": "browser_status" }
```

期望：`loaded: true`、`connected: true` 或首次调用时自动启动、`visibility: "headless"`。

再用 example.com 做最小验证：

```text
browser_open  {"url":"https://example.com","newTab":true}
browser_observe {"layers":["text","meta"]}
browser_screenshot {"fullPage":true}
```

## 可见性模式

| 模式 | 行为 | 适用 |
|---|---|---|
| `headless` | 无窗口，后台 | 默认；大多数读取与批量任务 |
| `offscreen` | 有窗口但移出屏幕/不抢焦点 | 站点检测 headless 时的兜底；Windows 下可能仍出现在任务栏 |
| `window` | 正常可见窗口 | 人工登录、验证码、需要人观察的调试 |

切换方式（`cordis.patch.yml` 或 `browser_open` 的 `visibility` 覆盖）：

```yaml
config:
  visibility: window   # 登录时临时用
```

登录完成后改回 `headless`，避免长期占用前台。

## 三种运行模式

### launch：独立 profile（默认）

```yaml
config:
  mode: launch
  channel: msedge
  visibility: headless
  idleCloseMs: 0
```

- 默认目录由 `resolveConfig` 解析为 `~/.dsh/browser-tool/profile`、`artifactDir`、`downloadsDir`（若设置了 `$DSH_HOME` 则在其下）；`cordis.patch.yml` 不再硬编码任何 Desktop runtime 路径。
- 登录态保存在 `userDataDir`，跨进程复用。
- **沿用旧登录态**：如果旧版本把 profile 放在 `Desktop/未来/浏览器操作工具/runtime/profile`，升级后必须显式配置：

  ```yaml
  config:
    userDataDir: 'C:/Users/生升/Desktop/未来/浏览器操作工具/runtime/profile'
  ```

  否则会使用 `~/.dsh/browser-tool/profile` 这个新的空 profile，需要重新登录。
- 同一 `userDataDir` 同时只能被一个浏览器进程占用。

### cdp：连接已启动的浏览器

复用你日常浏览器的登录态。先完全退出该浏览器，再以调试端口启动：

```powershell
& 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' `
  --remote-debugging-port=9222 `
  --user-data-dir="C:\Users\生升\.dsh\browser-tool\cdp-profile"
```

配置：

```yaml
config:
  mode: cdp
  cdpUrl: 'http://127.0.0.1:9222'
  visibility: headless
```

注意：

- CDP 模式下 `browser_close` 只断开连接，不关闭你的标签页。
- 调试端口暴露给本机所有进程，用完关闭浏览器。
- 不要对生产账号长期开着调试端口。

### offscreen：兼容兜底

`visibility: offscreen` 用于需要「不是 headless」又不想抢前台的站点。它不是隐身，仍可能被检测，也可能出现在任务栏。

## bundle patch 示例

`cordis.patch.yml` 当前只写与默认不同的常用项，其余由 `resolveConfig` 补齐（目录项默认在 `~/.dsh/browser-tool/`，不再出现 Desktop 路径）：

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

需要固定目录或沿用旧登录态时，再额外加（均为可选）：

```yaml
        userDataDir: 'C:/Users/生升/Desktop/未来/浏览器操作工具/runtime/profile'
        artifactDir: 'C:/Users/生升/.dsh/browser-tool/artifacts'
        downloadsDir: 'C:/Users/生升/.dsh/browser-tool/downloads'
        maxTabs: 24
        allowEval: false
        allowAbsoluteArtifacts: false
```

- 这是**本仓库自带的默认 patch**；安装到 profile 后，profile 侧的组合可能覆盖或合并它。
- 不导出 `Config` / `ConfigSchema`：Loader 直接调用 `apply(ctx, rawConfig)`，`lib/config.js` 负责归一化与默认值。
- 不要手工编辑 profile 的 `package.json`；用 `plugin_manager` 重装。
- 改配置后通常需要重新加载插件或重启 GUI 才生效。

## 发布前检查（npm / bundle 打包）

`package.json` 的 `files` 当前只列了 `README.md`。正式发布到 npm 或打 bundle 包前，需要由 core-host 模块补齐：

- `README.en.md`
- `docs/`（架构、工具、安装、排错、提案、验收模板）
- `skills/`（`browser-field-ops` 技能）
- `SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`
- `LICENSE`（npm 通常自动包含，但显式列出更稳）

本文只做提醒，不修改 `package.json`。

## 卸载 / 回滚

```text
plugin_manager action=remove_bundle target=@future/dsh-browser-tool
```

- 卸载只移除 bundle 组合，不删除 `userDataDir` / `artifactDir` 里的登录态与产物。
- 回滚到旧版本：重新安装旧目录，或 `git checkout` 旧 tag 后重装。

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具列表没有 `browser_*` | bundle 未组合 / DSH 版本不满足 / patch 路径错误 | 见上文第 3 步；重装并重启 |
| `Configuration directory is already in use` | 同一 `userDataDir` 被两个进程占用 | 关闭旧浏览器进程，或换 profile |
| `Executable doesn't exist` | 没有 Edge 或路径不对 | 设置 `executablePath`，或安装 Edge |
| `EACCES` / 权限拒绝 | 产物目录不可写 | 换 `artifactDir` 或修目录权限 |
| 插件加载但无工具 | `ctx.tools` 未注入 / apply 抛错 | 看 DSH 日志，确认 `inject: ['tools']` |
| 页面一直加载 | 站点慢或风控 | 增大 `navigationTimeoutMs`，换 `offscreen` 重试 |

更多见 [`troubleshooting.md`](troubleshooting.md)。

## 安装验收记录

实际安装与实机验证结果由 install-verify 模块写入 [`install-verification.md`](install-verification.md)。该文件当前是模板，**不代表已验收**。
