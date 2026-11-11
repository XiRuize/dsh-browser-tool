# QQ 论坛（腾讯频道）运营脚本

这些是**一次性运营用**脚本，不属于插件运行时，也不进入 `test/` 的回归套件。

| 脚本 | 用途 |
|---|---|
| `scrape-five.mjs` | 抓五个栏目各 N 条（默认 150），输出 JSON |
| `scrape-all-sections.mjs` | 抓全部栏目各 N 条 |
| `section-paging.mjs` | 单栏目游标翻页验证 |
| `pilot-sections.mjs` | 三栏目试点（二手/光华/柳林） |
| `bench-forum.mjs` / `speed-window.mjs` | 论坛抓取与窗口模式基准 |
| `watch-paging.mjs` | 观察分页/实时流（可见滚动） |

## 使用前提

1. 脚本直接复用插件 profile 的登录态，**运行前先关闭插件浏览器**（`browser_close`），否则 profile 被占用会启动失败。
2. 换账号后 `bkn` 会变：当前实现会从 Cookie 现算；如需手动指定，可从页面网络请求里取 `?bkn=`。
3. 抓取接口：`GetChannelTimelineFeeds`，`x-oidb` 必须是 `{"uint32_service_type":10}`。