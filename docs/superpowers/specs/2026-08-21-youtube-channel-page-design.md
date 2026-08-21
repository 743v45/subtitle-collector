# YouTube 频道页支持（popup 频道卡 + server 批量任务）设计

> 2026-08-21。示例锚点：https://www.youtube.com/@mattpocockuk（及其 /videos 等子页）。

## 0. 背景与目标

B 站侧已有「UP 全部视频卡」（空间页/视频页入口，全量分页 + 勾选批量采集，`fetchAllUpperVideos` + `BatchCollectCard`）。YouTube 侧被动采集（watch 页）与主动采集（`fetch-youtube-subtitle` navigate）已通，但**频道页（UP 主页）无任何入口**。本设计补：

1. **popup 频道卡**：`youtube.com/@handle/**`（含 `/channel/UC…`、`/c/`、`/user/` 及所有子页）识别为 UP 主页，展示频道视频列表 + 勾选批量采集。
2. **server 批量任务**：`/api/collect-tasks/batch` 支持 `{vids, source}`（调度分发 `fetch-youtube-subtitle` 已有，零改动）。

## 1. 关键决策

| 决策点 | 结论 |
|---|---|
| 频道页判定 | youtube.com 域 + path 匹配 `^/@[^/]+` / `^/channel/UC[\w-]{22}` / `^/c/` / `^/user/`（任意子页）。纯函数 `extractYoutubeChannelKey(url)`，node:test 覆盖 |
| 列表数据源 | 频道 `/videos` tab：HTML `ytInitialData`（首页 ~30 条 + continuation token）+ InnerTube `POST /youtubei/v1/browse`（续页全量分页）。API key / clientVersion 从首页 HTML 抠（`INNERTUBE_API_KEY` / `INNERTUBE_CONTEXT_CLIENT_VERSION`），clientVersion 兜底硬编码 |
| 列表范围 | 仅 `/videos` tab（普通视频 + 直播回放）。shorts/streams 独立 tab（需额外 tab params）不做——字幕采集价值低，YAGNI |
| 发布时间 | `publishedTimeText` 是相对文本（"3 weeks ago"）→ 估算时间戳（供「近半年/一年」过滤，档位粗粒度足够） |
| server 边界 | batch 端点 source 参数化 + 已采查询 source 参数化。`/api/upper-videos/expand`（web「按 UP 批量」B 站专用）不做 YouTube 版 |
| 网络验证 | 开发机无 YouTube 网络：解析层宽容降级（多形态正则）+ error 透传到卡上；真机验收由用户装机完成 |

## 2. 扩展端（subtitle-collector）

### 2.1 纯函数 `yt-channel.mjs`（node:test 可测）

- `extractYoutubeChannelKey(url)`：`{kind: 'handle'|'channel', key: '@mattpocockuk' | 'UCxxx'} | null`（watch/shorts/结果页等非频道页 → null）
- `parseYtChannelHtml(html)`：抠 channelId/channelName/videos[]/continuation token/INNERTUBE key+clientVersion
- `parseYtBrowseResponse(json)`：抠 videos[]/下一页 token（与 HTML 页共用 videoRenderer 解析）
- `parseRelativeTime(text)`：`"3 weeks ago"` → 估算 unix 秒
- `parseVideosCount(text)`：`"1.2K videos"` → 1200（进度分母）

### 2.2 background：`fetchAllYoutubeChannelVideos({handle?|channelId?})`

- 对齐 `fetchAllUpperVideos`：storage `ytChannelVideos:{key}` 唯一真相、页间 500ms、bvid 去重、noNewStreak≥3 终止、1h TTL + refresh
- 首页 URL：handle → `/@handle/videos`；channelId → `/channel/UC…/videos`
- item：`{vid, title, created(估), play, length, pic?}`（YouTube 缩略图 `https://i.ytimg.com/vi/{vid}/mqdefault.jpg` 可直接拼，无需解析）
- 消息分支 `FETCH_YT_CHANNEL_ALL {key, refresh?}`

### 2.3 popup

- `useSpaceMid` 泛化为 `useUpperEntry(): {source, key} | null`（B 站空间页 mid / YouTube 频道页 key）
- `useYoutubeChannelVideos(key)`：对齐 `useUpperAllVideos`
- `useCreatorCollected(mid, httpBase, enabled, source)`：加 source 参数（已采标注 `?source=youtube&creator_uid=UC…`）
- `BatchCollectCard` 链接参数化：`linkFor(vid)` prop（B 站 `bilibili.com/video/BV` / YouTube `watch?v=`）
- 渲染：YouTube 频道页 → 频道卡（storage 数据的 channelId 到位后已采标注才查）；YouTube 视频页 → 对齐 B 站视频页（server creator.source_uid = channelId → 出卡）；批量提交带 `source`

## 3. server 端（collector-server）

