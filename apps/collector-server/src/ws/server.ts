import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ingestVideo, ingestUpper, type IngestRequest, type IngestUpperRequest } from '../db/ingest.js';
import { upsertClient, touchClientLastSeen, listKnownClients, compareClientRows, type ClientSortKey } from '../db/clients.js';
import { notifyClientOnline, pushTask } from '../tasks/tasks.js';
import { amendLateResult, amendLateIngest } from '../tasks/amend.js';
import { releaseClient } from '../tasks/inflight.js';
import { registerWsBridge } from '../tasks/wsBridge.js';

// 超时命令的 params 暂存：result 迟到时 pending 已删，靠它定位任务做改判（amendLateResult）。
// 上限防无界增长；改判命中或永不迟到则等淘汰。
const MAX_TIMED_OUT = 200;
const timedOutParams = new Map<string, Record<string, unknown>>();

// B 站登录态快照（hello / login-state 上报）解析在 ws/login.ts（2026-08-25 偿还复杂度台账抽出）。
// YouTube 同构（2026-08-25 镜像）：快照同形复用同一解析。
import { parseLogin, parseLoginMsg, type LoginSnapshot } from './login.js';

interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
  clientId: string | null;
  clientName: string | null; // 客户端名字（hello / client-name-state 上报；null=未命名或已清除）
  biliLogin: LoginSnapshot | null; // B 站登录态现值（hello / login-state 上报；null=未知或旧扩展）
  ytLogin: LoginSnapshot | null;  // YouTube 登录态现值（同上，2026-08-25 镜像）
  connectedAt: number;       // 本次连接建立时刻（hello 握手时；「在线时长」起算点）
  reportingEnabled: boolean;
  taskDispatchEnabled: boolean; // 2026-08-23 仅上报状态：false = 调度器不派任务（hello 上报，popup 本地切发 task-dispatch-state）
}

const connections = new Map<string, ExtConn>(); // key = clientId（hello 后入表）

// hello 的注册表落库元信息（自 handleHello 抽出，偿还复杂度台账）：
// 登录态/版本只在有效上报时落库（undefined=旧扩展未上报，DB 旧值保留不抹）。
function helloUpsertMeta(conn: ExtConn): { biliLogin?: string; ytLogin?: string; extVersion?: string } {
  return {
    biliLogin: conn.biliLogin != null ? JSON.stringify(conn.biliLogin) : undefined,
    ytLogin: conn.ytLogin != null ? JSON.stringify(conn.ytLogin) : undefined,
    extVersion: conn.extVersion ?? undefined,
  };
}

// login-state 消息处理（自 message 回调抽出，偿还复杂度台账）：更新连接表 + 落库。
// 畸形/缺字段不清除 DB 旧值（保守：探测失败 ≠ 未登录）；扩展侧单平台已知时只带对应字段，
// 字段缺省不动该平台现值（'login' in msg 判定——旧扩展只带 login，新扩展可能只带 yt_login）。
function handleLoginState(db: Database.Database, conn: ExtConn, msg: any): void {
  if ('login' in msg) conn.biliLogin = parseLoginMsg(msg.login);
  if ('yt_login' in msg) conn.ytLogin = parseLoginMsg(msg.yt_login);
  if (!conn.clientId) return;
  const meta: { biliLogin?: string; ytLogin?: string } = {};
  if (conn.biliLogin) {
    meta.biliLogin = JSON.stringify(conn.biliLogin);
    console.log(`[ws] client_id=${conn.clientId} B 站登录态更新：${conn.biliLogin.is_login ? `已登录 ${conn.biliLogin.uname ?? ''}(${conn.biliLogin.mid ?? '?'})` : '未登录'}`);
  }
  if (conn.ytLogin) {
    meta.ytLogin = JSON.stringify(conn.ytLogin);
    console.log(`[ws] client_id=${conn.clientId} YouTube 登录态更新：${conn.ytLogin.is_login ? '已登录' : '未登录'}`);
  }
  if (meta.biliLogin !== undefined || meta.ytLogin !== undefined) {
    upsertClient(db, conn.clientId, undefined, meta);
  }
}

