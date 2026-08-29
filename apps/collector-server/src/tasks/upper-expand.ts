// UP/频道/博主全部视频列表展开（web 端「按 UP 批量」用，server 经扩展 WS 代理拉取）。
// 2026-08-24 两平台；2026-08-29 从 tasks/tasks.ts 整体抽出独立模块（沿 db/tag-match.ts 抽出
// 先例）+ douyin 第三平台接入（S8 接线：扩展 action expand-douyin-upper）。
// 2026-08-30 版本感知：douyin 分支按 hello 上报的 ext_version 设派发门槛（多机版本参差事故，
// 详见 DOUYIN_EXPAND_MIN_VERSION 注释），回执 unknown action 统一分类为「扩展版本过旧」。
// server 不直连平台（无浏览器 cookie/wbi 环境且数据中心 IP 易风控），复用扩展 action：
// bilibili 逐页 list-upper-videos（页间节流对齐 popup 的 500ms）；
// youtube 一次 list-yt-channel-videos（扩展内全量分页 + 1h 缓存，refresh 绕过）；
// douyin 一次 expand-douyin-upper（扩展内 max_cursor 游标翻页聚合成一次回传，server 不感知游标）。
import type Database from 'better-sqlite3';
import { getWsBridge } from './wsBridge.js';
import { EXT_NEEDS_UPDATE_ERROR, compareExtVersion, extNeedsUpdate } from './ext-version.js';
import type { Source } from './source.js';

export interface UpperVideoItem {
  bvid: string;          // 平台内视频 ID：B 站 BV 号 / YouTube 11 位 ID / 抖音 aweme_id（沿用字段名兼容渲染层）
  title: string;
  created: number | null;
  play: number | null;
  length: string | null; // arc/search 原样 "MM:SS" / "HH:MM:SS"
  pic: string | null;    // 封面 URL（"//" 协议头相对形式归一为 https:）
  collected: boolean;    // 已入库（videos 表按平台命中）
}

// ── YouTube 频道标识与参数解析（2026-08-24 从 cli/commands/collect.ts 下沉，http 端点复用）──
/** 频道标识（扩展 list-yt-channel-videos action 的 ident 参数）。 */
export interface YtChannelIdent { handle?: string; channelId?: string; custom?: string; }

/** 用户输入（@handle / UCxxx / 频道页 URL）→ ident。无法识别抛错（调用方转 400/ARGS）。 */
export function parseYtChannelArg(arg: string): YtChannelIdent {
  const a = arg.trim();
  if (/^@[\w.-]{3,30}$/.test(a)) return { handle: a };
  if (/^UC[\w-]{22}$/.test(a)) return { channelId: a };
  try {
    const u = new URL(a);
    if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) {
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg[0] && /^@[\w.-]{3,30}$/.test(seg[0])) return { handle: seg[0] };
      if (seg[0] === 'channel' && seg[1] && /^UC[\w-]{22}$/.test(seg[1])) return { channelId: seg[1] };
      if ((seg[0] === 'c' || seg[0] === 'user') && seg[1] && /^[\w.-]+$/.test(seg[1])) return { custom: seg[1] };
    }
  } catch { /* 非 URL → 落到下面统一报错 */ }
  throw new Error(`无法识别的频道参数：${arg}（支持 @handle / UC 开头 channelId / 频道页 URL）`);
}

/** expand 查询（联合类型分平台）：B 站按 mid 逐页；YouTube 按 ident 一次全量；抖音按 secUid（S3 骨架）。 */
export type ExpandUpperQuery =
  | { source: 'bilibili'; mid: string }
  | { source: 'youtube'; ident: YtChannelIdent }
  | { source: 'douyin'; secUid: string };

// 封面 URL 归一：arc/search 的 pic 常为 "//i2.hdslb.com/..." 协议头相对形式，补 https:
function normalizePic(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  return p.startsWith('//') ? `https:${p}` : p;
}

