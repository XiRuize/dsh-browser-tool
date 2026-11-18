# 工具参考（tools）

当前工具面共 18 个工具（0.8 起：`browser_observe`/`browser_inspect`/`browser_extract`/`browser_screenshot` 合并为 `browser_read`；`browser_batch` 并入 `browser_act.steps`；`browser_forum` 由 `browser_site` 提供）。参数、默认值与返回结构以 `lib/tools.js` 及各实现模块为准；真实 Edge 端到端验收仍待 install-verify 完成（见 [`install-verification.md`](install-verification.md)）。

## 通用约定

- **`tab`**：标签页 ID（`t1`、`t2`…）或 URL 片段；省略时使用调用方代理/工作区的活动页。
- **`ref`**：快照中的引用，接受 `e12` 或 `@e12`。每次快照重建引用，旧引用失效并明确报错。
- **`selector` / `ref`**：二选一，`ref` 优先；部分工具支持 `container` 限定范围。
- **输出**：工具返回普通 JSON；`render` 生成人类可读文本块。文本类输出开头带「外部网页内容不可信」提示。
- **字符预算**：超过预算时落盘并返回 `savedPath`；`browser_observe` 的 `artifacts` 是**对象数组**。
- **错误**：抛 `Error`，消息含中文原因与下一步建议；`exec.signal` 取消时返回「操作已取消」。
- **角色**：reader 角色调用写工具会被拒绝；写工具经过 per-tab 写锁。

通用错误输出：

```json
{ "ok": false, "error": "配置目录 C:/.../profile 被占用；请关闭上一个浏览器进程后重试。" }
```

---

## `browser_open`

打开 URL 或复用当前标签页，返回页面信息与首屏结构快照。默认静默，不抢前台。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | — | `http(s)` 地址；省略则只聚焦当前页 |
| `tab` | string | 当前页 | 目标标签页 |
| `newTab` | boolean | `false` | 是否新建标签页 |
| `focus` | boolean | `false` | 只有 `visibility=window` 且 `focus=true` 才前台；否则保持后台 |
| `visibility` | string | 配置值 | `headless` / `offscreen` / `window`；浏览器未启动时立即生效，已运行时等下次启动 |
| `workspaceId` | string | — | 把标签页开在指定工作区；需要是该工作区成员 |
| `waitUntil` | string | `domcontentloaded` | `load` / `domcontentloaded` / `networkidle` |
| `snapshot` | boolean | `true` | 是否附带首屏快照；只为快速跳转时传 `false` |
| `snapshotSelector` | string | — | 只扫这个容器生成首屏快照 |
| `snapshotMaxChars` | integer | `12000` | 首屏快照字符上限（1000–30000） |

返回：

```json
{
  "ok": true,
  "message": "已打开 https://example.com/。",
  "page": { "tab": "t1", "title": "Example Domain", "url": "https://example.com/" },
  "snapshot": { "text": "...@e1...", "refs": {}, "truncated": false },
  "warning": ""
}
```

错误语义：浏览器不可用 → 提示安装 Edge 或设置 `executablePath`；`userDataDir` 被占用 → 提示关闭旧进程；非 `http(s)` → 拒绝；`focus=true` 但非 `window` → 不报错，`warning` 说明「focus 仅在 visibility=window 时生效」。

---

## `browser_snapshot`（structure 层兼容别名）

等价于 `browser_observe` 只请求 `structure` 层，保留旧签名。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 目标标签页 |
| `interactiveOnly` | boolean | `false` | 只列可交互元素 |
| `maxChars` | integer | `snapshotMaxChars` | 1000–30000 |
| `selector` | string | — | 只扫描这个容器（大页面快速定位） |
| `maxElements` | integer | `280` | 最多扫描多少个可交互元素；大页面调小可提速 |
| `detail` | string | `compact` | 与上次快照相同时只回一行并沿用旧引用；`full` 总是全文 |

返回：`{ ok, page, snapshot: { text, refs, refMap, count, frames, captcha, scroll, title, url, tabId, truncated, nextCursor } }`。

---

## `browser_read`