interface PendingEntry { resolve: (v: any) => void; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingEntry>();

// hello 握手处理（2026-08-24 自 attachWsServer 抽出，偿还复杂度台账）：
// token 校验 → 解析身份/开关/名字（client_name 三态：string=名 / null=显式清除 /
// undefined=旧扩展未上报，DB 旧名保留）→ 入连接表 → upsert 注册表 → kick 调度器。
function handleHello(db: Database.Database, ws: WebSocket, conn: ExtConn, msg: any, expectedToken: string): void {
  conn.extVersion = typeof msg.ext_version === 'string' ? msg.ext_version : null;
  // WS 握手 token 校验：非空 token 必须匹配，不匹配 nack+close（防 WS CSRF，学 opencli）。
  // 空 expectedToken = 无 token 模式 → 跳过校验，任何 hello 都 ack（COLLECTOR_TOKEN= 显式开放，适合内网）。
  if (expectedToken && msg.token !== expectedToken) {
    ws.send(JSON.stringify({ type: 'hello-nack', ok: false, error: 'bad token' }));
    ws.close(4001, 'bad token');
    console.warn(`[ws] hello 握手失败：token 不匹配（ext_version=${conn.extVersion ?? 'unknown'}）`);
    return;
  }
  console.log(`[ws] hello 握手成功：ext_version=${conn.extVersion ?? 'unknown'}`);
  ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
  conn.clientId = typeof msg.client_id === 'string' && msg.client_id ? msg.client_id : null;
  conn.reportingEnabled = msg.reporting_enabled !== false; // 缺省 true
  conn.taskDispatchEnabled = msg.task_dispatch_enabled !== false; // 缺省 true（旧扩展 fail-open）
  const reportedName = typeof msg.client_name === 'string' ? msg.client_name.trim() : null;
  conn.clientName = reportedName || null; // 空串视同 null（显式清除）
  conn.biliLogin = parseLoginMsg(msg.bili_login);
  conn.ytLogin = parseLoginMsg(msg.yt_login);
  conn.connectedAt = Date.now();
  if (conn.clientId) {
    const prev = connections.get(conn.clientId);
    if (prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN) prev.ws.close(4000, 'replaced');
    connections.set(conn.clientId, conn);
    upsertClient(db, conn.clientId, msg.client_name === undefined ? undefined : conn.clientName, helloUpsertMeta(conn));
    notifyClientOnline(); // 扩展上线：kick 采集任务调度器（pending 任务可派发了）
  }
}

export function attachWsServer(httpServer: Server, db: Database.Database, expectedToken?: string, heartbeatMs = 30000): void {
  const EXPECTED_TOKEN = expectedToken ?? process.env.COLLECTOR_TOKEN ?? ''; // 空 token = 未配置 → 不校验（无 token 模式，开放，适合内网）；非空 = 必须匹配
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ext',
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const origin = req.headers['origin'];
      // Origin 是辅助防线（非浏览器/本地 Node 不带 Origin）；主鉴权靠 hello token（B1 备注）
      return !origin || origin.startsWith('chrome-extension://');
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: ExtConn = { ws, extVersion: null, clientId: null, clientName: null, biliLogin: null, ytLogin: null, connectedAt: 0, reportingEnabled: true, taskDispatchEnabled: true };
    // 心跳：连接建立 isAlive=true，收到 pong 翻回 true；sweep 周期内无 pong → terminate（清理半开连接）
    const live = ws as WebSocket & { isAlive: boolean };
    live.isAlive = true;
    ws.on('pong', () => { live.isAlive = true; });
    console.log('[ws] connect（等待 hello 握手）');

    ws.on('message', async (data: RawData) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      // 未完成 hello 握手且非 hello 消息：拒（防竞态未握手连接写库，B4）
      if (msg.type !== 'hello' && !conn.extVersion) return;

      if (msg.type === 'hello') {
        handleHello(db, ws, conn, msg, EXPECTED_TOKEN);
        return;
      }

      if (msg.type === 'log') {
        const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info';
        console[level](`[ext] ${msg.msg}`);
        return;
      }

      if (msg.type === 'reporting-state') {
        conn.reportingEnabled = msg.enabled === true;
        return;
      }

      if (msg.type === 'task-dispatch-state') {
        // popup 本地切任务派发开关后的状态同步（对齐 reporting-state：显式推送严格解析）
        conn.taskDispatchEnabled = msg.enabled === true;
        return;
      }

      if (msg.type === 'client-name-state') {
        // popup 改名推送（对齐 reporting-state）：更新连接表 + 落库。name null/空串 = 清除名字。
        const name = typeof msg.name === 'string' && msg.name.trim() ? msg.name.trim() : null;
        conn.clientName = name;
        if (conn.clientId) upsertClient(db, conn.clientId, name);
        return;
      }

      if (msg.type === 'login-state') {
        handleLoginState(db, conn, msg);
        return;
      }

      if (msg.type === 'ingest' && msg.payload) {
        try {
          const result = ingestVideo(db, msg.payload as IngestRequest);
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, ...result }));
          console.log(`[server] ingest source=${result.source} source_vid=${result.source_vid} 新增 ${result.inserted_tracks} 条版本 / 跳过 ${result.skipped_tracks} 条（已存在）`);
          // 必要字段缺失告警（2026-08-25：上报不完整必须可观察——ingest 终值口径的 duration/published_at
          // 仍 NULL 时留证；不拒收，force 重采可补齐。ingest-ack 亦回传 missing_required 供客户端感知）。
          if (result.missing_required?.length) {
            console.warn(`[server] ingest 必要字段缺失 source=${result.source} source_vid=${result.source_vid} missing=${result.missing_required.join(',')}（上报不完整，建议排查扩展侧数据源或 force 重采补齐）`);
          }
          // 迟到 INGEST 改判：超时落 failed 的任务，字幕轨稍后经被动链路实际入库 → 改判 succeeded
          //（与迟到 result 改判互补：扩展自限超时后无回执可等，只有 INGEST 证明数据落了）
          const amended = amendLateIngest(db, result);
          if (amended != null) {
            pushTask(db, amended); // 改判后推送（与 amendLateResult 改判后的推送一致）
            console.log(`[server] 迟到 ingest 改判超时任务 id=${amended} source=${result.source} source_vid=${result.source_vid} → succeeded`);
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: false, error: (err as Error).message }));
          console.log(`[server] ingest 失败 source=${msg.payload?.source} source_vid=${msg.payload?.video?.source_vid} error=${(err as Error).message}`);
        }
        return;
      }

      if (msg.type === 'ingest-upper' && msg.payload) {
        try {
          const result = ingestUpper(db, msg.payload as IngestUpperRequest);
          ws.send(JSON.stringify({ type: 'ingest-upper-ack', ok: true, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ingest-upper-ack', ok: false, error: (err as Error).message }));
        }
        return;
      }

      if (msg.type === 'result') {
        const entry = pending.get(msg.id);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(msg.id);
          entry.resolve(msg);
        } else if (timedOutParams.has(msg.id)) {
          // 迟到 result（命令已超时、任务已落 failed）：按暂存 params 改判超时失败任务——
          // 扩展实际执行完成（可能已 INGEST 落库），failed 是假失败，用户按提示重试会重复采集
          const params = timedOutParams.get(msg.id)!;
          timedOutParams.delete(msg.id);
          const amended = amendLateResult(db, params, { ok: msg.ok === true, data: msg.data });
          console.log(`[ext] 迟到 result id=${msg.id} ok=${msg.ok}${amended != null ? ' → 已改判超时任务为 succeeded' : ''}`);
          if (amended != null) pushTask(db, amended); // 改判后推送（popup 进度卡由失败翻绿）
        } else {
          console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
        }
        return;
      }
    });

    ws.on('close', () => {
      console.log(`[ws] close client_id=${conn.clientId ?? '(未握手)'}`);
      if (conn.clientId && connections.get(conn.clientId) === conn) connections.delete(conn.clientId);
      if (conn.clientId) {
        // 断开时刻 =「离线时长」起算点（DB 留存）。尽力而为：进程退出/测试清理时 db 可能先关，
        // 失败静默丢弃（last_seen_at 停留本次连接建立时刻，误差=连接存活时长，自用可接受）。
        try { touchClientLastSeen(db, conn.clientId); } catch { /* db 已关竞态 */ }
        // 释放调度器 inFlight 占位：断线扩展不再有在途命令，重连的同 client 立即可接新任务
        //（否则占位要等命令超时，最长 180s）
        releaseClient(conn.clientId);
      }
    });
  });

  // 心跳扫频：每 heartbeatMs 遍历所有连接，isAlive=false（上一轮 ping 后未收 pong）→ terminate（触发 close→删 Map）；
  // 否则置 false 并 ping。浏览器原生 WS 协议层自动回 pong，无需客户端配合。学 ws 库官方示例。
  const sweep = setInterval(() => {
    wss.clients.forEach((c) => {
      const cw = c as WebSocket & { isAlive?: boolean };
      if (cw.isAlive === false) {
        console.log('[ws] 心跳超时，terminate 半开连接');
        return c.terminate();
      }
      cw.isAlive = false;
      c.ping();
    });
  }, heartbeatMs);
  sweep.unref(); // 不阻止进程退出（dev/test 场景）
  httpServer.on('close', () => clearInterval(sweep));
}

