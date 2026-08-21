import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { listClients, requestCommand, broadcastEvent } from '../ws/server.js';
import { inFlight } from './inflight.js';

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
const TASK_SELECT = `SELECT t.*, v.title AS title, COALESCE(c.name, ct.name) AS creator_name ${TASK_JOINS}`;

// 任务行 + 库内视频标题（videos 有 UNIQUE(source, source_vid),JOIN 不扇出）
const TASK_WITH_TITLE = `${TASK_SELECT} WHERE t.id = ?`;

// 单任务在扩展侧的执行预算（按平台分档）——须覆盖扩展全链路（导航加载 + 多请求 + 宽限 + 关 tab 间隔），
// 超时早于扩展实际完成会落假失败（扩展仍在跑并落库，任务页却显示失败，用户重试 = 重复采集）。
// bilibili：navigate ~20s + view/tags/player 拉取；youtube：后台 tab + 45s 自限 + 8s 宽限 + 关 tab 间隔。
export function commandTimeoutMs(source: 'bilibili' | 'youtube'): number {
  return source === 'youtube' ? 180_000 : 90_000;
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
): { created: CollectTask[]; skipped: string[] } {
  const re = VID_RE[source];
  const urlFor = (vid: string) =>
    source === 'youtube' ? `https://www.youtube.com/watch?v=${vid}` : `https://www.bilibili.com/video/${vid}`;
  // 同批共享一个 batch_id：纯展示侧聚合标签（UI 分组成一个批量任务），无批次实体/状态
  const batchId = randomUUID();
  const created: CollectTask[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const vid of Array.isArray(vids) ? vids : []) {
    if (typeof vid !== 'string' || !re.test(vid) || seen.has(vid)) continue;
    seen.add(vid);
    if (findActiveTask(db, source, vid)) { skipped.push(vid); continue; }
    created.push(createTask(db, { source, source_vid: vid, url: urlFor(vid) }, creatorClientId, batchId, creatorUid));
  }
  return { created, skipped };
}

// ── UP 全部视频列表（web 端「按 UP 批量」用，server 经扩展 WS 代理拉取）──
// server 不直连 B 站（无浏览器 cookie/wbi 环境且数据中心 IP 易风控），分页循环复用扩展的
// list-upper-videos action（background.js arc/search 封装），页间节流对齐 popup 全量拉取的 500ms。
export interface UpperVideoItem {
  bvid: string;
  title: string;
  created: number | null;
  play: number | null;
  length: string | null; // arc/search 原样 "MM:SS" / "HH:MM:SS"
  pic: string | null;    // 封面 URL（"//" 协议头相对形式归一为 https:）
  collected: boolean;    // 已入库（videos 表命中）
}

// 封面 URL 归一：arc/search 的 pic 常为 "//i2.hdslb.com/..." 协议头相对形式，补 https:
function normalizePic(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  return p.startsWith('//') ? `https:${p}` : p;
}

