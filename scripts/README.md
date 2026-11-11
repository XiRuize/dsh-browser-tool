# QQ 论坛（腾讯频道）运营脚本

这些是**一次性/运营用**脚本，不属于插件运行时，也不进入 `test/` 的回归套件。
统一放在这里，避免污染插件测试目录。

| 脚本 | 用途 |
|---|---|
| `scrape-five.mjs` | 抓五个栏目各 N 条（默认 150），输出 JSON |
| `scrape-all-sections.mjs` | 抓全部栏目各 N 条 |
| `section-paging.mjs` | 单栏目游标翻页验证 |
| `pilot-sections.mjs` | 三栏目试点（二手/光华/柳林） |
| `bench-forum.mjs` / `speed-window.mjs` | 论坛抓取与窗口模式基准 |
| `watch-paging.mjs` | 观察分页/实时流 |
| `check-targets.mjs` / `check2.mjs` | 评论前检查（已有 dd / 已关闭 / 已过期） |
| `comment-dd.mjs` / `one-comment.mjs` | 在匹配需求下发 `dd` 评论 |

## 使用前提

1. 这些脚本直接复用插件 profile 的登录态，**运行前要关闭插件浏览器**（`browser_close`），否则 profile 被占用会启动失败。
2. 换账号后 `bkn` 会变：先从页面网络请求里取 `?bkn=`，作为参数传入（`scrape-five.mjs` 第 5 个参数）。
3. 抓取接口：`GetChannelTimelineFeeds`，`x-oidb` 必须 `{"uint32_service_type":10}`。

## 示例

```bash
# 关闭插件浏览器后
node scripts/qq-forum/scrape-five.mjs "C:/path/to/out" 150 4 1276245135
```