统一读取入口（0.8 起替代 `browser_observe` / `browser_inspect` / `browser_extract` / `browser_screenshot`）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `source` | string | `auto` | `observe` / `inspect` / `extract` / `screenshot`；auto 按 `mode`/`layers` 推断 |
| `mode` | string | — | extract：`text/html/links/tables/labeled/structured/records/markdown/images/forms`；inspect：`overview/dom/html/css/a11y/box/resources/scripts/storage/console/performance` |
| `layers` | string[] | `["structure"]` | observe 层：`structure/text/visual/network/console/meta` |
| `selector` / `container` / `ref` | string | — | 限定读取范围 |
| `itemSelector` / `labels` / `fields` | — | — | extract records / labeled / structured 参数 |
| `offset` / `limit` / `maxChars` | integer | — | 字符/条数窗口与输出预算 |
| `fullPage` / `format` / `path` | — | — | inspect html 整页；screenshot 截图 |
| `cache` | boolean | `false` | extract 是否走内容缓存（页面可能变化，静态列表再开） |
| `refresh` | boolean | `false` | 强制绕过缓存 |
| `detail` | string | `compact` | `compact`：records 只回前 20 条、text 截 4000 字符；`full` 全量 |

返回带 `source` 字段区分通道；extract 命中缓存时返回 `cached:true` 与 `ageMs`。

---

## `browser_act`

执行单个动作，或传 `steps` 一次跑多步（0.8 起吸收原 `browser_batch`），默认回读核验。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | 单步必填 | `click` / `type` / `press` / `scroll` / `select` / `check` / `uncheck` / `hover` / `drag` / `upload` / `back` / `forward` / `reload` / `wait` / `waitFor` / `dialog`；传 `steps` 时忽略 |
| `steps` | array | — | 多步模式：1–50 步，每步 `{action, label?, url?, ref?, selector?, text?, value?, key?, verify?, mode?, itemSelector?, fields?}`；action 支持 act 全部动作 + `extract` + `goto` |
| `stopOnError` | boolean | `true` | steps 模式某步失败是否立即停止 |
| `options` | object | — | 附加参数：button/clickCount/modifiers/state/urlPattern/responseUrl/exact/files/dialog/from/to/drag/waitFor |
| `tab` | string | 当前页 | 目标标签页 |
| `ref` | string | — | 快照引用 |
| `selector` | string | — | CSS selector |
| `text` | string | — | 按可见文本定位（click / scroll / waitFor） |
| `container` | string | — | 容器 selector 或 ref，限定目标查找范围 |
| `nth` | integer | `0` | 同条件多个匹配时取第几个（从 0 开始） |
| `value` | string | — | `type` 的文本；`select` 的选项 |
| `key` | string | — | `press` 按键，如 `Enter`、`Control+A` |
| `direction` | string | `down` | `scroll` 方向 |
| `amount` | integer | `640` | `scroll` 像素 |
| `times` | integer | `1` | `scroll` 次数 |
| `submit` | boolean | `false` | `type` 后按 Enter |
| `clear` | boolean | `true` | `type` 前是否清空原值 |
| `ms` | integer | `1000` | `wait` 毫秒 |
| `verify` | boolean | `true` | 动作后是否回读核验 |
| `label` | string | — | 角标文案（可见模式下显示） |
| `snapshot` | boolean | auto | 动作后是否附带快照。不传时 auto：页面变化或 click/type/press 等动作才附带；`false` 强制省略、`true` 强制附带 |
| `timeoutMs` | integer | 配置值 | 动作超时 |

返回：

```json
{
  "ok": true,
  "message": "已点击 @e3。URL 已变化。",
  "action": "click",
  "target": { "label": "登录", "by": "ref", "container": null, "matchCount": 1, "chosenIndex": 0 },
  "verify": {
    "ok": true,
    "urlChanged": true,
    "exists": true,
    "visible": true,
    "value": null,
    "checked": null,
    "dialog": null
  },
  "pageChanged": true,
  "page": { "tab": "t2", "url": "https://example.com/dashboard" },
  "snapshot": { "text": "...", "refs": {} },
  "dialog": null
}
```

`verify` 可能包含：`urlChanged`、`titleChanged`、`newTab`、`newTabUrl`、`dialog`、`exists`、`visible`、`value`、`checked`、`selected`、`aria`、`response`、`notes`。动作打开新标签页时，返回会自动切到新页并重新快照。

填写语义（0.8.1 起）：

