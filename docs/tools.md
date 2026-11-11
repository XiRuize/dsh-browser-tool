# 工具参考（tools）

当前工具面共 14 个工具：10 个基线工具名 + `browser_observe`、`browser_inspect`、`browser_workspace`、`browser_status`。参数、默认值与返回结构以 `lib/tools.js` 及各实现模块为准；真实 Edge 端到端验收仍待 install-verify 完成（见 [`install-verification.md`](install-verification.md)）。

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

返回：`{ ok, page, snapshot: { text, refs, refMap, count, frames, captcha, scroll, title, url, tabId, truncated, nextCursor } }`。

---

## `browser_observe`

一次调用按层读取页面状态。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 目标标签页 |
| `layers` | string[] | `["structure"]` | `structure` / `text` / `visual` / `network` / `console` / `meta` |
| `selector` | string | — | 限定观测范围的 CSS selector |
| `ref` | string | — | 以快照引用作为容器（visual 截图或结构范围） |
| `offset` | integer | `0` | 分段起点（字符或行） |
| `limit` | integer | 预算 | text 字符窗口 / structure 行 / network 条数上限 |
| `maxChars` | integer | 配置值 | 本次输出字符预算 |
| `save` | boolean | `false` | **仅 `save===true`** 时把各层结果额外落盘；超限时个别层仍会落盘 |
| `format` | string | `png` | `text` / `json` / `png` / `jpeg`；只影响 **visual** 截图格式，text/json 仅为调用方兼容 |
| `fullPage` | boolean | `false` | visual 是否整页截图 |
| `path` | string | 自动 | visual 截图文件名或相对 artifacts 路径 |

> `save` 默认 `false` 不等于「完全不落盘」：`visual` 层生成截图时一定会写入产物库并登记 manifest；text/network/console 超预算时也会落盘。

返回：

```json
{
  "ok": true,
  "layers": {
    "structure": { "text": "...", "refs": {}, "truncated": false, "nextCursor": null },
    "text": { "text": "...", "length": 12000, "truncated": true, "nextCursor": 12000 },
    "visual": {
      "path": "C:/Users/生升/.dsh/browser-tool/artifacts/observe-view-....png",
      "width": 1280,
      "height": 720,
      "bytes": 84213,
      "fullPage": false,
      "sha256": "...",
      "id": "art-...",
      "element": false,
      "selector": null
    },
    "network": {
      "active": true,
      "count": 3,
      "entries": [],
      "note": "…"
    },
    "console": { "count": 0, "entries": [], "truncated": false },
    "meta": { "title": "Example Domain", "url": "https://example.com/" }
  },
  "artifacts": [
    {
      "layer": "visual",
      "kind": "screenshot",
      "path": "C:/Users/生升/.dsh/browser-tool/artifacts/observe-view-....png",
      "bytes": 84213,
      "sha256": "...",
      "id": "art-...",
      "width": 1280,
      "height": 720
    }
  ],
  "nextCursor": 12000,
  "page": { "tab": "t1", "url": "https://example.com/", "title": "Example Domain" },
  "manifestPath": "C:/Users/生升/.dsh/browser-tool/artifacts/manifest.jsonl"
}
```

说明：

- `network` 层**不会自动开始捕获**；先 `browser_network action=start`，再触发页面请求。
- `artifacts` 是对象数组，字段为 `layer`、`kind`、`path`、`bytes`、`sha256`、`id`，截图额外带 `width` / `height`。
- `manifestPath` 仅在本次有落盘（`save=true` 或产生 artifacts）时返回。

错误语义：`layers` 含未知值 → 列出可用值；`ref` 过期 → 要求重新快照；单层失败返回该层 `error`，不阻断其它层。

---

## `browser_inspect`

