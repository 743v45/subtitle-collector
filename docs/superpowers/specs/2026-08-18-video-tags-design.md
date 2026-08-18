# 视频标签系统设计（四档来源 / 优先级可配 / 聚合查询）

> 2026-08-18 实现并验收。本文档对齐全局 CLAUDE.md「审查与文档化规则」，含验收标准与测试轮次记录。

## 1. 背景与目标

给已入库视频加标签体系，支持四种来源，服务「按主题组织 + 检索已采字幕」：

| 档位 | 含义 | 写入路径 |
|---|---|---|
| `manual` | server 侧手动（web 详情页/CLI） | POST /api/videos/:s/:v/tags、`tags apply`（默认档） |
| `batch` | 采集批量（搜主题入库时整批打标） | `tags apply --source batch`、collect-batch.mjs `--tag` |
| `bili` | B 站视频自带 tag | **只读**，实时读 `videos.extra` 的 `tags` JSON，不落表 |
| `ai` | AI 按字幕内容二次标记 | `tags apply --source ai`（agent 会话 sub search 读字幕后打标；将来可接 LLM） |

核心行为：
- 同视频同标签名**多档并存**（UNIQUE(video_id, tag_id, source)），展示按优先级取一档（winner）
- 优先级存 server settings（默认 manual > batch > bili > ai），web 可拖动排序
- 标签库可复用（打标即建标，upsert）；按标签聚合查询；按档位分开可查可聚
- 颜色按档位固定：manual=蓝 / batch=琥珀 / bili=粉 / ai=紫（静态 Tailwind 类）

## 2. 关键架构决策

| 决策 | 理由 |
|---|---|
| 三档独立表（tags + video_tags），bili 不落表 | `videos.extra` 是**整体替换**（ingest 重采覆盖），塞 extra 的手工标签会被冲掉；bili 档天然跟随 extra 无需迁移 |
| `tags.name` 全局 UNIQUE（不分档） | 标签是跨档复用实体，档位是关系属性（video_tags.source）；分档建库则改名/删除跨 3 份 |
| `UNIQUE(video_id, tag_id, source)` 含 source | 多档并存是产品决策；不含 source 会互相顶掉 |
| settings 表（DB KV）而非 JSON 文件 | 远端部署（10.0.0.100）重新发布不丢配置 |
| 优先级每请求直读不缓存 | better-sqlite3 同步微秒级；缓存失效复杂度不值 |
| 列表**后端 dedupe**（tag_details 带 winner source） | 前端/CLI 零逻辑；详情返回全档不去重 |
| 不用 usage_count 冗余列 | 3376 视频规模实时 COUNT 毫秒级；冗余必漂移 |
| 不用 FK ON DELETE | 全库先例：应用层事务清理（deleteTag 先删关系再删标签） |
| ingest 零改动 | 对齐 categories 先例；打标是独立写路径，与采集解耦 |

## 3. Schema（[schema.sql](../../../apps/collector-server/src/db/schema.sql) 追加，IF NOT EXISTS 幂等）

```sql
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(name)
);
CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id),
  tag_id INTEGER NOT NULL REFERENCES tags(id),
  source TEXT NOT NULL CHECK(source IN ('manual','batch','ai')),
  created_at INTEGER NOT NULL,
  UNIQUE(video_id, tag_id, source)
);
CREATE INDEX IF NOT EXISTS idx_video_tags_video ON video_tags(video_id);
CREATE INDEX IF NOT EXISTS idx_video_tags_tag ON video_tags(tag_id, source);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL );
```

远端 server 重启自动建表（migrate() 全量 exec schema.sql）。

