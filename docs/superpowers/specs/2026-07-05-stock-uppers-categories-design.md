# 股票 UP 主分类采集 + 后台管理 设计

> 状态：已批准（用户 `/goal` 指令：按推荐实现，勿问）。本文档为 agent teams 实现依据。
> 措辞：本项目是**字幕（subtitle）**系统，全文不涉及弹幕。

## 1. 背景与目标

用户场景：找**股票 UP 主**「今日 A 股收盘（15:00）后」发布的视频字幕，批量采集。要求：

1. 能按**发布时间窗**筛选（采集端目前完全没有，`created` 只用于打日志）；
2. 无字幕视频被采过一次会被永久标「已采」不可重试——刚发布的视频字幕可能还没生成，需可补采；
3. 给 UP 主打**分类**（如「股票」），且 **agent 自动分类**与**人工分类**两套选择项隔离；
4. 按分类批量采集（「多收集」）；
5. server 端查看页面（collector-web）需完善：补一个**后台管理页面**做分类管理 + UP 主管理 + 视频按分类筛选。

## 2. 范围

**In scope**：
- 采集端：`collectUpperVideosAll` 加发布时间窗过滤；新增 `collectNosub` 纯函数；`collect-uppers.mts` 加 `--after-market` / `--since` / `--retry-nosub` / `--category`。
- 数据层：新增 `categories` 表；`creators` 加 `category_agent_id` / `category_human_id`；migrate 双轨；ingest 不动。
- API 层：`/api/categories` CRUD；`/api/creators` 列表/筛选；`/api/creators/:source_uid/category` 打分类（agent/human 通用）。
- 前端层：collector-web 加「分类管理」「UP 主管理」两个 tab 页；视频列表加分类筛选；补 vite dev proxy；`npx shadcn add` 新组件。
- 测试：`collect.test.ts` 扩展；migrate 幂等测试；`vite build` 冒烟；含验收清单 + 测试轮次记录表。

**Out of scope（YAGNI）**：
- 定时/调度/cron/launchd wrapper（用户明确选「核心补齐」，订阅列表不持久化为独立子系统，改由分类承载）。
- 节假日交易日历（仅做周六/周日回溯到上周五；节假日由 `--since` 手动覆盖）。
- discover/new-videos 命令的时间窗（主入口是 collect-uppers）。
- 改 `collectDedupe` 语义（用独立 `collectNosub`，零风险）。
- 扩展层（background.js）改动。
- react-router / SWR / react-hook-form 引入（沿用 useState tab + useEffect + 手写表单）。
- 采集触发进 UI（不在后台页面触发 collect-uppers；YAGNI）。

## 3. 现状与缺口（依据）

