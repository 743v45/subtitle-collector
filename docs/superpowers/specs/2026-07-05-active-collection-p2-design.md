# 主动采集 P2（UP 主维度）—— 设计文档

> 日期：2026-07-05
> 状态：**正式 spec**（P1 spec 的 P2 章节详细化）。关键决策「upper-videos 不入库」**待用户最终确认**（暂按推荐方案 A）。
> 关联：
> - [P1 spec](./2026-07-05-active-collection-design.md) §5.1（creators 加字段）、§6.2c-d（get-upper-info / list-upper-videos）、§12 B1–B4（P2 验收）
> - [P1 plan](../plans/2026-07-05-active-collection.md)（实现模式：扩展 action / CLI collect / server ingest）

---

## §1 概述

P2 给 P1 主动采集加 **UP 主维度**：UP 主完整资料采集 + UP 主视频列表拉取 + 发现新视频。全扩展通信（复用 P1 的扩展内 fetch + Wbi 签名），不服务端出站。

三个能力：
- `collect upper-info <mid>`：UP 主资料入库（creators 表扩字段）
- `collect upper-videos <mid>`：拉 UP 主视频列表（**不入库**，返列表）
- `collect new-videos <mid>`：列表对比库，返回新增 BV

## §2 关键设计决策（待确认）

**upper-videos 不入库 video 摘要**（推荐 A，暂按此设计）。

| 选项 | 说明 | 代价 |
|---|---|---|
| **A 不入库，只返列表（推荐）** | upper-videos 返视频列表，不入库。new-videos 用列表对比库找新增 | 库里仍只存 fetch-subtitle 采过的；dedupe 不受影响 |
| B 入库摘要 + 改 dedupe | upper-videos 入库 video 摘要；dedupe 改"有字幕轨才算采过" | 改动 P1 dedupe 判据，影响 P1 行为 |
| C 入库 + status 字段 | upper-videos 入库 + status 区分"采过字幕/仅列表" | 加迁移 + 改 dedupe/ingest 逻辑 |

**选 A 的理由**：不污染 P1 的 dedupe（"video 存在"判据保持不变）；对齐用户场景「new-videos 发现没采过的视频」——new-videos 返回的就是"库里没有、值得采的"。若用户选 B/C，本 spec §6/§9 调整。

## §3 需求

| # | 需求 | 验证 |
|---|---|---|
| R1 | 给 mid，采 UP 主完整资料入库 | `collect upper-info` 后 creators 表有 sign/level/fans/... |
| R2 | 给 mid，拉 UP 主视频列表 | `collect upper-videos` 返回 {total, items:[{bvid,title,created,...}]} |
| R3 | 给 mid，发现库里没有的新视频 | `collect new-videos` 返回 missing BV |
| R4 | 全扩展通信（复用 P1） | server/CLI 无 `api.bilibili.com` 出站 |

## §4 架构（复用 P1 链路）

```
skill / CLI collect upper-* ── 已有：HTTP
  ▼
collector-server ── WS Command（新增 get-upper-info / list-upper-videos）
  ▼
subtitle-collector 扩展 ── 复用 P1：wbi.js（encWbi）+ bili-fetch.js（biliFetch）
  │   get-upper-info    → fetch acc/info（Wbi）+ relation/stat（cookie）→ ws.send ingest-upper
  │   list-upper-videos → fetch arc/search（Wbi）→ 回执列表（不上报）
  ▼
B 站
```

`collect new-videos` 不经扩展额外 action：CLI 层调 `upper-videos` 拉列表 + 直读 SQLite 对比库 → 返回 missing。

## §5 数据模型变更（creators 表加字段）

[现 creators 表](../../apps/collector-server/src/db/schema.sql#L2) 只有 name + avatar（P1 已加 sign/level/... 在 spec，但**P1 未实现**——P1 只做了主动采集搜索/字幕，creators 表未扩）。P2 落地这些字段：

| 字段 | 类型 | 来源 |
|---|---|---|
| `sign` | TEXT | acc/info `data.sign` |
| `level` | INTEGER | acc/info `data.level` |
| `sex` | TEXT | acc/info `data.sex` |
| `official_type` | INTEGER | acc/info `data.official.type` |
| `official_title` | TEXT | acc/info `data.official.title` |
| `fans` | INTEGER | relation/stat `data.follower` |
| `following` | INTEGER | relation/stat `data.following` |

迁移：`ALTER TABLE creators ADD COLUMN ...`（SQLite 幂等加列，启动时迁移函数 + try/catch 忽略 "duplicate column"）。

`change_log` 策略对齐 videos：**fans/following 波动不记**（stat 类，同 videos.stat 哲学）；其余字段（sign/level/official_*)变化照常记。

