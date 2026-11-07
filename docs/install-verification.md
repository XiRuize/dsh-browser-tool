# 安装与实机验收记录

> **状态：已执行 install-verify（2026-11-07）。** `0.2.0` 已安装到 desktop profile 并加载 14 个 `browser_*` 工具；代码单测、live Host 验收与自动化 E2E（60/60）均已通过，结论为**已验收通过**。30 分钟空闲墙钟、真实站点 WAF、offscreen、eval 开启仍为未覆盖风险。
>
> 负责人：install-verify 模块（只读代码，不改源码）。本文件只记录实际执行结果，未执行项写 `SKIP` 并说明原因。

## 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-07 14:49–14:55（Asia/Shanghai） |
| 操作系统 | Microsoft Windows 11 家庭版 中文版 10.0.26200（build 26200） |
| DSH 版本 | desktop `0.2.2-rc.1`（`.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json`） |
| Node 版本 | `v24.21.0`（`C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`） |
| pnpm 版本 | `11.28.5`（runtime.json） |
| Playwright 版本 | `playwright-core 1.64.1`（`node_modules/playwright-core/package.json`） |
| 浏览器 | Microsoft Edge `142.0.3595.94`（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`） |
| 运行模式 | `launch`（`browser_status`） |
| 可见性 | `headless`（`browser_status`） |
| bundle 目录 | `C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool` |
| profile 链接 | `C:\Users\生升\.dsh\profiles\desktop\node_modules\@future\dsh-browser-tool` → Junction → 上述 bundle 目录 |
| 插件版本 | `@future/dsh-browser-tool 0.2.0`（`package.json`） |
| 安装时间 | 2026-11-07 14:42:55（`+ @future/dsh-browser-tool 0.2.0`，pnpm 日志 `operation-wP1BAy`）；14:49:18 再次解析 link（`operation-xKE56U`） |
| 测试服务 | `http://127.0.0.1:62280`（`test/live-server.mjs`，PID 2176，HTTP 200） |

## 验收命令（逐条执行并记录）

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
Set-Location 'C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool'

# 1. 依赖与语法
& $node --check .\index.js
Get-ChildItem .\lib -Filter *.js | ForEach-Object { & $node --check $_.FullName }

# 2. 无浏览器单测
& $node .\test\unit.mjs