// port 参数保留为向后兼容签名（MVP 单实例广播；未来可按 port/contextId 路由）
export function broadcastCommand(_port: number, cmd: { id: string; action: string; [k: string]: unknown }): void {
  const payload = JSON.stringify(cmd);
  for (const c of connections.values()) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}

// 服务端主动事件广播（task-update / task-delete 等无 id 推送）：所有已握手连接。
// 无连接时 no-op。旧扩展对未知 type 的无 id 消息静默忽略（background 的 !msg.id 守卫）。
export function broadcastEvent(msg: Record<string, unknown>): void {
  const payload = JSON.stringify(msg);
  for (const c of connections.values()) {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(payload);
  }
}

// 仅在线客户端（调度器派发池 / wsBridge 用：离线客户端不可能接任务，语义必须保持纯在线）。
export function listOnlineClients(): Array<{ client_id: string; ext_version: string | null; reporting_enabled: boolean; task_dispatch_enabled: boolean; connected: true }> {
  return [...connections.values()]
    .filter(c => c.clientId && c.ws.readyState === WebSocket.OPEN)
    .map(c => ({ client_id: c.clientId!, ext_version: c.extVersion, reporting_enabled: c.reportingEnabled, task_dispatch_enabled: c.taskDispatchEnabled, connected: true as const }));
}