`videos` 表不变。**upper-videos 不入库**（选 A），故 videos 表只增 fetch-subtitle 采过的。

## §6 接口契约

### §6.1 复用 P1 WS Command 通道（不改协议）

server→扩展 `{id, action, ...params}`；扩展→server result `{type:"result", id, ok, data|error}`（[P1 spec §6.1](./2026-07-05-active-collection-design.md)）。本 spec 只新增 action 取值 + 一条上行消息。

### §6.2 新增 action

#### (a) `get-upper-info` —— UP 主资料入库

server→扩展：
```json
{ "id": "<uuid>", "action": "get-upper-info", "mid": "12345" }
```
扩展端：
1. `biliFetch('/x/space/wbi/acc/info', { wbi:true, params:{ mid }, wbiKeys })` → data（name/sign/level/sex/official/face）
2. `biliFetch('/x/relation/stat', { params:{ vmid: mid } })` → data（follower/following）
3. `ws.send({ type:'ingest-upper', payload: { source:'bilibili', creator:{...} } })`
4. 回执 `{type:"result", id, ok:true, data:{ mid, name, fans, ... }}`

失败：任一 fetch `parsed.ok=false` → result `{ok:false, error:parsed.code}`。

#### (b) `list-upper-videos` —— 拉视频列表（不入库）

server→扩展：
```json
{ "id": "<uuid>", "action": "list-upper-videos", "mid": "12345", "page": 1, "page_size": 30 }
```
扩展端：
1. `biliFetch('/x/space/wbi/arc/search', { wbi:true, params:{ mid, pn:page, ps:page_size, order:'pubdate' }, wbiKeys })`
2. 解析 `data.list.vlist[]` → `{bvid, title, created, play, length, ...}`
3. 回执 `{type:"result", id, ok:true, data:{ total: data.page.count, items:[...] }}`

**不上报 ingest**（不入库）。

### §6.3 新增上行消息 `ingest-upper`

扩展→server：
```json
{ "type": "ingest-upper", "payload": {
  "source": "bilibili",
  "creator": {
    "source_uid": "12345", "name": "up名", "avatar": "https://face",
    "sign": "签名", "level": 6, "sex": "男",
    "official_type": 0, "official_title": "",
    "fans": 100000, "following": 50
  }
} }
```
server `ingestUpper(db, payload)`：upsert creators（按 source+source_uid）+ 字段级 change_log（stat 类 fans/following 不记）。回 `ingest-upper-ack {ok, ...}`。

### §6.4 B 站接口（扩展内 fetch，复用 P1 biliFetch + wbiKeys）

| 接口 | 签名 | 返回 |
|---|---|---|
| `/x/space/wbi/acc/info` | Wbi | name/sign/level/sex/official/face |
| `/x/relation/stat` | cookie | follower/following |
| `/x/space/wbi/arc/search` | Wbi | list.vlist[]（bvid/title/created/play/length） |

### §6.5 CLI 新增命令（`collect` 命令组）

```
cli collect upper-info <mid>           # → get-upper-info（经扩展）→ 入库 creators
cli collect upper-videos <mid> [--page N] [--size N]  # → list-upper-videos，返回列表（不入库）
cli collect new-videos <mid> [--page N] [--size N]    # CLI 层：upper-videos 拉列表 + 直读 SQLite 对比 → 返回 missing（新增）
```

`new-videos` 复用 `collectDedupe` 的对比逻辑（P1 已实现）：拉到列表 BV 后，`SELECT source_vid FROM videos WHERE source='bilibili' AND source_vid IN (...)`，返回 missing。

底层 `collect upper-info` / `upper-videos` 复用 `ServerClient.sendCommand`（P1 模式）；`new-videos` 组合 sendCommand（拉列表）+ openReadonlyDb（对比）。

## §7 扩展改动（subtitle-collector）

| 文件 | 改动 |
|---|---|
| [background.js](../../apps/subtitle-collector/background.js) action 分发 | 新增 `get-upper-info` / `list-upper-videos` 分支（复用 wbiKeys / biliFetch） |
| background.js 上行 | 新增 `ingest-upper` 消息发送（get-upper-info 入库用） |

