// 端到端测试：走真 server 入口（src/main.ts 子进程）——HTTP API + WS /ext + 采集任务调度全链路。
// 跑法（验收单独跑，不进 pnpm test 全量 glob）：
//   cd apps/collector-server && node --test --import tsx src/e2e/server.e2e.test.ts
// 覆盖率自查（c8 经 NODE_V8_COVERAGE 环境继承收集子进程，stdin 'shutdown' → process.exit(0) 保证落盘）：
//   npx c8 --include 'src/main.ts' --include 'src/ws/**' --include 'src/tasks/**' --include 'src/http/tasks.ts' \
//     node --test --import tsx src/e2e/server.e2e.test.ts
//
// 架构：每个 describe 起一个独立子进程（临时 DB + listen 预挑端口），测完 stdin 发 'shutdown' 优雅退出；
// WS 用 ws 库模拟扩展客户端（hello → 收命令 → 回 result 回执），对真 HTTP API 断言。
// 不 import 生产模块（除子进程内的 main.ts），保证走的是完整入口（鉴权/路由/调度器/WS 全真实路径）。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 探针：子进程起 main.ts + /ping + stdin 优雅退出 + c8 孙进程覆盖率透传 | 通过 | main.ts 71%（仅 /ping），覆盖率链路成立 |
// | R2 | loopback 无 token：静态/403/404 + WS hello/非法 JSON/log/reporting-state + ingest/ingest-upper/坏 payload + HTTP 查询链（videos/tags/creators/stats/settings） + /api/clients command 四态 | 通过 | 首轮修正断言：evil Origin 走 403（Origin 守卫先于 401 鉴权） |
// | R3 | /api/clients 期望补 task_dispatch_enabled（2026-08-23 仅上报状态；hello 缺省 → true 隐式覆盖） | 通过 | e2e 走真 server 起停，qa 并行下偶发超时 flaky 单跑复验 |
// | R6 | /api/clients 全形态断言改字段级（2026-08-24 客户端命名：新增 client_name/connected_at/first_seen_at/last_seen_at，时间戳动态不能 deepEqual） | 通过 | |
// | R3 | 采集任务生命周期：单条→派发→succeeded、双击去重、失败分类（普通/needs_update/pot_limited）、retry（重置重跑/already_collected）、youtube watch/shorts、batch+历史筛选+删除、upper-videos/expand（含空页终止/整页重复停滞终止） | 通过 | B3 重写为「先设 handler 再建任务」受控时序（原写法命令到达时已被默认 handler 回执） |
// | R4 | 超时与迟到改判：bilibili 超时 15s → failed「扩展执行超时」→ 迟到 result / 迟到 ingest 改判 succeeded + 心跳 sweep 存活断言 | 通过 | 观察窗 14s→17s：首轮 sweep（子进程 t≈30.7s）差 0.3s 未跑到 |
// | R5 | token 鉴权：WS 错 token nack+close(4001)、暴露部署（0.0.0.0）HTTP 401/Bearer/同源/sec-fetch-site/evil-Host 403、缺 token 拒启动 | 通过 | |
// | R6 | 终验：验收命令裸跑（无 c8）+ c8 覆盖率跑均 17/17 通过；无残留子进程/临时目录 | 通过 | 全程 ~46s（含真实 15s 超时 + 17s 心跳观察窗） |

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const APP_DIR = join(import.meta.dirname, '..', '..');
const MAIN_URL = pathToFileURL(join(APP_DIR, 'src', 'main.ts')).href;

// 子进程包装：import main.ts 起真 server；stdin 收 'shutdown' → process.exit(0)。
// 必须优雅退出（而非 SIGKILL/SIGTERM）：V8 覆盖率只在进程正常退出时落盘，c8 才能收到子进程数据。
const WRAPPER = `
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { if (String(d).trim() === 'shutdown') process.exit(0); });
import(process.env.E2E_MAIN_URL).catch((e) => { console.error('[e2e-wrapper] main import failed:', e); process.exit(1); });
`;

// ── 通用小工具 ──────────────────────────────────────────────

// 预挑空闲端口（listen 0 → 取端口 → 关闭；极小概率被抢占，startServer 失败时换端口重试兜底）
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// 直到 fn() 为真（超时抛错并附 desc + context dump）
async function until(desc: string, fn: () => boolean, timeoutMs = 8_000, step = 50, context?: () => string): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）：${desc}${context ? `\n--- context ---\n${context()}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, step));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 合法 BV 号（parseVideoUrl 只认 BV + 10 位字母数字）：seed 补零到 10 位
const bv = (seed: string) => 'BV' + (seed + '0000000000').slice(0, 10);

// ── 真 server 子进程 ──────────────────────────────────────

interface ServerHandle {
  port: number;
  base: string;
  wsUrl: string;
  logs: () => string;
  shutdown: () => Promise<void>;
}

interface StartOpts {
  host?: string;
  token?: string;
  /** 不等 listening 日志，改为等子进程退出（用于「拒绝启动」场景断言 exit code） */
  expectExit?: boolean;
}

async function startServer(opts: StartOpts = {}): Promise<{ handle?: ServerHandle; exitCode?: number | null; logs: string }> {
  let lastLogs = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const dir = mkdtempSync(join(tmpdir(), 'collector-e2e-'));
    const proc = spawn(process.execPath, ['--import', 'tsx', '--eval', WRAPPER], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        E2E_MAIN_URL: MAIN_URL,
        COLLECTOR_DB_PATH: join(dir, 'test.db'),
        COLLECTOR_PORT: String(port),
        COLLECTOR_HOST: opts.host ?? '127.0.0.1',
        COLLECTOR_TOKEN: opts.token ?? '',
        COLLECTOR_ALLOWED_HOSTS: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let logs = '';
    proc.stdout!.on('data', (d: Buffer) => { logs += d.toString(); });
    proc.stderr!.on('data', (d: Buffer) => { logs += d.toString(); });

    if (opts.expectExit) {
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 10_000);
        proc.once('exit', (c) => { clearTimeout(t); resolve(c); });
      });
      rmSync(dir, { recursive: true, force: true });
      return { exitCode: code, logs };
    }

    const ready = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 15_000);
      const onData = () => { if (logs.includes('listening on')) { clearTimeout(t); resolve(true); } };
      proc.stdout!.on('data', onData);
      proc.stderr!.on('data', onData);
      proc.once('exit', (code) => { clearTimeout(t); lastLogs = `child exited early code=${code}\n${logs}`; resolve(false); });
    });
    if (!ready) {
      proc.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const handle: ServerHandle = {
      port,
      base: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}/ext`,
      logs: () => logs,
      shutdown: async () => {
        await new Promise<void>((resolve) => {
          const t = setTimeout(() => { proc.kill('SIGTERM'); resolve(); }, 3_000);
          proc.once('exit', () => { clearTimeout(t); resolve(); });
          proc.stdin!.write('shutdown\n');
        });
        rmSync(dir, { recursive: true, force: true });
      },
    };
    return { handle, logs };
  }
  throw new Error(`server failed to start: ${lastLogs}`);
}