## 4. API 一览

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/tags?source=&q=&topN=` | 标签库（counts 三档全量；source 过滤该档>0） |
| POST | `/api/tags/apply` | 批量打标（upsert 幂等；全 miss→404 带清单） |
| POST | `/api/tags/remove` | 批量移除（source 省略删全档） |
| PATCH | `/api/tags/:id` | 改名（撞名 409） |
| DELETE | `/api/tags/:id` | 事务删关系+标签 |
| GET/PUT | `/api/settings/tag-priority` | 优先级四档精确排列（非法 400） |
| POST | `/api/videos/:source/:vid/tags` | 单视频打标（web 详情页） |
| DELETE | `/api/videos/:source/:vid/tags?name=&source=` | 单视频移除 |

- `bili` 档 apply/remove → 400（只读）
- 筛选：`GET /api/videos?tags=a,b`（精确 AND）+ `tag_source=manual,bili`（档位过滤）；旧 `?tag=` 模糊保留（扩展为四档并查，超集兼容）
- 聚合：`GET /api/stats?type=aggregate&groupBy=tag`（UNION ALL 关系表+extra json_each，外层 COUNT(DISTINCT video_id)，同名多档按 1 计；支持全部 VideoFilter 透传）
- 富化：列表 item `tag_details:[{name,source}]`（winner 去重）；详情 `tag_details` 全档不去重

实现：[db/tags.ts](../../../apps/collector-server/src/db/tags.ts)、[db/settings.ts](../../../apps/collector-server/src/db/settings.ts)、[http/tags.ts](../../../apps/collector-server/src/http/tags.ts)、[http/settings.ts](../../../apps/collector-server/src/http/settings.ts)、main.ts 前缀分发挂载。

## 5. CLI

| 命令 | 通道 |
|---|---|
| `tags list [--source] [--q]` | 直读只读 SQLite（CLI 只读不变量） |
| `tags apply <bvid...> --names <csv> [--source manual]` | HTTP |
| `tags remove <bvid...> --names <csv> [--source]` | HTTP |

AI 打标工作流：agent `sub search "<kw>"` 读字幕片段 → 判断 → `tags apply BV... --names "..." --source ai`。
采集联动：[collect-batch.mjs](../../../scripts/collect-batch.mjs) `--tag "a,b"` 采完对成功清单一次性 `tags apply --source batch`。

## 6. Web

- [lib/tagSources.ts](../../../apps/collector-web/src/lib/tagSources.ts)：四档颜色/文案静态类表
- **TagsPage**：标签库管理（改名/删除/档位过滤/计数）+ 优先级拖动排序（HTML5 原生，无新依赖）+ 保存 PUT
- **VideoList**：标签 Select（选项 `groupBy=tag` 聚合）+ 档位 Select；VideoRow 四色 Badge（winner）
- **VideoDetail**：全档四色展示 + 手动打标表单 + 非 bili 移除按钮
- StatsPage GROUP_LABEL 加 `tag`

## 7. 明确不做

- change_log 记打标动作（将来审计可加 entity='video_tag'）
- 标签 OR 筛选（YAGNI，将来可加 tag_op）
- usage_count 冗余列
- bili 档迁移入库
- LLM 自动打标（schema 已预留 source='ai'）

## 8. 验收标准与测试轮次

### 8.1 功能验收清单

| # | 验收项 | 状态 |
|---|---|---|
| 1 | 打标即建标（upsert），重复 apply 幂等（计数不变） | ✅ db/tags.test.ts |
| 2 | 同视频同标签多档并存（manual+ai 两条关系都在） | ✅ db/tags.test.ts |
| 3 | 列表 tag_details 按优先级 winner 去重（默认 manual 赢） | ✅ http/tags.test.ts |
| 4 | 优先级 PUT 翻转后 winner 跟随翻转（后端 dedupe） | ✅ http/tags.test.ts |
| 5 | 详情返回全档 tag_details 不去重（含 bili 从 extra 解析） | ✅ http/tags.test.ts（回归 extra 是 JSON 字符串须 parse） |
| 6 | 优先级 PUT 非四档精确排列 → 400；DB 值损坏 → 回落默认不炸 | ✅ db/settings.test.ts |
| 7 | bili 档 apply/remove → 400 | ✅ http/tags.test.ts |
| 8 | rename 撞名 → 409；delete 事务清关系无孤儿 | ✅ db/tags.test.ts |
| 9 | tags=a,b 精确 AND + tag_source 分支（bili 只查 extra / 关系档只查表） | ✅ db/advanced.test.ts |
| 10 | groupBy=tag 同名多档 DISTINCT 计 1；其他 filter（q）两分支同受约束 | ✅ db/advanced.test.ts |
| 11 | 旧 ?tag= 模糊保留（四档并查超集兼容） | ✅ db/advanced.test.ts |
| 12 | CLI tags apply 打真库端到端（本地 server 实测 inserted=2，详情 tag_details batch+bili 并存） | ✅ 手动 R1 |
| 13 | collect-batch --tag 采后打 batch 标 | ✅ 代码实现（复用 tags apply HTTP） |
| 14 | Web TagsPage/四色展示/筛选/拖动排序 | ✅ vite build 冒烟 + 手测清单 |
| 15 | collector-server 全量测试回归 | ✅ 244/244 |

### 8.2 测试轮次记录表

| 轮次 | 日期 | 改动 | 自动化 | 手动 | 结果 |
|---|---|---|---|---|---|
| R1 | 2026-08-18 | DB 层（tags/settings + 测试） | 10/10 | — | ✅ 修 listTags 档位过滤语义（默认含 0 使用标签） |
| R2 | 2026-08-18 | HTTP 层（tags/settings/单视频 tags + 测试） | 1/1 | — | ✅ 一次过 |
| R3 | 2026-08-18 | 筛选聚合（tags=/tag_source=/groupBy=tag + 测试） | 19/19（advanced） | — | ✅ 修 UNION 分支 where 空串拼接 bug |
| R4 | 2026-08-18 | 富化（enrichItems winner + 详情全档 + 测试） | 2/2 | 本地真库 | ✅ 发现并修 detail bili 解析 bug（extra 是 TEXT 须 parse） |
| R5 | 2026-08-18 | CLI（tags 命令组 + collect-batch --tag） | TS 全过 | CLI apply 真库 ✅ | ✅ 旧测试 2 处断言随行为更新（tags 顺序/groupBy 文案） |
| R6 | 2026-08-18 | Web 全量 | vite build | 手测清单（见 agent 报告） | ✅ |
| R7 | 2026-08-18 | 全量回归 | 244/244 | — | ✅ |

### 8.3 部署注意（远端 10.0.0.100）

1. 拉代码后重启远端 server → migrate 自动建 tags/video_tags/settings 表
2. 旧库无影响（CREATE IF NOT EXISTS 幂等；无破坏性变更）
3. 远端 CLI 打标走代理（COLLECTOR_SERVER=http://127.0.0.1:21528）或 web 直接操作
