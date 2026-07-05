# 视频标签采集 + Web 后台展示完善 设计

> 对应用户反馈（2026-07-05）：「视频内容上报有标签，都可以计到我们的分类里。我看数据展示有问题。除了字幕，很多功能缺的。」

## 1. 背景与目标

四路并行调研（视频上报流 / web 展示 / server 模型 API / 功能缺口）收敛出一个核心洞察：

> **数据已经在 DB 里、CLI 强大、扩展 popup 富 UI，唯独 collector-web 后台几乎不展示。** 这就是用户「功能缺」的根因——不是采集缺，是消费侧（web）缺。

三层诉求对应的根因：

| 用户诉求 | 根因 |
|---|---|
| 视频上报有标签，可以计入分类 | 代码层面 `extra.tags` 通路齐全，但扩展从 `__INITIAL_STATE__.videoData.tags` / `/x/web-interface/view` 抽 tags，**这两个源标准不返回 tags**，实际多为空；`tid`/`tname` 分区稳定有。web 端既不展示也不筛选标签/分区。 |
| 数据展示有问题 | 几乎所有页面 fetch 失败 `.catch(() => 空数组)` **静默吞错**；无 loading；VideoDetail 只渲染 4 字段（封面/分区/标签/统计全丢，且 `extra` 是 TEXT 字符串前端没 parse）。 |
| 除了字幕，很多功能缺的 | 无统计看板、无 UP 主详情页、视频列表筛选维度单一（仅 title 模糊）、CLI 已有的多维过滤/统计/导出能力没挂 HTTP。 |

## 2. 范围

**做**：
- 扩展：主动采集补 `/x/tag/archive/tags`，让 `extra.tags` 真有数据。
- server：把 `db/advanced.ts` 已有能力（`listVideosFiltered`/`aggregateStats`/`countOverview`）暴露成 HTTP（`/api/videos` 升级 + `/api/stats` 新增）；确认 `/api/creators/:id` 富字段；清死代码。
- web：全局基建（`useAsync` + toast + skeleton，统一 loading/error，消灭静默吞错）；新增「看板」页；VideoList 多维筛选；VideoDetail 字段补全；新增 UP 主详情页；CreatorsPage 双 scope 分类编辑；CategoriesPage CRUD 加固。

**不做（YAGNI）**：字幕全文检索（FTS5）、路由化（react-router）、多用户权限、定时任务、视频级自定义标签管理、subtitle-extractor 填充。这些留 P1/P2 后续。

## 3. 现状与缺口（依据）

