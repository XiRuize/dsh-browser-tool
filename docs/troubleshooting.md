# 常见问题（troubleshooting）

按「现象 → 原因 → 处理」组织。命令默认在 PowerShell 下执行。

## 浏览器配置目录锁

**现象**

```text
Error: 浏览器配置目录已被占用：C:\Users\...\browser-tool\profile
```

或 Playwright 报 `Target page, context or browser has been closed` / `ProcessSingleton`。

**原因**

同一个 `userDataDir` 同时只允许一个 Chromium 进程。常见于：上一个进程没退干净、两个 DSH 实例同时运行、手动开过同目录的浏览器。

**处理**

```powershell
# 找出仍占用的 Edge 进程
Get-Process msedge -ErrorAction SilentlyContinue | Select-Object Id, Path

# 确认是插件拉起的 profile 后再结束
Stop-Process -Id <PID>
```

或改用另一个 profile：

```yaml
config:
  userDataDir: 'C:/Users/生升/.dsh/browser-tool/profile-b'
```

不要在浏览器还开着时删除 `userDataDir`，会损坏登录态。

## Edge 不存在 / 启动失败

**现象**：`Executable doesn't exist at ...` 或「没有找到可用的浏览器」。

**原因**：本机没装 Edge/Chrome，或 `channel` / `executablePath` 指向错误。

**处理**

1. 确认 Edge 路径：

```powershell
Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
Test-Path 'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
```

2. 显式指定：

```yaml
config:
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
```

3. `executablePath` 设置后会忽略 `channel`，不要再同时依赖 `channel`。

## headless 被站点拦截

**现象**：返回 403/405、WAF 页面、空白页、验证码页；`browser_collect` 的 `blocked` 计数上升。

**原因**：站点检测无头浏览器、IP、请求频率或行为。

**处理**

- 换 `visibility: offscreen` 再试，仍可能被拦。
- 需要人工登录/验证时用 `visibility: window`，由人完成后切回。
- 降低 `collectConcurrency`、增大 `collectDelayMs`，不要压测站点。
- **不要**尝试 stealth 补丁或验证码绕过；插件不提供，也不接受此类 PR。

## 产物目录权限

**现象**：`EACCES`、`EPERM`、`ENOENT`，截图/提取落盘失败。

**原因**：`artifactDir` / `downloadsDir` 不存在、只读、被安全软件拦截，或路径越界。

**处理**

```powershell
$dir = 'C:\Users\生升\.dsh\browser-tool\artifacts'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Test-Path $dir
```

- 确认配置是绝对路径且父目录存在。
- 绝对路径产物需要 `allowAbsoluteArtifacts: true`，默认关闭。
- Windows Defender 受控文件夹访问可能阻止写入，临时放行或换目录。

## Playwright 版本不匹配

**现象**：`browserType.launchPersistentContext: Protocol error`、`Cannot find module 'playwright-core'`、接口行为与文档不符。

**原因**：`node_modules` 缺失、版本与 `package.json` 不一致、profile 与源码目录混用。

**处理**

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'