// GET /api/clients 的合并视图（2026-08-24 客户端命名）：DB 注册表全量（含离线）+ 内存在线态。
// 在线客户端的名字取连接表现值（旧扩展连着时 hello 未带名，回落 DB 历史名）；离线时
// reporting/task_dispatch 开关未知 → null（远端切换须在线，web 据此隐藏操作按钮）。
export interface ClientRow {
  client_id: string;
  client_name: string | null;
  ext_version: string | null;
  bili_login: LoginSnapshot | null; // 在线取连接表现值，离线回落 DB 快照（NULL=旧版扩展从未上报）
  yt_login: LoginSnapshot | null;   // 同上（YouTube，2026-08-25 镜像）
  reporting_enabled: boolean | null;
  task_dispatch_enabled: boolean | null;
  connected: boolean;
  connected_at: number | null; // 本次连接建立时刻（离线 null；「在线时长」起算点）
  first_seen_at: number;       // server 首次见到该 client_id
  last_seen_at: number;        // 最近一次连接建立/断开时刻（「离线时长」起算点）
}

export function listClients(db: Database.Database, sort: ClientSortKey = 'last_seen', desc = true): ClientRow[] {
  const online = new Map<string, ExtConn>();
  for (const c of connections.values()) {
    if (c.clientId && c.ws.readyState === WebSocket.OPEN) online.set(c.clientId, c);
  }
  const known = listKnownClients(db);
  const rows: ClientRow[] = known.map((k) => {
    const c = online.get(k.client_id);
    return {
      client_id: k.client_id,
      client_name: c?.clientName ?? k.name,
      ext_version: c?.extVersion ?? k.ext_version,
      bili_login: c?.biliLogin ?? parseLogin(k.bili_login),
      yt_login: c?.ytLogin ?? parseLogin(k.yt_login),
      reporting_enabled: c ? c.reportingEnabled : null,
      task_dispatch_enabled: c ? c.taskDispatchEnabled : null,
      connected: !!c,
      connected_at: c ? c.connectedAt : null,
      first_seen_at: k.first_seen_at,
      last_seen_at: k.last_seen_at,
    };
  });
  // 防御：在线但不在 DB（hello 必 upsert，正常不可能；手工库/异常时兜底不漏显示）
  for (const [id, c] of online) {
    if (!known.some((k) => k.client_id === id)) {
      rows.push({
        client_id: id,
        client_name: c.clientName,
        ext_version: c.extVersion,
        bili_login: c.biliLogin,
        yt_login: c.ytLogin,
        reporting_enabled: c.reportingEnabled,
        task_dispatch_enabled: c.taskDispatchEnabled,
        connected: true,
        connected_at: c.connectedAt,
        first_seen_at: c.connectedAt,
        last_seen_at: c.connectedAt,
      });
    }
  }
  // 排序在合并视图上做（比较器与键清单在 db/clients.ts；口径：主键方向随 sort、client_id tie、name NULLS LAST）
  rows.sort((a, b) => compareClientRows(a, b, sort, desc));
  return rows;
}

