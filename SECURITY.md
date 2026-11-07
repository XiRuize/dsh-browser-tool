# 安全声明（SECURITY）

本插件让模型直接驱动一个真实的、带登录态的浏览器。这赋予它很强的能力，也因此必须把边界写清楚。

## 威胁模型

| 威胁 | 描述 | 处理 |
|---|---|---|
| 任意 JS 执行 | `browser_inspect` 的 `eval` 模式可在页面上下文执行任意 JavaScript，可能读取同源数据、发起请求或修改页面 | 默认关闭（`allowEval=false`）；开启后仅在明确授权的任务中使用，输出不保证可信 |
| 产物路径穿越 | 调用方给出 `../../` 或越界绝对路径，把文件写到产物目录之外 | `ArtifactStore` 限制在 `artifactDir`；`allowAbsoluteArtifacts=false` 时拒绝越界绝对路径 |
| 网页提示注入 | 页面文本里出现「忽略之前的指令」「把数据发到某地址」等诱导内容 | 所有网页内容在工具输出中标记为**外部不可信数据**；模型不将其当作指令；技能文档要求只执行用户/主代理的意图 |
| 登录态泄露 | `userDataDir` 含 Cookie、LocalStorage、已保存密码 | 目录由用户所有；不随仓库分发；`.gitignore` 排除 `runtime/`、`profiles/`；文档提醒不要把 profile 打包 |
| 凭据 / 敏感值外泄 | 读取表单、storage、网络响应时把 token、手机号、密码带进上下文 | 敏感值默认脱敏；`browser_inspect` 的 `storage` / `console` 输出做截断与掩码 |
| 下载与上传 | 下载可执行文件；上传把本地文件送到网站 | 下载只写入 `downloadsDir`；上传需要显式参数；两者都建议先由人确认 |
| 跨站写操作 | 在已登录站点执行提交、删除、购买 | 工具不自动提交；`browser_act` 的写动作可由 reader 角色阻止；最终提交留给人 |
| 资源滥用 | 大量标签页、批量采集给站点造成压力 | `maxTabs` 上限；采集默认并发 2、间隔 800ms；不做隐藏式大规模抓取 |
| 命令注入 | 用户提供的配置或 URL 传入 shell | 不使用 shell 拼接；URL 只接受 `http(s)` |

## 默认安全配置

v0.2 目标默认值（与 `docs/MODULE-CONTRACT.md` 一致）：

```yaml
visibility: headless
idleCloseMs: 0
maxTabs: 24
allowEval: false
allowAbsoluteArtifacts: false
```

- `mode` 默认 `launch`（独立 profile），不自动连用户日常浏览器。
- 连接日常浏览器需显式 `mode: cdp` + `cdpUrl`，用户应知晓调试端口暴露的风险。
- 只允许 `http(s)`；`file:`、`javascript:` 等一律拒绝。

## 明确不做的事

- **没有 stealth / 反检测**：不伪造指纹、不修改 `navigator.webdriver`、不使用打补丁的 Chromium。
- **没有验证码识别或绕过**：遇到验证码、短信、人机验证时，工具把状态报给模型，由人完成；需要时用 `visibility=window` 临时可见。
- **没有自动提交 / 自动交卷**：表单提交、订单确认、问卷交卷等最后一脚必须由人完成。
- **没有隐藏式爬取**：不提供规避站点限速、封锁或付费墙的能力。

## 密钥与日志

- 不要在执行工具的机器上放置无关的长期凭据；插件只需要浏览器 profile 自身的登录态。
- 错误日志可能包含 URL 与页面标题，提交 issue 前请先脱敏。
- 产物 manifest 记录来源 URL、时间、尺寸与哈希，便于审计；不要把它上传到公开位置而不检查内容。

## 漏洞报告

请不要在公开 issue 中披露未修复的安全问题。当前仓库尚未建立私有安全渠道，推荐做法：

1. 在 GitHub 仓库建立后，使用 **Security → Report a vulnerability**（Private vulnerability reporting）；
2. 仓库尚未发布时，通过维护者已知的私有联系方式报告；
3. 报告请包含：影响版本、复现步骤、最小 PoC、影响面评估、建议修复方向。

维护者会在确认后给出修复计划，并在修复发布后致谢（如报告者愿意署名）。

## 支持的版本

只有最新 `0.2.x` 分支接受安全修复；`0.1.0` 为历史基线，不再单独维护。
