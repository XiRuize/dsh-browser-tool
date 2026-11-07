# 安装与实机验收记录（模板）

> **状态：待安装模块填写。** 本文件目前是模板，不代表任何验证已经完成。`0.2.0` 尚未发布，也尚未通过完整实机验收。
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

## 安装步骤记录

| 步骤 | 命令 / 操作 | 结果 | 备注 |
|---|---|---|---|
| 依赖安装 | `& $node $pnpm install --prod --ignore-scripts` | 待填 | |
| bundle 安装 | `plugin_manager install_bundle target=<bundle 目录>` | 待填（期望 `application=applied`） | |
| 组合检查 | `plugin_manager list_plugins` | 待填 | 是否出现 `browser-tool` |
| 重启 / 重载 | 待填 | 待填 | 是否需要重启 GUI |
| 工具可见 | 主代理工具列表含 `browser_*` | 待填 | |

## 验收清单

逐项勾选，并附证据（路径 / 输出片段）。**未实际执行的项保持未勾选。**

- [ ] `browser_status` 返回 `loaded: true` 与运行模式
- [ ] 默认 `headless` 打开 `https://example.com`，窗口不抢焦点
- [ ] `browser_observe` 的 `structure` / `text` / `meta` 分层返回
- [ ] `browser_observe` 的 `visual` 产物可被 `read_image` 打开
- [ ] `browser_act` 点击后返回回读核验结果
- [ ] `browser_extract`（`labeled` 或 `text`）成功
- [ ] `browser_screenshot` 返回路径、尺寸、字节数
- [ ] `browser_inspect` 的 `dom` / `html` / `css` / `a11y` 有合理输出
- [ ] `browser_inspect` 的 `eval` 在 `allowEval=false` 时被拒绝
- [ ] 空闲 30 分钟不自动关闭（`idleCloseMs=0`）
- [ ] 强制结束浏览器进程后，下一次调用自动恢复
- [ ] 两个子代理在各自 workspace/tab 并行，ref 不串页
- [ ] reader 角色调用写工具被拒绝
- [ ] `browser_collect` 中断后从 checkpoint 续跑，不重复已完成 URL
- [ ] 产物越界绝对路径被拒绝（`allowAbsoluteArtifacts=false`）

## 证据

| 项 | 路径 / 输出 |
|---|---|
| `browser_status` 输出 | 待填（脱敏） |
| 截图样本 | 待填 |
| 结构报告样本 | 待填 |
| 恢复日志 | 待填 |
| 续跑 checkpoint | 待填 |

## 剩余风险

待填。建议至少记录：

- 站点对 headless 的拦截情况；
- `offscreen` 在 Windows 任务栏的可见性；
- 多子代理下的内存与标签页增长；
- 与 profile 中其它 bundle 的冲突；
- 未覆盖的验收项及原因。

## 结论

待填。**在完成上述清单前，不要写「已验收通过」。**