// 依赖注入（测试 mock 用）；生产默认经 wsBridge 取真 WS 实现（ws/server.ts 加载时注册）。
// ext_version：hello 上报的扩展版本（版本门槛判定输入；测试夹具缺省视为 0.0.0）。
export interface UpperExpandDeps {
  listClients?: () => Array<{ client_id: string; ext_version?: string | null; task_dispatch_enabled?: boolean }>;
  requestCommand?: (
    clientId: string,
    action: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<{ ok: true; result: any } | { ok: false; code: 'offline' | 'timeout' }>;
  sleep?: (ms: number) => Promise<void>;
  pageGapMs?: number;
}

const UPPER_PAGE_TIMEOUT_MS = 30_000; // 单页（30 条）30s 上限，全量循环整体不设超时
const YT_CHANNEL_TIMEOUT_MS = 180_000; // YouTube 全量分页在扩展内完成（大频道十几秒），对齐 CLI 默认采集超时
// 抖音滚动翻页聚合在扩展内完成（2026-08-30 审查 M1 由 180s 调 420s=7 分钟）：扩展侧防失控上限
// UPPER_MAX_ITEMS=2000（content-dy.js），每页 ~18 条 + 滚动间隔 1200ms，2000 条 ≈ 6 分钟——
// 180s 只够 ~1400 条，超限前 server 先超时；7 分钟与上限节奏匹配（对齐扩展滚动翻页节奏）。
const DY_UPPER_TIMEOUT_MS = 420_000;

// 抖音博主展开的扩展版本门槛（2026-08-30 多机版本参差事故）：expand-douyin-upper 是 0.1.25
// 新增 action（2736d6e 抖音平台化首发），旧扩展（事故中的 0.1.18）不认识 → 回执
// 「unknown action: expand-douyin-upper」原样透出 503，而够新的机器明明能干。派发前按 hello
// 上报的 ext_version 硬过滤（见 expandUpperVideos 客户端选择）。
// 注：0.1.24 从未发布（0.1.23 直升 0.1.25），门槛取实际承载该 action 的最低已发布版本。
const DOUYIN_EXPAND_MIN_VERSION = '0.1.25';

// 回执失败分类（对齐任务派发侧同款机制，共享实现见 ext-version.ts）：unknown action /
// needs_update → 「扩展版本过旧」+ 回执原文——版本门槛是事前过滤，这里是兜底（门槛漏网如
// hello 谎报版本时，错误也能指向更新而非误重试）；其余失败（need_login/风控）原文透出。
function receiptError(result: { error?: unknown; data?: unknown; needs_update?: unknown }, fallback: string): Error {
  if (extNeedsUpdate(result)) {
    const raw = typeof result.error === 'string' ? result.error : 'unknown action';
    return new Error(`${EXT_NEEDS_UPDATE_ERROR}（回执：${raw}）`);
  }
  return new Error(String(result.error ?? fallback));
}

// collected 标注：videos 表按平台 source_vid IN 分批查（SQLite 绑定变量上限兜底 chunk 500）
function markCollected(db: Database.Database, items: UpperVideoItem[], source: Source): void {
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT source_vid FROM videos WHERE source = ? AND source_vid IN (${ph})`,
    ).all(source, ...chunk.map((x) => x.bvid)) as Array<{ source_vid: string }>;
    const hit = new Set(rows.map((row) => row.source_vid));
    for (const it of chunk) it.collected = hit.has(it.bvid);
  }
}

// 扩展回执条目 → UpperVideoItem（title/created/play/length/pic 宽松透传，缺失回落空值；
// 两平台回执共用，id 键由调用方先取出：yt 的 vid / bili 的 bvid）。
function toUpperItem(
  v: { title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown },
  id: string,
): UpperVideoItem {
  return {
    bvid: id,
    title: typeof v.title === 'string' ? v.title : '',
    created: typeof v.created === 'number' ? v.created : null,
    play: typeof v.play === 'number' ? v.play : null,
    length: typeof v.length === 'string' ? v.length : null,
    pic: normalizePic(v.pic),
    collected: false,
  };
}

// 非空字符串收窄（扩展回执字段宽松透传：''/非字符串 → null）。
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

// creator 最小行落库（库里无该频道才写——批量任务的 UP 筛选归属；已有行的名字不覆盖）。
function insertYtCreatorIfAbsent(db: Database.Database, channelId: string, name: string | null): void {
  const exists = db.prepare("SELECT 1 FROM creators WHERE source = 'youtube' AND source_uid = ?").get(channelId);
  if (!exists) {
    const now = Date.now();
    db.prepare('INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('youtube', channelId, name, now, now);
  }
}

// YouTube 频道展开：一次 list-yt-channel-videos 全量回执（扩展内分页 + 1h 缓存，refresh 绕过）。
// 完整频道统计（订阅数等）需 about 页抓取，扩展侧后续补（见 README 待建）。
async function expandYtChannelVideos(
  db: Database.Database,
  ident: YtChannelIdent,
  reqCmd: NonNullable<UpperExpandDeps['requestCommand']>,
  clientId: string,
): Promise<{ total: number; items: UpperVideoItem[]; channel: { id: string | null; name: string | null } }> {
  const r = await reqCmd(clientId, 'list-yt-channel-videos', { ident, refresh: true }, YT_CHANNEL_TIMEOUT_MS);
  if (!r.ok) throw new Error(r.code === 'offline' ? '扩展离线（拉取中断）' : '扩展执行超时');
  const result = r.result ?? {};
  if (result.ok === false) throw receiptError(result, 'list-yt-channel-videos 失败');
  const data = result.data ?? {};
  const raw: Array<{ vid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }> =
    Array.isArray(data.items) ? data.items : [];
  const items: UpperVideoItem[] = [];
  for (const v of raw) {
    if (typeof v?.vid !== 'string') continue;
    items.push(toUpperItem(v, v.vid));
  }
  const channelId = strOrNull(data.channel_id);
  const channelName = strOrNull(data.channel_name);
  if (channelId) insertYtCreatorIfAbsent(db, channelId, channelName);
  markCollected(db, items, 'youtube');
  return { total: typeof data.total === 'number' ? data.total : items.length, items, channel: { id: channelId, name: channelName } };
}

// 抖音博主展开（2026-08-29 S8 接线，对齐 YouTube 一次全量回执形态）：扩展 expand-douyin-upper
// 在博主页 tab 内滚动驱动 max_cursor 游标翻页聚合 + profile 抓取，一次回传全量（server 不感知
// 游标）。回执条目 bvid=aweme_id（图集已在扩展侧过滤）；creators 最小行由扩展顺带 ingest-upper
// 落库（对齐 B 站 get-upper-info 的扩展侧入库），server 不重复落。channel_id=secUid、
// channel_name=扩展抓到的博主昵称（profile 未到手时 null）。
async function expandDouyinUpperVideos(
  db: Database.Database,
  secUid: string,
  reqCmd: NonNullable<UpperExpandDeps['requestCommand']>,
  clientId: string,
): Promise<{ total: number; items: UpperVideoItem[]; channel: { id: string | null; name: string | null } }> {
  const r = await reqCmd(clientId, 'expand-douyin-upper', { secUid }, DY_UPPER_TIMEOUT_MS);
  if (!r.ok) throw new Error(r.code === 'offline' ? '扩展离线（拉取中断）' : '扩展执行超时');
  const result = r.result ?? {};
  if (result.ok === false) throw receiptError(result, 'expand-douyin-upper 失败');
  const data = result.data ?? {};
  const raw: Array<{ bvid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }> =
    Array.isArray(data.items) ? data.items : [];
  const items: UpperVideoItem[] = [];
  for (const v of raw) {
    if (typeof v?.bvid !== 'string') continue;
    items.push(toUpperItem(v, v.bvid));
  }
  markCollected(db, items, 'douyin');
  return {
    total: typeof data.total === 'number' ? data.total : items.length,
    items,
    channel: { id: strOrNull(data.channel_id), name: strOrNull(data.channel_name) },
  };
}

// B 站单页条目并入（bvid 去重，页间新投稿导致分页位移重叠时防重复）；返回本页新增数（停滞判定输入）。
function pushBiliPageItems(
  pageItems: Array<{ bvid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }>,
  items: UpperVideoItem[],
  seen: Set<string>,
): number {
  let added = 0;
  for (const v of pageItems) {
    if (typeof v?.bvid !== 'string' || seen.has(v.bvid)) continue;
    seen.add(v.bvid);
    added++;
    items.push(toUpperItem(v, v.bvid));
  }
  return added;
}

// B 站逐页循环：契约对齐 background.js list-upper-videos action（读 msg.page / msg.page_size——
// 曾误用 pn/ps 导致扩展每页回落第 1 页，2026-08-19 回归）；连续 3 整页无新视频判定分页
// 停滞/重叠死循环终止（保已拉部分）。
async function expandBilibiliUpperVideos(
  db: Database.Database,
  mid: string,
  reqCmd: NonNullable<UpperExpandDeps['requestCommand']>,
  clientId: string,
  sleep: (ms: number) => Promise<void>,
  gap: number,
): Promise<{ total: number; items: UpperVideoItem[] }> {
  const items: UpperVideoItem[] = [];
  const seen = new Set<string>();
  let total = 0;
  let noNewStreak = 0;
  for (let page = 1; ; page++) {
    const r = await reqCmd(clientId, 'list-upper-videos', { mid, page, page_size: 30 }, UPPER_PAGE_TIMEOUT_MS);
    if (!r.ok) throw new Error(r.code === 'offline' ? '扩展离线（拉取中断）' : '扩展执行超时');
    const result = r.result ?? {};
    if (result.ok === false) throw receiptError(result, 'list-upper-videos 失败');
    const data = result.data ?? {};
    const pageItems: Array<{ bvid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }> = Array.isArray(data.items) ? data.items : [];
    total = typeof data.total === 'number' ? data.total : items.length + pageItems.length;
    const added = pushBiliPageItems(pageItems, items, seen);
    if (pageItems.length === 0 || items.length >= total) break;
    noNewStreak = added > 0 ? 0 : noNewStreak + 1;
    if (noNewStreak >= 3) break;
    await sleep(gap); // 页间节流防风控
  }
  markCollected(db, items, 'bilibili');
  return { total, items };
}

export async function expandUpperVideos(
  db: Database.Database,
  query: ExpandUpperQuery,
  deps: UpperExpandDeps = {},
): Promise<{ total: number; items: UpperVideoItem[]; channel?: { id: string | null; name: string | null } }> {
  const lsClients = deps.listClients ?? getWsBridge().listClients;
  const reqCmd = deps.requestCommand ?? getWsBridge().requestCommand;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = deps.pageGapMs ?? 500;

  const clients = lsClients();
  if (clients.length === 0) throw new Error('扩展离线：UP 视频列表需经桌面扩展拉取（连上扩展后重试）');
  // 客户端选择（2026-08-23 任务派发池）：优先接受任务派发的客户端——批量采集编排尽量落在
  // 专职采集机上（B 站 API 配额/风控压力同源）。池空（全仅上报）回退任意在线：
  // list-upper-videos / list-yt-channel-videos 是纯 API 代理查询，无标签页/UI 干扰，不必拒绝。
  const pool = clients.filter((c) => c.task_dispatch_enabled !== false);

  // 抖音版本门槛（2026-08-30 多机版本参差事故——0.1.26 新机与 0.1.18 旧机同时在线，无版本感知
  // 选到旧机 → 回执 unknown action 透出 503）：expand-douyin-upper 仅 ≥0.1.25 扩展认识，先按
  // ext_version 硬过滤，池偏好（专职采集机优先）只在合格者内生效——版本是「能不能干」，池是
  // 「该谁干」。无合格端 → 报错带各端版本清单（http 层 503 可见，指明差在哪台）。bilibili/
  // youtube 不设门槛（list-upper-videos / list-yt-channel-videos 旧扩展已认识，防回归）。
  let clientId: string;
  if (query.source === 'douyin') {
    const qualified = clients.filter((c) => compareExtVersion(c.ext_version, DOUYIN_EXPAND_MIN_VERSION) >= 0);
    if (qualified.length === 0) {
      const roster = clients.map((c) => `${c.client_id}@${c.ext_version ?? '未知版本'}`).join('、');
      throw new Error(`在线扩展版本均过低（抖音博主展开需 ≥${DOUYIN_EXPAND_MIN_VERSION}）：${roster}`);
    }
    clientId = (qualified.find((c) => c.task_dispatch_enabled !== false) ?? qualified[0]).client_id;
  } else {
    clientId = (pool[0] ?? clients[0]).client_id;
  }

  // 平台分派：YouTube / 抖音一次全量回执（扩展内分页/游标聚合）；B 站走下方逐页循环。
  if (query.source === 'youtube') return expandYtChannelVideos(db, query.ident, reqCmd, clientId);
  if (query.source === 'douyin') return expandDouyinUpperVideos(db, query.secUid, reqCmd, clientId);
  return expandBilibiliUpperVideos(db, query.mid, reqCmd, clientId, sleep, gap);
}
