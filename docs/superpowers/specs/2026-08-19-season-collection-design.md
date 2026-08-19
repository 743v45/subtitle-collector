# 合集（ugc_season）采集与合集标签设计

> 2026-08-19。示例锚点：BV12WGV67Ehm ∈ 合集「AI前沿-2026」（season_id 7070308，UP GoldenSpiderAI，484 条）。

## 0. 背景与目标

B 站 UP 主常把系列视频组织成**合集（ugc_season）**。当前系统已把 `extra.ugc_season = {id, title}` 采集入库（inject.js readVideoExtra → ingest-payload.js → videos.extra），但**零消费端**。本设计补两块：

1. **popup 合集卡**：视频页当前视频属于合集时，展示合集视频列表（字幕已采标注）+ 勾选批量上报（复用 `/api/collect-tasks/batch`）。
2. **season 档标签（第五档，只读）**：标签系统在 manual/batch/ai（落表）+ bili（只读实时读 extra.tags）之外新增 season 档——只读实时读 `extra.ugc_season.title`，对齐 bili 模式。

## 1. 关键决策（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 合集标签实现方式 | **只读档**（对齐 bili）：零写路径、零迁移、零 backfill；合集改名/移出自动跟随（重采即更新）。代价：标签库列表（GET /api/tags）不含该档（对齐 bili 现状）；SQL 过滤走 json_extract 特判 |
| popup 合集卡形态 | **对齐 UpperAllVideosCard**：折叠态合集名+总数+已采数；展开后过滤 pill + 勾选列表（已采绿点）+ 批量采集（现有 `/api/collect-tasks/batch`，server 调度免导航采集） |
| 合集列表 API | `/x/polymer/web-space/seasons_archives_list?season_id=&sort_reverse=false&page_num=&page_size=30`（**已验证免 wbi 签名、mid 非必需**；archive 条目含 bvid/title/duration/pic/pubdate/stat.view） |

## 2. 扩展端（subtitle-collector）

### 2.1 background：fetchAllSeasonVideos

对齐 `fetchAllUpperVideos` 结构（storage 唯一真相 + 页间节流 + 中断保部分结果）：

- storage key：`seasonVideos:{seasonId}`，结构 `{items, total, done, error, fetchedAt}`（同 upperAllVideos）
- item 字段：`{bvid, title, created(unix秒=pubdate), play(stat.view), duration(秒), pic}`
- 分页：page_size=30、页间 500ms 节流（防 -412 风控）、bvid 去重、连续 3 整页无新条目终止
- 缓存：1h TTL；`refresh=true` 绕过（popup ↻ 按钮）
- 消息分支：`FETCH_SEASON_ALL {seasonId, refresh?}`，异步长任务立即回执，数据经 storage 增量流出
- 错误透传：非 0 code → `error: 'seasons_archives_list <code>（已拉 x/total，中断）'`

### 2.2 popup：useSeasonVideos hook + SeasonVideosCard

- `useSeasonVideos(season: {id, title} | null)`：挂载触发 FETCH_SEASON_ALL + storage.onChanged 增量渲染（抄 useUpperAllVideos）
- 入口数据源：**只依赖 local extra.ugc_season**（GET_LOCAL_STATE）——纯扩展模式也可拉合集列表（B 站 API 直连）；仅已采标注/批量采集按钮需 server（standalone 置灰，对齐 UP 卡）
- 渲染条件：`currentPlatform.id === 'bilibili'` 且 local extra 有 ugc_season；位置在视频卡后、UP 卡前
- 已采标注：合集内视频同属一个 UP（B 站合集只能装 UP 自己的视频）→ 复用 `useCreatorCollected(upperMid)`；upperMid null 时状态列隐藏
- 列表行：checkbox + 封面缩略图（16:9，协议头归一 https:）+ 已采绿点 + 标题链接 + 时长/播放/日期小字
- 过滤 pill：状态（全部/未采/已采，已采标注可用时）+ 近半年/近一年 + 播放量档位——对齐 UP 卡
- 批量：勾选 → `POST /api/collect-tasks/batch {bvids}`（>50 confirm 提示）——**现有端点零改动**

