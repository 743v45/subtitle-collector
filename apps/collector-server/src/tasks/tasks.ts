import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { getWsBridge } from './wsBridge.js';
import { DEFAULT_COLLECT_TIMEOUT_MS, getCollectTimeout, type CollectTimeoutMs } from '../db/settings.js';
import { markNoSubtitle } from '../db/tags.js';
import { inFlight } from './inflight.js';
import { buildOrderBy, cmpBySortKey, TASK_SORT_KEYS, type TaskSortKey } from '../db/sort.js';

// ── 采集任务系统：手机/网页提交 → server 派发给桌面扩展 → 扩展采集回执 ──
// 设计依据：docs/superpowers/specs/2026-08-13-mobile-collect-task-design.md
// 状态机：pending → dispatched → succeeded | failed
// 批量扩展（2026-08-19）：docs/superpowers/specs/2026-08-19-upper-all-videos-batch-design.md

export type TaskStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed' | 'limited';

export interface CollectTask {
  id: number;
  source: 'bilibili' | 'youtube';
  source_vid: string;
  url: string;
  status: TaskStatus;
  client_id: string | null;
  creator_client_id?: string | null; // 创建者客户端（popup 提交自带；CLI/旧任务 null），sticky 派发用
  batch_id?: string | null;          // 展示侧聚合标签（批量提交同批共享；单条/旧任务 null）
  batch_total?: number;              // 仅 task-update 推送携带——同批成员总数（popup 聚合分母）；列表/单查 API 不返回
  error: string | null;
  result: string | null;
  title: string | null; // 库内视频标题（LEFT JOIN videos；采集页直接展示,未入库为 null）
  creator_name?: string | null; // UP 名（入库经 creators、未入库经任务行 creator_uid 关联资料行；两处都无则 null）
  creator_source_uid?: string | null; // UP 外链 uid（入库取 creators.source_uid、未入库回落任务行 creator_uid；任务卡跳空间页）
  creator_uid?: string | null; // 任务行 UP 归属冗余列（批量提交已知 / 建任务查库 / ingest 回填；历史页筛未入库任务）
  created_at: number;
  finished_at: number | null;
}

// 任务行查询的公共 FROM/JOIN（标题与 UP 名经 join 带出；videos 有 UNIQUE(source, source_vid)、
// creators 单行，JOIN 不扇出）。ct = 任务行 creator_uid 关联的资料行（未入库但已知 UP 的任务，
// P2 通道采过资料的库里有名字可回显）；c 与 ct 理论上同源同行（视频入库后归属一致），COALESCE 兜底。
const TASK_JOINS = `
  FROM collect_tasks t
  LEFT JOIN videos v ON v.source = t.source AND v.source_vid = t.source_vid
  LEFT JOIN creators c ON c.id = v.creator_id
  LEFT JOIN creators ct ON ct.source = t.source AND ct.source_uid = t.creator_uid
`;
const TASK_SELECT = `SELECT t.*, v.title AS title, COALESCE(c.name, ct.name) AS creator_name, COALESCE(c.source_uid, t.creator_uid) AS creator_source_uid ${TASK_JOINS}`;

// 任务行 + 库内视频标题（videos 有 UNIQUE(source, source_vid),JOIN 不扇出）
const TASK_WITH_TITLE = `${TASK_SELECT} WHERE t.id = ?`;

// 单任务在扩展侧的执行预算（按平台分档，可经 settings.collect_timeout_ms 配置）——须覆盖扩展
// 全链路（导航加载 + 多请求 + 宽限 + 关 tab 间隔），超时早于扩展实际完成会落假失败（扩展仍在
// 跑并落库，任务页却显示失败，用户重试 = 重复采集）。
// bilibili：navigate ~20s + view/tags/player 拉取；youtube：后台 tab + 无进展窗口 + 8s 宽限 + 关 tab 间隔。
// youtube 等回执预算 = 无进展窗口 + 135s 余量（窗口本身可配置下发扩展,余量覆盖关 tab/INGEST 落库,
// 对齐原硬编码 45s 窗口 + 180s 预算的关系）。
export function commandTimeoutMs(
  source: 'bilibili' | 'youtube',
  timeouts: CollectTimeoutMs = DEFAULT_COLLECT_TIMEOUT_MS,
): number {
  return source === 'youtube' ? timeouts.youtube + 135_000 : timeouts.bilibili;
}
// 兜底轮询周期（事件驱动派发之外，防事件遗漏）
const SWEEP_MS = 15_000;