// 依赖注入（测试 mock 用）；生产默认真 WS 实现。
export interface UpperExpandDeps {
  listClients?: () => Array<{ client_id: string }>;
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

export async function expandUpperVideos(
  db: Database.Database,
  mid: string,
  deps: UpperExpandDeps = {},
): Promise<{ total: number; items: UpperVideoItem[] }> {
  const lsClients = deps.listClients ?? listClients;
  const reqCmd = deps.requestCommand ?? requestCommand;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gap = deps.pageGapMs ?? 500;

  const clients = lsClients();
  if (clients.length === 0) throw new Error('扩展离线：UP 视频列表需经桌面扩展拉取（连上扩展后重试）');
  const clientId = clients[0].client_id;

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

  // 标注已采：videos 表 source_vid IN 分批查（SQLite 绑定变量上限兜底 chunk 500）
  for (let i = 0; i < items.length; i += 500) {
    const chunk = items.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${ph})`,
    ).all(...chunk.map((x) => x.bvid)) as Array<{ source_vid: string }>;
    const hit = new Set(rows.map((row) => row.source_vid));
    for (const it of chunk) it.collected = hit.has(it.bvid);
  }
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
    broadcastEvent({ type: 'task-update', task: { ...task, batch_total: n } });
    return;
  }
  broadcastEvent({ type: 'task-update', task });
}

// 删除任务（采集页删除按钮）。任意状态可删：dispatched 删除后扩展回执的 UPDATE 不命中行,no-op 无副作用。
// 删除后广播 task-delete（popup 列表移除该行）。载荷用 taskId 不用顶层 id：旧扩展（359fd97 之前）
// background 对带 id 的消息一律回 "unknown action" 失败回执（噪音 + needs_update 误导），
// 无顶层 id 则被其 !msg.id 守卫静默忽略（与 task-update 一致）。
export function deleteTask(db: Database.Database, id: number): boolean {
  const deleted = db.prepare('DELETE FROM collect_tasks WHERE id = ?').run(id).changes > 0;
  if (deleted) broadcastEvent({ type: 'task-delete', taskId: id });
  return deleted;
}

// 任务列表筛选（2026-08-22 历史页多维查询）。UP 归属双来源：任务行冗余列 t.creator_uid
// （批量提交已知 / 建任务查库回填 / ingest 回填——未入库任务也能筛）+ 入库后 v→creators；
// q 是入库元数据维度（标题），但 vid 段匹配 t.source_vid 覆盖未入库任务（按 BV 号找任务）；
// status/source/since/until/batchId 全走 t.* 列，覆盖全部任务。
export interface TaskListFilter {
  status?: readonly TaskStatus[];
  source?: 'bilibili' | 'youtube';
  batchId?: string;
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
  db: Database.Database,
  limit = 20,
  offset = 0,
  filter: TaskListFilter = {},
): { total: number; items: CollectTask[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.status?.length) {
    conds.push(`t.status IN (${filter.status.map(() => '?').join(',')})`);
    params.push(...filter.status);
  }
  if (filter.source) { conds.push('t.source = ?'); params.push(filter.source); }
  if (filter.batchId) { conds.push('t.batch_id = ?'); params.push(filter.batchId); }
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
    ORDER BY t.id DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as CollectTask[];
  const batchIds = [...new Set(seed.map((r) => r.batch_id).filter((b): b is string => b != null))];
  let items = seed;
  if (batchIds.length > 0) {
    const members = db.prepare(`
      ${TASK_SELECT}
      WHERE t.batch_id IN (${batchIds.map(() => '?').join(',')})
    `).all(...batchIds) as CollectTask[];
    const seen = new Set(seed.map((r) => r.id));
    items = [...seed, ...members.filter((r) => !seen.has(r.id))].sort((a, b) => b.id - a.id);
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
//     只派给创建者（忙则本轮跳过等待，不给别的客户端弹采集页）；创建者离线或无归属
//     （CLI/旧任务）→ 任意空闲客户端；
//   - 串行：同 client 同时只派 1 个任务（inFlight 集合）,防风控对齐 CLI 采集的 sleep 思路。

// inFlight 状态在 ./inflight.ts（ws/server 连接 close 时释放，避免循环 import）

// 任务 → 派发目标（纯函数供测试）。三态：
//   { clientId }  派给它；'wait'  创建者在线但忙（本轮跳过，留给创建者）；null  无任何空闲客户端。
export function pickClientForTask(
  task: Pick<CollectTask, 'creator_client_id'>,
  clients: ReadonlyArray<{ client_id: string }>,
  inFlight: ReadonlyMap<string, number>,
): { clientId: string } | 'wait' | null {
  if (task.creator_client_id) {
    const creator = clients.find((c) => c.client_id === task.creator_client_id);
    if (creator) return inFlight.has(creator.client_id) ? 'wait' : { clientId: creator.client_id };
  }
  const free = clients.find((c) => !inFlight.has(c.client_id));
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
    const clients = listClients();
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
    const params = task.source === 'bilibili' ? { bvid: task.source_vid } : { videoId: task.source_vid };
    const r = await requestCommand(clientId, action, params, commandTimeoutMs(task.source));
    if (r.ok && r.result?.ok) {
      const data = r.result.data ?? {};
      // 字幕受限（pot_limited：扩展全轨 body 为空，0 轨入库，元信息已入库）→ limited 终态：
      // 执行本身成功但产出受限，区别于 succeeded（展示「受限」而非「已完成」，允许重试重采）。
      const status = data?.reason === 'pot_limited' ? 'limited' : 'succeeded';
      db2.prepare("UPDATE collect_tasks SET status = ?, result = ?, finished_at = ? WHERE id = ?")
        .run(status, JSON.stringify(data), Date.now(), taskId);
      pushTask(db2, taskId);
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

  // 暴露手动触发（HTTP handler 建任务后调用；单 server 进程单调度器,全局引用足够）
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