- `createTasksBatch(db, vids, source)`：source 参数化（默认 bilibili 兼容旧调用）；去重查询/URL 拼接按 source
- `/api/collect-tasks/batch`：body 兼容 `{bvids}`（→bilibili）+ `{vids, source}`（youtube）；校验 youtube vid 11 位
- 调度分发（`fetch-youtube-subtitle` + videoId）已有零改动

## 3.5 CLI：`collect yt-videos`（用户要求的 CLI 批量方式）

- 参数 `<key>`：`@handle` / `UCxxx` / 频道页 URL（`parseYtChannelArg` 纯函数解析，非法报错）
- `--since-days <n>`：相对时间估算过滤（created==null 保留防漏采）；`--refresh` 绕过扩展侧 1h 缓存
- `--collect`：先 `collectDedupe(db, vids, 'youtube')` 挑未入库 → 逐条 `fetch-youtube-subtitle`（navigate 采集 ~1 分钟/条，间隔 `--sleep` 默认 1500ms）；need_login/risk_control 即停
- 扩展侧 WS action `list-yt-channel-videos {ident, refresh}`：background 全量拉完（或缓存命中）从 storage 读出回执（channel_id/channel_name/total/items）；默认 `--timeout 180000`（全量分页含节流）
- popup 侧消息分支 `FETCH_YT_CHANNEL_ALL`（storage 流式增量渲染进度）；`useUpperEntry` 泛化替代 useSpaceMid（B 站空间页 + YouTube 频道页统一入口），顺带修复「YouTube 视频页 upMid=channelId 误喂 B 站 UP 卡」存量 bug（upperMid 仅 bili 平台）

## 4. 测试与验收

| 层 | 方式 |
|---|---|
| yt-channel.mjs | node:test：URL 识别（handle/channel/c/user/子页/watch 排除）、HTML/响应解析（fixture 片段）、相对时间/计数解析 |
| collector-server | node --test：createTasksBatch source 参数化 + batch 端点 youtube body |
| 三端 | vite build ×2 + tsc + 全套 node:test 回归 + puppeteer 主链路回归 |
| 真机 | 用户装机：频道页出卡 → 列表拉取 → 勾选批量 → server 任务派发（navigate 采集） |

### 测试轮次记录表

| 轮次 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 0 | 前置技术验证（curl 频道页 + InnerTube browse 续页，@mattpocockuk） | ✅ | 首页 30 lockupViewModel + continuation token；续页 30 条 + 新 token；`"299 videos"` 总数；`/channel/UC…/videos` 直查同构 |
| 1 | `node --test test/yt-channel.test.mjs` | ✅ 11/11 | URL 识别（含排除表）/计数/相对时间/lockup 解析/HTML 解析/URL 构造 |
| 2 | server `npm test` | ✅ 299/299 | 新增：createTasksBatch youtube（11 位校验/watch URL/复合去重域）+ parseYtChannelArg ×2 + collectDedupe source + collectYtChannelVideos 透传 |
| 3 | 扩展 `npm test` + `vite build` + server `tsc` + puppeteer 回归 | ✅ 132/132 + 构建过 + 主链路 ✅ | |
| 4 | 真机验收（Chrome 151 + dist v0.1.4，@mattpocockuk/videos + popup 截图×2） | ✅ | 折叠态「频道全部视频 共 300 条 已采 0」拉取完成；展开态列表行（缩略图/标题链接/时长/播放/日期/勾选/过滤 pill/channelId footer）全渲染；YouTube 视频页误出 B 站 UP 卡的存量 bug 顺带修复 |

### 补充轮次（2026-08-21 用户反馈两 bug：过滤不生效 + 拉取「⚠ 中断」）

| 轮次 | 验证 | 结果 | 备注 |
|---|---|---|---|
| 5 | 根因调查：测试 Chrome 读 storage + SW 上下文 A/B 头组合实验 + 页面上下文对照 | 定位 | **根因**：MV3 SW 跨源 POST 自动带 `Origin: chrome-extension://…`（浏览器强制、header 盖不掉）→ InnerTube browse 403（无头/Referer/X-Origin/延迟 四组合全 403；页面上下文 200）。首页 HTML 不受影响（仍走 background）。过滤不生效为次生症状：403 截断后仅剩 30 条最新视频，时间/播放量档位命中全部条目无视觉区分 |
| 6 | 修复（v0.1.5）：续页改经 YouTube 页面 tab 执行（`chrome.scripting.executeScript`，对齐 collectYoutubeViaNavigate「页面运行时」先例）；复用已开 YouTube tab / 无则后台开一个拉完即关；manifest + `scripting` 权限 | ✅ | 修后测试 Chrome：`error:null`、143 条拉完无中断（143≠299 为该测试 profile 未登录 YouTube 的数据源限制，用户登录态不受影响）；数据区分度恢复：近半年 25/143、1万+ 133/143 |
| 7 | 回归：扩展 `npm test` 132/132 + `vite build` + puppeteer 主链路 | ✅ | 用户真机验收：重装 v0.1.5 → 频道页 popup ↻ 重拉 → 过滤 pill 生效确认 |
