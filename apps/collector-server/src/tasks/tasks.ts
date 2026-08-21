import type Database from 'better-sqlite3';
import { listClients, requestCommand } from '../ws/server.js';

// ── 采集任务系统：手机/网页提交 → server 派发给桌面扩展 → 扩展采集回执 ──
// 设计依据：docs/superpowers/specs/2026-08-13-mobile-collect-task-design.md
// 状态机：pending → dispatched → succeeded | failed
// 批量扩展（2026-08-19）：docs/superpowers/specs/2026-08-19-upper-all-videos-batch-design.md

export type TaskStatus = 'pending' | 'dispatched' | 'succeeded' | 'failed';

export interface CollectTask {
  id: number;
  source: 'bilibili' | 'youtube';
  source_vid: string;
  url: string;
  status: TaskStatus;
  client_id: string | null;
  error: string | null;
  result: string | null;
  title: string | null; // 库内视频标题（LEFT JOIN videos；采集页直接展示,未入库为 null）
  created_at: number;
  finished_at: number | null;
}

// 任务行 + 库内视频标题（videos 有 UNIQUE(source, source_vid),JOIN 不扇出）
const TASK_WITH_TITLE = `
  SELECT t.*, v.title AS title
  FROM collect_tasks t
  LEFT JOIN videos v ON v.source = t.source AND v.source_vid = t.source_vid
  WHERE t.id = ?
`;

// 单任务在扩展侧最长执行时间（导航加载页面 + 采字幕 + 汇总），对齐 B 站 navigate 采集 20s + 余量
const COMMAND_TIMEOUT_MS = 60_000;
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

export function createTask(db: Database.Database, target: ParsedTarget): CollectTask {
  const now = Date.now();
  const info = db.prepare(
    'INSERT INTO collect_tasks (source, source_vid, url, status, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(target.source, target.source_vid, target.url, 'pending', now);
  return getTask(db, Number(info.lastInsertRowid))!;
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
): { created: CollectTask[]; skipped: string[] } {
  const re = VID_RE[source];
  const urlFor = (vid: string) =>
    source === 'youtube' ? `https://www.youtube.com/watch?v=${vid}` : `https://www.bilibili.com/video/${vid}`;
  const created: CollectTask[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const vid of Array.isArray(vids) ? vids : []) {
    if (typeof vid !== 'string' || !re.test(vid) || seen.has(vid)) continue;
    seen.add(vid);
    const active = db.prepare(
      'SELECT 1 FROM collect_tasks WHERE source = ? AND source_vid = ? AND status IN (?, ?)',
    ).get(source, vid, 'pending', 'dispatched');
    if (active) { skipped.push(vid); continue; }
    created.push(createTask(db, { source, source_vid: vid, url: urlFor(vid) }));
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

// 删除任务（采集页删除按钮）。任意状态可删：dispatched 删除后扩展回执的 UPDATE 不命中行,no-op 无副作用。
export function deleteTask(db: Database.Database, id: number): boolean {
  return db.prepare('DELETE FROM collect_tasks WHERE id = ?').run(id).changes > 0;
}

export function listTasks(db: Database.Database, limit = 20): { total: number; items: CollectTask[] } {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM collect_tasks').get() as { n: number }).n;
  const items = db.prepare(`
    SELECT t.*, v.title AS title
    FROM collect_tasks t
    LEFT JOIN videos v ON v.source = t.source AND v.source_vid = t.source_vid
    ORDER BY t.id DESC LIMIT ?
  `).all(limit) as CollectTask[];
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
//   - 扩展按平台选择：bilibili → 任意在线扩展（现网仅一台）；youtube → 同样任意（扩展是同一只,能力内置）。
//     多台扩展的路由留待后续（YAGNI,单台起步）;
//   - 串行：同 client 同时只派 1 个任务（inFlight 集合）,防风控对齐 CLI 采集的 sleep 思路。

const inFlight = new Map<string, number>(); // client_id -> task_id（同时每扩展只跑 1 任务）

export function attachTaskScheduler(db: Database.Database): void {
  resetDispatched(db); // 启动恢复

  const dispatch = async () => {
    const clients = listClients();
    if (clients.length === 0) return; // 无扩展在线：任务留 pending
    const pendingRows = db.prepare(
      "SELECT * FROM collect_tasks WHERE status = 'pending' ORDER BY id ASC",
    ).all() as CollectTask[];
    for (const task of pendingRows) {
      // 选一台空闲扩展（暂不分平台路由：单台扩展同时具备 B 站 + YouTube 采集能力）
      const free = clients.find((c) => !inFlight.has(c.client_id));
      if (!free) break; // 全忙,等下一个事件/轮询
      await dispatchTask(db, task.id, free.client_id);
    }
  };

  const dispatchTask = async (db2: Database.Database, taskId: number, clientId: string) => {
    const task = getTask(db2, taskId);
    if (!task || task.status !== 'pending') return;
    inFlight.set(clientId, taskId);
    db2.prepare("UPDATE collect_tasks SET status = 'dispatched', client_id = ? WHERE id = ? AND status = 'pending'").run(clientId, taskId);
    const action = task.source === 'bilibili' ? 'fetch-subtitle' : 'fetch-youtube-subtitle';
    const params = task.source === 'bilibili' ? { bvid: task.source_vid } : { videoId: task.source_vid };
    const r = await requestCommand(clientId, action, params, COMMAND_TIMEOUT_MS);
    if (r.ok && r.result?.ok) {
      const data = r.result.data ?? {};
      db2.prepare("UPDATE collect_tasks SET status = 'succeeded', result = ?, finished_at = ? WHERE id = ?")
        .run(JSON.stringify(data), Date.now(), taskId);
    } else {
      const error = !r.ok
        ? (r.code === 'offline' ? '扩展离线' : '扩展执行超时')
        : String(r.result?.error ?? '采集失败');
      db2.prepare("UPDATE collect_tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(error, Date.now(), taskId);
    }
    inFlight.delete(clientId);
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
