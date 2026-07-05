# 主动采集 P4（被动 UP 采集）—— 设计文档

> 日期：2026-07-05
> 状态：**正式 spec**。关键决策「进视频页被动触发 + popup 展示最新视频不入库 + 资料 7天/最新视频 1h TTL」**待用户最终确认**（暂按推荐）。
> 关联：[P1 spec](./2026-07-05-active-collection-design.md)（被动采集链路）、[P2 spec](./2026-07-05-active-collection-p2-design.md)（upper-info/upper-videos）、[4 popup UP 卡片](./2026-07-05-active-collection-p2-design.md)

---

## §1 概述

P4 让 UP 主数据**像字幕一样被动采集**：进 B 站视频页（`bilibili.com/video/BV...`）时，扩展顺带采当前视频 UP 的：
- **资料**（sign/level/fans/official，7 天 refresh）—— 次要，低频
- **最新视频列表**（1h refresh，popup 展示，不入库）—— 主要，常新

不再需要手动 `upper-info` / `new-videos`——你看视频时就自动更新。

## §2 关键决策（待确认）

| 决策 | 选择（暂按推荐） | 理由 |
|---|---|---|
| 触发时机 | **进视频页**（passive，复用 P1 触发点） | 最「常新」——你看视频就更新；复用现有 passive 链路 |
| UP 资料 refresh | **7 天 TTL** | 用户明确「UP 信息次要 7 天就行」 |
| 最新视频 refresh | **1h TTL** | 「常刷常新」+ 防风控（arc/search 每视频页都打会 -412） |
| 最新视频处理 | **popup 展示，不入库** | 不污染 P2 dedupe（决策 A）；不入 videos 表，存 chrome.storage 缓存 |

## §3 需求

| # | 需求 | 验证 |
|---|---|---|
| R1 | 进视频页，UP 资料 7 天没更新 → 自动 fetch acc/info+stat → ingestUpper | creators.updated_at 推进；popup 卡片有完整资料 |
| R2 | 进视频页，UP 最新视频 1h 没 fetch → 自动 fetch arc/search → 缓存 | popup 最新视频列表常新 |
| R3 | 最新视频**不入** videos 表（不污染 dedupe） | videos 表只增 fetch-subtitle 采过的 |
| R4 | 风控兜底：fetch 失败（-412/-101）不影响主链路（video ingest） | UP fetch 异步、失败静默 |

## §4 架构

```
进视频页（P1 passive 触发）
  │ content.js 拦 player API + 字幕（P1，不动）→ background INGEST
  ▼
background 收到 INGEST（video，含 creator.source_uid = UP mid）
  │ 1. sendIngest(video)（P1，不动）
  │ 2. 异步顺带（不阻塞主链路）：
  │    a) ensureUpperInfo(mid)：若 >7天没采 → biliFetch acc/info + relation/stat → ws.send ingest-upper
  │    b) ensureUpperVideos(mid)：若 >1h没采 → biliFetch arc/search → chrome.storage 缓存
  ▼
popup 打开：
  - UP 资料卡片（4，server getCreator，已做）
  - UP 最新视频列表（新：从 chrome.storage 缓存读，展示 bvid/title）
```

## §5 接口契约

### §5.1 background passive 流程（收到 INGEST 后顺带 UP fetch）

[background.js](apps/subtitle-collector/background.js) 的 `chrome.runtime.onMessage` INGEST 处理（[L265-277](apps/subtitle-collector/background.js#L265)），在 `sendIngest(payload)` 之后，**异步**加：
```javascript
// P4：顺带被动采 UP 资料（7天）+ 最新视频（1h），失败不影响主链路
const mid = payload.video?.creator?.source_uid;
if (mid) {
  ensureUpperInfo(mid).catch((e) => console.warn('[background] passive upper-info failed', String(e)));
  ensureUpperVideos(mid).catch((e) => console.warn('[background] passive upper-videos failed', String(e)));
}
```
（异步、不 await、失败静默——UP fetch 是「锦上添花」，不能拖累/弄崩主 video ingest。）

### §5.2 ensureUpperInfo / ensureUpperVideos（TTL 缓存检查）

复用 P1 的 `ensureWbiKeys`（TTL 模式）+ P2 的 `biliFetch`：

```javascript
// per-UP 资料上次采集时间（chrome.storage），7 天 TTL
async function ensureUpperInfo(mid) {
  const key = `upperInfoAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 7 * 24 * 3600 * 1000) return;  // 7 天内跳过
  await ensureWbiKeys();
  const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
  const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
  if (!infoRes.ok) throw new Error('acc/info ' + infoRes.code);
  const info = infoRes.data, stat = statRes.ok ? statRes.data : {};
  const creator = { source_uid: String(mid), name: info.name, avatar: info.face, sign: info.sign, level: info.level, sex: info.sex, official_type: info.official?.type, official_title: info.official?.title, fans: stat.follower, following: stat.following };
  ws.send(JSON.stringify({ type: 'ingest-upper', payload: { source: 'bilibili', creator } }));
  await chrome.storage.local.set({ [key]: Date.now() });
}