- `type` 对普通 `input`/`textarea` 走 `fill`；对 **contenteditable**（富文本/自定义编辑器）走「聚焦 → `Control+A` → `Delete` → 逐行 `insertText`」，行间用 `Shift+Enter`，因此 `\n` 能保留为换行、`clear` 默认真正覆盖旧文本。清空前会确认焦点在目标内部，未确认时跳过清空并在 `notes` 说明（避免误删整页内容）。
- 回读比较容忍纯空白差异：完全一致为 `exact`，仅空白/换行不同视为成功并在 `notes` 注明，不再误报「核验未通过」。
- 文本定位命中多个元素时（`target.matchCount > 1`），默认不再盲取第 1 个：按「弹出层（listbox/menu/option）内 > 可点击标签 > 面积更小 > 在视口内」排序，原因写入 `target.pickReason`（`弹出层内` / `可点击元素` / `面积更小`）。显式传 `nth` 或 `container` 时以调用方为准。

错误语义：引用过期 → 「ref 已失效，请重新快照」；元素不可见/被遮挡 → 返回 Playwright 原因 + 建议滚动或 `waitFor`；reader 角色 → 「当前工作区角色为 reader，不能执行写操作」；锁超时 → 明确提示；`upload` 文件不存在 → 明确路径错误。

---

## `browser_paginate`

在列表页上连续翻页并逐页提取，一次调用完成「下一页 → 等待 → 提取」循环。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 起始列表页 |
| `next` | object | 自动识别 | 显式下一页控件：`selector` / `ref` / `text` / `container` / `nth` |
| `maxPages` | integer | `5` | 最多翻几页，上限 `20` |
| `waitMs` | integer | `8000` | 每次翻页后等待 URL/内容变化的上限 |
| `waitSelector` | string | — | 翻页后等待该选择器出现再抓（异步渲染列表用） |
| `mode` | string | `text` | 逐页提取模式，同 `browser_extract` |
| `selector` / `container` / `itemSelector` / `labels` / `fields` / `maxChars` / `offset` / `limit` | — | — | 透传给逐页提取 |
| `save` | boolean | `true` | 完整结果落盘 JSON |
| `timeoutMs` | integer | `120000` | 整次分页总预算，上限 `290000` |

自动识别顺序：`a[rel~=next]` → `<link rel=next>` 的 href → 文本/aria/title 命中「下一页 / 下页 / next / older / › / »」的可见控件（分页容器内加分，`上一页` 与 disabled 控件排除）。

停止原因 `stoppedReason`：`no-next`（没有下一页）、`no-change`（点击后 URL 与内容都没变）、`max-pages`（页数上限）、`timeout`（总预算耗尽）。

返回：

```json
{
  "ok": true,
  "totalPages": 3,
  "pages": [{ "page": 1, "url": "...", "title": "分页列表 第1页", "mode": "records", "count": 3, "preview": "..." }],
  "items": [{ "title": "第1页条目1", "page": 1 }],
  "stoppedReason": "no-next",
  "ms": 1820,
  "savedPath": ".../paginate-20261118_143500.json"
}
```

---

## `browser_tabs`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | 必填 | `list` / `switch` / `close` / `claim` / `release` |
| `tab` | string | `active` | `switch` / `close` / `claim` / `release` 的目标 |
| `agentId` | string | 调用方 | 兼容参数；`claim` 只允许绑定到调用方自己 |

返回 `list`：`{ ok, action:"list", workspace, tabs: [{ tab, title, url, active, owner, workspaceId, role, locked }] }`。

- `claim`：把标签页绑定到当前代理的工作区（没有则自动创建）；不能代其他代理 claim。
- `release`：解除 owner，返回 `previousOwner` 与 `workspaceId`。
- `close`：关闭标签页并返回剩余 `tabs`。

---

## `browser_workspace`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | 必填 | `create` / `join` / `status` / `grant` / `handoff` / `close` |
| `workspaceId` | string | — | `join` / `status` / `grant` / `handoff` / `close` 的目标 |
| `label` | string | — | `create` 的名称 |
| `role` | string | `reader` | `join` / `grant` 授予的角色：`reader` / `writer` |
| `toAgent` | string | — | `grant` 被授权代理；`handoff` 接手代理 |
| `tab` | string | — | `handoff` 的标签页 |
| `note` | string | — | `handoff` 的交接摘要 |
| `closeTabs` | boolean | `false` | `close` 时是否同时关闭工作区内标签页 |

返回：