// ── URL 解析（手机粘贴文本 → 平台 + 视频 ID）──
// 手机 B 站 App 分享出来的是 b23.tv 短链混在文案里；YouTube 分享是 youtu.be 短链。
// 纯函数，不 fetch —— 短链展开在 createTask 的调用侧做（可注入 fetch 便于测试）。

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ParsedTarget {
  source: 'bilibili' | 'youtube';
  source_vid: string;
  url: string; // 解析出 videoId 后回填的标准 watch URL
}

// 从粘贴文本提取第一个视频 URL（b23.tv / youtu.be / bilibili.com / youtube.com）
export function extractVideoUrl(text: string): string | null {
  const urls = text.match(URL_RE) ?? [];
  for (const u of urls) {
    let host: string;
    try { host = new URL(u).hostname; } catch { continue; }
    if (
      host === 'b23.tv' || host === 'bili2233.cn' || host === 'bili2233.com'
      || host === 'www.bilibili.com' || host === 'bilibili.com' || host === 'm.bilibili.com'
      || host === 'youtu.be' || host === 'www.youtu.be'
      || host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com'
    ) {
      return u;
    }
    return null; // 只认第一个 URL,非视频站直接拒
  }
  return null;
}

// 短链展开：b23.tv / youtu.be 跟随重定向拿最终 URL（Node fetch 默认跟 301/302）
export async function expandShortLink(url: string, fetcher: FetchLike): Promise<string> {
  let host: string;
  try { host = new URL(url).hostname; } catch { return url; }
  if (host !== 'b23.tv' && host !== 'bili2233.cn' && host !== 'bili2233.com' && host !== 'youtu.be' && host !== 'www.youtu.be') return url;
  try {
    const res = await fetcher(url, { redirect: 'follow' });
    return res.url || url; // Response.url = 重定向后的最终 URL
  } catch {
    return url; // 展开失败按原 URL 走（后续解析会 400,错误可见）
  }
}

// 解析标准视频 URL → 平台 + 视频 ID。解析不出返回 null。
export function parseVideoUrl(url: string): ParsedTarget | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname;
  // ── B 站：/video/BVxxxx 或 ?bvid= ──
  if (host === 'www.bilibili.com' || host === 'bilibili.com' || host === 'm.bilibili.com') {
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return { source: 'bilibili', source_vid: m[1], url: `https://www.bilibili.com/video/${m[1]}` };
    const bvid = u.searchParams.get('bvid');
    if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) return { source: 'bilibili', source_vid: bvid, url: `https://www.bilibili.com/video/${bvid}` };
    return null;
  }
  // ── YouTube：watch?v= / shorts / youtu.be/<id> ──
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    if (/^[\w-]{11}$/.test(id)) return { source: 'youtube', source_vid: id, url: `https://www.youtube.com/watch?v=${id}` };
    return null;
  }
  if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) return { source: 'youtube', source_vid: v, url: `https://www.youtube.com/watch?v=${v}` };
    const shorts = u.pathname.match(/\/shorts\/([\w-]{11})/);
    if (shorts) return { source: 'youtube', source_vid: shorts[1], url: `https://www.youtube.com/watch?v=${shorts[1]}` };
    return null;
  }
  return null;
}

// ── 任务 CRUD ──