// per-UP 最新视频缓存（chrome.storage），1h TTL，不入库
async function ensureUpperVideos(mid) {
  const key = `upperVideosAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 3600 * 1000) return;  // 1h 内跳过
  await ensureWbiKeys();
  const parsed = await biliFetch('/x/space/wbi/arc/search', { wbi: true, params: { mid, pn: 1, ps: 10, order: 'pubdate' }, wbiKeys });
  if (!parsed.ok) throw new Error('arc/search ' + parsed.code);
  const items = (parsed.data?.list?.vlist ?? []).map((v) => ({ bvid: v.bvid, title: v.title, created: v.created ?? null }));
  await chrome.storage.local.set({ [`upperVideos:${mid}`]: { items, fetchedAt: Date.now() }, [key]: Date.now() });
}
```

### §5.3 popup 最新视频列表（从 chrome.storage 缓存读）

popup 加 hook `useUpperVideos(mid)`：读 `chrome.storage.local[`upperVideos:${mid}`]` → `{items, fetchedAt}`。popup 在 UP 资料卡片下加「最新视频」列表（bvid/title，点击可跳 B 站）。无缓存时（首次/过期）显示「浏览该 UP 一个视频后更新」。

## §6 不做（YAGNI）

- 自动 `fetch-subtitle` 新视频（用户手动 collect subtitle；P4 只列出最新视频）
- 最新视频入 videos 表（避免污染 dedupe；存 chrome.storage 缓存）
- 后台调度/cron（passive 触发，复用 P1）
- popup 打开时主动 fetch 最新视频（用 passive 缓存；避免 popup 延迟）

## §7 数据模型

- **creators 表**：不变（P2 字段；passive ingestUpper 更新，7 天 TTL 由 background chrome.storage 控制频率，不由 DB）
- **videos 表**：不变（最新视频不入库）
- **chrome.storage**：per-UP 缓存（`upperInfoAt:<mid>` / `upperVideosAt:<mid>` / `upperVideos:<mid>`）

## §8 验收标准

| # | 验收项 |
|---|---|
| E1 | 进一个 UP 的视频页（该 UP 资料 >7天 或从未采）→ creators 表 sign/level/fans 更新；popup UP 卡片有完整资料 |
| E2 | 进视频页（该 UP 最新视频 >1h 或从未采）→ chrome.storage 缓存最新视频；popup 展示列表 |
| E3 | 7 天/1h 内重复进视频页 → **不重复 fetch**（TTL 跳过，看 chrome.storage 时间戳） |
| E4 | UP fetch 失败（断网/-412）→ 不影响 video 字幕 ingest（主链路正常） |
| E5 | 最新视频**不入** videos 表（dedupe 行为不变） |

## §9 测试方式（对齐 [CLAUDE.md §3](../../CLAUDE.md)）

| 对象 | 方式 |
|---|---|
| ensureUpperInfo / ensureUpperVideos TTL 逻辑 | `node --test`（mock biliFetch + chrome.storage，断言 TTL 跳过） |
| popup useUpperVideos | `node --test`（mock chrome.storage，断言读缓存） |
| background passive 集成 | `verify-active-collect.mjs` 扩展（mock acc/info + arc/search，断言 ingest-upper + 缓存） |

### §9.1 测试轮次记录表

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |

## §10 风险

| 风险 | 缓解 |
|---|---|
| passive UP fetch 增加每视频页请求数（acc/info + arc/search） | TTL 去重（7天/1h）；失败静默不阻塞主链路 |
| chrome.storage 缓存膨胀（per-UP） | 只存最新 10 个 + fetchedAt；旧 UP 缓存可过期清理（YAGNI，先不做） |
| background SW 重启丢内存 TTL | TTL 用 chrome.storage（持久），不靠内存 |
| ensureUpperInfo 复用 P2 get-upper-info 逻辑（DRY） | 实现时考虑抽公共（acc/info+stat → creator 组装），但 P4 先内联（避免改 P2） |

## §11 本地映射参考

- P1 passive 触发点（复用）：[background.js](apps/subtitle-collector/background.js) INGEST onMessage（[L265-277](apps/subtitle-collector/background.js#L265)）
- P2 get-upper-info 逻辑（acc/info+stat → creator）：[background.js:167-196](apps/subtitle-collector/background.js#L167)
- P2 list-upper-videos 逻辑（arc/search）：[background.js:197-220](apps/subtitle-collector/background.js#L197)
- P1 ensureWbiKeys（TTL 模式参考）：[background.js:26-28](apps/subtitle-collector/background.js#L26)
- 4 popup UP 卡片（已做）：[Popup.tsx](apps/subtitle-collector/src/popup/Popup.tsx) CreatorCard