深层前端检查，返回普通 JSON。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `mode` | string | `overview` | `overview` / `dom` / `html` / `css` / `a11y` / `box` / `resources` / `scripts` / `storage` / `console` / `performance` / `eval` |
| `tab` | string | 当前页 | 目标标签页 |
| `selector` | string | — | 限定检查元素 |
| `ref` | string | — | 快照引用；没有 selector 时转换为 `[data-dsh-ref="..."]` |
| `depth` | integer | `4` | DOM 树深度，0–12 |
| `maxNodes` | integer | `300` | DOM/a11y 最大节点数 |
| `limit` | integer | 200 | 资源/脚本/存储/console 条数上限 |
| `properties` | string[] | — | css 模式要读取的 computed 属性 |
| `attrs` | string[] | — | dom 模式只保留这些属性 |
| `includeText` | boolean | `true` | dom 模式是否包含文本 |
| `includeSecrets` | boolean | `false` | storage 模式是否返回 cookie / storage 原值；默认脱敏为 `***` |
| `fullPage` | boolean | `false` | html 模式是否读取整个 `documentElement` |
| `urlPattern` | string | — | resources 模式按 URL 正则过滤 |
| `script` | string | — | eval 模式要执行的 JS |
| `code` | string | — | `script` 的兼容别名（会被映射到 `script`） |
| `maxChars` | integer | 配置值 | 输出预算，超长落盘返回 `savedPath` |

各模式返回要点：

- `overview`：`{ mode, page: { title, url, tab }, lang, charset, viewport: { width, height, devicePixelRatio }, scroll, counts: { frames, resources, scripts, forms, images, links, tables, headings, domNodes }, generator, frameworks }`。
- `dom`：`{ selector, depth, count, truncated, depthLimited, text, savedPath }`，`text` 为缩进节点行。
- `html`：`{ selector, fullPage, length, html, truncated, savedPath }`；`fullPage=true` 时一定会保留完整 HTML 文件。
- `css`：`{ selector, properties, count, styles: { prop: value } }`；selector 无匹配时返回 `note`。
- `a11y`：`{ selector, source, yaml, rows, truncated, savedPath }`；`source` 为 `ariaSnapshot` 或回退的 `aria-attributes`。
- `box`：`{ selector, box, ... }`；`box` 为 `boundingBox()` 结果，无匹配时 `box: null` + `note`。
- `resources`：`{ count, totalTransferSize, totalDecodedBodySize, byType, entries, truncated, savedPath }`。
- `scripts`：`{ count, entries, truncated, savedPath }`。
- `storage`：`{ redacted, includeSecrets, cookies: { count, items, truncated }, localStorage, sessionStorage, indexedDB, note }`；默认 `redacted: true`，cookie 无 `value`，storage 值为 `***`。
- `console`：`{ count, entries, truncated, note, savedPath }`。
- `performance`：`{ ...timing, navigation, resources, ... }`，超长时 `truncated` + `savedPath`。
- `eval`：`{ result }`；结果超长时 `result:null` + `savedPath`；`allowEval !== true` 时抛错，`script` 为空也抛错。

错误语义：

```text
eval 默认关闭（allowEval=false）。如确需执行，请在 cordis.patch.yml 中设置 allowEval: true，并在任务中明确说明用途。
```

`storage` 返回原值时（`includeSecrets=true`）会附带警告：请勿写入日志或公开输出。

---

## `browser_act`

对页面执行一个动作，默认回读核验。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `action` | string | 必填 | `click` / `type` / `press` / `scroll` / `select` / `check` / `uncheck` / `hover` / `drag` / `upload` / `back` / `forward` / `reload` / `wait` / `waitFor` / `dialog` |
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
| `button` | string | `left` | `click` 鼠标键 |
| `clickCount` | integer | `1` | 点击次数 |
| `modifiers` | string[] | — | 修饰键 |
| `ms` | integer | `1000` | `wait` 毫秒 |
| `verify` | boolean | `true` | 动作后是否回读核验 |
| `state` | string | `visible` | `waitFor` 元素状态：`attached` / `visible` / `hidden` / `detached` |
| `urlPattern` | string | — | `waitFor` 要等待的 URL 通配符或正则 |
| `responseUrl` | string | — | `waitFor` 要等待的响应 URL 片段 |
| `exact` | boolean | `false` | `text` 定位是否精确匹配 |
| `files` | string[] | — | `upload` 的本地文件路径 |
| `dialog` | string | — | `accept` / `dismiss`：触发动作时如何处理对话框 |
| `from` / `to` | string | — | `drag` 的源/目标（ref 或 selector） |
| `drag` | object | — | `{ "from": "e1", "to": "e2" }` |
| `waitFor` | object | — | `{ selector, ref, text, state, urlPattern, responseUrl, timeoutMs }`，字段并入本次动作参数 |
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