不动 wbi.js / bili-fetch.js / ingest-payload.js（P1 已就绪，复用）。

## §8 collector-server 改动

| 文件 | 改动 |
|---|---|
| [ws/server.ts](../../apps/collector-server/src/ws/server.ts) | 新增 `ingest-upper` 消息分支 → `ingestUpper()` + 回 `ingest-upper-ack` |
| `db/ingest.ts` | 新增 `ingestUpper(db, payload)`：upsert creators（新字段 + 字段级 change_log，stat 类不记） |
| [db/schema.sql](../../apps/collector-server/src/db/schema.sql) + 迁移 | creators 加 7 字段 + 启动迁移函数（ALTER ADD COLUMN，幂等） |
| [cli/commands/collect.ts](../../apps/collector-server/src/cli/commands/collect.ts) | 新增 `upper-info` / `upper-videos` / `new-videos` 子命令 + 纯处理 |

## §9 new-videos 语义

`collect new-videos <mid>`：
1. CLI 调 `list-upper-videos`（经扩展）拉 UP 主视频列表 → BV 列表
2. CLI 直读 SQLite：`videos WHERE source='bilibili' AND source_vid IN (列表 BV)`
3. 返回 `{total, new:[...], collected:[...]}`（new = 列表 - 库）

**不入库**（只对比）。用户据此决定对哪些 new BV 跑 `collect subtitle`。

## §10 不做（YAGNI）

- 后台订阅（同 P1，按需触发）
- UP 主的合集/列表/动态/专栏
- upper-videos 入库（选 A，避免 dedupe 污染；若选 B/C 再议）
- list-upper-videos 自动翻页（提供 --page，手动翻；自动翻全部 = YAGNI）

## §11 验收标准

| # | 验收项 |
|---|---|
| B1 | `cli collect upper-info <mid>` 入库 creators 新字段（sign/level/sex/official_type/official_title/fans/following） |
| B2 | `cli collect upper-videos <mid>` 返回视频列表（bvid/title/created），**不入库**（videos 表无新增） |
| B3 | `cli collect new-videos <mid>` 对比库，正确返回 new（手造数据验证差集） |
| B4 | creators 加列迁移幂等（重复启动不报错）；fans/following 波动不记 change_log |

## §12 测试方式（对齐 [CLAUDE.md §3](../../CLAUDE.md)）

| 对象 | 方式 |
|---|---|
| server `ingestUpper` | `node --test --import tsx`（事务 upsert + change_log，stat 不记，纯函数测） |
| CLI `collect upper-*` 纯处理 | `node --test --import tsx`（注入 mock ServerClient） |
| CLI `new-videos` 对比 | `node --test --import tsx`（临时 SQLite 造数据） |
| 扩展 action | `verify-active-collect.mjs` 扩展（mock acc/info / arc/search，断言 ingest-upper + 回执） |

### §12.1 测试轮次记录表

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |

## §13 风险

| 风险 | 缓解 |
|---|---|
| acc/info / arc/search 的 Wbi 签名要求变更 | 复用 P1 wbi.js（已验证 search/player 签名）；接口集中在 bili-fetch.js |
| upper-videos 分页（arc/search pn/ps） | 提供 --page/--size，手动翻；默认 ps=30 |
| UP 主资料接口字段变化（official 结构等） | ingestUpper 对缺失字段 null 兜底（不抛） |
| new-videos 对比依赖库准确（fetch-subtitle 入库的） | 库数据来自 P1 主动采集 + 被动采集，已验证 |

## §14 本地映射参考

- P1 WS Command 通道（复用）：[background.js:78-117](../../apps/subtitle-collector/background.js#L78) action 分发
- P1 扩展内 fetch 模式：[bili-fetch.js](../../apps/subtitle-collector/bili-fetch.js) `biliFetch({wbi})`
- P1 Wbi 签名：[wbi.js](../../apps/subtitle-collector/wbi.js) `encWbi` / `extractKeysFromNav`
- P1 CLI collect 模式：[collect.ts](../../apps/collector-server/src/cli/commands/collect.ts)
- P1 ingest 事务（upsert + change_log）：[ingest.ts](../../apps/collector-server/src/db/ingest.ts) `ingestVideo`
- creators 现状：[schema.sql:2-11](../../apps/collector-server/src/db/schema.sql#L2)
