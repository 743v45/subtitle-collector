# 主动采集（AI 驱动 / 全扩展通信）—— 设计文档

> 日期：2026-07-05
> 状态：**正式 spec**（取代 [2026-06-23-active-collection-exploration.md](./2026-06-23-active-collection-exploration.md) 的探索笔记，把"方案 D"升级为可执行设计）
> 关联：
> - [2026-06-20-media-subtitle-collector-design.md](./2026-06-20-media-subtitle-collector-design.md) §6.2（WS Command 协议）、§9（批量采集推迟 → 本 spec 接续）
> - [2026-07-05-collector-cli-design.md](./2026-07-05-collector-cli-design.md)（CLI 命令风格 / 退出码 / `--format` 规范）

---

## §1 概述

把现有"被动采集器"（进视频页自动入库）升级为**AI 驱动的主动采集**：

- **主场景（P1）**：用户给一个主题 → Claude 经 skill + `collector-cli` 驱动**同一个 `subtitle-collector` 扩展**，全自动搜 B 站 → 对未采的视频逐个捞字幕 → 聚合产物。
- **UP 主维度（P2）**：获取 UP 主完整资料 + UP 主视频列表 + 发现新视频（按需触发）。

核心约束（用户拍板）：
1. **不做 MCP**，写一个 Claude **skill** 调 `collector-cli`。
2. **全部扩展通信**：B 站数据获取只由扩展发起（扩展在浏览器内 `fetch`，自动带登录 cookie），服务端/CLI 不直接出站调 B 站。
3. **扩展内 fetch** 保证确定性（不靠"打开页面等 hook"）。
4. **已采字幕的视频不重采**（决策前先查库去重）。

---

## §2 背景

被动采集 MVP 已跑通（[2026-06-20 主设计](./2026-06-20-media-subtitle-collector-design.md)）：进视频页 → `inject.js` 拦 player API + 字幕体 → `content.js` 聚合 → `background.js` 经 WS `ingest` 入库。