// ── HTTP 客户端 ──────────────────────────────────────

async function api(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

// 原始 HTTP 请求（可设 Host / Sec-Fetch-Site 等被 fetch 规范限制或需精确控制的头）
function rawReq(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers } as RequestOptions, (res) => {
      let buf = '';
      res.on('data', (c: string) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── WS 扩展客户端 mock ──────────────────────────────────────

type CmdHandler = (cmd: any, ext: ExtClient) => void;

// 默认扩展行为：任何命令都回成功回执（set-reporting 按扩展契约回显 reporting_enabled）
const defaultHandler: CmdHandler = (cmd, ext) => {
  ext.send({
    type: 'result', id: cmd.id, ok: true,
    data: cmd.action === 'set-reporting' ? { reporting_enabled: cmd.enabled === true } : {},
  });
};

class ExtClient {
  ws: WebSocket;
  commands: any[] = [];      // server 下发的命令（id + action）
  taskUpdates: any[] = [];   // task-update 广播
  acks: any[] = [];          // hello-ack / ingest-ack / ingest-upper-ack / hello-nack
  handler: CmdHandler = defaultHandler;

  constructor(ws: WebSocket) { this.ws = ws; }

  static async connect(wsUrl: string, hello: Record<string, unknown>): Promise<ExtClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const ext = new ExtClient(ws);
    ws.on('message', (data) => {
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'task-update' || m.type === 'task-delete') ext.taskUpdates.push(m);
      else if (m.id && m.action) {
        ext.commands.push(m);
        try { ext.handler(m, ext); } catch { /* mock handler 抛错不影响测试进程 */ }
      } else ext.acks.push(m);
    });
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0-e2e', ...hello }));
    // 等 hello-ack（握手完成、连接入表，之后的派发/广播才可达）
    await until('hello-ack', () => ext.acks.some((a) => a.type === 'hello-ack'), 5_000, 20);
    return ext;
  }

  send(msg: Record<string, unknown>): void { this.ws.send(JSON.stringify(msg)); }

  /** 等某条命令出现并返回它 */
  async waitCommand(pred: (c: any) => boolean, timeoutMs = 8_000): Promise<any> {
    await until('server 下发命令', () => this.commands.some(pred), timeoutMs, 30, () => JSON.stringify(this.commands));
    return this.commands.find(pred)!;
  }

  /** 等某条 ack 出现并返回它 */
  async waitAck(pred: (a: any) => boolean, timeoutMs = 8_000): Promise<any> {
    await until('server ack', () => this.acks.some(pred), timeoutMs, 30, () => JSON.stringify(this.acks));
    return this.acks.find(pred)!;
  }

  /** 等该任务出现指定状态的 task-update 广播（按 id 过滤，返回状态序列） */
  statuses(taskId: number): string[] {
    return this.taskUpdates.filter((m) => m.type === 'task-update' && m.task?.id === taskId).map((m) => m.task.status);
  }
  async waitStatus(taskId: number, status: string, timeoutMs = 8_000): Promise<void> {
    await until(`task ${taskId} → ${status}`, () => this.statuses(taskId).includes(status), timeoutMs, 50,
      () => JSON.stringify(this.taskUpdates));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

// 轮询任务终态（HTTP 视角；与 ext.taskUpdates 双视角互补）
async function waitTaskStatus(base: string, id: number, want: string[], timeoutMs = 8_000): Promise<any> {
  let last: any = null;
  const t0 = Date.now();
  for (;;) {
    const r = await api(base, 'GET', `/api/collect-tasks/${id}`);
    last = r.json?.task ?? null;
    if (r.status === 200 && last && want.includes(last.status)) return last;
    if (Date.now() - t0 > timeoutMs) throw new Error(`任务 ${id} 未在 ${timeoutMs}ms 内到 ${want.join('/')}，当前：${JSON.stringify(last)}`);
    await sleep(60);
  }
}

// WS ingest payload 构造（形状对齐 db/ingest.test.ts / 扩展实际上报）
function ingestPayload(sourceVid: string, title: string, creatorUid = '101', creatorName = 'UP主甲') {
  return {
    source: 'bilibili',
    video: { source_vid: sourceVid, title, creator: { source_uid: creatorUid, name: creatorName }, extra: { tags: [{ tag_id: 1, tag_name: '测试标签' }] }, duration: 100, published_at: 1_700_000_000_000 },
    tracks: [{ lan: 'zh-CN', lan_doc: '中文（简体）', track_type: 1, versions: [{ origin: 'external', payload: { body: { lines: [] } }, source_url: 'https://example/sub.json' }] }],
  };
}

// ════════════════════════════════════════════════════════════
// A. loopback 无 token：基础链路（HTTP 静态/守卫 + WS 握手/上报 + 查询 API）
// ════════════════════════════════════════════════════════════

describe('A. loopback 无 token：真 main.ts 子进程基础链路', () => {
  let srv: ServerHandle;
  let ext: ExtClient;

  before(async () => {
    const r = await startServer();
    srv = r.handle!;
    ext = await ExtClient.connect(srv.wsUrl, { client_id: 'ext-a', reporting_enabled: true });
  });

  after(async () => {
    await ext.close().catch(() => {});
    await srv.shutdown();
  });

  it('启动探活与静态托管：/ping、/（index.html）、缺失文件 404、非 loopback Host 403（DNS rebinding 防护）', async () => {
    const ping = await api(srv.base, 'GET', '/ping');
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json, { ok: true });

    // 静态托管 collector-web 产物（cwd=apps/collector-server → public/index.html）
    const home = await fetch(`${srv.base}/`);
    assert.equal(home.status, 200);
    assert.match((home.headers.get('content-type') ?? '').split(';')[0], /^text\/html$/);
    assert.ok((await home.text()).includes('<'));

    const missing = await fetch(`${srv.base}/definitely-missing-e2e.js`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'not found');

    // Host 非 loopback 且未放行 → 403（httpOriginAllowed 拒绝）
    const evilHost = await rawReq(srv.port, 'GET', '/api/videos', { Host: 'evil.example' });
    assert.equal(evilHost.status, 403);
    assert.deepEqual(JSON.parse(evilHost.body), { ok: false, error: 'forbidden' });
    // Origin 前缀注入（localhost.evil.com）同样拒
    const evilOrigin = await rawReq(srv.port, 'GET', '/api/videos', { Origin: 'http://localhost.evil.com' });
    assert.equal(evilOrigin.status, 403);
    // 扩展 Origin 放行
    const extOrigin = await rawReq(srv.port, 'GET', '/api/videos', { Origin: 'chrome-extension://abc' });
    assert.equal(extOrigin.status, 200);
  });

  it('WS 握手与杂项消息：hello-ack 后 /api/clients 可见；非法 JSON / log / 无 id result 均被忽略不崩', async () => {
    let r = await api(srv.base, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    assert.equal(r.json.clients.length, 1);
    // 字段级断言（2026-08-24 起含命名/时间线字段，时间戳动态不能 deepEqual）
    const c0 = r.json.clients[0];
    assert.equal(c0.client_id, 'ext-a');
    assert.equal(c0.ext_version, '0.1.0-e2e');
    assert.equal(c0.reporting_enabled, true);
    assert.equal(c0.task_dispatch_enabled, true);
    assert.equal(c0.connected, true);
    assert.equal(c0.client_name, null, 'hello 未带 client_name → 未命名');
    assert.equal(typeof c0.connected_at, 'number', '在线时长起算点');
    assert.equal(typeof c0.first_seen_at, 'number');
    assert.equal(typeof c0.last_seen_at, 'number');

    // 非法 JSON 帧：静默忽略
    ext.ws.send('this is not json {{{');
    // log 消息（warn 级）：仅记日志
    ext.send({ type: 'log', level: 'warn', msg: 'e2e log line' });
    // 无 pending 的 result：仅记日志
    ext.send({ type: 'result', id: 'unsolicited-e2e', ok: true });
    await sleep(100);

    // reporting-state：扩展上报采集开关 → conn 状态同步到 /api/clients
    ext.send({ type: 'reporting-state', enabled: false });
    {
      const t0 = Date.now();
      for (;;) {
        const c = await api(srv.base, 'GET', '/api/clients');
        if (c.json.clients[0]?.reporting_enabled === false) break;
        if (Date.now() - t0 > 5_000) throw new Error('reporting-state 未同步到 /api/clients');
        await sleep(50);
      }
    }
    ext.send({ type: 'reporting-state', enabled: true });
    await sleep(60);

    // 服务端未被上述杂项消息打崩：clients 仍可查
    r = await api(srv.base, 'GET', '/api/clients');
    assert.equal(r.status, 200);
    assert.equal(r.json.clients.length, 1);

    // 无 client_id 的 hello：ack 但不入 clients 表
    const anon = new WebSocket(srv.wsUrl);
    await new Promise<void>((res) => anon.once('open', res));
    anon.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0-e2e' }));
    await sleep(120);
    r = await api(srv.base, 'GET', '/api/clients');
    assert.equal(r.json.clients.length, 1, '无 client_id 的连接不应出现在 /api/clients');
    anon.close();
    await sleep(80);
  });

  it('WS ingest 上报：视频+字幕轨落库回 ack；重复上报幂等去重；坏 payload 回 ok:false；ingest-upper 资料上报', async () => {
    const vid = bv('e2eing');
    ext.send({ type: 'ingest', payload: ingestPayload(vid, '端到端测试视频') });
    const ack1 = await ext.waitAck((a) => a.type === 'ingest-ack' && a.source_vid === vid);
    assert.equal(ack1.ok, true);
    assert.equal(ack1.inserted_tracks, 1);

    // 重复上报：external 轨按 body_hash 去重
    ext.send({ type: 'ingest', payload: ingestPayload(vid, '端到端测试视频') });
    const ack2 = await ext.waitAck((a) => a.type === 'ingest-ack' && a.source_vid === vid && a !== ack1);
    assert.equal(ack2.ok, true);
    assert.equal(ack2.inserted_tracks, 0);
    assert.equal(ack2.skipped_tracks, 1);

    // 坏 payload（缺 video）：ack ok:false，连接不崩
    ext.send({ type: 'ingest', payload: { source: 'bilibili' } });
    const badAck = await ext.waitAck((a) => a.type === 'ingest-ack' && a.ok === false);
    assert.equal(typeof badAck.error, 'string');

    // UP 资料上报（P2 通道）
    ext.send({ type: 'ingest-upper', payload: { source: 'bilibili', creator: { source_uid: '101', name: 'UP主甲', fans: 4242 } } });
    const upAck = await ext.waitAck((a) => a.type === 'ingest-upper-ack' && a.ok === true);
    assert.equal(upAck.source_uid, '101');
    // 坏 ingest-upper（缺 creator）：ack ok:false
    ext.send({ type: 'ingest-upper', payload: { source: 'bilibili' } });
    await ext.waitAck((a) => a.type === 'ingest-upper-ack' && a.ok === false);
  });

  it('HTTP 查询全链路：videos 列表/详情 → tags apply/list → creators → stats overview/aggregate → settings', async () => {
    const vid = bv('e2eing');

    // 列表查到 WS 刚 ingest 的视频（扩展上报 → HTTP 可查）
    let r = await api(srv.base, 'GET', `/api/videos?source=bilibili&source_vid=${vid}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 1);
    assert.equal(r.json.items[0].source_vid, vid);
    assert.equal(r.json.items[0].title, '端到端测试视频');

    // 详情
    r = await api(srv.base, 'GET', `/api/videos/bilibili/${vid}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.video.source_vid, vid);

    // tags：apply → list（scope=档位；items[].source=平台）
    r = await api(srv.base, 'POST', '/api/tags/apply', { items: [{ source: 'bilibili', source_vid: vid }], names: ['e2e标记'], scope: 'manual' });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1);
    r = await api(srv.base, 'GET', '/api/tags');
    const tag = r.json.items.find((t: any) => t.name === 'e2e标记');
    assert.ok(tag, 'tags 列表应含刚 apply 的标签');
    assert.equal(tag.counts.manual, 1);
    // 平台收窄计数：source=bilibili 只算 B 站关系（仍为 1）
    r = await api(srv.base, 'GET', '/api/tags?source=bilibili');
    assert.equal(r.json.items.find((t: any) => t.name === 'e2e标记').counts.manual, 1);

    // creators
    r = await api(srv.base, 'GET', '/api/creators');
    assert.equal(r.status, 200);
    assert.ok(r.json.items.some((c: any) => c.source_uid === '101' && c.name === 'UP主甲'));

    // stats overview（WS ingest 的视频/轨/UP 全部计入；total + 分平台 by_source）
    r = await api(srv.base, 'GET', '/api/stats?type=overview');
    assert.equal(r.status, 200);
    assert.ok(r.json.total.videos >= 1);
    assert.ok(r.json.total.tracks >= 1);
    assert.ok(r.json.total.creators >= 1);
    assert.equal(r.json.by_source.bilibili.videos, r.json.total.videos); // 单平台库：平台小节 = 总量
    // aggregate
    r = await api(srv.base, 'GET', '/api/stats?type=aggregate&groupBy=creator');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.items));
    r = await api(srv.base, 'GET', '/api/stats?type=aggregate&groupBy=source');
    assert.equal(r.status, 200);
    assert.ok(r.json.items.some((i: any) => i.key === 'bilibili' && i.count >= 1), '按平台分组应含 bilibili 行');
    r = await api(srv.base, 'GET', '/api/stats?type=aggregate&groupBy=bogus');
    assert.equal(r.status, 400);

    // settings（默认值）
    r = await api(srv.base, 'GET', '/api/settings/collect-timeout');
    assert.deepEqual({ bilibili: r.json.bilibili, youtube: r.json.youtube }, { bilibili: 90_000, youtube: 45_000 });
    r = await api(srv.base, 'GET', '/api/settings/tag-priority');
    assert.equal(r.json.priority.length, 6);
  });

  it('clients command 四态：成功 200 透传 result、扩展失败 502、离线 404、回执超时 504；reporting 开关同步', async () => {
    // 成功：navigate 下发到 WS 扩展，回执 data 透传
    const prevHandler = ext.handler;
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: true, data: { opened: true } });
    let r = await api(srv.base, 'POST', '/api/clients/ext-a/command', { action: 'navigate', url: `https://www.bilibili.com/video/${bv('navg')}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.result.opened, true);
    const navCmd = ext.commands.find((c) => c.action === 'navigate');
    assert.equal(navCmd.url, `https://www.bilibili.com/video/${bv('navg')}`);

    // 扩展执行失败 → 502 + error 原文
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: false, error: '页面打不开' });
    r = await api(srv.base, 'POST', '/api/clients/ext-a/command', { action: 'operate', selector: '#x' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error, '页面打不开');

    // 离线 client → 404
    r = await api(srv.base, 'POST', '/api/clients/ext-none/command', { action: 'navigate' });
    assert.equal(r.status, 404);
    // 无 action → 400
    r = await api(srv.base, 'POST', '/api/clients/ext-a/command', { url: 'x' });
    assert.equal(r.status, 400);

    // 回执超时 → 504（handler 静默 + timeout 120ms）
    ext.handler = () => { /* 静默：不回执 */ };
    r = await api(srv.base, 'POST', '/api/clients/ext-a/command', { action: 'navigate', timeout: 120 });
    assert.equal(r.status, 504);
    // reporting 回执超时同理 → 504（requestReportingChange 默认 5s，无 timeout 参数可注入）
    r = await api(srv.base, 'POST', '/api/clients/ext-a/reporting', { enabled: false });
    assert.equal(r.status, 504);
    ext.handler = prevHandler;

    // reporting：下发 set-reporting → 扩展回显 → conn 状态同步到 /api/clients
    r = await api(srv.base, 'POST', '/api/clients/ext-a/reporting', { enabled: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.reporting_enabled, false);
    r = await api(srv.base, 'GET', '/api/clients');
    assert.equal(r.json.clients[0].reporting_enabled, false);
    r = await api(srv.base, 'POST', '/api/clients/ext-a/reporting', { enabled: true });
    assert.equal(r.json.reporting_enabled, true);
    // 非法 body → 400；离线 → 404
    r = await api(srv.base, 'POST', '/api/clients/ext-a/reporting', { enabled: 'x' });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'POST', '/api/clients/ext-none/reporting', { enabled: true });
    assert.equal(r.status, 404);
  });

  it('同 client_id 重连：新连接顶掉旧连接（旧连接收 close(4000)），clients 表仍一条', async () => {
    const replaced = new Promise<number>((resolve) => {
      ext.ws.once('close', (code) => resolve(code));
      setTimeout(() => resolve(-1), 5_000);
    });
    const ext2 = await ExtClient.connect(srv.wsUrl, { client_id: 'ext-a', reporting_enabled: true });
    assert.equal(await replaced, 4000, '旧连接应被 4000 replaced 关闭');
    const r = await api(srv.base, 'GET', '/api/clients');
    assert.deepEqual(r.json.clients.map((c: any) => c.client_id), ['ext-a']);
    await ext2.close();
    // ext 已关闭：before 里那个 ext 后续不再用（本 describe 到此为止）
    await sleep(80);
  });
});