- 采集链路全程**无发布时间过滤**：`created` 仅 `fmtDate` 展示（[collect-uppers.mts:77](../../../scripts/collect-uppers.mts#L77)、[L130](../../../scripts/collect-uppers.mts#L130)）；CLI 的 `--since/--until` 比的是入库时间 `first_seen_at`（[advanced.ts:122](../../../apps/collector-server/src/db/advanced.ts#L122)），非发布时间。
- 无字幕视频被标「已采」不可重试：[background.js:192](../../../apps/subtitle-collector/background.js#L192)「无字幕也入库 video，避免下次重采」；dedupe 只看 video 行存在（[collect.ts:68](../../../apps/collector-server/src/cli/commands/collect.ts#L68)）。
- 无分类体系：`creators` 表无分类字段（[schema.sql:2-18](../../../apps/collector-server/src/db/schema.sql#L2)）；无 categories 表。
- HTTP 无 `/api/categories`、无 `/api/creators` 列表（[http/queries.ts](../../../apps/collector-server/src/http/queries.ts) 只有 `/api/creators/:id` 详情）；缺 `listCreators` / `getCreatorBySourceUid`。
- collector-web 仅 videos/clients 两个 tab（[App.tsx:8](../../../apps/collector-web/src/App.tsx#L8)），无管理页；shadcn 仅 4 组件。

## 4. 总体设计

### 4.1 分类体系（数据层）

**两套隔离的分类选择项**：通过 `categories.scope ∈ ('agent','human')` 区分。同一 name 在不同 scope 下是不同条目（`UNIQUE(name, scope)`）。

- `categories` 表（新增，写入 [schema.sql](../../../apps/collector-server/src/db/schema.sql) 末尾，`CREATE TABLE IF NOT EXISTS` 幂等）：

```sql
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK(scope IN ('agent','human')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(name, scope)
);
CREATE INDEX IF NOT EXISTS idx_categories_scope ON categories(scope, sort_order);
```

- `creators` 加两列（双轨：[schema.sql](../../../apps/collector-server/src/db/schema.sql) 建表语句加 + [migrate.ts](../../../apps/collector-server/src/db/migrate.ts) 的 `CREATOR_COLUMNS` 追加，复刻 P2 字段范式）：

```sql
category_agent_id INTEGER REFERENCES categories(id),
category_human_id INTEGER REFERENCES categories(id)
```

- **ingest 路径零改动**：`ingestUpper` 的 `UPPER_FIELDS`（[ingest.ts:174](../../../apps/collector-server/src/db/ingest.ts#L174)）不含这两列，upsert 不会覆盖分类值。分类由 HTTP API 显式写入。

**命名注意**：`advanced.ts` 的 `Overview.categories`（[L312](../../../apps/collector-server/src/db/advanced.ts#L312)）是「B 站分区数」语义，与本表的「UP 主分类」无关，字段不冲突（不同上下文）。

### 4.2 采集端补齐（CLI 层）

**纯函数层**（[collect.ts](../../../apps/collector-server/src/cli/commands/collect.ts)）：

1. `collectUpperVideosAll(client, clientId, mid, size, timeout, sinceCreated?)`：合并 items 后追加一行过滤——`it.created == null || it.created >= sinceCreated`（**null 保留**避免漏采，日志标「发布时间未知」）。
2. 新增 `collectNosub(db, bvids): string[]`：`SELECT v.source_vid FROM videos v LEFT JOIN subtitle_tracks t ON t.video_id = v.id WHERE v.source='bilibili' AND v.source_vid IN (...) AND t.id IS NULL`，返回「已入 videos 但无字幕轨」的 bvid 子集。
3. commander：`upper-videos` 加 `--since-created <unix>` 选项（透传纯函数）。

**collect-uppers.mts**（[scripts/collect-uppers.mts](../../../scripts/collect-uppers.mts)）新增 argv：

| 参数 | 作用 |
|---|---|
| `--after-market` | 时间窗 = 「最近交易日 15:00」（本地时区）。周一~五=今日15:00；周六=上周五15:00；周日=上周五15:00。节假日不处理（用 `--since`）。 |
| `--since <unix秒>` | 手动指定起始时间戳，覆盖 `--after-market`。 |
| `--retry-nosub` | 采字幕队列额外并入 `collectNosub(时间窗内 bvids)`，强制重采无字幕视频（`fetch-subtitle` 不查 dedupe，ingest upsert 幂等，安全）。 |
| `--category <name>` | ① 采集前：从 DB 查 `scope='agent' AND name=<name>` 的分类，把该分类下所有 creator 的 mid 并入采集列表；② 采集后：对所有涉及的 mid，经 HTTP 标记其 `category_agent_id`。 |

**默认行为不变**（不加这些 flag = 现有「全采未入库」语义，向后兼容）。

**数据流**：
```
默认:        拉列表(--all) → dedupe → missing → 串行采
--after-market: 拉列表(--all, sinceCreated) → 时间窗items → dedupe → missing → 串行采
--retry-nosub:  以上 + collectNosub(时间窗bvids) 并入采集队列
--category X:   采集前并入该分类 mid；采集后标记 category_agent
```

**退出码语义不变**（0/2/3/4）。

### 4.3 HTTP API 契约（server 层）

照搬 [http/queries.ts](../../../apps/collector-server/src/http/queries.ts) 范式（本地 `json()` helper + 正则路由），新 handler `src/http/categories.ts` 与 `src/http/creators.ts`，在 [main.ts:57](../../../apps/collector-server/src/main.ts#L57) 的 `/api/` 兜底**之前**注册。

| Method | Path | body / query | 返回 | 用途 |
|---|---|---|---|---|
| GET | `/api/categories` | `?scope=agent\|human` | `{ok, items: Category[]}` | 列分类（按 scope+sort_order） |
| POST | `/api/categories` | `{name, scope}` | `{ok, category}` | 新建分类（`UNIQUE(name,scope)` 冲突→409） |
| PATCH | `/api/categories/:id` | `{name?, sort_order?}` | `{ok, category}` | 改名/排序 |
| DELETE | `/api/categories/:id` | — | `{ok}` | 删分类（creators 对应列置 NULL，不级联删 creator） |
| GET | `/api/creators` | `?q=&category=&scope=agent\|human&page=&size=` | `{ok, total, items: CreatorListItem[]}` | 列 UP 主，可按分类筛选 |
| GET | `/api/creators/:id` | — | `{ok, creator: CreatorDetail}` | 已有，补返回 `category_agent`/`category_human`（join 出 name） |
| POST | `/api/creators/by-uid/:source_uid/category` | `{scope:'agent'\|'human', name}` | `{ok, creator}` | 打分类（通用）：查/建 category → upsert creator（不存在则建最小行）→ 设对应列。collect-uppers `--category` 与前端「打 human 分类」都走这个。 |

`Category`：`{id, name, scope, sort_order, created_at}`。
`CreatorListItem`：`{id, source, source_uid, name, avatar, fans, video_count, category_agent_id?, category_agent_name?, category_human_id?, category_human_name?, first_seen_at}`（video_count 子查询 `videos` 表该 creator 的计数）。
`CreatorDetail`：现有全字段 + `category_agent`/`category_human`（join categories 取 name）。

**新查询函数**（放 [db/queries.ts](../../../apps/collector-server/src/db/queries.ts)）：`listCategories(db, scope?)`、`createCategory(db,name,scope)`、`updateCategory(db,id,...)`、`deleteCategory(db,id)`、`listCreators(db, filter, page, size)`、`getCreatorBySourceUid(db, source, source_uid)`、`setCreatorCategory(db, source, source_uid, scope, categoryName)`（含 upsert creator + 查/建 category）。

### 4.4 collector-web 后台页面（前端层）

**沿用 useState tab**（[App.tsx:8](../../../apps/collector-web/src/App.tsx#L8)），扩 `Tab` 类型加 `'categories' | 'creators'`，加导航 Button + 渲染分支。不引入 router。

新页面（`src/pages/`）：

1. **CategoriesPage.tsx**：两个 sub-tab（agent 分类 / human 分类），Table 列出分类，Dialog 做新建/改名，Button 删除。表单手写（Input + Label + Button），不引入 react-hook-form。
2. **CreatorsPage.tsx**：Table 列 UP 主，列：name / agent 分类（只读 Badge） / human 分类（行内 Select 编辑） / fans / video_count。顶部筛选：分类下拉（scope=human）+ 搜索框（seqRef 防抖，复刻 [VideoList.tsx:15-25](../../../apps/collector-web/src/pages/VideoList.tsx#L15)）。分页复刻 VideoList。
3. **VideoList.tsx 增强**：顶部加「按 UP 主分类筛选」下拉（scope=human 或 agent，默认 human），传给后端 `?category=&scope=`。

**shadcn 新增组件**（`npx shadcn@latest add` → 自动 pnpm install `@radix-ui/react-*`）：`table`、`dialog`、`select`、`label`、`badge`。

**API client**（[api.ts](../../../apps/collector-web/src/api.ts)）：加 `listCategories`/`createCategory`/`updateCategory`/`deleteCategory`/`listCreators`/`setCreatorCategory`，沿用 `ensureOk`。

**vite dev proxy**（[vite.config.ts](../../../apps/collector-web/vite.config.ts)）：加 `server.proxy`（`/api` + `/ping` → `http://127.0.0.1:21527`），dev 联调用。

**样式合规**：Tailwind 工具类 + 既有 CSS 变量，不写 `.css`、不内联 `style`。

## 5. 错误处理

- `sinceCreated` 为 undefined → 不过滤（向后兼容）。
- `created == null` → 保留入队，日志标「发布时间未知」。
- `collectNosub` 查询失败 → 降级（只采 missing），日志告警，不中断（退出码不变）。
- `--category` 查不到该分类（agent scope）→ 报错退出 2（用法错误），提示先建分类。
- HTTP 分类 CRUD：`UNIQUE(name,scope)` 冲突 → 409；删除被引用的分类 → creators 列置 NULL（`ON DELETE SET NULL` 不依赖，应用层 UPDATE 置 NULL）。
- 打分类 API：creator 不存在 → upsert 最小行（source/source_uid/name 占空/first_seen_at=now），再设分类。
- 不改退出码语义；HTTP 错误沿用 `{ok:false,error}` 协议。

## 6. 测试策略（对齐项目 CLAUDE.md §3）

| 模块 | 方式 | 文件 |
|---|---|---|
| `collectUpperVideosAll(sinceCreated)` 含 null created | `node --test --import tsx` 纯函数单测（mock client） | `apps/collector-server/src/cli/commands/collect.test.ts`（扩） |
| `collectNosub` 识别（有轨/无轨/missing） | 同上，mock better-sqlite3 db | 同上 |
| migrate 幂等（categories 表 + 两列） | 临时库跑 migrate 两次不报错 + 字段存在 | 新 `apps/collector-server/src/db/migrate.test.ts` |
| listCreators / setCreatorCategory | 临时库 + 插入夹具，验证筛选/upsert | 新 `apps/collector-server/src/db/queries.test.ts` |
| collector-web | `vite build` 冒烟 | `pnpm --filter @bilibili-ext/collector-web build` |
| collect-uppers.mts | `--dry-run` 冒烟（验证时间窗 + retry-nosub 队列 + --category 解析） | 手动 / verify 脚本 |
| 全量编排 | `turbo run test`（需补 `test` task） | `turbo.json` + 各 app package.json |

## 7. 验收清单

| ID | 验收项 | 验证 |
|---|---|---|
| AC1 | `collectUpperVideosAll` 带 sinceCreated 时只返回 `created>=since` 或 null | collect.test.ts |
| AC2 | `collectNosub` 正确识别「有 video 无 track」 | collect.test.ts |
| AC3 | `collect-uppers --after-market` 周日跑时 sinceCreated=上周五15:00 | dry-run 输出 |
| AC4 | `collect-uppers --retry-nosub` 把无字幕视频并入采集 | dry-run 输出 |
| AC5 | `collect-uppers --category 股票 <mids>` 采后 creators.category_agent_id 已设 | 查 DB |
| AC6 | `collect-uppers --category 股票`（无显式 mid）从 DB 取该分类 mid | dry-run 输出 |
| AC7 | categories 表 migrate 幂等（跑两次不报错） | migrate.test.ts |
| AC8 | `/api/categories` GET/POST/PATCH/DELETE 可用 | curl |
| AC9 | `/api/creators` 列表带分类筛选可用 | curl |
| AC10 | `/api/creators/by-uid/:uid/category` 打 agent/human 分类可用 | curl |
| AC11 | collector-web 分类管理页 CRUD 可用 | 浏览器手动 |
| AC12 | collector-web UP 主管理页列表/筛选/打 human 分类可用 | 浏览器手动 |
| AC13 | collector-web 视频列表按分类筛选可用 | 浏览器手动 |
| AC14 | `vite build` + `turbo run test` 全绿 | CI 本地 |
| AC15 | 措辞红线：全用「字幕」，无「弹幕」 | grep |

## 8. 测试轮次记录表（对齐全局 8.2）

| 轮次 | 范围 | 结果 | 备注 |
|---|---|---|---|
| R1 | collect.test.ts 扩展（AC1/AC2） | 待跑 | — |
| R2 | migrate.test.ts + queries.test.ts（AC7/AC9/AC10） | 待跑 | — |
| R3 | curl 打 API（AC8/AC9/AC10） | 待跑 | 需 server 在线 |
| R4 | collect-uppers --dry-run（AC3/AC4/AC5/AC6） | 待跑 | 需 server+扩展在线 |
| R5 | 浏览器走管理页（AC11/AC12/AC13） | 待跑 | 需 server 在线 |
| R6 | turbo run test + vite build（AC14） | 待跑 | — |

## 9. agent teams 实现拆分

三组**按 spec 契约并发**（文件不冲突）：

- **Group A — CLI 层**：`collect.ts`（sinceCreated + collectNosub + commander option）+ `collect.test.ts` 扩展 + `collect-uppers.mts`（新 argv + 调 HTTP 打分类）。**依赖**：Group B 的 `POST /api/creators/by-uid/:uid/category` 契约。
- **Group B — server 层**：`schema.sql` + `migrate.ts` + `db/queries.ts`（新查询函数）+ `db/categories` 查询 + `http/categories.ts` + `http/creators.ts` + `main.ts` 注册 + `migrate.test.ts`/`queries.test.ts`。
- **Group C — 前端层**：`npx shadcn add` 组件 + `App.tsx` tab 扩展 + `CategoriesPage`/`CreatorsPage` + `VideoList` 增强 + `api.ts` + `vite.config` proxy。**依赖**：Group B 的 API 契约。

集成顺序：B（schema 先行）→ A 与 C 并发（按契约）→ 全量 test + vite build → commit。
