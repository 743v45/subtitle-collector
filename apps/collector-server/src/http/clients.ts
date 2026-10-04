import { type IncomingMessage, type ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listClients, requestReportingChange, requestTaskDispatchChange, requestCommand } from '../ws/server.js';
import { CLIENT_SORT_KEYS, type ClientSortKey } from '../db/clients.js';
import { json, readJsonBody, parseSortParams } from './http-util.js';

// reporting / task-dispatch 两开关端点的同构处理（2026-08-23 抽出，降 handleClientsHttp 复杂度）：
// 校验 enabled 布尔 → 调切换函数 → 404 离线 / 504 回执超时 / 200 新状态三态。
// 成功体 {ok, client_id, ...切换函数返回的新状态字段}（reporting_enabled / task_dispatch_enabled）。
type ToggleResult = { ok: true } & Record<string, unknown> | { ok: false; code: 'offline' | 'timeout' };
async function handleTogglePost(
  res: ServerResponse,
  clientId: string,
  body: unknown,
  toggle: (clientId: string, enabled: boolean) => Promise<ToggleResult>,
): Promise<void> {
  if (typeof (body as { enabled?: unknown } | null)?.enabled !== 'boolean') {
    json(res, 400, { ok: false, error: 'enabled must be boolean' });
    return;
  }
  const r = await toggle(clientId, (body as { enabled: boolean }).enabled);
  if (!r.ok) {
    if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
    json(res, 504, { ok: false, error: 'extension result timeout' }); return;
  }
  json(res, 200, { client_id: clientId, ...r }); // r 含 ok:true + 新状态字段（reporting_enabled / task_dispatch_enabled）
}

// GET /api/clients 列表：全量视图（DB 注册表含离线 + 在线态合并）+ 排序参数。
// 抽出降 handleClientsHttp 圈复杂度（2026-08-25 排序分支并入后主函数超标恶化）。
function handleListClients(res: ServerResponse, url: URL, db: Database.Database): void {
  // sort：last_seen（默认）/first_seen/name；非法 → 400；desc 缺省 true（最近活跃在前 = 现状）
  const sp = parseSortParams(url.searchParams, CLIENT_SORT_KEYS, 'last_seen');
  if ('error' in sp) { json(res, 400, { ok: false, error: sp.error }); return; }
  json(res, 200, { ok: true, clients: listClients(db, sp.sort as ClientSortKey, sp.desc) });
}

// ── /command 收紧（C6）：action 白名单 + navigate 目标 URL 校验（纯函数供测试）──

// action 白名单：以扩展 background.js 消息分发的 case 全集为准（实查 14 个，2026-10-04）。
// 白名单外 action → HTTP 400（参数错误），不走 needs_update 语义——needs_update 表示
// 「server 比扩展新、该升级扩展」（扩展回执 unknown action），而白名单拒绝是「该 action
// 根本不该出现在请求里」（打字错/探测/滥用），两者提示方向不同。
export const COMMAND_ACTIONS: readonly string[] = [
  'navigate', 'operate', 'search',
  'fetch-subtitle', 'fetch-youtube-subtitle', 'fetch-douyin-subtitle', 'expand-douyin-upper',
  'get-upper-info', 'list-upper-videos', 'list-yt-channel-videos', 'yt-search', 'list-season-videos',
  'set-reporting', 'set-task-dispatch',
];

export function isAllowedCommandAction(action: string): boolean {
  return COMMAND_ACTIONS.includes(action);
}

// navigate 目标 host 白名单族：等于白名单域或以其为子域后缀（bilibili.com 主站视频/搜索/空间页
// 都放行；口径对齐 tasks.ts VIDEO_URL_HOSTS 的平台域约束，用后缀族表达以覆盖 www./m./space. 等子域）。
// 扩展端同款 navigate 兜底校验见 apps/subtitle-collector/navigate-guard.mjs——depcruise 禁跨 app
// import，两端各自实现但保持同一份清单字面量（注释互指），改动须两端同步。
const NAVIGATE_HOST_SUFFIXES: readonly string[] = ['bilibili.com', 'youtube.com', 'douyin.com'];