# 3. 实机深测 / 全量 E2E（需要本机 Edge；headless）
$env:DSH_BROWSER_E2E='1'
& $node .\test\deep.mjs
& $node .\test\e2e.mjs
```

安装与工具可见性（通过 DSH 工具调用，不是 shell）：

```text
plugin_manager action=install_bundle target=C:\Users\生升\Documents\deepseek-harness\default-workspace\browser-tool
plugin_manager action=list_plugins
browser_status
```

## 自动化测试实际结果

| 命令 | exit code | 结果 | 证据 |
|---|---|---|---|
| `node --check .\index.js` | 0 | PASS | 无语法错误 |
| `node --check .\lib\*.js`（16 个文件） | 0 | PASS | 16/16 通过 |
| `node .\test\unit.mjs` | 0 | **PASS 15/15，0 FAIL** | 末尾 `UNIT RESULT 15/15 PASS, 0 FAIL, 1621ms` |
| `$env:DSH_BROWSER_E2E='1'; node .\test\deep.mjs` | 0 | **PASS 23/23，0 FAIL** | 末尾 `DEEP RESULT 23 PASS, 0 FAIL` |
| `$env:DSH_BROWSER_E2E='1'; node .\test\e2e.mjs` | 0 | **PASS 60/60，0 FAIL** | 末尾 `E2E RESULT PASS (60 assertions)` |

E2E 复跑记录（2026-11-07 15:01，真实 Edge headless）：

```text
DEEP RESULT 23 PASS, 0 FAIL
E2E RESULT PASS (60 assertions)
```

此前 `test/e2e.mjs:164` 曾把 `verify.selected`（label 列表）当作 value 断言，导致 30 assertions 后中止；tests-verify 已按契约修正为 `verify.value==='b'` + `verify.selected===['选项B']`（容器 select 为 `b2` / `['选项B2']`）。本次复跑后覆盖 act select/check、container、network/HAR、collect 22 条续跑、workspace reader ACL、closeTabs 等全部 60 条断言。

## 安装结果

| 步骤 | 命令 / 操作 | 实际结果 | 备注 |
|---|---|---|---|
| 依赖安装 | `pnpm install --prod --ignore-scripts` | SKIP（未重复执行） | `node_modules/playwright-core` 已是 `1.64.1`；插件已安装，按要求不重装 |
| 语法检查 | `node --check` | PASS | `index.js` + 16 个 `lib/*.js` 全部 exit 0 |
| 无浏览器单测 | `test/unit.mjs` | PASS 15/15 | 0 FAIL，1621ms |
| bundle 安装 | `plugin_manager install_bundle`（主协调代理执行） | PASS（application applied，依据 profile 与日志） | 本子代理未重装；核对 `profile/package.json` 的 `dsh.profile.bundles` 含 `@future/dsh-browser-tool`，pnpm 日志 `+ @future/dsh-browser-tool 0.2.0` |
| 组合检查 | `plugin_manager list_plugins` | PASS | `include:browser-tool`，`moduleName=@future/dsh-browser-tool`，`enabled=true`，`fiberPhase=active` |
| 重启 / 重载 | 当前 Host 已加载 | PASS | 本次会话直接可用，无需重启 GUI |
| 工具可见 | 工具列表 | PASS | 14 个：`browser_open/close/status/snapshot/observe/inspect/act/extract/screenshot/network/collect/download/tabs/workspace` |
| 实机深测 | `test/deep.mjs` | PASS 23/23 | 真实 Edge、headless、独立临时 profile |
| 自动化 E2E | `test/e2e.mjs` | PASS 60/60 | exit 0；真实 Edge headless，独立临时 profile |

## 验收项与结果

状态列只填：`PASS` / `FAIL` / `SKIP(原因)`，并附证据。

| # | 验收项 | 命令 / 工具调用 | 期望 | 实际 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| 1 | `browser_status` 可用 | `browser_status` | 扁平对象，`loaded:true`、`visibility:"headless"` | 已连接、mode=launch、visibility=headless、Edge 142.0.3595.94、restart=2 | PASS | `浏览器：已连接 ｜ 模式 launch ｜ 可见性 headless ｜ 状态 ready` |
| 2 | 默认 headless 打开 | `browser_open {"url":"http://127.0.0.1:62280/","newTab":true}` | 窗口不抢焦点，返回 page+snapshot | 打开成功，标签 t15/t19/t26，headless 无前台窗口 | PASS | `已打开 http://127.0.0.1:62280/`；`browser_status` visibility=headless |
| 3 | 分层观测 structure/text/meta | `browser_observe {"layers":["structure","text","visual","meta","console"],"save":true}` | 各层分别返回 | 5 层均返回；nextCursor=(无)；产物 5 个 + manifest | PASS | `C:\Users\生升\.dsh\browser-tool\artifacts\observe-*20261107_145128.*`；`artifacts\manifest.jsonl` |
| 4 | visual 截图可打开 | `browser_observe {"layers":["visual"],"save":true}` + `read_image` | `artifacts` 含对象，PNG 可查看 | `observe-view-*.png` 47499 B，1440×900，已用 `read_image` 成功读取 | PASS | `C:\Users\生升\.dsh\browser-tool\artifacts\observe-view-20261107_145128.png` |
| 5 | 动作回读核验 | `browser_act {"action":"type","selector":"#q","value":"阿里巴巴","verify":true}` | `verify.value === "阿里巴巴"` | `回读 value="阿里巴巴"`，verify.ok=true | PASS | t15；随后 writer 场景 type `install-verify-writer` 亦回读通过 |
| 6 | 提取 labeled/text | `browser_extract {"mode":"text","limit":300}`；`{"mode":"labeled","labels":[...]}` | 返回内容或 `savedPath` | text 截断并落盘；labeled 返回 3 个字段 | PASS | `artifacts\extract-20261107_145301.txt`；labeled 返回 `91310000TEST/张三/1000万元` |
| 7 | 截图 | `browser_screenshot {"fullPage":true}` | 返回 path/width/height/bytes | 1440×900，11321 B，整页；`read_image` 可读 | PASS | `C:\Users\生升\.dsh\browser-tool\artifacts\verify-install-popup.png` |
| 8 | inspect dom/html/css/a11y | `browser_inspect` 四种 mode | 返回可读结构 | dom 10 节点；html 637 字符 outerHTML；css display/font-size/color；a11y ariaSnapshot | PASS | t15/t26；另测 overview/resources/scripts/storage/performance 均返回 |
| 9 | eval 默认拒绝 | `browser_inspect {"mode":"eval","script":"1+1"}` | 在 `allowEval=false` 时报错 | 抛错：`任意 JS 执行默认关闭，请在插件配置中显式设置 allowEval: true` | PASS | 未执行任意 JS |
| 10 | storage 默认脱敏 | `browser_inspect {"mode":"storage"}` | `redacted:true`，无原值 | `redacted:true`、`includeSecrets:false`；cookie 无 `value`，local/sessionStorage 为空 | PASS | 19 个 cookie 仅元数据 |
| 11 | 空闲不自动关闭 | 等待 ≥30 分钟后再调用 | `connected:true`，未自行关闭 | 未做 30 分钟墙钟测试；代码/配置校验 `idleCloseMs=0`，`scheduleIdleClose` 在 `<=0` 时直接返回；本次运行约 6 分钟保持连接 | SKIP(未做 30 分钟墙钟；配置与代码校验通过) | `lib/config.js:107`；`lib/manager.js:120-129`；`browser_status` 不显示自动关闭 |
| 12 | 崩溃恢复 | 强制结束浏览器进程后调用工具 | 自动重启并返回恢复提示 | `Stop-Process -Force -Id 1296` 后 status 显示未启动、`重启 1 次`、最近错误「浏览器窗口已关闭…自动重启」；`browser_open` 自动重启成功，`重启 2 次`，当前 root PID 28976 | PASS | PID 1296（root）→ 28976；`browser_status` 重启次数 0→1→2 |
| 13 | 工作区隔离 | 两个工作区各自 tab | ref 不串页、active tab 不互相覆盖 | 主工作区 `ws-mw61iatn-4awg08`（t10/t14）；本代理工作区 `ws-mw61q7kl-k2z3dk`（t19/t26）；跨工作区 observe 正常，写操作按工作区 ACL 隔离 | PASS | 两工作区并存；t10/t14 与 t19/t26 各自 owner/role 正确 |
| 14 | reader 不能写 | reader 调 `browser_act` | 明确拒绝 | 中文 ACL 错误：`代理 8f3819c2-… 在工作区 ws-mw61iatn-4awg08（e2e-main）中是只读成员（reader），不能对标签页 t10 执行写操作。` | PASS | reader 加入后 click t10 被拒；同工作区 observe t10/t14 成功 |
| 15 | collect 续跑 | 2 URL + `jobId`，第二次带 `cursor` | `doneUrls` 去重、不重复抓取 | 首次 2/2 成功；续跑 `本次 0 条`；checkpoint `nextCursor=2`、`done=true`、`doneUrls=2`、`failed=0` | PASS | `artifacts\jobs\verify-install-collect\checkpoint.json`；`collect-20261107_145207/145208.json` |
| 16 | 产物越界拒绝 | `browser_screenshot {"path":"C:/Windows/x.png"}` | `allowAbsoluteArtifacts=false` 时拒绝 | 抛错：`产物路径越界：拒绝使用绝对路径 C:/Windows/x.png` | PASS | 未写入 `C:\Windows` |
| 17 | HAR 导出 | `browser_network start` → 点击「加载接口」→ `list/get` → `export` | 返回 `harPath`、`entryCount` | 捕获 n1 `GET /api/company` 200；HAR 落盘 2882 B、entries=1；cookie/auth 已脱敏 | PASS | `C:\Users\生升\.dsh\browser-tool\artifacts\verify-install.har` |
| 18 | claim/release | `browser_tabs` 两动作 | owner 正确变化 | release t19 后 owner 清空；claim 后 owner=本代理、ws=`ws-mw61q7kl-k2z3dk`、role=writer | PASS | t19 owner 8f3819c2-…；`browser_tabs list` 可核对 |

## 证据索引

| 项 | 路径 / 输出 |
|---|---|
| `browser_status` 输出 | `浏览器：已连接 ｜ 模式 launch ｜ 可见性 headless ｜ 状态 ready`；版本 142.0.3595.94；重启 2 次；活动标签 t26 |
| 截图样本 | `C:\Users\生升\.dsh\browser-tool\artifacts\verify-install-popup.png`（1440×900，11321 B） |
| observe 分层产物 | `artifacts\observe-view-20261107_145128.png`、`observe-structure-…json`、`observe-text-…txt`、`observe-meta-…json`、`observe-console-…json` |
| 产物清单 | `C:\Users\生升\.dsh\browser-tool\artifacts\manifest.jsonl`（每条含 kind/path/bytes/sha256/tabId） |
| 提取落盘 | `artifacts\extract-20261107_145301.txt` |
| 恢复日志 | root PID 1296 被 `Stop-Process -Force`；status 显示 `重启 1 次` + 最近错误；重启后 root PID 28976，status `重启 2 次` |
| 续跑 checkpoint | `artifacts\jobs\verify-install-collect\checkpoint.json`（`nextCursor=2`、`done=true`、`doneUrls` 2 条） |
| HAR 文件 | `artifacts\verify-install.har`（2882 B，1 entry，`/api/company` 200） |
| 安装/组合 | `C:\Users\生升\.dsh\profiles\desktop\package.json`；`plugin_manager list_plugins` 的 `include:browser-tool` active |

## 剩余风险

- **自动化 E2E 已全绿，但覆盖面有限**：`test/e2e.mjs` 60/60、`test/deep.mjs` 23/23，均使用本地回环页面；真实站点 WAF、验证码、限流与慢页仍未覆盖。
- **30 分钟空闲**：未做墙钟测试；仅验证默认 `idleCloseMs=0` 与 `scheduleIdleClose` 早退逻辑，长时间驻留仍需实机观察。
- **真实站点 WAF**：仅用本地 `127.0.0.1:62280`，未验证真实站点对 headless 的拦截、验证码或限流。
- **`offscreen` 任务栏可见性**：未测试；默认 `headless`，`offscreen` 在 Windows 任务栏的表现未知。
- **`eval` 未开启**：`allowEval=false` 符合安全默认；本次未验证开启后的执行能力。
- **GitHub 未推送**：仓库无 remote（`git remote -v` 为空），提交 `88b6367` 仅在本地；未执行 `git commit`/`git push`。
- **多子代理内存/标签页增长**：本次两个工作区约 10+ 标签页，未做长时间、多代理压力测试。
- **profile 路径编码**：`profile/package.json` 中 link 路径在 PS 5.1 下显示为乱码（`C:/Users/鐢熷崌/...`），但 Junction 目标与 `node_modules/@future/dsh-browser-tool` 实际解析正确；属显示/编码层注意项，非本次安装失败。

## 结论

**已验收通过（代码 + live Host + 自动化 E2E）。**

- 安装：`@future/dsh-browser-tool 0.2.0` 已进入 `desktop` profile，`include:browser-tool` 为 `active`，14 个 `browser_*` 工具可用。
- 代码：`index.js` 与 16 个 `lib/*.js` 语法通过；`test/unit.mjs` 15/15 PASS；`test/deep.mjs` 23/23 PASS；`test/e2e.mjs` 60/60 PASS。
- live Host：18 项验收中 17 项 PASS、1 项 SKIP（30 分钟空闲未做墙钟）；崩溃恢复、reader ACL、collect 续跑、HAR、popup 接管、产物越界拒绝均实测通过。
- 未覆盖/剩余风险：30 分钟空闲墙钟、真实站点 WAF、offscreen 任务栏表现、`allowEval=true` 后的执行能力、多子代理长时间压力、GitHub 远端推送。建议后续在真实站点与长时任务中继续观察。