```json
{
  "ok": true,
  "action": "create",
  "workspace": {
    "id": "ws-7f3a",
    "label": "qcc-research",
    "ownerAgent": "lead",
    "members": [{ "agentId": "lead", "role": "writer", "expiresAt": 1794033600000 }],
    "tabs": ["t1"]
  },
  "status": {
    "agentId": "lead",
    "workspace": { "id": "ws-7f3a", "label": "qcc-research" },
    "role": "writer",
    "members": [],
    "tabs": [],
    "locks": [],
    "leases": [],
    "leaseExpiresAt": 1794033600000,
    "audit": []
  }
}
```

重要语义：

- **`status` 只报告当前代理的活动工作区**。传了不同的 `workspaceId` 会报错，提示先 `join` 再查询；不会跨工作区查询。
- `reader` 执行写动作会被拒绝；`writer` 才能 `browser_act`。
- `join` 需要 `workspaceId`；`grant` 需要 `workspaceId` 和 `toAgent`；`handoff` 需要 `toAgent` 和 `tab`。
- 租约过期后需要重新 `join`。

错误语义：workspace 不存在 → 列出可用 ID；非成员 → 拒绝；reader 写 → 拒绝；租约过期 → 提示重新 join；`status` 传错 workspaceId → 明确报错。

---

## `browser_network`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | 必填 | `start` / `stop` / `list` / `get` / `clear` / `export` |
| `tab` | string | 当前页 | 目标标签页 |
| `urlPattern` | string | — | 只记录/过滤匹配的 URL（正则） |
| `resourceTypes` | string[] | `["xhr","fetch"]` | 资源类型；也可加 `document`、`script` |
| `maxEntries` | integer | `80` | 保留/返回条数上限 |
| `maxBodyChars` | integer | `networkMaxBodyChars` | 单条响应体上限 |
| `id` / `urlContains` | string | — | `get` 的定位方式 |
| `maxChars` | integer | `50000` | `get` 响应体上限 |
| `type` | string | — | `list` 时只返回指定资源类型 |
| `path` | string | 自动 | `export` 的 HAR 路径（限 `artifactDir`） |
| `includeSecrets` | boolean | `false` | `export` 是否不脱敏 Cookie/Authorization/Set-Cookie |
| `includeBodies` | boolean | `true` | `export` 是否包含响应体 |

返回 `export`：

```json
{
  "ok": true,
  "action": "export",
  "harPath": "C:/Users/生升/.dsh/browser-tool/artifacts/network-har-....json",
  "entryCount": 12,
  "pendingBodies": 0,
  "redacted": true,
  "recorder": { "active": true, "count": 12 }
}
```

错误：无记录 → 提示先 `start`；正则非法 → 明确报错；HAR 路径越界 → 拒绝。

---

## `browser_collect`

对一组 URL 后台并行提取，支持 checkpoint + cursor 续跑。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `urls` | string[] | 必填 | 去重后最多 **200** 条；单次调用最多处理 **100** 条，其余返回 `nextCursor` |
| `mode` | string | `text` | `text` / `html` / `links` / `tables` / `labeled` / `structured` / `records` / `markdown` |
| `itemSelector` | string | — | records 模式必填：每条记录的容器选择器 |
| `render` | boolean | `true` | `false` 走 HTTP 快通道（不渲染，命中挑战自动回落渲染） |
| `retries` | integer | `2` | 单条导航/请求重试次数 |
| `selector` / `labels` / `fields` | — | — | 同 `browser_extract` |
| `maxChars` | integer | `8000` | 每条保留字符数 |
| `limit` | integer | `200` | 数组模式每页条数 |
| `concurrency` | integer | `4` | 1–8 |
| `delayMs` | integer | `0` | 每条间隔；命中风控自动退避 |
| `includeFrames` | boolean | `false` | 合并 iframe |
| `save` | boolean | `true` | 是否写结果 JSON |
| `jobId` | string | 自动派生 | 续跑任务 ID；相同 jobId + urls 复用检查点 |
| `cursor` | integer | `0` | 从第几条 URL 开始 |
| `deadlineMs` | integer | `120000` | 单次调用时限，到时保存检查点并返回 |
| `layers` | string[] | 无 | 每个 URL 额外留下的层：`text` / `structure` / `visual` / `network` |
| `checkpointPath` | string | 自动 | 检查点路径；省略时按 jobId 放到 artifacts |
| `scratch` | boolean | `false` | 原始内容写入暂存区再清洗 |
| `keepScratch` | boolean | `false` | 采集后保留暂存文件 |
| `clean` | boolean | `true` | 是否对暂存原始内容做文本清洗 |