// ════════════════════════════════════════════════════════════
// B. 采集任务生命周期（独立实例，干净任务表）
// ════════════════════════════════════════════════════════════

describe('B. 采集任务生命周期：建任务 → WS 派发 → 回执落终态', () => {
  let srv: ServerHandle;
  let ext: ExtClient;

  before(async () => {
    const r = await startServer();
    srv = r.handle!;
    ext = await ExtClient.connect(srv.wsUrl, { client_id: 'ext-b', reporting_enabled: true });
  });

  after(async () => {
    await ext.close().catch(() => {});
    await srv.shutdown();
  });

  it('单条提交全链路：POST text → 派发 fetch-subtitle 到扩展 → 回执 → succeeded（含 task-update 广播序列）', async () => {
    const vid = bv('taskA');
    const r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `帮忙采集一下 ${`https://www.bilibili.com/video/${vid}`} 谢谢` });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.created, true);
    assert.equal(r.json.task.source_vid, vid);
    assert.equal(r.json.task.status, 'pending'); // 响应快照在建任务时点（派发异步随后发生）

    // 派发到 WS 扩展：action + bvid 契约
    const cmd = await ext.waitCommand((c) => c.action === 'fetch-subtitle' && c.bvid === vid);
    assert.ok(cmd.id, '命令须带 id');

    // 回执（默认 handler 已自动回 ok）→ 任务终态 succeeded
    await ext.waitStatus(r.json.task.id, 'succeeded');
    const task = await waitTaskStatus(srv.base, r.json.task.id, ['succeeded']);
    assert.equal(task.error, null);
    assert.equal(task.title, null); // 未 ingest，标题为空
    // 广播序列：pending → dispatched → succeeded（按到达顺序）
    assert.deepEqual(ext.statuses(r.json.task.id), ['pending', 'dispatched', 'succeeded']);
  });

  it('双击提交去重：同视频在途 → created:false 返回既有任务；在途占位下 creator 忙 wait / 全忙 null', async () => {
    const vid = bv('duplB');
    const prevHandler = ext.handler;
    ext.handler = () => { /* hold：不回执，任务停在 dispatched */ };
    const r1 = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${vid}` });
    assert.equal(r1.json.created, true);
    await ext.waitCommand((c) => c.bvid === vid);
    const r2 = await api(srv.base, 'POST', '/api/collect-tasks', { text: `再看 ${`https://www.bilibili.com/video/${vid}`} 这个` });
    assert.equal(r2.json.created, false);
    assert.equal(r2.json.task.id, r1.json.task.id);

    // ext-b 在途（唯一客户端忙）：
    //   带 creator_client_id=ext-b 的任务 → wait（创建者忙，留给创建者）→ 停 pending
    const rb = await api(srv.base, 'POST', '/api/collect-tasks/batch', { vids: [bv('waitC')], client_id: 'ext-b' });
    assert.equal(rb.json.created, 1);
    //   无归属任务 → 无空闲客户端（pick null）→ 停 pending
    const rd = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${bv('nullD')}` });
    assert.equal(rd.json.created, true);
    await sleep(300);
    assert.equal((await api(srv.base, 'GET', `/api/collect-tasks/${rb.json.tasks[0].id}`)).json.task.status, 'pending', '创建者忙应 wait（pending）');
    assert.equal((await api(srv.base, 'GET', `/api/collect-tasks/${rd.json.task.id}`)).json.task.status, 'pending', '全忙应无目标可派（pending）');

    // 释放：回执 hold 的命令 → 第一个任务成功，串行链式派发随后消化 waitC/nullD
    const held = ext.commands.find((c) => c.bvid === vid);
    ext.send({ type: 'result', id: held.id, ok: true, data: {} });
    ext.handler = prevHandler;
    await waitTaskStatus(srv.base, r1.json.task.id, ['succeeded']);
    await waitTaskStatus(srv.base, rb.json.tasks[0].id, ['succeeded']);
    await waitTaskStatus(srv.base, rd.json.task.id, ['succeeded']);
  });

  it('失败分类：普通失败回执原样、unknown action → 扩展版本过旧、pot_limited → limited 终态', async () => {
    // 受控时序：先设 handler 再建任务——命令到达时按当前 handler 回执
    // 1) 普通失败 → error 原样透传
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: false, error: 'need_login' });
    const v2 = bv('failF');
    let r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${v2}` });
    await ext.waitCommand((c) => c.bvid === v2);
    let task = await waitTaskStatus(srv.base, r.json.task.id, ['failed']);
    assert.equal(task.error, 'need_login');

    // 2) 旧扩展 unknown action → 版本过旧分类
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: false, error: 'unknown action: fetch-subtitle' });
    const v3 = bv('oldxG');
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${v3}` });
    await ext.waitCommand((c) => c.bvid === v3);
    task = await waitTaskStatus(srv.base, r.json.task.id, ['failed']);
    assert.equal(task.error, '扩展版本过旧，请更新扩展后重试');

    // 3) pot_limited → limited
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: true, data: { reason: 'pot_limited' } });
    const v4 = bv('limtH');
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${v4}` });
    await ext.waitCommand((c) => c.bvid === v4);
    task = await waitTaskStatus(srv.base, r.json.task.id, ['limited']);
    assert.equal(JSON.parse(task.result).reason, 'pot_limited');
    ext.handler = defaultHandler;
  });

  it('retry：limited 原地重置重跑 → succeeded；failed 且库内已有轨 → already_collected 不重采；非法入参 400/静默跳过', async () => {
    // 先造一个 failed 任务（普通失败）+ 一个 limited 任务
    const prev = ext.handler;
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: false, error: 'boom' });
    const vFail = bv('rtryI');
    let r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${vFail}` });
    await ext.waitCommand((c) => c.bvid === vFail);
    const failedId = r.json.task.id;
    await waitTaskStatus(srv.base, failedId, ['failed']);

    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: true, data: { reason: 'pot_limited' } });
    const vLim = bv('rtryJ');
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${vLim}` });
    await ext.waitCommand((c) => c.bvid === vLim);
    const limitedId = r.json.task.id;
    await waitTaskStatus(srv.base, limitedId, ['limited']);
    ext.handler = prev;

    // 1) limited → retry：库内无轨 → 重置 pending → 重新派发（client_id 保留，上次执行者优先）→ 回 ok → succeeded
    ext.handler = defaultHandler;
    r = await api(srv.base, 'POST', '/api/collect-tasks/retry', { ids: [limitedId] });
    assert.equal(r.status, 200);
    assert.equal(r.json.retried, 1);
    const rerun = await waitTaskStatus(srv.base, limitedId, ['succeeded']);
    assert.equal(rerun.id, limitedId, '重试是原地重置，不建新行');

    // 2) failed → 先经 WS ingest 落 1 轨 → retry 直接 already_collected（succeeded，不派发）
    ext.send({ type: 'ingest', payload: ingestPayload(vFail, '重试前已入库') });
    await ext.waitAck((a) => a.type === 'ingest-ack' && a.source_vid === vFail && a.ok === true);
    const cmdsBefore = ext.commands.length;
    r = await api(srv.base, 'POST', '/api/collect-tasks/retry', { ids: [failedId] });
    assert.equal(r.json.retried, 1);
    const collected = await waitTaskStatus(srv.base, failedId, ['succeeded']);
    assert.equal(JSON.parse(collected.result).reason, 'already_collected');
    assert.equal(JSON.parse(collected.result).tracks, 1);
    assert.equal(ext.commands.length, cmdsBefore, 'already_collected 短路不应再派发命令');

    // 3) 非法入参：空 ids 400；不存在/终态 id 静默跳过（retried 0）
    r = await api(srv.base, 'POST', '/api/collect-tasks/retry', { ids: [] });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'POST', '/api/collect-tasks/retry', { ids: [999_999] });
    assert.equal(r.status, 200);
    assert.equal(r.json.retried, 0);
    r = await api(srv.base, 'POST', '/api/collect-tasks/retry', { ids: [limitedId] });
    assert.equal(r.json.retried, 0, 'succeeded 不可重试');
    r = await api(srv.base, 'GET', '/api/collect-tasks/retry');
    assert.equal(r.status, 405);
  });

  it('youtube 任务：解析 watch / shorts URL → 派发 fetch-youtube-subtitle（videoId + timeout_ms 随 settings 下发）', async () => {
    const yid = 'e2eYtVideo1'; // 11 位
    const r = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.youtube.com/watch?v=${yid}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.task.source, 'youtube');
    assert.equal(r.json.task.source_vid, yid);
    const cmd = await ext.waitCommand((c) => c.action === 'fetch-youtube-subtitle');
    assert.equal(cmd.videoId, yid);
    assert.equal(cmd.timeout_ms, 45_000, 'youtube 无进展窗口默认 45s 应随命令下发');
    await waitTaskStatus(srv.base, r.json.task.id, ['succeeded']);

    // shorts 形态归一为 watch URL
    const sid = 'e2eShortsId';
    const r2 = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.youtube.com/shorts/${sid}` });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.task.source_vid, sid);
    assert.equal(r2.json.task.url, `https://www.youtube.com/watch?v=${sid}`);
    await ext.waitCommand((c) => c.action === 'fetch-youtube-subtitle' && c.videoId === sid);
    await waitTaskStatus(srv.base, r2.json.task.id, ['succeeded']);
  });

  it('批量建任务 + 历史查询：batch 去重/非法 vid 忽略、批次成员聚合、多维筛选、分页、删除', async () => {
    // batch：合法 2 + 非法 1 + 批内重复 1 → created 2；creator_uid 落任务行
    const v1 = bv('btchK');
    const v2 = bv('btchL');
    let r = await api(srv.base, 'POST', '/api/collect-tasks/batch', { vids: [v1, v2, 'not-a-vid', v1], creator_uid: '4242' });
    assert.equal(r.status, 200);
    assert.equal(r.json.created, 2);
    assert.equal(r.json.skipped, 0);
    assert.equal(r.json.tasks[0].batch_id, r.json.tasks[1].batch_id, '同批共享 batch_id');
    assert.equal(r.json.tasks[0].creator_uid, '4242');
    const t1 = r.json.tasks[0].id, t2 = r.json.tasks[1].id;
    await waitTaskStatus(srv.base, t1, ['succeeded']);
    await waitTaskStatus(srv.base, t2, ['succeeded']);

    // 历史筛选
    r = await api(srv.base, 'GET', '/api/collect-tasks?batch=batch&status=succeeded');
    const batchIds = r.json.items.map((t: any) => t.id);
    assert.ok(batchIds.includes(t1) && batchIds.includes(t2), 'batch 档应含两个成员');
    r = await api(srv.base, 'GET', '/api/collect-tasks?creator_uid=4242');
    assert.ok((r.json.items.filter((t: any) => [t1, t2].includes(t.id))).length === 2);
    r = await api(srv.base, 'GET', `/api/collect-tasks?q=${v1}`);
    assert.ok(r.json.items.some((t: any) => t.id === t1), 'q 按源 vid 段匹配');
    // creator 按 UP 名模糊筛（上一用例 ingest 回填过任务行 creator_uid → ct.name 命中）
    r = await api(srv.base, 'GET', '/api/collect-tasks?creator=UP主甲');
    assert.ok(r.json.items.some((t: any) => t.creator_name === 'UP主甲'), 'creator 筛出关联 UP 的任务');
    r = await api(srv.base, 'GET', '/api/collect-tasks?status=pending');
    assert.equal(r.json.items.filter((t: any) => [t1, t2].includes(t.id)).length, 0, '无 pending 残留');
    r = await api(srv.base, 'GET', '/api/collect-tasks?status=bogus,failed');
    assert.equal(r.json.ok, true, '非法 status 值忽略不报错');
    r = await api(srv.base, 'GET', '/api/collect-tasks?page=1&page_size=1');
    assert.equal(r.json.page, 1);
    assert.equal(r.json.page_size, 1);
    r = await api(srv.base, 'GET', '/api/collect-tasks?limit=5');
    assert.equal(r.json.page, undefined, 'limit 形态无 page 字段');

    // 删除
    r = await api(srv.base, 'DELETE', `/api/collect-tasks/${t2}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    r = await api(srv.base, 'GET', `/api/collect-tasks/${t2}`);
    assert.equal(r.status, 404);
    r = await api(srv.base, 'DELETE', `/api/collect-tasks/${t2}`);
    assert.equal(r.status, 404);

    // 入参校验与 405
    r = await api(srv.base, 'POST', '/api/collect-tasks/batch', { vids: [] });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'GET', '/api/collect-tasks/batch');
    assert.equal(r.status, 405);
    r = await api(srv.base, 'GET', '/api/collect-tasks');
    assert.equal(r.status, 200); // GET 合法
    r = await api(srv.base, 'PUT', '/api/collect-tasks');
    assert.equal(r.status, 405);
    r = await api(srv.base, 'GET', '/api/collect-tasks/not-a-number');
    assert.equal(r.status, 404);
    // 单条提交 400 分支
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: '这里没有链接' });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: 'https://www.bilibili.com/video/不是BV号' });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: 'https://example.com/plain-page' });
    assert.equal(r.status, 400, '非视频站 URL 直接拒');
    r = await api(srv.base, 'POST', '/api/collect-tasks', { text: 'https://www.youtube.com/channel/abc' });
    assert.equal(r.status, 400, 'youtube 非 watch/shorts 形态无法识别');
  });

  it('upper-videos/expand：经扩展代理拉 UP 全部视频 + collected 标注；扩展失败 503；入参 400；离线 503', async () => {
    const v1 = bv('xpndM');
    const v2 = bv('xpndN');
    const prev = ext.handler;
    ext.handler = (cmd, e) => e.send({
      type: 'result', id: cmd.id, ok: true,
      data: { total: 2, items: [
        { bvid: v1, title: '视频一', created: 1, play: 5, length: '3:21', pic: '//i2.hdslb.com/x.jpg' },
        { bvid: v2, title: '视频二', created: 2 },
      ] },
    });
    let r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 2);
    const item1 = r.json.items.find((i: any) => i.bvid === v1);
    const item2 = r.json.items.find((i: any) => i.bvid === v2);
    assert.equal(item1.pic, 'https://i2.hdslb.com/x.jpg', '协议头相对封面归一 https:');
    assert.equal(item1.collected, false);
    assert.equal(item2.length, null, '缺省字段归 null');

    // v1 入库后 expand 标注 collected
    ext.send({ type: 'ingest', payload: ingestPayload(v1, 'expand 已采') });
    await ext.waitAck((a) => a.type === 'ingest-ack' && a.source_vid === v1 && a.ok === true);
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.json.items.find((i: any) => i.bvid === v1).collected, true);
    assert.equal(r.json.items.find((i: any) => i.bvid === v2).collected, false);

    // 分页鲁棒 A：第 2 页空 → 立即终止，保已拉部分（total 以服务端口径透传）
    const v3 = bv('xpndQ');
    ext.handler = (cmd, e) => e.send({
      type: 'result', id: cmd.id, ok: true,
      data: cmd.page === 1 ? { total: 5, items: [{ bvid: v3, title: '唯一新视频' }] } : { total: 5, items: [] },
    });
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 5);
    assert.deepEqual(r.json.items.map((i: any) => i.bvid), [v3], '空页终止只保留已拉条目');

    // 分页鲁棒 B：整页重复（分页停滞）连续 3 页 → 终止防死循环，保已拉部分
    ext.handler = (cmd, e) => e.send({
      type: 'result', id: cmd.id, ok: true,
      data: { total: 5, items: [{ bvid: v3, title: '唯一新视频' }] }, // 每页都回落同一页
    });
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.items.map((i: any) => i.bvid), [v3], '停滞去重后不重复');

    // 扩展执行失败（回执 ok:false）→ 503
    ext.handler = (cmd, e) => e.send({ type: 'result', id: cmd.id, ok: false, error: '风控' });
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /风控/);

    // 入参 400 / 方法 405
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: 'abc' });
    assert.equal(r.status, 400);
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', {});
    assert.equal(r.status, 400);
    r = await api(srv.base, 'GET', '/api/upper-videos/expand');
    assert.equal(r.status, 405);

    // 扩展离线 → 503（本 describe 最后一条用例，断开扩展安全）
    ext.handler = prev;
    await ext.close();
    await sleep(100);
    r = await api(srv.base, 'POST', '/api/upper-videos/expand', { mid: '12345' });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /扩展离线/);
  });
});

// ════════════════════════════════════════════════════════════
// C. 派发超时与迟到回执改判（collect-timeout 调到下限 15s，走真实超时路径）
// ════════════════════════════════════════════════════════════

describe('C. 派发超时 → failed「扩展执行超时」→ 迟到 result / 迟到 ingest 改判', () => {
  let srv: ServerHandle;

  before(async () => {
    const r = await startServer();
    srv = r.handle!;
    // bilibili 采集超时调到下限 15s（PUT 校验 ≥15s，低于会 400）
    const put = await api(srv.base, 'PUT', '/api/settings/collect-timeout', { bilibili: 15_000, youtube: 45_000 });
    assert.equal(put.status, 200);
  });

  after(async () => { await srv.shutdown(); });

  it('两个静默扩展各持一个任务：15s 超时落 failed → 迟到 result 改判 / 迟到 ingest 改判 → 心跳 sweep 不误杀活连接', { timeout: 60_000 }, async () => {
    const extA = await ExtClient.connect(srv.wsUrl, { client_id: 'ext-slow-a' });
    const extB = await ExtClient.connect(srv.wsUrl, { client_id: 'ext-slow-b' });
    extA.handler = () => {}; // 静默：不回执
    extB.handler = () => {};

    // 两个任务分别派给 A / B（唯一空闲客户端各一，inFlight 串行互不阻塞）
    const vRes = bv('lateO');
    const vIng = bv('lateP');
    const r1 = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${vRes}` });
    const r2 = await api(srv.base, 'POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${vIng}` });
    const cmdA = await extA.waitCommand((c) => c.action === 'fetch-subtitle' && c.bvid === vRes);
    const cmdB = await extB.waitCommand((c) => c.action === 'fetch-subtitle' && c.bvid === vIng);

    // 15s 命令预算耗尽 → 双双 failed「扩展执行超时」
    const t1 = await waitTaskStatus(srv.base, r1.json.task.id, ['failed'], 25_000);
    const t2 = await waitTaskStatus(srv.base, r2.json.task.id, ['failed'], 25_000);
    assert.equal(t1.error, '扩展执行超时');
    assert.equal(t2.error, '扩展执行超时');

    // 迟到 result（命令已超时，pending 已删）：按暂存 params 改判 succeeded + task-update 推送
    extA.send({ type: 'result', id: cmdA.id, ok: true, data: { captured: 2, tracks: 2 } });
    await extA.waitStatus(r1.json.task.id, 'succeeded');
    const amended1 = await waitTaskStatus(srv.base, r1.json.task.id, ['succeeded']);
    assert.equal(amended1.error, null);
    assert.equal(JSON.parse(amended1.result).captured, 2);

    // 迟到 ingest（无 result 可等的补救路径）：字幕轨实际入库 → 改判 succeeded（result 带 amended 标记）
    extB.send({ type: 'ingest', payload: ingestPayload(vIng, '迟到入库视频') });
    const ack = await extB.waitAck((a) => a.type === 'ingest-ack' && a.source_vid === vIng && a.ok === true);
    assert.equal(ack.inserted_tracks, 1);
    await extB.waitStatus(r2.json.task.id, 'succeeded');
    const amended2 = await waitTaskStatus(srv.base, r2.json.task.id, ['succeeded']);
    assert.equal(JSON.parse(amended2.result).amended, 'late-ingest');

    // 迟到入库的视频经 HTTP 可查（全链路闭环）
    const list = await api(srv.base, 'GET', `/api/videos?source=bilibili&source_vid=${vIng}`);
    assert.equal(list.json.total, 1);

    // 心跳 sweep（默认 30s 周期）：活连接回 pong 翻活，不应被 terminate。
    // 上面 15s 超时 + 改判约 17s，再等到 ≥33s 让第一轮 sweep（ping+pong）确实跑过（attach 在子进程 t≈0.7s）。
    await sleep(17_000);
    const clients = await api(srv.base, 'GET', '/api/clients');
    assert.deepEqual(clients.json.clients.map((c: any) => c.client_id).sort(), ['ext-slow-a', 'ext-slow-b'],
      '心跳 sweep 后活连接应仍在');

    await extA.close();
    await extB.close();
  });
});

