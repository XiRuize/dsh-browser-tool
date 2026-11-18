# 性能基线与提速记录（0.3 → 0.7）

目标站点：QQ 论坛（腾讯频道 `pd.qq.com`），典型页面为 500KB 级 SSR HTML + JSON 接口。
测试机：本机 Windows / Edge、headless、并发 4、条目间隔 0。

## 复现命令

```bash
# 渲染路径
node test/bench.mjs --n 20 --concurrency 4 --label render

# HTTP 快通道
node test/bench.mjs --n 20 --concurrency 4 --render=false --label http

# 真实论坛适配器（需本机 Edge；免登录走 SSR）
node test/forum-live.mjs iloveswufe 120
```

## 改造前（0.2.x）

| 指标 | 数值 |
|---|---|
| 单条采集 | ~2.4s（`browser_collect` 并发 3） |
| 20 条总耗时 | 常态 45s+，并出现过 `page.goto` 45s 超时 |
| 批量上限 | 单次 20 条 / urls 100 |
| 列表提取 | `structured` 只能取第一个匹配，需逐条选择器 |

主要原因：

1. 每条 URL 新建/关闭标签页；
2. 导航后固定 `sleep(450)` + 渲染等待 700ms + `waitForLoadState` 最多 2500ms；
3. 默认 `delayMs=800`、并发 2；
4. 检查点每条结果全量重写；
5. 没有免渲染路径。

## 改造后（0.3.0）

| 指标 | 渲染路径 | HTTP 快通道 |
|---|---|---|
| P50 | **1.18–1.27s** | **0.73–0.78s** |
| P95 | 2.1s | 1.0s（偶发 6.8s 由站点限速导致） |
| 20 条总耗时 | **10.0s** | **6.3–12.4s** |
| 失败 | 0 | 0 |
| 单页正文 | — | ~500KB |

真实论坛适配器（`discover=true`，14 个版块）：

```
11.8s ｜ 122 条 ｜ 100% 带作者 tiny_id ｜ 请求 14 ｜ 失败 0 ｜ 去重 10
```

即 **10 条/秒**，且每条都带作者存档 ID。

## 关键改动

| 改动 | 效果 |
|---|---|
| 导航去固定 sleep，改 `navigateSettleMs=120` | −0.4~0.5s/条 |
| worker 复用常驻标签页 | 省去每条的建页/销毁 |
| 并发默认 4、`delayMs` 默认 0、风控自适应退避 | 吞吐 ×3~4 |
| 检查点 JSONL 追加 + 1s 防抖快照 | 去掉 O(n²) 全量重写 |
| `records` 提取模式 | 一次拿整页列表 |
| `browser_fetch` 快通道（Cookie/UA/Referer） | 1.2s → 0.75s，且不占渲染进程 |
| `browser_forum` 适配器 + 版块自动发现 | 百条级归档进入 10 秒档 |

## 踩坑记录

- `pd.qq.com` 会对 `HeadlessChrome` UA 返回 ~1KB 的 JS 挑战页（设置 `__tst_status` 后跳转）。
  快通道必须使用页面真实 UA（去掉 headless 标记）+ 同源 Referer，否则拿不到正文。
- 站点是 SPA + 长轮询，`waitUntil: 'networkidle'` 可能永不结束；统一用 `domcontentloaded` + 短沉降。
- `?page=2` 对 SSR 无效；真正翻页是 `GetGuildFeeds` 的 `feedAttchInfo` 游标（需要登录 Cookie）。
- 作者昵称不可作为身份（大量重名 `momo`），必须用帖子 id 内嵌的 `tiny_id`。

## 0.5.0：QQ 论坛分页

| 指标 | SSR 首屏（0.3） | 游标分页（0.5） |
|---|---|---|
| 单版块 | 10–12 条 | 100+ 条 |
| 14 版块总条数 | 122 | **1237** |
| 总耗时 | 7.7s | **15.6s** |
| 吞吐 | 15.8 条/秒 | **79.4 条/秒** |

关键点：`x-oidb` 必须 `{"uint32_service_type":10}`；`bkn` 从 `p_skey/skey` 现算并缓存；
每页服务端上限约 12 条；`count` 调大无效，提速靠**版块级并发**（默认 3，可到 6）。

可见翻页（`watch:true`）：二手 100 条 / 18 次滚动 / 40s，窗口里能看到滚动加载。

## 0.7.7：交互延迟（定位 / 截取 / 翻页）

复现：`npm run test:perf`（本地测试页、headless、关闭 HUD）。下表是同机改前/改后：

| 操作 | 0.7.6 | 0.7.7 | 关键改动 |
|---|---|---|---|
| `browser_act` scroll | 443ms | **219–268ms** | 多次滚动只等一个 80ms 沉降；`detectNewTab` 先看页数再等 |
| `browser_act` click | 422ms | **240ms** | 同上 |
| `browser_snapshot` 限定 `selector`（无交互元素） | 330ms | **15ms** | 限定区域时不再为“0 个元素”白等 300ms |
| `browser_paginate` 3 页 | 577ms | **463ms** | 变化轮询 150→60ms、沉降 120→80ms、loadState 上限 5s→1.5s |
| `browser_paginate` 每页均摊 | 191ms | **154ms** | 同上 |
| `browser_batch` goto+extract | — | **54ms** | 新增 `goto` 步骤，一次调用完成跳转+提取 |
| `browser_screenshot` 视口 / 整页 | 150 / 540ms | **113 / 485ms** | 视口截图优先；整页截图天然更慢 |

另外：

- `navigateSettleMs` 默认 120 → **60ms**；
- `browser_act` 默认 **auto 快照**：只有页面变化或 click/type/press 等动作才附带快照；scroll/hover/wait/check 不再背 8KB 快照；
- `browser_open` 支持 `snapshot:false`（只为跳转）与 `snapshotSelector`（只扫局部）。

仍无法消除的固定成本：Edge **冷启动 ~3–5s**（浏览器常驻后不再发生，`idleCloseMs=0`）；论坛/交易所首次 HTTPS 建连偶发 3–5s。


## 0.8.0：工具面瘦身 + 内容缓存

| 指标 | 0.7.7 | 0.8.0 |
|---|---|---|
| 工具数 | 23 | **18** |
| 工具 schema（每请求固定） | 27,794 B ≈ 8,700 tokens | **20,993 B ≈ 6,560 tokens**（−24%） |
| 读取入口 | observe/inspect/extract/screenshot 四个 | 合并为 `browser_read`（source 分发） |
| 多步 | `browser_batch` 独立工具 | 并入 `browser_act.steps` |
| 内容缓存 | 无 | `browser_fetch` / `browser_read`（opt-in），命中 **2ms**（本地；网络路径原 26ms–5s） |
| 回包精简 | 默认全量 | `detail=compact`：records 前 20 条、text 截 4000 字符 |
| 未变化快照 | 每次全文 | 相同快照只回一行并沿用旧引用 |
