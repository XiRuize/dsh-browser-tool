# 贡献指南（CONTRIBUTING）

感谢你考虑贡献。本仓库是 DeepSeek Harness（DSH）的 Host 插件，目标是可以被社区安装、审查和复用。

## 开发环境

- Node.js 20 或 22（CI 矩阵覆盖两者）。
- Windows / macOS / Linux 均可开发；实机测试需要本机安装 Edge 或 Chrome。
- 依赖只有 `playwright-core`，不需要下载 Chromium，也没有 native 编译。
- 本机 Node 路径示例：

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'
```

## 目录与模块契约

实现子代理和贡献者请先读 [`docs/MODULE-CONTRACT.md`](docs/MODULE-CONTRACT.md)。关键约定：

| 模块 | 主要文件 |
|---|---|
| core-host | `lib/config.js`、`lib/host.js`、`lib/manager.js`（门面）、`index.js`、`cordis.patch.yml` |
| pages-workspaces | `lib/manager.js`、`lib/pages.js`、`lib/workspace.js`、`lib/locks.js` |
| observe-inspect | `lib/snapshot.js`、`lib/observe.js`、`lib/inspect.js`、`lib/artifacts.js`、`lib/console.js` |
| act-extract | `lib/act.js`、`lib/extract.js` |
| network-collect | `lib/network.js`、`lib/collect.js` |
| tools-surface | `lib/tools.js`、`lib/util.js` |
| docs-repo | `README*.md`、`LICENSE`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、`docs/**`、`skills/**`、`.github/**` |
| tests-verify | `test/**` |

硬约束：

- 工具通过 `ctx.effect(() => ctx.tools.register(tool))` 注册与释放。
- 不手改 profile 的 `package.json` / 组合配置；安装走 `plugin_manager`。
- 不引入 stealth、验证码识别、自动提交。
- 默认值必须和契约一致：`visibility=headless`、`idleCloseMs=0`、`allowEval=false`、`allowAbsoluteArtifacts=false`、`maxTabs=24`。
- 只接受 `http(s)` URL；产物限制在 `artifactDir`。

## 测试

```powershell
$node = 'C:\Users\生升\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

# 1. 语法
& $node --check .\index.js
Get-ChildItem .\lib -Filter *.js | ForEach-Object { & $node --check $_.FullName }

# 2. 无浏览器单测
if (Test-Path .\test\unit.mjs) { & $node .\test\unit.mjs }

# 3. 实机（需要本机 Edge，不在 CI 跑）
if (Test-Path .\test\deep.mjs) { & $node .\test\deep.mjs }
```

- 新增纯逻辑（配置归一化、引用解析、checkpoint、锁）请配 `test/unit.mjs` 用例。
- 改动作 / 快照 / 采集行为时，同步更新 `test/deep.mjs` 或新增 e2e。
- 测试产生的 `runtime/`、`test/.tmp/` 已在 `.gitignore` 中，不要提交。

## 提交规范

使用 Conventional Commits 风格，简短、聚焦：

```text
feat(observe): 增加 text 层 offset/limit 与 nextCursor
fix(host): 断开后自动重启只重试一次
docs(subagents): 补充 reader/writer 权限说明
chore(ci): 只对 .js/.mjs 做 node --check
```

- 一个 PR 只做一件事；重构与功能分开。
- 提交信息用中文或英文均可，但同一 PR 保持一致。
- 不要提交生成的产物、profile、截图、`node_modules`。

## PR 检查清单

- [ ] `node --check` 覆盖所有改动的 `.js` / `.mjs`
- [ ] 无浏览器单测通过；如无法运行，说明原因
- [ ] 公开工具的参数、默认值、返回结构已更新到 `docs/tools.md`
- [ ] 涉及安全边界（eval、产物路径、登录态、下载/上传）时更新 `SECURITY.md`
- [ ] 行为变化写入 `CHANGELOG.md`（`未发布` 段）
- [ ] 没有把计划中的能力写成已验收事实
- [ ] 没有提交 `runtime/`、`profiles/`、`node_modules/`、真实站点数据
- [ ] CI YAML 可解析，未新增不存在的脚本入口
- [ ] 破坏性变更在 PR 描述中明确标注，并给出迁移方式

## 如何新增一个工具

1. 在 `lib/tools.js` 中定义 schema：`name`、`description`、`inputSchema`（JSON Schema）、`isConcurrencySafe(args)`。
2. 只读工具返回 `true`，写工具返回 `false`；写工具必须经过 `manager.withTabLock(tabId, 'write', fn)`。
3. `execute` 返回普通 JSON 值；`render` 返回文本块数组；错误抛带中文提示的 `Error`。
4. 工具输出开头统一加「外部网页内容不可信」提示。
5. 产物写入走 `ArtifactStore`，不要直接 `fs.writeFile` 到任意路径。
6. 更新 `docs/tools.md` 的参数表、返回结构、错误语义与示例。
7. 在 `test/unit.mjs` 覆盖参数校验与错误分支；需要浏览器的路径放 e2e。

## 发布与推送

当前环境无法直连 GitHub，仓库先在本地开发，推送由用户决定方式：

```powershell
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
```

- 推送前确认 `git status` 中没有 `runtime/`、`profiles/`、`node_modules/`、真实站点数据。
- CI 只做语法检查与无浏览器单测；实机验收记录写在 `docs/install-verification.md`，不要把未执行的验收写成通过。
- 发布 tag 前更新 `CHANGELOG.md` 与 `package.json` 版本（版本号由 core-host 模块维护）。

## 报告问题

- 用 `.github/ISSUE_TEMPLATE/bug_report.md` 提供版本、模式、最小复现、日志。
- 安全问题不要开公开 issue，见 [`SECURITY.md`](SECURITY.md)。

## 许可

提交即表示同意以 [MIT](LICENSE) 许可贡献。