## 3. server 端（collector-server）：season 只读档

改动面（全部对齐 bili 档既有先例）：

| 文件 | 改动 |
|---|---|
| `db/settings.ts` | `TagPrioritySource` 加 `'season'`；默认序 `['manual','batch','bili','season','ai']`；排列校验改五档。存量四档 settings 校验失败 → 回落新默认（自动升级，自定义过的顺序会重置——可接受，一次性） |
| `db/advanced.ts` | `tagMatchCond`：allSources 加 season，分支 `json_extract(v.extra,'$.ugc_season.title') = / LIKE ?`；`aggregateStats('tag')`：UNION ALL 加 season 分支（`json_extract(v.extra,'$.ugc_season.title')`） |
| `http/filter.ts` | tag_source 合法值加 `'season'` |
| `http/queries.ts` | `mergeTagDetails` 加 seasonNames 参数；`enrichItems` SQL 加 `json_extract(extra,'$.ugc_season.title')`；详情页并入 season 名；打标/移除 season → 400（只读，对齐 bili） |
| `db/tags.ts` | **不动**（season 不入 TAG_SOURCES，不落表） |

语义：season 档与 bili 档同为平台结构化只读档——标签库列表（GET /api/tags）不含、档位过滤组（TagsPage）不含，但视频列表/详情 tag_details 展示、tag/tag_source 过滤、tag 聚合计数全支持。

## 4. web 端（collector-web）

- `src/lib/tagSources.ts`：`TagSource` 加 `'season'`；CLASS teal 系 / LABEL「合集」/ DOT 同色加深
- `VideoList.tsx`：tagSource 下拉加「合集」选项
- `TagsPage.tsx`：本地 DEFAULT_PRIORITY 加 `'season'`（优先级排序组；档位过滤组仍不含 bili/season）
- 验收：`vite build` 冒烟

## 5. 测试与验收

| 层 | 方式 |
|---|---|
| collector-server | `node --test --import tsx`：settings 五档默认/存量回落、advanced tag_source=season 过滤与聚合、queries enrich tag_details 含 season、打标 season 400 |
| subtitle-collector | `vite build` 冒烟 + `node:test`（现有全绿不回归）+ `scripts/verify-subtitle-sources.mjs`（puppeteer mock，冒烟主链路） |
| collector-web | `vite build` 冒烟 |
| 手工验收 | 视频页 popup 见合集卡（拉取进度→列表→已采标注）；勾选批量采集任务落库；web 视频列表 tag_details 出现 season 档「合集」色标；tag_source=season 过滤命中 |

### 测试轮次记录表

| 轮次 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 1 | `npm test`（collector-server，`node --test --import tsx`） | ✅ 294/294 | 新增 5 用例：settings 五档默认+存量四档自动升级；advanced season 筛选/聚合 ×2；http tags season 富化/只读/过滤/聚合 ×1（含旧四档断言升五档） |
| 2 | `npm test`（subtitle-collector）+ `npx vite build` ×2（ext/web）+ `npm run build`（server tsc） | ✅ 121/121 + 三构建全过 | |
| 3 | `node scripts/verify-collector.mjs`（puppeteer 加载 dist 回归主链路） | ✅ | inject→content→WS ingest 全通 |
| 4 | 真机 API 冒烟（node 直调 `biliFetch` seasons_archives_list season_id=7070308） | ✅ | 484 条；字段映射（pubdate/stat.view/duration→"M:SS"/pic）逐一核对；尾页 4 条终止正确 |
| 5 | 手工验收（Chrome 151 + dist 扩展，视频页 BV12WGV67Ehm + popup.html 截图） | ✅ | 合集卡渲染：「合集 AI前沿-2026 共 484 条 已采 4」拉取完成；批量采集待用户装机后使用验收 |