// navigate 参数校验：url 必须存在、协议 http(s)、host 在白名单族。不满足返回 {ok:false, error}（调用方 400）。
export function validateNavigateUrl(url: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'navigate requires url (non-empty string)' };
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, error: `navigate url not a valid URL: ${url}` }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, error: `navigate url protocol must be http(s): ${url}` };
  }
  const host = u.hostname.toLowerCase();
  const ok = NAVIGATE_HOST_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) return { ok: false, error: `navigate url host not allowed: ${u.hostname}（允许 ${NAVIGATE_HOST_SUFFIXES.join('/')} 及其子域）` };
  return { ok: true };
}

// 下发命令端点的 body 校验 + 派发（自 handleClientsHttp 抽出，2026-10-04 C6 加白名单/host 校验时
// 防主函数圈复杂度恶化；对齐 handleTogglePost 的抽出先例）。
// 错误码语义（2026-08-21 收敛为「HTTP 状态即结果」，对齐 expand 的 503 / reporting 的 404·504）：
//   400 action 白名单外 / navigate 参数非法（server 侧参数校验，先于在线判定——离线也不放行坏参数）
//   404 客户端离线 / 504 回执超时 / 502 扩展执行失败（下游执行体失败，error = 扩展回执 error 原文）。
// 成功 200 的 result 直接是扩展回执 data（去掉 {ok,data} 一层包装，外层 ok 即终判）——
// CLI 不再需要层层挖 result.ok/result.error。
async function handleCommandPost(res: ServerResponse, clientId: string, body: unknown): Promise<void> {
  if (typeof (body as { action?: unknown } | null)?.action !== 'string' || !(body as { action: string }).action) {
    json(res, 400, { ok: false, error: 'action must be non-empty string' });
    return;
  }
  const { action, timeout, ...params } = body as { action: string; timeout?: unknown } & Record<string, unknown>;
  // C6 白名单：白名单外直接 400，不透传到扩展（扩展对未知 action 回 needs_update，语义已由 server 拦截取代）
  if (!isAllowedCommandAction(action)) {
    json(res, 400, { ok: false, error: `action not allowed: ${action}（允许的 action：${COMMAND_ACTIONS.join(' ')}）` });
    return;
  }
  // C6 navigate 目标收紧：只许导航到三平台白名单族（防 /command 被用来驱动扩展开任意 URL）
  if (action === 'navigate') {
    const nav = validateNavigateUrl(params.url);
    if (!nav.ok) { json(res, 400, { ok: false, error: nav.error }); return; }
  }
  const r = await requestCommand(clientId, action, params, typeof timeout === 'number' ? timeout : undefined);
  if (!r.ok) {
    if (r.code === 'offline') { json(res, 404, { ok: false, error: 'client not online' }); return; }
    json(res, 504, { ok: false, error: 'extension result timeout' }); return;
  }
  if (r.result?.ok !== true) {
    json(res, 502, { ok: false, error: String(r.result?.error ?? 'extension command failed') });
    return;
  }
  json(res, 200, { ok: true, client_id: clientId, action, result: r.result?.data });
}

export async function handleClientsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  // 全量视图：DB 注册表（含离线，名字/时间线持久）合并内存在线态（2026-08-24 客户端命名）
  if (pathname === '/api/clients') { handleListClients(res, url, db); return; }

  // 两开关端点（CLI clients reporting / task-dispatch、web 客户端页）共用同构处理
  const toggles: Array<[RegExp, (clientId: string, enabled: boolean) => Promise<ToggleResult>]> = [
    [/^\/api\/clients\/([^/]+)\/reporting$/, requestReportingChange],
    // task-dispatch（2026-08-23 仅上报状态）：off = 调度器不再给该客户端派采集任务（保持连接上报）
    [/^\/api\/clients\/([^/]+)\/task-dispatch$/, requestTaskDispatchChange],
  ];
  for (const [re, toggle] of toggles) {
    const m = pathname.match(re);
    if (m && req.method === 'POST') {
      await handleTogglePost(res, decodeURIComponent(m[1]), await readJsonBody(req), toggle);
      return;
    }
  }

  // 下发命令端点（CLI collector-cli clients command）：body 含 action + 任意 params + 可选 timeout。
  // 校验 + 派发在 handleCommandPost（C6 抽出：action 白名单 + navigate host 校验,见上方注释）。
  const mc = pathname.match(/^\/api\/clients\/([^/]+)\/command$/);
  if (mc && req.method === 'POST') {
    await handleCommandPost(res, decodeURIComponent(mc[1]), await readJsonBody(req));
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