返回：

```json
{
  "ok": true,
  "jobId": "collect-...",
  "count": 20,
  "succeeded": 19,
  "failed": 1,
  "blocked": 2,
  "nextCursor": 20,
  "done": false,
  "total": 100,
  "processed": 20,
  "remaining": 80,
  "totalFailed": 1,
  "checkpointPath": "C:/Users/生升/.dsh/browser-tool/artifacts/jobs/.../checkpoint.json",
  "savedPath": "C:/Users/生升/.dsh/browser-tool/artifacts/collect-....json",
  "results": [{ "url": "...", "ok": true, "title": "...", "blocked": false, "data": "..." }],
  "note": "单次最多处理 100 条；本次处理到 cursor=100，带同一 urls 列表和 cursor=100 继续。"
}
```

续跑：`done=false` 时，带**同一 `urls` 列表**、同一 `jobId` 和返回的 `nextCursor` 作为 `cursor` 再调用；`doneUrls` 去重，已完成 URL 不重复抓取。

---

## `browser_fetch`

HTTP 快通道：复用当前浏览器上下文的 Cookie / UA / Referer 直接发请求，不渲染页面。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | 必填 | 请求地址 |
| `method` | string | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` |
| `headers` | object | — | 额外请求头；Cookie 自动沿用浏览器上下文 |
| `body` | string | — | 请求体 |
| `timeoutMs` | integer | 配置值 | 超时毫秒 |
| `retries` | integer | `2` | 网络错误重试次数 |
| `maxChars` | integer | `20000` | 返回正文上限，超出落盘 |
| `save` | boolean | `true` | 超长时是否落盘完整正文 |

返回 `{ ok, status, finalUrl, contentType, bytes, body, json, blocked, elapsedMs, retriesUsed, savedPath }`。
`blocked=true` 表示命中 JS 挑战 / 验证码 / 401 / 403 / 429，应改用渲染路径。

---

## `browser_site`

站点工具注册表（内置适配器 + 声明式清单）。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | `list` | `list` / `match` / `run` |
| `tab` | string | 当前页 | `match`/`run` 时使用 |
| `url` | string | 当前页 | `match` 的目标 URL |
| `siteId` | string | — | `run` 必填，例如 `qq-forum` |
| `tool` | string | — | `run` 必填 |
| `args` | object | `{}` | 工具参数 |
| `save` | boolean | `false` | `run` 结果落盘 JSON |

清单放在 `siteToolsDir`（默认 `~/.dsh/browser-tool/site-tools`），一个文件一个站点：

```json
{
  "id": "example-hr",
  "name": "示例招聘",
  "match": ["hr.example.com", "/jobs/"],
  "tools": {
    "list": {
      "description": "抓招聘列表",
      "url": "https://hr.example.com/jobs",
      "mode": "records",
      "selector": "#job-list",
      "itemSelector": ".job-item",
      "fields": { "title": "h3", "link": { "selector": "a", "attr": "href" } }
    }
  }
}
```

内置站点：`qq-forum`（工具 `collect`，与 `browser_forum` 同一实现）。`match` 支持子串（不区分大小写）与 `/正则/` 两种写法；清单工具可省略 `url`，直接在 `tab` 当前页上提取。清单校验失败不会影响其它站点，错误会随 `list` 返回。

---

## `browser_show`

静默 / 非静默切换。三种可见性：

| 值 | 含义 | 资源 |
|---|---|---|
| `headless` | 完全无窗口（默认） | 最省 |
| `offscreen` | 有窗口但放在屏幕外，可随时 `show` | 中 |
| `window` | 正常窗口 | 高 |

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | `status` | `status` / `set` / `show` / `hide` |
| `visibility` | string | — | `set` 时的目标值：`headless` / `offscreen` / `window` |
| `tab` | string | 当前页 | 目标标签页 |
| `restoreTabs` | boolean | `true` | `set` 重启后是否恢复原标签页 URL |

说明：`set` 会重启浏览器上下文以切换有头/无头（Cookie 与登录态保留在 userDataDir）；
`show`/`hide` 只在 `offscreen`/`window` 下有效，通过 CDP 移动窗口位置，不重启。
运行时切换不会写回配置，重启 DSH 后仍按配置里的 `visibility` 启动。
---

## `browser_capture`

F12 式抓取：当前页面（或 `selector` 范围）的原始 HTML 写入临时暂存区，立即清洗并返回正文；默认抓完即删。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 目标标签页 |
| `selector` | string | — | 只抓某个容器 |
| `keep` | boolean | `false` | 保留暂存文件（可用 `browser_scratch read` 读取） |
| `maxChars` | integer | `20000` | 清洗后返回上限 |

返回 `{ jobId, path, bytes, title, chars, text, cleared }`。

---

## `browser_devtools`

F12 式前端工作流：抓取 → 暂存 → 清洗。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | `capture` | `capture` / `clean` / `manifest` / `clear` |
| `tab` | string | 当前页 | 目标标签页（capture） |
| `selector` | string | — | 只捕获某个容器（capture） |
| `jobId` | string | — | clean/manifest/clear 必填 |
| `clean` | boolean | `true` | capture 后立即清洗 |
| `keep` | boolean | `true` | 保留暂存文件 |
| `keepLinks` | boolean | `false` | 清洗时保留链接 |
| `dropScripts` / `dropStyles` | boolean | `true` | 清洗开关 |
| `maxChars` | integer | `8000` | 清洗预览上限 |

`capture` 返回 `{ jobId, files, counts, meta, styleLinks, scriptSrcCount, cleaned }`；
`clean` 返回 `{ path, bytes, stats, text }`，`stats` 含去脚本/样式/注释/内联事件/埋点数量。
---

## `browser_scratch`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | `stats` | `stats` / `list` / `read` / `clear` |
| `jobId` | string | — | 暂存任务 ID（`list` / `clear` 必填） |
| `path` | string | — | `read` 的文件路径（必须在暂存区内） |
| `maxChars` | integer | `20000` | `read` 返回上限 |
---

## `browser_download`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | — | 直接下载地址（共享 cookie） |
| `ref` / `selector` | string | — | 点击元素触发下载 |
| `path` | string | 自动 | 文件名或相对 `downloads` 的路径 |
| `tab` | string | 当前页 | 目标标签页 |
| `timeoutMs` | integer | `60000` | 超时 |

返回 `{ ok, path, bytes, filename, url, mode: "request"|"browser" }`。直接 URL 模式使用 `context.request`；点击模式等待浏览器 download 事件。

---

## `browser_status`

无参数，返回**扁平**诊断对象（`manager.status()` + `artifactDir`）。

```json
{
  "ok": true,
  "loaded": true,
  "connected": true,
  "mode": "launch",
  "visibility": "headless",
  "browserVersion": "120.0.0.0",
  "pages": 2,
  "launchedAt": 1794029999000,
  "restartCount": 0,
  "lastError": null,
  "lastErrorAt": null,
  "cleanupWarning": null,
  "state": "ready",
  "watchdogActive": true,
  "idleCloseMs": 0,
  "tabs": [{ "tab": "t1", "url": "https://example.com/", "owner": "lead", "locked": false }],
  "activeTab": "t1",
  "pending": 0,
  "workspaces": [],
  "locks": [],
  "restored": false,
  "restoredAt": null,
  "staleTabs": [],
  "lastEviction": null,
  "lastPersistError": null,
  "artifactDir": "C:/Users/生升/.dsh/browser-tool/artifacts"
}
```

用途：安装后自检、崩溃后诊断、确认 bundle 是否真的加载。注意没有嵌套的 `browser` 字段。

---

## `browser_close`

无参数。关闭浏览器、释放配置目录锁，保留登录态。返回 `{ ok, message }`。CDP 模式只断开连接。

---

## 参数快速对照

| 工具 | 只读 | 并发安全 |
|---|---|---|
| `browser_open` | 否（会建标签页） | 否 |
| `browser_snapshot` | 是 | 是 |
| `browser_observe` | 是 | 是 |
| `browser_inspect` | 是 | 是 |
| `browser_act` | 否 | 否 |
| `browser_extract` | 是 | 是 |
| `browser_screenshot` | 是 | 是 |
| `browser_tabs` | `list` 是，其余否 | `list` 是 |
| `browser_workspace` | `status` 是，其余否 | `status` 是 |
| `browser_network` | `list` / `get` / `export` 是 | 同上 |
| `browser_fetch` | 是 | 是 |
| `browser_forum` | 是 | 是 |
| `browser_collect` | 否（导航） | 否 |
| `browser_download` | 否 | 否 |
| `browser_status` | 是 | 是 |
| `browser_close` | 否 | 否 |