Set-Location 'C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool'
& $node $pnpm install --prod --ignore-scripts
& $node -e "console.log(require('./node_modules/playwright-core/package.json').version)"
```

期望版本与 `package.json` 的 `playwright-core` 一致（当前 `1.64.1`）。升级 Playwright 时同步验证 Edge 通道。

## 工具未出现（bundle 未组合）

**现象**：模型看不到 `browser_*`；`browser_status` 不存在；日志没有插件加载记录。

**原因**：bundle 没写进 profile 组合、DSH 版本不满足 `engines.dsh`、patch 路径错误、apply 抛错。

**处理**

```text
plugin_manager action=list_plugins
```

- 没有条目 → 重新 `install_bundle`，然后重启 GUI。
- 有条目但 disabled → 启用后重载。
- 有条目、enabled，仍无工具 → 看 DSH 日志中的 apply 错误；常见是 `inject: ['tools']` 未满足或 `cordis.patch.yml` 语法错误。
- 检查 `package.json` 的 `dsh.bundle.patch` 指向的文件存在。

> 当前桌面 profile 曾出现「组合里没有浏览器插件条目」的问题。这不是工具逻辑错误，按 [`installation.md`](installation.md) 重装并确认组合即可。

## 页面操作后状态不对

- 引用过期：重新 `browser_observe` / `browser_snapshot`，不要复用旧 `@eN`。
- 元素被遮挡：先 `scroll` 或 `waitFor`，再点击。
- 弹窗/对话框：`browser_act` 返回后检查 `dialog` 字段；需要时先处理弹窗。
- 页面被导航：重新解析 `tab`，确认 URL。
- 多个子代理互相覆盖：用工作区与 per-tab 锁，见 [`subagents.md`](subagents.md)。

## 空闲后浏览器消失

- 检查 `idleCloseMs`：`0` 表示不自动关闭；非 0 会在空闲后关闭。
- `browser_status` 看 `connected` 与 `lastError`。
- 崩溃后下一次调用会自动重启一次；连续失败时检查配置目录锁与磁盘。

## 下载失败

- 直接 URL 模式走 `context.request`，与页面内 JS 触发的下载在少数站点行为不同；优先用点击元素模式。
- 确认 `downloadsDir` 可写。
- 大文件超时：增大 `timeoutMs`。

## 内存/标签页增长

- 检查 `maxTabs`（默认 24）。
- 批量采集结束会关闭自己的标签页；手动开的标签页用 `browser_tabs close` 清理。
- 长时间运行后 `browser_status` 看 `pages` 数量；异常增长时关闭无用标签页。

## 收集日志与最小复现

报告问题前请准备：

1. `browser_status` 输出（脱敏）；
2. 触发问题的工具与参数；
3. 错误消息全文；
4. DSH 版本、Node 版本、Playwright 版本、Edge 版本；
5. 是否为 `launch` / `cdp`，`visibility` 是什么。

不要附带真实账号 Cookie、手机号、身份证等敏感数据。
## 启动失败：exitCode=21 / Target page, context or browser has been closed

**现象**：调用任意 `browser_*` 时报 `browserType.launchPersistentContext: Target page, context or browser has been closed`，
Playwright 日志里能看到 `<process did exit: exitCode=21>`。

**原因**：上一次崩溃、强杀或脚本异常退出后，仍有 msedge 进程占着 `userDataDir`（或残留 `lockfile`），
新进程拿不到 profile，Chromium 以 21 退出。错误文本里没有 `profile/locked` 字样，容易被误判成「没装 Edge」。

**处理**

- `0.7.4+` 已内置自愈：启动前检查 `lockfile` 与同 profile 的 msedge 进程并清理；启动失败时在 Windows 上清残留后重试（最多 3 次）。
- 仍失败时手动清理（只清这个 profile，不影响你自己的浏览器）：

```powershell
Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
  Where-Object { $_.CommandLine -like '*\.dsh\browser-tool\profile*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Remove-Item "$env:USERPROFILE\.dsh\browser-tool\profile\lockfile" -Force -ErrorAction SilentlyContinue
```

- 回归验证：`$env:DSH_BROWSER_HEAL='1'; node test/heal.mjs`
- 提示文案回归：`$env:DSH_BROWSER_LOCKCHECK='1'; node test/locked-hint.mjs`（断言提示指向「配置目录被占用」而不是「没装 Edge」）

## 启动超时：Timeout NNNms exceeded

**现象**：`browserType.launchPersistentContext: Timeout 30000ms exceeded.`（阈值由 `launchTimeoutMs` 决定），
Playwright 日志里已经有 `<launched> pid=...`，但随后没有建立调试连接。
`0.7.3` 及更早版本会把它误报成「未找到可用的 Edge/Chromium：请安装 Microsoft Edge」——
**看到「请安装 Edge」但 `Test-Path` 明明存在时，就是撞到了这个误判**。

**原因**：进程起来了但 `--remote-debugging-pipe` 迟迟连不上。最常见是 `userDataDir` 被残留 msedge 进程占着
（此时新进程不会立刻退出，而是挂在 singleton 等待上），其次是被安全软件 / 受控文件夹访问 / 受限沙箱拦截。

**处理**

1. 看 `browser_status` 的「启动前清理告警」：有告警说明自愈用的 PowerShell 探测被限制了，需要手动清理。
2. 手动结束占用进程（同上一节的命令），再重试。
3. 缩小启动预算便于快速失败：`launchTimeoutMs: 20000`、`launchDeadlineMs: 40000`（两者都必须小于工具超时 90000）。
4. 需要复用已有登录浏览器时，改用 `mode: cdp` + `cdpUrl`，绕开启动环节。

