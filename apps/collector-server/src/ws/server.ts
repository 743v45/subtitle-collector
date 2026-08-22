import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ingestVideo, ingestUpper, type IngestRequest, type IngestUpperRequest } from '../db/ingest.js';
import { notifyClientOnline, pushTask } from '../tasks/tasks.js';
import { amendLateResult, amendLateIngest } from '../tasks/amend.js';
import { releaseClient } from '../tasks/inflight.js';
import { registerWsBridge } from '../tasks/wsBridge.js';

// 超时命令的 params 暂存：result 迟到时 pending 已删，靠它定位任务做改判（amendLateResult）。
// 上限防无界增长；改判命中或永不迟到则等淘汰。
const MAX_TIMED_OUT = 200;
const timedOutParams = new Map<string, Record<string, unknown>>();

interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
  clientId: string | null;
  reportingEnabled: boolean;
}

const connections = new Map<string, ExtConn>(); // key = clientId（hello 后入表）

interface PendingEntry { resolve: (v: any) => void; timer: NodeJS.Timeout; }
const pending = new Map<string, PendingEntry>();

export function attachWsServer(httpServer: Server, _db: Database.Database, expectedToken?: string, heartbeatMs = 30000): void {
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
    const conn: ExtConn = { ws, extVersion: null, clientId: null, reportingEnabled: true };
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
        conn.extVersion = typeof msg.ext_version === 'string' ? msg.ext_version : null;
        // WS 握手 token 校验：非空 token 必须匹配，不匹配 nack+close（防 WS CSRF，学 opencli）。
        // 空 EXPECTED_TOKEN = 无 token 模式 → 跳过校验，任何 hello 都 ack（COLLECTOR_TOKEN= 显式开放，适合内网）。
        if (EXPECTED_TOKEN && msg.token !== EXPECTED_TOKEN) {
          ws.send(JSON.stringify({ type: 'hello-nack', ok: false, error: 'bad token' }));
          ws.close(4001, 'bad token');
          console.warn(`[ws] hello 握手失败：token 不匹配（ext_version=${conn.extVersion ?? 'unknown'}）`);
          return;
        }
        console.log(`[ws] hello 握手成功：ext_version=${conn.extVersion ?? 'unknown'}`);
        ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
        conn.clientId = typeof msg.client_id === 'string' && msg.client_id ? msg.client_id : null;
        conn.reportingEnabled = msg.reporting_enabled !== false; // 缺省 true
        if (conn.clientId) {
          const prev = connections.get(conn.clientId);
          if (prev && prev.ws !== ws && prev.ws.readyState === WebSocket.OPEN) prev.ws.close(4000, 'replaced');
          connections.set(conn.clientId, conn);
          notifyClientOnline(); // 扩展上线：kick 采集任务调度器（pending 任务可派发了）
        }
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

      if (msg.type === 'ingest' && msg.payload) {
        try {
          const result = ingestVideo(_db, msg.payload as IngestRequest);
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, ...result }));
          console.log(`[server] ingest source=${result.source} source_vid=${result.source_vid} 新增 ${result.inserted_tracks} 条版本 / 跳过 ${result.skipped_tracks} 条（已存在）`);
          // 迟到 INGEST 改判：超时落 failed 的任务，字幕轨稍后经被动链路实际入库 → 改判 succeeded
          //（与迟到 result 改判互补：扩展自限超时后无回执可等，只有 INGEST 证明数据落了）
          const amended = amendLateIngest(_db, result);
          if (amended != null) {
            pushTask(_db, amended); // 改判后推送（与 amendLateResult 改判后的推送一致）
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
          const result = ingestUpper(_db, msg.payload as IngestUpperRequest);
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
          const amended = amendLateResult(_db, params, { ok: msg.ok === true, data: msg.data });
          console.log(`[ext] 迟到 result id=${msg.id} ok=${msg.ok}${amended != null ? ' → 已改判超时任务为 succeeded' : ''}`);
          if (amended != null) pushTask(_db, amended); // 改判后推送（popup 进度卡由失败翻绿）
        } else {
          console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
        }
        return;
      }
    });

    ws.on('close', () => {
      console.log(`[ws] close client_id=${conn.clientId ?? '(未握手)'}`);
      if (conn.clientId && connections.get(conn.clientId) === conn) connections.delete(conn.clientId);
      // 释放调度器 inFlight 占位：断线扩展不再有在途命令，重连的同 client 立即可接新任务
      //（否则占位要等命令超时，最长 180s）
      if (conn.clientId) releaseClient(conn.clientId);
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

export function listClients(): Array<{ client_id: string; ext_version: string | null; reporting_enabled: boolean; connected: true }> {
  return [...connections.values()]
    .filter(c => c.clientId && c.ws.readyState === WebSocket.OPEN)
    .map(c => ({ client_id: c.clientId!, ext_version: c.extVersion, reporting_enabled: c.reportingEnabled, connected: true }));
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

// 模块加载即注册 ws 桥（函数声明有提升，此处引用安全）：tasks.ts 经 getWsBridge() 间接调用
// 三函数，断开 tasks → ws 上跳依赖（分层规则 server-tasks-no-upward；见 tasks/wsBridge.ts 注释）。
registerWsBridge({ listClients, requestCommand, broadcastEvent });