### 3.1 视频上报带标签了吗？
- `videos.extra`（TEXT/JSON）结构含 `tid, tname, ..., tags:[{tag_id,tag_name}], ...`（[schema.sql:33-41](apps/collector-server/src/db/schema.sql#L33)）。
- 扩展 `extractExtraFromView`（[ingest-payload.js:2-28](apps/subtitle-collector/ingest-payload.js#L2)）显式采集 tid/tname/tags。
- **但数据源不返回 tags**：被动从 `__INITIAL_STATE__.videoData.tags`、主动从 `/x/web-interface/view`，两者标准不含 tags。需另调 `/x/tag/archive/tags?aid=`（通常免 wbi）。
- 服务端原样塞 `videos.extra`（[ingest.ts:82](apps/collector-server/src/db/ingest.ts#L82)），无独立标签表/索引。

### 3.2 server API 缺口
- `db/advanced.ts` 实现了 `listVideosFiltered`（tid/tname/tag/lang/has_subtitle/时间窗/时长/sort）、`aggregateStats`（by creator/tname/lang/track-type）、`countOverview` —— **只被 CLI 用，没挂 HTTP**（[advanced.ts:151](apps/collector-server/src/db/advanced.ts#L151)）。
- `GET /api/videos` 仅支持 `q/page/size`（[http/queries.ts:14](apps/collector-server/src/http/queries.ts#L14)）。
- 死代码：`handleQueryHttp` 里重复的 `/api/creators/:id` 分支（已被 `http/creators.ts` 拦走）。

### 3.3 web 展示缺口
- ui 库只有 9 组件，**无 toast/skeleton/alert/pagination**。
- 几乎所有页面 `.catch(()=>静默吞)`，无统一 loading/error。
- VideoDetail 只渲染 4 字段；`extra` 是字符串前端没 `JSON.parse`，封面/分区/标签一直取不到。
- 缺：统计看板页、UP 主详情页、视频多维筛选。

## 4. 总体设计

### 4.1 扩展 tag 采集（subtitle-collector）
- `background.js` 的 `fetch-subtitle` 流程拿到 aid 后，额外 GET `/x/tag/archive/tags?aid=<aid>`，规整成 `[{tag_id, tag_name}]` 注入 `extra.tags`。
- 失败 try/catch 兜底（不阻断字幕采集，tags 保持空数组）。
- `verify-collector.mjs` mock 补 tag 接口响应。

### 4.2 HTTP API 契约（server）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/videos` | 升级：支持全 `VideoFilter`（q/tid/tname/tag/lang/has_subtitle/since/until/min_duration/max_duration/sort/desc/page/size）。向后兼容旧 q/page/size。底层调 `listVideosFiltered`。items 补 `tname`/`tid`/`tags`(tag_name 数组)/`published_at`/`creator_source_uid`。 |
| GET | `/api/stats?type=overview` | 返回 `{overview: countOverview结果}` |
| GET | `/api/stats?type=aggregate&groupBy=creator\|tname\|lang\|track-type` | 返回 `{items: KeyValue[]}`，支持 VideoFilter 过滤 |
| GET | `/api/creators/:id` | 富字段（已有，确认） |

响应统一 `{ok:true,...}` / `{ok:false,error}`。删 `handleQueryHttp` 死分支。

### 4.3 collector-web 前端
- **全局基建**：
  - `src/lib/useAsync.ts`：`{data, loading, error, reload, setData}`，防竞象，替代静默吞错。
  - `src/components/ui/toast.tsx`：自建极简 toast（不引入 sonner，纯 Tailwind），`useToast()` API。
  - `src/components/ui/skeleton.tsx`：shadcn 标准。
  - `main.tsx` 包 `ToastProvider`。
- **api.ts / types.ts 扩展**：`VideoFilter`/`StatsOverview`/`KeyValue`/`StatsGroupBy`/`CreatorDetail` 类型；`listVideos(filter)`/`getStatsOverview`/`getStatsAggregate`/`getCreatorDetail` 函数；`getVideo` 入口 `JSON.parse(extra)` 修复元信息取不到的 bug。
- **App.tsx**：加「看板」tab + UP 主详情 view 状态。
- **页面**：
  - `StatsPage`（新）：overview 数字卡 + 分组聚合 Top 榜（条形用静态 `WIDTH_CLASSES` 字面量数组，合规禁内联 style）。
  - `VideoList`（重写）：多维筛选（分区/标签/语言/有无字幕/排序）+ Skeleton + error 重试。
  - `VideoDetail`（重写）：补全分区/标签/统计/简介/发布时间/版权/P 数 + 字幕加载 error 态。
  - `CreatorDetailPage`（新）：UP 主资料 + 双 scope 改分类。
  - `CreatorsPage`（重写）：Agent/人工分类都可编辑 + 双 scope 筛选 + try/catch + busy。
  - `CategoriesPage`（重写）：CRUD 全 try/catch + toast + busy + 改名用 Dialog。

## 5. 错误处理
- 所有异步走 `useAsync`，error 落到 UI（text-destructive + 重试），不再静默吞。
- 写操作（分类 CRUD / 打分类）try/catch + toast 成功/失败 + busy disabled。
- 扩展 tag 接口失败不阻断主流程。

## 6. 测试策略（对齐项目 CLAUDE.md §3）
- server：`node --test --import tsx`，覆盖 `/api/videos` 带 tag/tid 过滤、`/api/stats` overview/aggregate、向后兼容、清死代码后无回归。
- 扩展：`pnpm test:ext`（verify-collector.mjs mock），补 tag 接口 mock。
- web：`vite build` 冒烟（`pnpm -C apps/collector-web test`）。
- 编排：`turbo run test` 全绿。

## 7. 验收清单

5 路 agent teams 并行实施 + 主控整合，全量验证通过（2026-07-05）：

- [x] 扩展主动采集后 `extra.tags` 非空 —— [background.js:176-185](apps/subtitle-collector/background.js#L176) 加 `/x/tag/archive/tags` + `normalizeTags`，try/catch 兜底不阻断主流程；`tags` 传入 `buildIngestPayload`。ext build 通过。
- [x] `GET /api/videos?tag=X` 返回含该标签视频 —— [http/queries.ts](apps/collector-server/src/http/queries.ts) 走 `listVideosFiltered` + `enrichItems`（json_extract 从 extra 取 tags 降维）；server 182 测试全绿。
- [x] `GET /api/stats?type=overview` / `?type=aggregate` —— [http/stats.ts](apps/collector-server/src/http/stats.ts) + 抽公共 [http/filter.ts](apps/collector-server/src/http/filter.ts)；server 测试覆盖。
- [x] 死代码清理 —— `handleQueryHttp` 重复 `/api/creators/:id` 分支已删（http/queries.ts:82-83 注释为证）。
- [x] web 看板页 —— [StatsPage.tsx](apps/collector-web/src/pages/StatsPage.tsx) overview 数字卡 + 分组 Top 条形（`WIDTH_CLASSES` 静态字面量合规）。
- [x] web VideoList 多维筛选 —— [VideoList.tsx](apps/collector-web/src/pages/VideoList.tsx) 分区/标签/语言/有无字幕/排序 + Skeleton + error 重试。
- [x] web VideoDetail 字段补全 —— [VideoDetail.tsx](apps/collector-web/src/pages/VideoDetail.tsx) 分区/标签/统计/简介/发布时间/版权/P 数 + 字幕加载 error 态；`getVideo` 入口 `JSON.parse(extra)` 修复元信息取不到的 bug。
- [x] web UP 主详情 + 双 scope 分类 —— [CreatorDetailPage.tsx](apps/collector-web/src/pages/CreatorDetailPage.tsx) + [CreatorsPage.tsx](apps/collector-web/src/pages/CreatorsPage.tsx) Agent/人工分类均可编辑 + 双 scope 筛选。
- [x] web 各页 fetch 失败显示错误 —— `useAsync` hook 统一 loading/error/data，消灭 `.catch(()=>静默吞)`；CategoriesPage CRUD 全 try/catch + toast + busy。
- [x] `turbo run test` 全绿 —— server `node --test` 182/182、web `vite build` 1886 modules、ext build 78 modules。

## 8. 测试轮次记录表（对齐全局 8.2）

> 实现完成后填写。

| 轮次 | 日期 | 测试范围 | 结果 | 备注 |
|---|---|---|---|---|
| 1 | 2026-07-05 | server `node --test`（含新 stats + videos 筛选测试） | ✅ 182 pass / 0 fail | server-agent 新增 http/stats + videos filter + 公共 filter.ts |
| 1 | 2026-07-05 | web `vite build` 冒烟 | ✅ 1886 modules | 主控基建（useAsync/toast/skeleton）+ 4 页改造 + 2 新页全编译通过 |
| 1 | 2026-07-05 | ext `vite build` 冒烟 | ✅ 78 modules | background.js 加 `/x/tag/archive/tags` 采集 |
| 1 | 2026-07-05 | ext `node:test` 单测 | ✅ 44 pass / 0 fail | 含新增 normalizeTags + buildIngestPayload tags 注入 3 例 |
| 1 | 2026-07-05 | ext puppeteer e2e（`pnpm test:ext`） | ✅ exit 0 | 21527 被运行中的 collector-server 占用，ext-agent 临时切 21528 跑通后 `git checkout` 干净 revert；verify 覆盖被动路径（inject→content）+ navigate/operate，被动 tags 源修复在 `__INITIAL_STATE__` 缺失时 no-op 不退化；主动路径 tag 采集（`/x/tag/archive/tags`）verify 不触发，由单测覆盖 |

## 9. agent teams 实现拆分

| 子任务 | 执行方 | 改动范围 |
|---|---|---|
| server HTTP API（videos 筛选 + stats + 清死代码） | server-agent | `apps/collector-server/src/http/*` + 测试 |
| 扩展 tag 采集 | ext-agent | `apps/subtitle-collector/background.js` + verify mock |
| web 全局基建（useAsync/toast/skeleton）+ 共享层（api/types/App） | 主控 | `apps/collector-web/src/{lib,components/ui,api,types,App,main}.ts(x)` |
| StatsPage 看板 + VideoDetail 补字段 | 主控 | `pages/StatsPage.tsx` + `pages/VideoDetail.tsx` |
| VideoList 多维筛选 | web-videolist | `pages/VideoList.tsx` |
| UP 主详情 + CreatorsPage 升级 | web-creators | `pages/CreatorDetailPage.tsx` + `pages/CreatorsPage.tsx` |
| CategoriesPage 加固 | web-categories | `pages/CategoriesPage.tsx` |
