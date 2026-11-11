---
name: qq-forum
description: QQ 论坛（腾讯频道 pd.qq.com）批量采集：优先 HTTP 快通道 + SSR 解析，按帖子 id 反解作者 tiny_id 去重，可关键词过滤；需要 JS 水合时回落渲染路径。用于"找需求发出者 / 存档 ID / 关键词订阅 / 二手信息归档"。
license: MIT
---

# QQ Forum（腾讯频道）采集

`pd.qq.com` 的频道就是现行"QQ 论坛"。列表页是 SSR（首屏 10~12 条直接带在 HTML 里），
翻页与实时流走 `trpc.qchannel.commreader.ComReader/GetGuildFeeds` JSON 接口。

## 何时用

- 要按版块/关键词收集帖子、作者、时间、链接；
- 要给需求发出者建"存档 ID → 昵称 → 发言"档案；
- 要做二手/拼车/招募类信息的持续归档。

## 三条路径，按代价从低到高

| 路径 | 工具 | 单页耗时 | 适用 |
|---|---|---|---|
| 免渲染 SSR | `browser_fetch` | ~0.6–1.0s | 列表页、帖子详情页 |
| 批量 SSR | `browser_collect` + `render:false` | ~0.3–0.6s/条 | 几十~几百个 URL |
| 站点适配器 | `browser_forum` | 3 个版块 ~2s | 一步到位拿结构化帖子 |
| 渲染兜底 | `browser_open` / `browser_collect` | 1.5–2.5s | 必须 JS 水合才能出内容 |

## 推荐用法

1. 快速归档：

```
browser_forum {"guild":"iloveswufe","limit":100,"keywords":["演员","出","收"]}
```

2. 指定版块 URL 批量抓：

```
browser_collect {
  "urls":["https://pd.qq.com/g/iloveswufe","https://pd.qq.com/g/iloveswufe?subc=38984169"],
  "mode":"records",
  "itemSelector":".msgBox",
  "fields":{
    "id":{"selector":"a","attr":"href"},
    "author":".nick",
    "time":".edit-time",
    "text":".feed-detail-text"
  },
  "render":false
}
```

3. 单页直取：`browser_fetch {"url":"https://pd.qq.com/g/iloveswufe?subc=38984169"}`

## 帖子卡片选择器（SSR 与 DOM 通用）

- 容器：`.msgBox`（`data-index` 就是帖子 id）
- 作者：`.nick`
- 时间：`.edit-time`（相对时间，如"4小时前"）
- 正文：`.feed-detail-text`（可能多个片段，需拼接）
- 链接：`.game-guild-main__short-content[href]`
- 头像：`.avatar img[src]`

## 作者存档 ID（关键）

帖子 id 形如 `B_bfd9f16a00280d00` + `144115218679196115` + `0X60`，
其中 18 位、以 `1441152` 开头的就是作者 `tiny_id`，正则 `1441152\d{11}`。

- 昵称不可当身份：样本里几十条帖子都叫 `momo`；
- 去重、建档案、增量订阅都用 `tiny_id`，不要用昵称。

## 分页

- SSR 只带首屏，`?page=2` 无效；
- 真翻页是 `GetGuildFeeds` 的 `feedAttchInfo` 游标：POST 该接口，响应里
  `data.feedAttchInfo` 作为下一次请求的游标，`data.vecFeed` 是 10 条帖子；
- 接口需要登录 Cookie（`browser_fetch` 已自动复用）；无 Cookie 返回
  `{"retcode":4002,"msg":"uin not found"}`。

## 坑

- 站点是 SPA + 长轮询，`page.goto` 等 `networkidle` 会一直不结束；用 `domcontentloaded` + 短沉降。
- 同一频道有大量重名 `momo`，按昵称统计会失真。
- 并发别超过 4~8；命中验证码/429 时 `browser_collect` 会自动退避，也可以手动把 `concurrency` 降到 1~2。
- 只采集公开内容，控制频率，不要把作者 ID 对外扩散。