// ════════════════════════════════════════════════════════════
// D. token 鉴权（WS hello 校验 + 暴露部署 HTTP 401）
// ════════════════════════════════════════════════════════════

describe('D. token 鉴权', () => {
  it('暴露部署（0.0.0.0）未设 COLLECTOR_TOKEN：拒绝启动（exit 1 + 错误可见）', async () => {
    const r = await startServer({ host: '0.0.0.0', expectExit: true });
    assert.equal(r.exitCode, 1);
    assert.match(r.logs, /必须设置 COLLECTOR_TOKEN/);
  });

  it('WS hello token：错 token → hello-nack + close(4001)；对 token → ack 入表', async () => {
    const r = await startServer({ token: 'sec-token' });
    const srv = r.handle!;
    try {
      // 错 token：nack + 服务端主动关闭 4001
      const ws = new WebSocket(srv.wsUrl);
      await new Promise<void>((res) => ws.once('open', res));
      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
        setTimeout(() => resolve(-1), 5_000);
      });
      ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0-e2e', token: 'WRONG' }));
      const nack = await new Promise<any>((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
      assert.equal(nack.type, 'hello-nack');
      assert.equal(nack.ok, false);
      assert.equal(await closed, 4001, '错 token 应被 close(4001)');

      // 对 token：ack + 入表（loopback HTTP 本身免鉴权）
      const ext = await ExtClient.connect(srv.wsUrl, { token: 'sec-token', client_id: 'ext-sec' });
      const clients = await api(srv.base, 'GET', '/api/clients');
      assert.deepEqual(clients.json.clients.map((c: any) => c.client_id), ['ext-sec']);
      await ext.close();
    } finally { await srv.shutdown(); }
  });

  it('暴露部署（0.0.0.0 + token）：/ping 免鉴权、/api/* 401、Bearer/同源 Origin/Sec-Fetch-Site 放行、静态页可访问、evil Host 403', async () => {
    const r = await startServer({ host: '0.0.0.0', token: 'sec-token' });
    const srv = r.handle!;
    try {
      // /ping 探活免鉴权
      let res = await api(srv.base, 'GET', '/ping');
      assert.equal(res.status, 200);

      // 无 token 的 /api/* → 401
      res = await api(srv.base, 'GET', '/api/videos');
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { ok: false, error: 'unauthorized' });

      // Bearer → 200
      res = await api(srv.base, 'GET', '/api/videos', undefined, { Authorization: 'Bearer sec-token' });
      assert.equal(res.status, 200);
      // 错 Bearer → 401
      res = await api(srv.base, 'GET', '/api/videos', undefined, { Authorization: 'Bearer nope' });
      assert.equal(res.status, 401);

      // 同源浏览器（Origin hostname === Host hostname）→ 免 token
      res = await api(srv.base, 'GET', '/api/videos', undefined, { Origin: `http://127.0.0.1:${srv.port}` });
      assert.equal(res.status, 200);
      // Sec-Fetch-Site: same-origin（浏览器强制头，JS 不可伪造）→ 免 token
      res = await api(srv.base, 'GET', '/api/videos', undefined, { 'Sec-Fetch-Site': 'same-origin' });
      assert.equal(res.status, 200);
      // Origin 合法但跨源（web 以 localhost 域名访问 127.0.0.1 绑定）+ 无 Bearer → 401（须 Bearer）
      res = await api(srv.base, 'GET', '/api/videos', undefined, { Origin: `http://localhost:${srv.port}` });
      assert.equal(res.status, 401);
      // 非法 Origin（evil 域）→ Origin 守卫先于鉴权 → 403
      res = await api(srv.base, 'GET', '/api/videos', undefined, { Origin: 'http://evil.example' });
      assert.equal(res.status, 403);

      // 静态页非 /api/*：Host 合法即放行（web 前端零配置可开）
      const home = await fetch(`${srv.base}/`);
      assert.equal(home.status, 200);

      // evil Host（DNS rebinding）→ 403（在鉴权之前）
      const evil = await rawReq(srv.port, 'GET', '/api/videos', { Host: 'evil.example', Authorization: 'Bearer sec-token' });
      assert.equal(evil.status, 403);

      // WS 在 0.0.0.0 + token 下同样工作（对 token）
      const ext = await ExtClient.connect(srv.wsUrl, { token: 'sec-token', client_id: 'ext-exposed' });
      await ext.close();
    } finally { await srv.shutdown(); }
  });
});
