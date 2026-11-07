# 面向 DSH 社区的提案（upstream-proposal）

> 状态：讨论稿，不是已合并的上游变更。任何接口都可能随 DSH 上游调整。

## 背景

`@future/dsh-browser-tool` 已经在 DSH 里可用，但它是一个**第三方 bundle**：工具名、配置项、`browserUse` 服务的使用方式都由本仓库定义。要让社区能复用、减少重复造轮子，需要把可通用的部分收敛成约定，并把其中最小的部分提给 DSH 上游。

本提案回答三件事：

1. `browserUse` provider 应如何可选注册；
2. 浏览器工具命名与配置约定；
3. 哪些改动适合拆成上游 PR，哪些留在本仓库。

## 1. `browserUse` provider 的可选注册

### 现状与问题

DSH 的 `browserUse` 服务契约较窄，不同浏览器 provider 的功能差异大（有的只有导航，有的支持工作区与锁）。如果强制注册，会出现：

- 没装浏览器的环境启动失败；
- 多个 provider 争抢同一个服务名；
- 本插件的能力（工作区、锁、分层观测）无法用窄契约表达。

### 建议

采用**可选注册 + 降级**：

```js
// 伪代码：本仓库侧
export const inject = ['tools', { browserUse: { optional: true } }]

export function apply(ctx, rawConfig) {
  // ... 初始化 manager、注册工具
  if (ctx.browserUse) {
    try {
      const dispose = ctx.browserUse.registerProvider({
        name: 'dsh-browser-tool',
        capabilities: ['navigate', 'observe', 'act', 'extract', 'workspace'],
        create: () => manager,
      })
      ctx.effect(() => dispose)
    } catch (error) {
      ctx.logger?.warn?.(`browserUse provider 注册失败，已降级为纯工具模式：${error.message}`)
    }
  } else {
    ctx.logger?.warn?.('browserUse 服务不存在，跳过 provider 注册（工具模式不受影响）')
  }
}
```

要点：

- 服务不存在 → 只记 warning，不阻断工具注册。
- 注册失败 → 降级为纯工具模式，不抛给用户。
- 不覆盖已存在的同名 provider；冲突时警告并让先到者保留。
- `capabilities` 用固定枚举，便于上游路由。

### 上游需要提供什么（最小）

- 一个稳定的 `browserUse.registerProvider(spec)` 契约，或明确「provider 由 bundle 自行管理，不经过 browserUse」。
- 允许 `inject` 中声明可选依赖（如果当前 Loader 已支持，文档写清语法即可）。
- provider 的 `dispose` 在插件卸载时被调用。

## 2. 工具命名约定

建议社区统一前缀 `browser_`，语义动作用动词：

| 约定 | 示例 | 说明 |
|---|---|---|
| `browser_<verb>` | `browser_open`、`browser_observe` | 单一职责 |
| 读工具与写工具分离 | `observe` / `inspect` vs `act` | 便于 `isConcurrencySafe` 与审批 |
| 兼容别名保留一个版本 | `browser_snapshot` → `browser_observe` | 不破坏旧提示词 |
| 分层参数用 `layers` | `["structure","text","visual"]` | 避免工具爆炸 |
| 分页统一 `offset` / `limit` / `nextCursor` | 所有读工具 | 模型可预期 |
| 产物统一返回 `savedPath` | 提取、截图、采集 | 不把大内容塞回上下文 |

不建议把 provider 名、内部实现（CDP/Playwright）写进工具名；它们是配置，不是 API。

## 3. 配置约定

建议所有浏览器类 bundle 共享以下字段名与默认值：

| 字段 | 建议默认 | 理由 |
|---|---|---|
| `visibility` | `headless` | 默认不打扰人 |
| `idleCloseMs` | `0` | 长任务不中断 |
| `maxTabs` | `24` | 防止资源失控 |
| `allowEval` | `false` | 高风险能力默认关 |
| `allowAbsoluteArtifacts` | `false` | 产物目录白名单 |
| `userDataDir` / `artifactDir` / `downloadsDir` | `~/.dsh/browser-tool/` 下 | 不污染用户目录 |
| `watchdogIntervalMs` | `30000` | 健康检查节流 |

配置应允许 bundle 自行归一化（不强制 schemastery `Config`），因为 DSH Loader 对 `Config` 的校验要求会变；`resolveConfig(raw)` 返回普通对象更稳。

## 4. 与官方 browser-use 服务的关系

- **不替代**：本插件是「显式工具面」，官方服务若有自己的抽象，二者可以并存。
- **可选接入**：存在 official provider 时，本插件可把自己注册为其中一个 provider；不存在时纯工具模式照常工作。
- **不共享登录态**：不同 provider 的 `userDataDir` 必须隔离，避免锁冲突。
- **能力声明**：provider 元数据里写清是否支持 workspace、lock、eval、download，便于上游选择。

## 5. 可拆分为上游 PR 的最小改动

按「侵入性从低到高」排序，建议一次只提一个：

1. **文档**：在 DSH 插件文档中增加「浏览器类 bundle 的配置字段约定」一节（零代码风险）。
2. **可选依赖注入**：若 `inject` 尚不支持可选服务，补 `{ service: { optional: true } }` 的解析与测试。
3. **provider 注册契约**：`browserUse.registerProvider` 的最小接口 + `dispose` 生命周期 + 一个 mock provider 测试。
4. **工具命名 lint**（可选）：社区规范文档，不强制运行时校验。

**不建议上游化**的部分（留在本仓库）：

- Playwright 具体实现、Edge 通道选择；
- 工作区/租约/锁的具体数据结构；
- `browser_inspect` 的 12 种模式；
- 站点特定适配（如企查查字段）。

这些是产品差异，不是协议。

## 6. 与社区协作的方式

1. 先在本仓库发 issue 讨论约定；
2. 约定稳定后，向上游提文档 PR；
3. 上游接受后，本仓库按约定调整（可能需要一个兼容层）；
4. 不把「本仓库的实现」当成既成标准倒逼上游。

## 7. 开放问题

- DSH 上游是否愿意接受 `browserUse` 的可选 provider 注册？
- provider 冲突策略：先到先得、显式优先级，还是报错？
- 是否需要跨 bundle 的浏览器实例共享（同一 Chromium，多插件）？若需要，锁与登录态归属要重新设计。
- 社区包名用 `dsh-browser-tool` 还是放在 `@deepseek-harness/*` scope？前者更中立，后者更易发现。