export function sendToClient(clientId: string, cmd: { id: string; action: string; [k: string]: unknown }): boolean {
  const conn = connections.get(clientId);
  if (!conn || conn.ws.readyState !== WebSocket.OPEN) return false;
  conn.ws.send(JSON.stringify(cmd));
  return true;
}

// 下发任意 command（navigate/operate/fetch-subtitle 等）并等扩展回 result 回执。
// 与 requestReportingChange 同模式：sendToClient 失败 → offline；超时无 result → timeout。
// 注意：本函数不在服务端侧改任何 conn 状态，只是透传回执（result 消息体含 ok/data/error）。
export async function requestCommand(
  clientId: string,
  action: string,
  params: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<{ ok: true; result: any } | { ok: false; code: 'offline' | 'timeout' }> {
  const id = randomUUID();
  const sent = sendToClient(clientId, { id, action, ...params });
  if (!sent) return { ok: false, code: 'offline' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        // 暂存 params 供迟到 result 改判（见 result 处理）；超上限淘汰最旧
        if (timedOutParams.size >= MAX_TIMED_OUT) {
          timedOutParams.delete(timedOutParams.keys().next().value as string);
        }
        timedOutParams.set(id, params);
        resolve({ ok: false, code: 'timeout' });
      }
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: any) => resolve({ ok: true, result: msg }),
      timer,
    });
  });
}

export async function requestReportingChange(
  clientId: string,
  enabled: boolean,
  timeoutMs = 5000,
): Promise<{ ok: true; reporting_enabled: boolean } | { ok: false; code: 'offline' | 'timeout' }> {
  const id = randomUUID();
  const sent = sendToClient(clientId, { id, action: 'set-reporting', enabled });
  if (!sent) return { ok: false, code: 'offline' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout' }); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: any) => {
        const conn = connections.get(clientId);
        if (conn) conn.reportingEnabled = msg?.data?.reporting_enabled === true;
        resolve({ ok: true, reporting_enabled: msg?.data?.reporting_enabled === true });
      },
      timer,
    });
  });
}

// 远程切任务派发开关（对齐 requestReportingChange：发 set-task-dispatch，等 result 回执后
// 更新连接表）。扩展回执 data.task_dispatch_enabled 为新状态。
export async function requestTaskDispatchChange(
  clientId: string,
  enabled: boolean,
  timeoutMs = 5000,
): Promise<{ ok: true; task_dispatch_enabled: boolean } | { ok: false; code: 'offline' | 'timeout' }> {
  const id = randomUUID();
  const sent = sendToClient(clientId, { id, action: 'set-task-dispatch', enabled });
  if (!sent) return { ok: false, code: 'offline' };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ ok: false, code: 'timeout' }); }
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg: any) => {
        const conn = connections.get(clientId);
        if (conn) conn.taskDispatchEnabled = msg?.data?.task_dispatch_enabled === true;
        resolve({ ok: true, task_dispatch_enabled: msg?.data?.task_dispatch_enabled === true });
      },
      timer,
    });
  });
}

// 模块加载即注册 ws 桥（函数声明有提升，此处引用安全）：tasks.ts 经 getWsBridge() 间接调用
// 三函数，断开 tasks → ws 上跳依赖（分层规则 server-tasks-no-upward；见 tasks/wsBridge.ts 注释）。
// 桥上注册 listOnlineClients（纯在线语义：调度器派发池，与 HTTP 的 listClients(db) 全量合并视图区分）。
registerWsBridge({ listClients: listOnlineClients, requestCommand, broadcastEvent });
