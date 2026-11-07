# 安装与实机验收记录（模板）

> **状态：待 install-verify 填写。** 本文件目前是模板，不代表任何验证已经完成。`0.2.0` 代码已落地，但真实 Edge 端到端验收尚未执行；在完成下文表格前，不要写「已验收通过」。
>
> 负责人：install-verify 模块（只读代码，不改源码）。

## 环境

| 项 | 值 |
|---|---|
| 日期 | 待填 |
| 操作系统 | 待填（如 Windows 11 24H2） |
| DSH 版本 | 待填 |
| Node 版本 | 待填 |
| Playwright 版本 | 待填（期望 `1.64.1`） |
| 浏览器 | 待填（Edge / Chrome 版本） |
| 运行模式 | 待填（`launch` / `cdp`） |
| 可见性 | 待填（`headless` / `offscreen` / `window`） |
| bundle 目录 | `C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool` |

## 验收命令（逐条执行并记录）

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
Set-Location 'C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool'

# 1. 依赖与语法
& $node $pnpm install --prod --ignore-scripts
& $node --check .\index.js
Get-ChildItem .\lib -Filter *.js | ForEach-Object { & $node --check $_.FullName }

# 2. 无浏览器单测（存在才跑）
if (Test-Path .\test\unit.mjs) { & $node .\test\unit.mjs }

# 3. 实机深测（需要本机 Edge；不在 CI 跑）
if (Test-Path .\test\deep.mjs) { & $node .\test\deep.mjs }
```

安装与工具可见性（通过 DSH 工具调用，不是 shell）：

```text
plugin_manager action=install_bundle target=C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool
plugin_manager action=list_plugins
browser_status
```

## 安装结果

| 步骤 | 命令 / 操作 | 实际结果 | 备注 |
|---|---|---|---|
| 依赖安装 | `pnpm install --prod --ignore-scripts` | 待填 | |
| 语法检查 | `node --check` | 待填 | |
| 无浏览器单测 | `test/unit.mjs`（若存在） | 待填 | |
| bundle 安装 | `plugin_manager install_bundle` | 待填（期望 `application=applied`） | |
| 组合检查 | `plugin_manager list_plugins` | 待填 | 是否出现 `browser-tool` |
| 重启 / 重载 | 待填 | 待填 | 是否需要重启 GUI |
| 工具可见 | 主代理与子代理工具列表含 14 个 `browser_*` | 待填 | |
| 实机深测 | `test/deep.mjs` | 待填 | 记录通过/失败数 |

## 验收项与结果

状态列只填：`通过` / `失败` / `未执行` / `不适用`，并附证据（路径或输出片段）。

| # | 验收项 | 命令 / 工具调用 | 期望 | 实际 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| 1 | `browser_status` 可用 | `browser_status` | 扁平对象，`loaded:true`、`visibility:"headless"` | 待填 | 未执行 | |
| 2 | 默认 headless 打开 | `browser_open {"url":"https://example.com"}` | 窗口不抢焦点，返回 page+snapshot | 待填 | 未执行 | |
| 3 | 分层观测 structure/text/meta | `browser_observe {"layers":["structure","text","meta"]}` | 三层分别返回 | 待填 | 未执行 | |
| 4 | visual 截图可打开 | `browser_observe {"layers":["visual"],"save":true}` + `read_image` | `artifacts` 含对象，PNG 可查看 | 待填 | 未执行 | |
| 5 | 动作回读核验 | `browser_act {"action":"type","ref":"@e1","value":"test","verify":true}` | `verify.value === "test"` | 待填 | 未执行 | |
| 6 | 提取 labeled/text | `browser_extract {"mode":"text","limit":2000}` | 返回内容或 `savedPath` | 待填 | 未执行 | |
| 7 | 截图 | `browser_screenshot {"fullPage":true}` | 返回 path/width/height/bytes | 待填 | 未执行 | |
| 8 | inspect dom/html/css/a11y | `browser_inspect` 四种 mode | 返回可读结构 | 待填 | 未执行 | |
| 9 | eval 默认拒绝 | `browser_inspect {"mode":"eval","script":"1+1"}` | 在 `allowEval=false` 时报错 | 待填 | 未执行 | |
| 10 | storage 默认脱敏 | `browser_inspect {"mode":"storage"}` | `redacted:true`，无原值 | 待填 | 未执行 | |
| 11 | 空闲不自动关闭 | 等待 ≥30 分钟后再调用 | `connected:true`，未自行关闭 | 待填 | 未执行 | |
| 12 | 崩溃恢复 | 强制结束浏览器进程后调用工具 | 自动重启并返回恢复提示 | 待填 | 未执行 | |
| 13 | 工作区隔离 | 两个子代理各自 workspace/tab | ref 不串页、active tab 不互相覆盖 | 待填 | 未执行 | |
| 14 | reader 不能写 | reader 调 `browser_act` | 明确拒绝 | 待填 | 未执行 | |
| 15 | collect 续跑 | 100 URL + `jobId`，第二次带 `cursor` | `doneUrls` 去重、不重复抓取 | 待填 | 未执行 | |
| 16 | 产物越界拒绝 | `browser_screenshot {"path":"C:/Windows/x.png"}` | `allowAbsoluteArtifacts=false` 时拒绝 | 待填 | 未执行 | |
| 17 | HAR 导出 | `browser_network {"action":"start"}` → 触发请求 → `export` | 返回 `harPath`、`entryCount` | 待填 | 未执行 | |
| 18 | claim/release | `browser_tabs` 两动作 | owner 正确变化 | 待填 | 未执行 | |

## 证据索引

| 项 | 路径 / 输出 |
|---|---|
| `browser_status` 输出 | 待填（脱敏） |
| 截图样本 | 待填 |
| 观测/结构报告 | 待填 |
| 恢复日志 | 待填 |
| 续跑 checkpoint | 待填 |
| HAR 文件 | 待填 |

## 剩余风险

待填。建议至少记录：

- 站点对 headless 的拦截情况；
- `offscreen` 在 Windows 任务栏的可见性；
- 多子代理下的内存与标签页增长；
- 与 profile 中其它 bundle 的冲突；
- 未覆盖的验收项及原因。

## 结论

待填。**在完成上述清单前，不要写「已验收通过」。**