export function createTask(
  db: Database.Database,
  target: ParsedTarget,
  creatorClientId: string | null = null,
  batchId: string | null = null,
  creatorUid: string | null = null, // UP 归属（批量提交时调用方已知）；缺省查库回填（重采：视频已入库）
): CollectTask {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO collect_tasks (source, source_vid, url, status, created_at, creator_client_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(target.source, target.source_vid, target.url, 'pending', now, creatorClientId, batchId);
  const id = Number(info.lastInsertRowid);
  // UP 归属冗余：显式值优先，否则从库内归属回填（该视频采过 → 任务行立即可按 UP 筛，失败重试场景的关键路径）
  db.prepare(
    `UPDATE collect_tasks SET creator_uid = COALESCE(?, (SELECT c.source_uid FROM videos v JOIN creators c ON c.id = v.creator_id
       WHERE v.source = collect_tasks.source AND v.source_vid = collect_tasks.source_vid)) WHERE id = ?`,
  ).run(creatorUid, id);
  pushTask(db, id);
  return getTask(db, id)!;
}

// 未终态判据：pending/dispatched 视为在途（创建去重跳过）；succeeded/failed 为终态（允许重采）
const ACTIVE_TASK_WHERE = "t.status IN ('pending', 'dispatched')";

// 同 (source, source_vid) 的未终态任务（多条在途取最新一条）——单条创建去重用，
// 判据与批量端点一致：双击提交返回既有任务而非再建一条（双采）。
export function findActiveTask(
  db: Database.Database,
  source: 'bilibili' | 'youtube',
  sourceVid: string,
): CollectTask | null {
  const row = db.prepare(`
    ${TASK_SELECT}
    WHERE t.source = ? AND t.source_vid = ? AND ${ACTIVE_TASK_WHERE}
    ORDER BY t.id DESC LIMIT 1
  `).get(source, sourceVid) as CollectTask | undefined;
  return row ?? null;
}

// ── 批量建任务（popup/web 按 UP 批量采集）──
// 去重：同 (source, source_vid) 已有未终态任务（pending/dispatched）跳过；终态（succeeded/failed）允许重采。
// 入参 vid 非法（bilibili 非 BV 格式 / youtube 非 11 位）或重复直接忽略，不进 skipped 也不建任务。
// source 参数化（2026-08-21，YouTube 频道批量）：默认 bilibili 兼容旧调用。
const VID_RE: Record<string, RegExp> = {
  bilibili: /^BV[0-9A-Za-z]{10}$/,
  youtube: /^[\w-]{11}$/,
};
export function createTasksBatch(
  db: Database.Database,
  vids: unknown,
  source: 'bilibili' | 'youtube' = 'bilibili',
  creatorClientId: string | null = null,
  creatorUid: string | null = null, // UP 归属（B 站 mid / YouTube channelId；批量提交入口已知）
  force = false, // 2026-08-25：默认跳过「已有字幕轨」的入库视频（重采须显式 force）
): { created: CollectTask[]; skipped: string[]; skippedCollected: string[] } {
  const re = VID_RE[source];
  const urlFor = (vid: string) =>
    source === 'youtube' ? `https://www.youtube.com/watch?v=${vid}` : `https://www.bilibili.com/video/${vid}`;
  // 已有字幕轨判定（批量默认不重采的判据）：videos 行存在且至少一条 subtitle_tracks。
  // 无字幕（no_subtitle/pot_limited 0 轨）不在跳过之列——后续平台可能出字幕，重试合理。
  const hasSubtitle = force ? null : db.prepare(
    `SELECT 1 FROM videos v WHERE v.source = ? AND v.source_vid = ?
       AND EXISTS (SELECT 1 FROM subtitle_tracks st WHERE st.video_id = v.id)`,
  );
  // 同批共享一个 batch_id：纯展示侧聚合标签（UI 分组成一个批量任务），无批次实体/状态。
  const batch = randomUUID();
  const created: CollectTask[] = [];
  const skipped: string[] = [];
  const skippedCollected: string[] = [];
  const seen = new Set<string>();
  for (const vid of Array.isArray(vids) ? vids : []) {
    if (typeof vid !== 'string' || !re.test(vid) || seen.has(vid)) continue;
    seen.add(vid);
    if (findActiveTask(db, source, vid)) { skipped.push(vid); continue; }
    if (hasSubtitle?.get(source, vid)) { skippedCollected.push(vid); continue; }
    created.push(createTask(db, { source, source_vid: vid, url: urlFor(vid) }, creatorClientId, batch, creatorUid));
  }
  return { created, skipped, skippedCollected };
}

// ── UP/频道全部视频列表（web 端「按 UP 批量」用，server 经扩展 WS 代理拉取；2026-08-24 两平台）──
// server 不直连平台（无浏览器 cookie/wbi 环境且数据中心 IP 易风控），复用扩展 action：
// bilibili 逐页 list-upper-videos（background.js arc/search 封装，页间节流对齐 popup 的 500ms）；
// youtube 一次 list-yt-channel-videos（扩展内全量分页 + 1h 缓存，refresh 绕过）。
export interface UpperVideoItem {
  bvid: string;          // 平台内视频 ID：B 站 BV 号 / YouTube 11 位 ID（沿用字段名兼容渲染层）
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

/** expand 查询（联合类型分平台）：B 站按 mid 逐页；YouTube 按 ident 一次全量。 */
export type ExpandUpperQuery =
  | { source: 'bilibili'; mid: string }
  | { source: 'youtube'; ident: YtChannelIdent };

// 封面 URL 归一：arc/search 的 pic 常为 "//i2.hdslb.com/..." 协议头相对形式，补 https:
function normalizePic(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  return p.startsWith('//') ? `https:${p}` : p;
}

// 依赖注入（测试 mock 用）；生产默认经 wsBridge 取真 WS 实现（ws/server.ts 加载时注册）。
export interface UpperExpandDeps {
  listClients?: () => Array<{ client_id: string; task_dispatch_enabled?: boolean }>;
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

// collected 标注：videos 表按平台 source_vid IN 分批查（SQLite 绑定变量上限兜底 chunk 500）
function markCollected(db: Database.Database, items: UpperVideoItem[], source: 'bilibili' | 'youtube'): void {
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

// YouTube 频道展开：一次 list-yt-channel-videos 全量回执（扩展内分页 + 1h 缓存，refresh 绕过）。
// 顺带落 creator 最小行（source_uid=channelId + name）——库里无该频道才写，批量任务的 UP 筛选归属；
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
  if (result.ok === false) throw new Error(String(result.error ?? 'list-yt-channel-videos 失败'));
  const data = result.data ?? {};
  const raw: Array<{ vid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }> =
    Array.isArray(data.items) ? data.items : [];
  const items: UpperVideoItem[] = [];
  for (const v of raw) {
    if (typeof v?.vid !== 'string') continue;
    items.push({
      bvid: v.vid,
      title: typeof v.title === 'string' ? v.title : '',
      created: typeof v.created === 'number' ? v.created : null,
      play: typeof v.play === 'number' ? v.play : null,
      length: typeof v.length === 'string' ? v.length : null,
      pic: normalizePic(v.pic),
      collected: false,
    });
  }
  const channelId = typeof data.channel_id === 'string' && data.channel_id ? data.channel_id : null;
  const channelName = typeof data.channel_name === 'string' && data.channel_name ? data.channel_name : null;
  if (channelId) {
    const exists = db.prepare("SELECT 1 FROM creators WHERE source = 'youtube' AND source_uid = ?").get(channelId);
    if (!exists) {
      const now = Date.now();
      db.prepare('INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('youtube', channelId, channelName, now, now);
    }
  }
  markCollected(db, items, 'youtube');
  return { total: typeof data.total === 'number' ? data.total : items.length, items, channel: { id: channelId, name: channelName } };
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
  const clientId = (pool[0] ?? clients[0]).client_id;

  // 平台分派：YouTube 一次全量回执（扩展内分页），B 站走下方逐页循环
  if (query.source === 'youtube') return expandYtChannelVideos(db, query.ident, reqCmd, clientId);

  const mid = query.mid;
  const items: UpperVideoItem[] = [];
  const seen = new Set<string>(); // bvid 去重（页间新投稿导致分页位移重叠时防重复）
  let total = 0;
  let noNewStreak = 0; // 连续整页无新视频的页数（≥3 判定分页停滞/重叠死循环，终止）
  for (let page = 1; ; page++) {
    // 契约对齐 background.js list-upper-videos action：读 msg.page / msg.page_size（曾误用 pn/ps
    // 导致扩展每页都回落第 1 页、列表整页重复 N 遍 —— 2026-08-19 回归修复）
    const r = await reqCmd(clientId, 'list-upper-videos', { mid, page, page_size: 30 }, UPPER_PAGE_TIMEOUT_MS);
    if (!r.ok) throw new Error(r.code === 'offline' ? '扩展离线（拉取中断）' : '扩展执行超时');
    const result = r.result ?? {};
    if (result.ok === false) throw new Error(String(result.error ?? 'list-upper-videos 失败'));
    const data = result.data ?? {};
    const pageItems: Array<{ bvid?: unknown; title?: unknown; created?: unknown; play?: unknown; length?: unknown; pic?: unknown }> = Array.isArray(data.items) ? data.items : [];
    total = typeof data.total === 'number' ? data.total : items.length + pageItems.length;
    let added = 0;
    for (const v of pageItems) {
      if (typeof v?.bvid !== 'string' || seen.has(v.bvid)) continue;
      seen.add(v.bvid);
      added++;
      items.push({
        bvid: v.bvid,
        title: typeof v.title === 'string' ? v.title : '',
        created: typeof v.created === 'number' ? v.created : null,
        play: typeof v.play === 'number' ? v.play : null,
        length: typeof v.length === 'string' ? v.length : null,
        pic: normalizePic(v.pic),
        collected: false,
      });
    }
    if (pageItems.length === 0 || items.length >= total) break;
    noNewStreak = added > 0 ? 0 : noNewStreak + 1;
    if (noNewStreak >= 3) break; // 整页重复连续 3 页：分页停滞（重叠/回落），保已拉部分终止
    await sleep(gap); // 页间节流防风控
  }

  markCollected(db, items, 'bilibili');
  return { total, items };
}

export function getTask(db: Database.Database, id: number): CollectTask | null {
  const row = db.prepare(TASK_WITH_TITLE).get(id) as CollectTask | undefined;
  return row ?? null;
}

// 任务状态推送：各落库点（createTask / dispatchTask / amend 改判）之后广播整行（含 title）。
// popup 快照 + 兜底轮询补推送盲区（旧 server / popup 关闭期间），此处只管把变化及时发出去。
// 批次任务附加 batch_total（同批成员总数）：批次成员被 >limit 新任务挤出列表窗口时，popup
// 只能靠 TASK_UPDATE 流入的成员聚合，无总量则分母低估（60 条批次显示 3/3）。
export function pushTask(db: Database.Database, id: number): void {
  const task = getTask(db, id);
  if (!task) return;
  if (task.batch_id) {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM collect_tasks WHERE batch_id = ?').get(task.batch_id) as { n: number }).n;
    getWsBridge().broadcastEvent({ type: 'task-update', task: { ...task, batch_total: n } });
    return;
  }
  getWsBridge().broadcastEvent({ type: 'task-update', task });
}

// 删除任务（采集页删除按钮）。任意状态可删：dispatched 删除后扩展回执的 UPDATE 不命中行,no-op 无副作用。
// 删除后广播 task-delete（popup 列表移除该行）。载荷用 taskId 不用顶层 id：旧扩展（359fd97 之前）
// background 对带 id 的消息一律回 "unknown action" 失败回执（噪音 + needs_update 误导），
// 无顶层 id 则被其 !msg.id 守卫静默忽略（与 task-update 一致）。
export function deleteTask(db: Database.Database, id: number): boolean {
  const deleted = db.prepare('DELETE FROM collect_tasks WHERE id = ?').run(id).changes > 0;
  if (deleted) getWsBridge().broadcastEvent({ type: 'task-delete', taskId: id });
  return deleted;
}

// ── 重试（2026-08-22 原地重置，取代「重试建新任务并入原批」方案）──
// failed/limited 任务行重置回 pending 重跑：不建新行——原任务行状态直接 failed→pending→succeeded,
// 批次聚合卡/聚焦视图/进度徽章随该行实时更新。仅终态未成功可重置：succeeded 重采走建新任务
// （保留成功历史）;pending/dispatched 在途不可重入。error/result/finished_at/client_id 一并清空。
// 查库短路（同日）：重试前先查该视频库内字幕轨数——已有轨（此前采集实际成功落库,只是回执迟到/
// 改判前还挂 failed/limited）→ 直接置 succeeded（result 带 already_collected + 轨数）不重采；
// 无轨（limited=0 轨入库,failed 可能未入库）才重置 pending 重新采集。
export function retryTask(db: Database.Database, id: number): CollectTask | null {
  const task = db.prepare('SELECT * FROM collect_tasks WHERE id = ?').get(id) as CollectTask | undefined;
  if (!task || (task.status !== 'failed' && task.status !== 'limited')) return null; // 不存在/非可重试：静默跳过
  const tracks = (db.prepare(
    'SELECT COUNT(*) AS n FROM subtitle_tracks st JOIN videos v ON v.id = st.video_id WHERE v.source = ? AND v.source_vid = ?',
  ).get(task.source, task.source_vid) as { n: number }).n;
  if (tracks > 0) {
    db.prepare("UPDATE collect_tasks SET status = 'succeeded', error = NULL, result = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify({ reason: 'already_collected', tracks }), Date.now(), id);
  } else {
    // client_id 保留（不清）：上次执行者线索——重试优先派回原扩展（各扩展环境/登录态不同,
    // 换机重跑结果可能漂移）;派发时 dispatchTask 会覆盖为实际执行者
    db.prepare(
      "UPDATE collect_tasks SET status = 'pending', error = NULL, result = NULL, finished_at = NULL WHERE id = ?",
    ).run(id);
  }
  pushTask(db, id);
  return getTask(db, id);
}

// 任务列表筛选（2026-08-22 历史页多维查询）。UP 归属双来源：任务行冗余列 t.creator_uid
// （批量提交已知 / 建任务查库回填 / ingest 回填——未入库任务也能筛）+ 入库后 v→creators；
// q 是入库元数据维度（标题），但 vid 段匹配 t.source_vid 覆盖未入库任务（按 BV 号找任务）；
// status/source/since/until/batchId 全走 t.* 列，覆盖全部任务。
export interface TaskListFilter {
  status?: readonly TaskStatus[];
  source?: 'bilibili' | 'youtube';
  batchId?: string;
  batchScope?: 'batch' | 'single'; // 批量/单点档：batch=batch_id 非空（批量提交），single=空（单条/旧任务）
  creator?: string;    // UP 名模糊（归属关联的 creators.name LIKE）
  creatorUid?: string; // UP mid/channelId 精确（t.creator_uid 冗余列或入库归属）
  q?: string;          // 库内标题模糊（videos.title LIKE）+ vid 段匹配（t.source_vid LIKE，搜 BV 号）
  since?: number;      // created_at 毫秒下界（含）
  until?: number;      // created_at 毫秒上界（含）
}

// 任务列表(采集页最近 N 条 / 历史页分页+多维筛选共用)。
// 批次补全:limit/offset 与全部筛选只限制种子行,种子涉及的批次成员全量带出——展示侧聚合要完整成员
// 才算得出「n/m 完成」进度;筛选同样只作用于种子(补全跨筛选/跨状态拉齐整批,分组完整)。
export function listTasks(
  db: Database.Database, limit = 20, offset = 0, filter: TaskListFilter = {},
  sort: TaskSortKey = 'created_at', desc = true,
): { total: number; items: CollectTask[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.status?.length) {
    conds.push(`t.status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  }
  if (filter.source) { conds.push('t.source = ?'); params.push(filter.source); }
  if (filter.batchId) { conds.push('t.batch_id = ?'); params.push(filter.batchId); }
  if (filter.batchScope === 'batch') conds.push('t.batch_id IS NOT NULL');
  if (filter.batchScope === 'single') conds.push('t.batch_id IS NULL');
  if (filter.creator) {
    conds.push('(ct.name LIKE ? OR c.name LIKE ?)');
    params.push(`%${filter.creator}%`, `%${filter.creator}%`);
  }
  if (filter.creatorUid) {
    conds.push('(t.creator_uid = ? OR v.creator_id IN (SELECT id FROM creators WHERE source_uid = ?))');
    params.push(filter.creatorUid, filter.creatorUid);
  }
  if (filter.q) {
    conds.push('(v.title LIKE ? OR t.source_vid LIKE ?)');
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  if (filter.since != null) { conds.push('t.created_at >= ?'); params.push(filter.since); }
  if (filter.until != null) { conds.push('t.created_at <= ?'); params.push(filter.until); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // total 与 seed 同 FROM/WHERE（筛选条件引用 v./c. 列时 total 也必须 join；LEFT JOIN 单行不扇出,COUNT 语义不变）
  const total = (db.prepare(
    `SELECT COUNT(*) AS n ${TASK_JOINS} ${where}`,
  ).get(...params) as { n: number }).n;
  const seed = db.prepare(`
    ${TASK_SELECT}
    ${where}
    ${buildOrderBy(`t.${sort}`, desc, { nullable: sort === 'finished_at', tieExpr: 't.id' })} LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as CollectTask[];
  const batchIds = [...new Set(seed.map((r) => r.batch_id).filter((b): b is string => b != null))];
  let items = seed;
  if (batchIds.length > 0) {
    const members = db.prepare(`
      ${TASK_SELECT}
      WHERE t.batch_id IN (${batchIds.map(() => '?').join(',')})
    `).all(...batchIds) as CollectTask[];
    const seen = new Set(seed.map((r) => r.id));
    items = [...seed, ...members.filter((r) => !seen.has(r.id))]
      .sort((a, b) => cmpBySortKey(a, b, sort, desc, 'id')); // 补全成员并入后按排序键重排（镜像 SQL 语义）
  }
  return { total, items };
}

// server 重启恢复：dispatched（无回执）重置回 pending，让调度器重新派发
export function resetDispatched(db: Database.Database): void {
  db.prepare("UPDATE collect_tasks SET status = 'pending', client_id = NULL WHERE status = 'dispatched'").run();
}

// ── 调度器：事件驱动派发 + 兜底轮询 ──
// 单进程内运行（对齐现有架构：单 server 进程 + SQLite 同步事务，不引入队列）。
// 派发策略：
//   - 每次触发（建任务 / 扩展上线 / 轮询）扫 pending 队列（按创建顺序）；
//   - 客户端归属（2026-08-21，多客户端 sticky）：任务带 creator_client_id 且创建者在线 →
//     只派给创建者（忙则本轮跳过等待，不给别的客户端弹采集页）；
//   - 上次执行者优先（2026-08-22，软偏好）：无创建者归属时优先派回 client_id 记录的原
//     执行者（重试不换环境——各扩展登录态不同,换机重跑结果可能漂移）;原执行者忙/离线 →
//     任意空闲客户端；
//   - 串行：同 client 同时只派 1 个任务（inFlight 集合）,防风控对齐 CLI 采集的 sleep 思路。

// inFlight 状态在 ./inflight.ts（ws/server 连接 close 时释放，避免循环 import）
// ws 能力（listClients/requestCommand/broadcastEvent）经 ./wsBridge.ts 间接取（分层不上跳 ws/）

// 任务 → 派发目标（纯函数供测试）。四态：
//   { clientId }  派给它；'wait'  创建者在线但忙（本轮跳过，留给创建者）；null  无任何空闲客户端。
// 优先级：创建者 > 上次执行者 > 任意空闲。
//   - 创建者（2026-08-21 sticky）：任务带 creator_client_id 且创建者在线 → 只派给创建者
//     （忙则 wait，不给别的客户端弹采集页）；
//   - 上次执行者（2026-08-22 软偏好）：重试/重新派发优先回到原扩展——各扩展环境/登录态不同,
//     换机重跑同一视频结果可能漂移（实测 h4xhid52 抓到轨、换 8n2g7ny3 重跑变 pot_limited）;
//     原执行者在线且空闲才选它,忙则回落任意空闲（软偏好不 wait,不空转——创建者是任务主人
//     才值得等,执行者只是环境偏好）；
//   - 任务派发池（2026-08-23 仅上报状态）：task_dispatch_enabled=false 的客户端不入池,
//     三级选择全在池内进行。创建者仅上报 → 视同不可派（与离线同语义,回落他人不 wait——
//     用户关接任务的意图就是「别在我这台跑」）；全池空 → null（任务留 pending,对齐扩展
//     全离线行为）。字段缺省视为接受（旧扩展 hello 不带,fail-open）。
export function pickClientForTask(
  task: Pick<CollectTask, 'creator_client_id' | 'client_id'>,
  clients: ReadonlyArray<{ client_id: string; task_dispatch_enabled?: boolean }>,
  inFlight: ReadonlyMap<string, number>,
): { clientId: string } | 'wait' | null {
  const pool = clients.filter((c) => c.task_dispatch_enabled !== false);
  if (task.creator_client_id) {
    const creator = pool.find((c) => c.client_id === task.creator_client_id);
    if (creator) return inFlight.has(creator.client_id) ? 'wait' : { clientId: creator.client_id };
  }
  if (task.client_id) {
    const last = pool.find((c) => c.client_id === task.client_id && !inFlight.has(c.client_id));
    if (last) return { clientId: last.client_id };
  }
  const free = pool.find((c) => !inFlight.has(c.client_id));
  return free ? { clientId: free.client_id } : null;
}

// 「扩展版本过旧」分类（2026-08-21）：server 升级新增 action 后，旧扩展不认识 → 回执失败。
// 判据按回执内容（两种形态）：旧扩展回 "unknown action: <action>" 字符串；新扩展对未知 action
// 显式带 needs_update:true（回执顶层或 data 内）。不做 hello 能力协商表——单一错误路径不值得
// 引入版本协商状态，hello 的 ext_version 保持仅日志展示；错误内容分类已足够定位。
// 提示语区分于普通采集失败（need_login 等）：此错指向更新扩展而非重试。
const EXT_NEEDS_UPDATE_ERROR = '扩展版本过旧，请更新扩展后重试';
function extNeedsUpdate(result: { error?: unknown; data?: unknown; needs_update?: unknown } | undefined): boolean {
  if (result?.needs_update === true) return true;
  if (typeof result?.error === 'string' && result.error.includes('unknown action')) return true;
  const data = result?.data;
  return typeof data === 'object' && data !== null && (data as { needs_update?: unknown }).needs_update === true;
}

export function attachTaskScheduler(db: Database.Database): void {
  resetDispatched(db); // 启动恢复

  const dispatch = async () => {
    const clients = getWsBridge().listClients();
    if (clients.length === 0) return; // 无扩展在线：任务留 pending
    const pendingRows = db.prepare(
      "SELECT * FROM collect_tasks WHERE status = 'pending' ORDER BY id ASC",
    ).all() as CollectTask[];
    for (const task of pendingRows) {
      const pick = pickClientForTask(task, clients, inFlight);
      if (pick === 'wait') continue; // 创建者在线但忙：留给创建者，不给别的客户端
      if (pick === null) break;      // 全忙，等下一个事件/轮询
      await dispatchTask(db, task.id, pick.clientId);
    }
  };

  const dispatchTask = async (db2: Database.Database, taskId: number, clientId: string) => {
    const task = getTask(db2, taskId);
    if (!task || task.status !== 'pending') return;
    inFlight.set(clientId, taskId);
    db2.prepare("UPDATE collect_tasks SET status = 'dispatched', client_id = ? WHERE id = ? AND status = 'pending'").run(clientId, taskId);
    pushTask(db2, taskId);
    const action = task.source === 'bilibili' ? 'fetch-subtitle' : 'fetch-youtube-subtitle';
    // youtube：无进展窗口随命令下发（settings.collect_timeout_ms 可配;旧扩展忽略未知字段回落内置 45s）
    const timeouts = getCollectTimeout(db2);
    const params = task.source === 'bilibili'
      ? { bvid: task.source_vid }
      : { videoId: task.source_vid, timeout_ms: timeouts.youtube };
    const r = await getWsBridge().requestCommand(clientId, action, params, commandTimeoutMs(task.source, timeouts));
    if (r.ok && r.result?.ok) {
      const data = r.result.data ?? {};
      // 字幕受限（pot_limited：扩展全轨 body 为空，0 轨入库，元信息已入库）→ limited 终态：
      // 执行本身成功但产出受限，区别于 succeeded（展示「受限」而非「已完成」，允许重试重采）。
      const status = data?.reason === 'pot_limited' ? 'limited' : 'succeeded';
      db2.prepare("UPDATE collect_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?")
        .run(status, JSON.stringify(data), Date.now(), taskId);
      pushTask(db2, taskId);
      // 确认无字幕（两平台回执均回 reason=no_subtitle）→ 打 no-subtitle 系统标（远期 ASR 定位锚点；
      // 视频元信息行已由扩展 ingest 先行落库，打标必命中）。失败静默——状态行已更新，标可回填。
      if (data?.reason === 'no_subtitle') {
        try { markNoSubtitle(db2, { source: task.source, source_vid: task.source_vid }); } catch { /* 回填补 */ }
      }
    } else {
      // 失败分类：未收到回执（offline/timeout）→ 连接层文案；收到失败回执 →
      // 扩展版本过旧（needs_update 分类，提示更新而非重试）/ 普通失败（扩展 error 原文）
      const error = !r.ok
        ? (r.code === 'offline' ? '扩展离线' : '扩展执行超时')
        : extNeedsUpdate(r.result) ? EXT_NEEDS_UPDATE_ERROR
        : String(r.result?.error ?? '采集失败');
      db2.prepare("UPDATE collect_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(error, Date.now(), taskId);
      pushTask(db2, taskId);
    }
    // 条件删除（竞态防串行失效）：断线重连链 close → releaseClient 清占位 → 重连 → 新任务 t2
    // 派给同 client 后，t1 超时收尾若无条件 delete 会错删 t2 的占位 → 同 client 双开任务。
    // 占位属于哪个任务，值就在 map 里，只删自己的。
    if (inFlight.get(clientId) === taskId) inFlight.delete(clientId);
    dispatch(); // 派完一个立即尝试下一个（串行链式）
  };

  // 兜底轮询（防事件遗漏）
  const timer = setInterval(dispatch, SWEEP_MS);
  timer.unref();

  taskSchedulerKick = () => { void dispatch(); };
}

// 模块级引用：HTTP handler 建任务后 kick 调度器（单 server 进程单调度器,全局足够）
let taskSchedulerKick: (() => void) | null = null;
export function kickTaskScheduler(): void {
  taskSchedulerKick?.();
}

// 扩展 WS 上线时也 kick（ws/server.ts hello 握手成功后调用）
export function notifyClientOnline(): void {
  taskSchedulerKick?.();
}