缺口（探索笔记 + 本次澄清确认）：
- 没有搜索 / UP 主资料 / UP 主视频列表能力（[inject.js](../../apps/subtitle-collector/inject.js) 只识别 player API + 字幕 URL）。
- `fetch-subtitle` WS Command 是占位 `not implemented`（[background.js:81-83](../../apps/subtitle-collector/background.js#L81)）。
- [creators 表](../../apps/collector-server/src/db/schema.sql#L2) 只有 `name + avatar`，UP 主资料极薄。

**探索笔记已过时的两点（本次确认已实现）**：
- 笔记说"`result` pending Map 待补"——实际 [ws/server.ts:17](../../apps/collector-server/src/ws/server.ts#L17) + [:88-98](../../apps/collector-server/src/ws/server.ts#L88) + `requestCommand` [:150-168](../../apps/collector-server/src/ws/server.ts#L150) **已实现**，同步等回执可用。
- 扩展已具备 background 代理 fetch B 站 URL 的机制（[background.js:118-128](../../apps/subtitle-collector/background.js#L118) 的 `FETCH_SUBTITLE`），带 `Referer`、免 CORS、cookie 自动带——这正是"扩展内 fetch"的现成载体。

---

## §3 需求

用户原话（2026-07-05）：
> "我想让 ai 搜寻 b 站某些信息，然后点开视频就能捞到字幕。能聚合数据，缩小确定性的链路。而不是每次分析一大堆。"
> "up 主页面数据也得整一个。我可以根据人的视频页分析出有没有新视频。"
> "应该不需要 api。全部扩展通信。（实现不了我们再讨论）"

拆解为可验证需求：

| # | 需求 | 验证 |
|---|---|---|
| R1 | AI 给主题，能搜 B 站拿候选视频列表 | `collect search` 返回候选 |
| R2 | 给 BV 号，确定性地捞到字幕并入库（不靠打开页面） | `collect subtitle <bvid>` 回执含采到的轨数，库里有 |
| R3 | 已采字幕的视频不重采 | 决策前 `collect dedupe` 能批量判重 |
| R4 | 聚合产物可取 | 复用现有 `export`/`stats` CLI（已实现） |
| R5 | UP 主完整资料入库 | `creators` 表有 fans/sign/level/official… |
| R6 | 拉取 UP 主视频列表 | `collect upper-videos` 入库一批 videos |
| R7 | 发现 UP 主新视频（按需） | `collect new-videos` 对比库返回新增 BV |
| R8 | 全程扩展通信，服务端不出站 | server/CLI 代码无 `api.bilibili.com` 出站 fetch |
| R9 | AI 只调工具、不碰 B 站细节 | skill 文档化命令序列，AI 无需感知 Wbi/hook |

---

## §4 架构

### §4.1 拓扑

```
Claude（用户使用的 AI）
  │  调 skill：一段文档化的 bash 流程（调 collector-cli）
  ▼
collector-cli ───── 已有：HTTP，agent 友好（--format/退出码）
  │  POST /api/clients/:id/command {action, ...params}
  ▼
collector-server ── 已有：存储 + WS 中转
  │  requestCommand(clientId, action, params) 同步等回执（pending Map 已实现）
  │  WS 下发 {id, action, ...params}
  ▼
subtitle-collector 扩展 ── 唯一 B 站入口（带登录 cookie）
  │  background action 处理器：
  │   · search         → fetch 搜索接口（Wbi 签名）
  │   · fetch-subtitle → fetch view+player+字幕体 → ws.send(ingest) → 回执
  │   · get-upper-info → fetch acc/info + relation/stat
  │   · list-upper-videos → fetch space arc/search
  │  （全部扩展内 fetch，host_permissions 已覆盖 *.bilibili.com，cookie 自动带）
  ▼
B 站
```

### §4.2 数据流（以"给主题捞字幕"为例）

```
1. Claude skill: cli collect search "RAG 实践"          → 候选 BV 列表
2. Claude skill: cli collect dedupe <BV...>             → {missing:[...], collected:[...]}
3. 对每个 missing BV（skill 循环，串行/低并发 + 间隔）：
   cli collect subtitle <BV>
     → server requestCommand(fetch-subtitle)
     → 扩展 fetch view + player/wbi/v2 + 字幕体
     → 扩展 ws.send(ingest) → server ingestVideo 入库
     → 扩展回 result{ok, tracks:N} → CLI 打印
4. Claude skill: cli export subtitle / cli stats overview → 聚合产物
```

---

## §5 数据模型变更

### §5.1 `creators` 表加字段（P2）

[现 schema](../../apps/collector-server/src/db/schema.sql#L2) 只有 `name/avatar`。新增列：

| 字段 | 类型 | 来源 |
|---|---|---|
| `sign` | TEXT | acc/info `data.sign` |
| `level` | INTEGER | acc/info `data.level` |
| `sex` | TEXT | acc/info `data.sex` |
| `official_type` | INTEGER | acc/info `data.official.type` |
| `official_title` | TEXT | acc/info `data.official.title` |
| `fans` | INTEGER | relation/stat `data.follower` |
| `following` | INTEGER | relation/stat `data.following` |

迁移：`ALTER TABLE creators ADD COLUMN ...`（SQLite 支持幂等加列，schema.sql 加 `IF NOT EXISTS` 不适用 ALTER，由 ingest 侧保证 + 启动时迁移函数）。`change_log` 策略对齐 videos：粉丝数波动**不记** change_log（同 stat 哲学），其余字段变化照常记。

### §5.2 `videos` 表

不变。[extra](../../apps/collector-server/src/db/schema.sql#L13) 已含 stat/tags/pages/desc 等。`fetch-subtitle` 路径下用 `/x/web-interface/view` 拿到的 `view` 数据结构与 `__INITIAL_STATE__.videoData` 同源，extra 可完整填充。

### §5.3 "新视频发现"不新增表

UP 主视频列表 = 一批 videos，直接 upsert 入库。"新视频"= 本次 `list-upper-videos` 拉到的 BV 集合 ∖ 库中该 UP 已有的 BV。纯查询时计算，落表无意义（YAGNI）。

---

## §6 接口契约

### §6.1 现有 WS Command 通道（复用，不改协议）

- **server→扩展**：`{id, action, ...params}`（[ws/server.ts:157](../../apps/collector-server/src/ws/server.ts#L157)）
- **扩展→server 回执**：`{type:"result", id, ok:true, data:{...}}` 或 `{type:"result", id, ok:false, error:"..."}`（[background.js:67](../../apps/subtitle-collector/background.js#L67)）
- server 侧 `requestCommand` 已实现 offline/timeout/ok 三态（[ws/server.ts:150-168](../../apps/collector-server/src/ws/server.ts#L150)）。
- HTTP 入口：`POST /api/clients/:id/command`（[http/clients.ts:38-54](../../apps/collector-server/src/http/clients.ts#L38)），body 接收任意 `action + params`，转 `requestCommand`。

**本 spec 不新增协议**，只新增 `action` 取值和扩展端处理器。

### §6.2 新增 action 信封样例

#### (a) `search` —— 关键词搜视频，返回候选（不入库）

server→扩展：
```json
{ "id": "<uuid>", "action": "search", "keyword": "RAG 实践", "page": 1, "order": "pubdate", "tid": 0 }
```
扩展→server result：
```json
{ "type": "result", "id": "<uuid>", "ok": true,
  "data": { "total": 137, "items": [
    { "bvid": "BV...", "title": "...", "mid": 12345, "up": "...", "play": 0, "duration": 0, "pubdate": 1700000000 }
  ] } }
```
扩展端：fetch `/x/web-interface/wbi/search/type`（`search_type=video`，Wbi 签名），解析 `data.result[]`。**不入库**（只给 AI 决策用；确定要采的才走 fetch-subtitle）。

#### (b) `fetch-subtitle` —— 给 BV 号确定性地捞字幕入库（P1 核心，占位的真正实现）

server→扩展：
```json
{ "id": "<uuid>", "action": "fetch-subtitle", "bvid": "BV1xxxxxxxx" }
```
扩展端处理（三步 fetch）：
1. `GET /x/web-interface/view?bvid=<bvid>`（cookie）→ 完整 videoData（标题/UP/stat/tags/pages/desc，组装 `extra`）
2. `GET /x/player/wbi/v2?bvid=<bvid>&aid=<aid>`（Wbi 签名 + cookie）→ `data.subtitle.subtitles[]` 字幕轨
3. 对每轨 `GET <subtitle_url>`（带 `Referer: https://www.bilibili.com/`）→ 字幕体 JSON
4. 组装与现有 ingest 一致的 payload（结构见 [content.js:61-85](../../apps/subtitle-collector/content.js#L61)），`ws.send({type:"ingest", payload})`，等 `ingest-ack`
5. 回执：

```json
{ "type": "result", "id": "<uuid>", "ok": true,
  "data": { "bvid": "BV...", "tracks": 2, "ingested": true } }
```
无字幕轨时：仍 ingest（`payload.tracks=[]`，video 元信息照常入库，避免下次重采），回执 `ok:true, data:{tracks:0, ingested:true, reason:"no_subtitle"}`（不是错误，让 AI 知道这视频没字幕可跳过）。
风控/未登录：`ok:false, error:"risk_control"` 或 `"need_login"`（见 §10）。

#### (c) `get-upper-info`（P2）

```json
{ "id": "<uuid>", "action": "get-upper-info", "mid": 12345 }
```
扩展端：fetch `/x/space/wbi/acc/info?mid=<mid>`（Wbi）+ `/x/relation/stat?vmid=<mid>`（cookie），组装 creators 字段，`ws.send({type:"ingest-upper", payload})`（新消息类型，server 侧新增 `ingestUpper()` upsert creators）。回执含入库字段。

#### (d) `list-upper-videos`（P2）

```json
{ "id": "<uuid>", "action": "list-upper-videos", "mid": 12345, "page": 1, "page_size": 30 }
```
扩展端：fetch `/x/space/wbi/arc/search?mid=<mid>&pn=<page>&ps=<page_size>&order=pubdate`（Wbi），把 `data.list.vlist[]` 组装成一批 video 元信息批量 upsert。回执 `{count, bvids:[...]}`。

### §6.3 扩展内 fetch + Wbi 签名模块

**fetch 封装**（扩展 background，复用 [background.js:121](../../apps/subtitle-collector/background.js#L121) 模式）：
```js
async function biliFetch(url, { wbi = false, params = {} } = {}) {
  const finalUrl = wbi ? signWbi(url, params) : withQuery(url, params);
  const res = await fetch(finalUrl, { headers: { Referer: "https://www.bilibili.com/" } });
  const body = await res.json();
  if (body.code === -101) throw new Error("need_login");
  if (body.code === -412) throw new Error("risk_control");
  if (body.code !== 0) throw new Error(`bili code ${body.code}: ${body.message}`);
  return body.data;
}
```
浏览器环境自动带 cookie（host_permissions `*://*.bilibili.com/*` 已覆盖，[manifest.json:7-11](../../apps/subtitle-collector/manifest.json#L7)）。

**Wbi 签名**（公开算法，扩展内实现一次，模块 `wbi.js`）：
1. 启动时（或首次需要时）`GET /x/web-interface/nav`（cookie）→ `data.wbi_img.{img_url, sub_url}`
2. 各取 URL pathname 最后一段、去扩展名 → `img_key + sub_key`（64 字符）
3. 按 **`mixinKeyEncTab`**（社区公开的 64 项固定重排表）重排，取前 32 字符 → `mixin_key`
4. 参数加 `wts = <秒级时间戳>`；过滤键值中的 `!'()*` 字符
5. 所有参数按 key 字典序 urlencode 拼接 → `query`
6. `w_rid = md5(query + mixin_key)`
7. 最终 URL = `api + query + "&w_rid=" + w_rid + "&wts=" + wts`

`mixin_key` 缓存（约 1 小时刷新），避免每次签名都打 nav。

> 接口签名要求以实现时 `scripts/verify-bili-endpoints.mjs`（§14）逐个验证为准；社区共识：`search/type`、`space/wbi/acc/info`、`space/wbi/arc/search`、`player/wbi/v2` 需 Wbi；`view`、`relation/stat`、`nav`、字幕体 GET 仅需 cookie。

### §6.4 CLI 新增命令（`collect` 命令组）

底层全部复用 `ServerClient.sendCommand`（已支持任意 params，[clients.ts:77](../../apps/collector-server/src/cli/commands/clients.ts#L77)）+ `POST /api/clients/:id/command`。`--client <id>` 缺省取第一个在线 client（先 `GET /api/clients`）。采集类命令默认 `--timeout 15000`（高于管控类的 5000，给 fetch+入库留时间）。

```
# P1
cli collect search <keyword> [--page N] [--order pubdate|click|stow...] [--tid N]
                             [--client ID] [--timeout MS] [--format json]
cli collect subtitle <bvid>  [--client ID] [--timeout MS]
cli collect dedupe <bvid...>            # 直读 SQLite，返回 {collected:[...], missing:[...]}
                                         #   判据：该 bvid 是否已有 subtitle_tracks 记录

# P2
cli collect upper-info <mid>            # → get-upper-info
cli collect upper-videos <mid> [--page N]
cli collect new-videos <mid>            # list-upper-videos + 对比库，返回新增 BV
```

退出码 / `--format` / stderr-stdout 分离全部对齐 [collector-cli 设计](./2026-07-05-collector-cli-design.md) 与 [output.ts](../../apps/collector-server/src/cli/output.ts)。纯处理函数（可测，注入 `ServerClient`）与 commander 装配分离，沿用 [clients.ts](../../apps/collector-server/src/cli/commands/clients.ts) 模式。

`collect dedupe` 走直读 SQLite（与 `videos list` 同通道，不经扩展），判据 = **该 bvid 是否已在 videos 表存在**（无字幕视频经 fetch-subtitle 后也入 videos，故不重采），批量 `SELECT source_vid FROM videos WHERE source_vid IN (...)`。

---

## §7 扩展改动（subtitle-collector）

| 文件 | 改动 |
|---|---|
| `wbi.js`（新） | Wbi 签名模块（§6.3） |
| `bili-fetch.js`（新） | `biliFetch` 封装 + 风控/登录错误归一化 |
| [background.js:81-83](../../apps/subtitle-collector/background.js#L81) | `fetch-subtitle` 占位 → 真实实现（§6.2b） |
| [background.js:64-90](../../apps/subtitle-collector/background.js#L64) action 分发 | 新增 `search` / `get-upper-info` / `list-upper-videos` 分支 |
| background.js | 新增 `ingest-upper` 上行消息（upsert creators） |
| `manifest.json` | 无需改权限（`*.bilibili.com` 已覆盖）；`wbi.js`/`bili-fetch.js` 加入打包 |

**content script / inject.js 不动**（被动采集链路保持原样，主动采集全在 background）。

---

## §8 collector-server 改动

| 文件 | 改动 |
|---|---|
| [ws/server.ts:78-86](../../apps/collector-server/src/ws/server.ts#L78) | 新增 `ingest-upper` 消息分支 → `ingestUpper(db, payload)` |
| `db/ingest.ts` | 新增 `ingestUpper()`：upsert creators（含新字段 + 字段级 change_log，stat 类不记） |
| `db/schema.sql` + 迁移 | creators 加列（§5.1） |
| `http/clients.ts` | **不动**（`/api/clients/:id/command` 已支持任意 action+params） |
| `cli/commands/collect.ts`（新） | `collect` 命令组（§6.4） |
| `cli/main.ts` | 注册 `collect` 命令组 |

---

## §9 Claude skill

位置：`.claude/skills/bili-collect/SKILL.md`（项目级，随仓库走；按团队 Claude Code 部署可调）。

skill 是**文档化的命令序列**（不是 `.sh` 脚本文件），让 Claude 知道何时触发、调哪些 CLI 命令、按什么顺序。骨架：

```markdown
---
name: bili-collect
description: 给主题批量采集 B 站字幕并聚合。当用户说"采集/搜集 X 的字幕""帮我整理 Y 的资料"时触发。
---

## 流程
1. 搜候选：`cli collect search "<主题>" --format json`
2. 判重：`cli collect dedupe <step1 的 BV 列表> --format json` → 取 missing
3. 逐个采集（串行，每个之间 sleep ~1s 防风控）：
   `cli collect subtitle <BV>`
   - 收到 reason:"no_subtitle" → 跳过
   - 收到 error:"need_login"/"risk_control" → 停下通知用户
4. 聚合：`cli export subtitle --format srt` 或 `cli stats overview`

## 前置
- `cli server ping` 不通 → 提示用户 `cli server start`
- `cli clients list` 无在线 client → 提示用户打开装了扩展的浏览器、确认已登录 B 站
```

具体命令名/参数以 §6.4 为准；skill 文案在实现阶段定稿。skill 不引入新依赖，只调 CLI。

---

## §10 错误处理 / 风控 / 限速

| 场景 | 处理 |
|---|---|
| 扩展离线 | `requestCommand` → `offline`；CLI 退 `RUNTIME`，提示"扩展未连接" |
| 超时（默认 15s） | `timeout`；CLI 提示，skill 可重试一次 |
| B 站返回 `-101` need_login | 扩展回执 `error:"need_login"`；skill 停下，通知用户登录 |
| B 站返回 `-412` risk_control | 扩展回执 `error:"risk_control"`；skill 停下冷却，通知用户 |
| 视频无字幕 | `ok:true, reason:"no_subtitle"`；正常跳过，不算错误 |
| 字幕轨 url 缺失 | 沿用 [inject.js:64](../../apps/subtitle-collector/inject.js#L64) `url_missing` 标记，该轨跳过 |
| 限速 | **skill 循环串行 + 每次间隔 ~1s**；不引入服务端调度器（YAGNI）。后续若风控频繁，再加扩展端 `biliFetch` 最小间隔 |

---

## §11 不做（YAGNI）

- ❌ MCP server（用 skill + CLI 替代）
- ❌ 后台订阅 / 定期调度（新视频发现 = 按需触发）
- ❌ 服务端/CLI 直接出站调 B 站（全扩展通信）
- ❌ "打开页面 hook"路径（用扩展内 fetch，确定）
- ❌ comments / dynamics / 弹幕（本项目是**字幕**系统，见 [CLAUDE.md §4](../../CLAUDE.md) 措辞红线）
- ❌ 弹幕采集、整栏批量合集采集（超出当前需求）

---

## §12 验收标准

### P1（主线：给主题 → 字幕 → 聚合）

| # | 验收项 |
|---|---|
| A1 | 扩展 `wbi.js` 能对 4 个 wbi 接口正确签名（`verify-bili-endpoints.mjs` 验证返回 `code:0`） |
| A2 | `cli collect search "测试词"` 经扩展返回候选视频列表（含 bvid/title/up） |
| A3 | `cli collect subtitle <bvid>` 经扩展 fetch view+player+字幕体，入库后回执 `{tracks:N, ingested:true}` |
| A4 | 对无字幕视频，`subtitle` 回执 `{tracks:0, reason:"no_subtitle"}`，不报错 |
| A5 | `cli collect dedupe <BV...>` 直读库，正确返回 collected/missing（按 video 是否存在） |
| A6 | 全程服务端/CLI 无 `api.bilibili.com` 出站（`grep` 验证，仅扩展内 fetch） |
| A7 | CLI 退出码 / `--format` 对齐全局规范 |
| A8 | skill 文档完整，Claude Code 能依此跑通一个真实主题示例 |

### P2（UP 主维度）

| # | 验收项 |
|---|---|
| B1 | `cli collect upper-info <mid>` 入库 creators 新字段（fans/sign/level/official…） |
| B2 | `cli collect upper-videos <mid>` 入库一批 videos，回执含 bvids |
| B3 | `cli collect new-videos <mid>` 对比库，正确返回新增 BV（手造数据验证差集） |
| B4 | creators 加列迁移幂等；粉丝数波动不记 change_log |

---

## §13 测试方式（对齐 [CLAUDE.md §3](../../CLAUDE.md)）

| 对象 | 方式 |
|---|---|
| 扩展 | `pnpm --filter subtitle-collector build`（vite build 冒烟）+ `scripts/verify-active-collect.mjs`（puppeteer mock：模拟扩展 WS，对 search/fetch-subtitle action 回放固定 B 站响应 JSON，断言 ingest 入库 + 回执） |
| 扩展 Wbi | `scripts/verify-bili-endpoints.mjs`（puppeteer 驱动扩展，对 4 个 wbi 接口实打签名 + 断言 `code:0`；需登录态） |
| server `ingestUpper` | `node --test --import tsx`（事务 upsert + change_log，纯函数测） |
| CLI `collect` | `node --test --import tsx`（纯处理函数，注入 mock `ServerClient`，断言下发 action/params + 退出码） |
| CLI `dedupe` | `node --test --import tsx`（临时 SQLite，造数据，断言 collected/missing） |

编排：`turbo run test` 一条命令跑全部（[turbo.json](../../turbo.json) 已有/补 `test` task）。

### §13.1 测试轮次记录表

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |

---

## §14 风险

| 风险 | 缓解 |
|---|---|
| B 站接口签名要求变更（wbi 算法/接口下线） | `verify-bili-endpoints.mjs` 持续守护；接口集中在 `bili-fetch.js`，单点改 |
| 风控（频繁请求被 -412） | skill 串行 + 间隔；遇 risk_control 立即停；后续可加扩展端最小间隔 |
| 登录态丢失（cookie 过期） | `need_login` 回执 → skill 停下通知用户 |
| MVP 范围蔓延 | §11 YAGNI 红线 + P1/P2 分期 |
| `view` 接口也要 Wbi（不确定） | verify 脚本验证；若要，纳入 `biliFetch({wbi:true})` |

---

## §15 本地映射参考

- 现有 WS Command 通道（复用）：[ws/server.ts:150-168](../../apps/collector-server/src/ws/server.ts#L150) `requestCommand`、[background.js:64-90](../../apps/subtitle-collector/background.js#L64) action 分发
- 扩展内 fetch 现成模式：[background.js:118-128](../../apps/subtitle-collector/background.js#L118) `FETCH_SUBTITLE`
- 现有 ingest payload 结构：[content.js:61-85](../../apps/subtitle-collector/content.js#L61)
- 现有 ingest 事务（upsert + change_log）：[db/ingest.ts:52-146](../../apps/collector-server/src/db/ingest.ts#L52)
- CLI 命令风格模板：[cli/commands/clients.ts](../../apps/collector-server/src/cli/commands/clients.ts)
- 探索笔记（已被本 spec 取代）：[2026-06-23-active-collection-exploration.md](./2026-06-23-active-collection-exploration.md)