错误语义：引用过期 → 「ref 已失效，请重新快照」；元素不可见/被遮挡 → 返回 Playwright 原因 + 建议滚动或 `waitFor`；reader 角色 → 「当前工作区角色为 reader，不能执行写操作」；锁超时 → 明确提示；`upload` 文件不存在 → 明确路径错误。

---

## `browser_extract`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 目标标签页 |
| `mode` | string | `text` | `text` / `html` / `links` / `tables` / `labeled` / `structured` / `records` / `markdown` / `images` / `forms` |
| `selector` | string | — | 限定容器 |
| `container` | string | — | `selector` 的兼容别名 |
| `labels` | string[] | — | `labeled` 的标签列表 |
| `itemSelector` | string | — | `records` 的记录容器选择器 |
| `fields` | object | — | `structured` / `records` 字段映射；records 下相对每个列表项取值 |
| `maxChars` | integer | `extractMaxChars` | 返回上限 |
| `offset` | integer | `0` | `text` / `markdown` 的字符窗口起点 |
| `limit` | integer | `200` | `text`/`markdown` 为字符窗口大小；数组模式为条数上限（内部最多 1000） |
| `includeFrames` | boolean | `false` | `text`/`html` 是否合并 iframe 内容 |

返回：

```json
{
  "ok": true,
  "mode": "labeled",
  "content": "统一社会信用代码：...\n法定代表人：...",
  "truncated": false,
  "savedPath": null,
  "nextCursor": null,
  "page": { "tab": "t1", "url": "...", "title": "..." }
}
```

`structured` 返回 `data` 对象；`records` / `links` / `tables` / `images` / `forms` 返回 `data` 数组；`records` 一次抽完整列表，避免逐条选择器调用；超长或分段时 `savedPath` 指向完整文件，`nextCursor` 用于继续读取窗口。

---

## `browser_screenshot`

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tab` | string | 当前页 | 目标标签页 |
| `fullPage` | boolean | `false` | 整页截图 |
| `ref` / `selector` | string | — | 只截取元素 |
| `path` | string | 自动 | 文件名或相对 `artifacts` 的路径；绝对路径需 `allowAbsoluteArtifacts` |
| `format` | string | `png`/按扩展名 | `png` / `jpeg` |
| `timeoutMs` | integer | 配置值 | 截图超时 |

返回：`{ ok, id, path, bytes, width, height, sha256, element, fullPage, page }`。

错误：元素不在视口或不可见 → 明确原因；路径越界 → 拒绝并提示 `allowAbsoluteArtifacts`。

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

## `browser_forum`

站点适配器：采集 QQ 论坛（腾讯频道 `pd.qq.com`）帖子。

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `guild` | string | `iloveswufe` | 频道号或完整频道 URL |
| `limit` | integer | `100` | 目标条数，最大 1000 |
| `keywords` | string[] | — | 关键词过滤（正文或昵称） |
| `discover` | boolean | `false` | 渲染一次频道页，自动发现全部版块 `subc`（约 4–6 秒） |
| `sections` | object[] | 全部/热门/二手 | `[{name, subc}]`，可自行补充 |
| `paginate` | boolean | `false` | 每个版块走 `GetChannelTimelineFeeds` 游标翻页（100+ 条/版块） |
| `watch` | boolean | `false` | 可见翻页：窗口里真实滚动加载（慢，便于验收） |
| `concurrency` | integer | `3` | paginate 时并行版块数，1–6 |
| `api` | object | — | 可选 JSON 分页：`{body, pageSize, maxPages, headers}`，`body` 支持 `{{cursor}}` / `{{pageSize}}` 占位 |
| `save` | boolean | `true` | 是否落盘 JSON |

每条帖子返回 `post_id / author_tinyid / author_nick / posted_at / text / link`。
作者 `tiny_id` 由帖子 id 反解（`1441152` + 11 位），不依赖接口。
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
