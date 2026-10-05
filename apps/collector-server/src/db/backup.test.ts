// backup 模块测试：VACUUM INTO 一致性快照 / 文件名 / 滚动清理 / 失败路径。
// 背景（2026-08-24 两次 SQLITE_CORRUPT）：备份空窗 14h 导致坏页数据不可恢复；内置容器内
// 定时备份把空窗压到 1h，且 VACUUM INTO 自带事务一致性（无需暂停写入）。
// A2 落盘自检（2026-10-04）：checkSnapshotIntegrity（quick_check / integrity_check 两档，
// 异常折叠 non-ok 不抛）+ attachBackupTimer 的「备份成功但校验 non-ok」failStreak 告警分型
// （webhook 经 mock fetch 捕获，不发真网络）+ 每日首份全量档位选择 + 主库 24h 日检。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { backupFileName, backupOnce, pruneBackups, attachBackupTimer, checkSnapshotIntegrity } from './backup.js';
import type { IntegrityMode } from './backup.js';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-backup-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

test('backupOnce：VACUUM INTO 产物可独立打开、数据完整、integrity ok', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title: '甲', creator: { source_uid: '1', name: 'UP' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [{ lan: 'zh-CN', lan_doc: '中文', track_type: 0, versions: [{ origin: 'external', payload: { body: [] } }] }],
    });
    const r = backupOnce(db, join(dir, 'test.db'), new Date('2026-08-24T23:05:07'));
    assert.match(r.path, /backups[/]bilibili-collector-backup-20260824-230507\.db$/);
    assert.ok(r.sizeBytes > 0);
    // 产物独立可读：数据在、结构完整
    const snap = new Database(r.path, { readonly: true });
    try {
      assert.equal(snap.pragma('integrity_check', { simple: true }), 'ok');
      assert.equal((snap.prepare("SELECT COUNT(*) c FROM videos WHERE source_vid = 'BV1'").get() as { c: number }).c, 1);
    } finally { snap.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backupFileName：时间各段补零、格式稳定（排序即时间序）', () => {
  assert.equal(backupFileName(new Date(2026, 0, 2, 3, 4, 5)), 'bilibili-collector-backup-20260102-030405.db');
  assert.equal(backupFileName(new Date(2026, 11, 31, 23, 59, 59)), 'bilibili-collector-backup-20261231-235959.db');
});

test('backupOnce：目标已存在（同秒重跑）→ 抛错可观察，不静默覆盖', () => {
  const { db, dir } = freshDb();
  try {
    const now = new Date('2026-08-24T23:05:07');
    backupOnce(db, join(dir, 'test.db'), now);
    assert.throws(() => backupOnce(db, join(dir, 'test.db'), now), /already exists|exists/i);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pruneBackups 分层：保最近 8 份 ∪ 每日末份 × 14 天；非备份文件不动；目录不存在静默', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-prune-'));
  try {
    // 构造 16 天跨度：D-15..D0；D0 当日 10 份（15min 级）、其余每日 2 份
    const now = new Date('2026-08-25T12:00:00');
    const names: string[] = [];
    for (let d = 15; d >= 0; d--) {
      const day = new Date(now.getTime() - d * 86_400_000);
      const p = (n: number) => String(n).padStart(2, '0');
      const base = `${day.getFullYear()}${p(day.getMonth() + 1)}${p(day.getDate())}`;
      if (d === 0) {
        for (let i = 0; i < 10; i++) names.push(`bilibili-collector-backup-${base}-${p(Math.floor(i * 1.5))}0000.db`);
      } else {
        names.push(`bilibili-collector-backup-${base}-010000.db`);
        names.push(`bilibili-collector-backup-${base}-230000.db`); // 当日末份
      }
    }
    for (const n of names) writeFileSync(join(dir, n), '');
    writeFileSync(join(dir, 'unrelated.txt'), 'x'); // 非备份名：不删

    // 显式传 now：与文件构造同一时钟。缺省会走真实时钟——D0 次日跑测试时 D0 已非「今天」，
    // 末份分层期望值漂移（2026-08-26 跨天首跑即 flake，21!==22）。
    const pruned = pruneBackups(dir, 8, 14, now);
    const rest = readdirSync(dir).filter((n) => n.endsWith('.db')).sort();
    // 期望留存：D0 最近 8 份（2h 窗口，D0 头 2 份被清）+ D-1..D-14 各自末份 14 份 = 22 份
    assert.equal(rest.length, 22, 'D0 的最近 8 份 + 14 个每日末份');
    assert.ok(!rest.some((n) => n.includes('20260810')), 'D-15（cutoff 外）全删');
    assert.equal(pruned.length, names.length - 22, '删除数 = 总数 - 留存');
    assert.ok(existsSync(join(dir, 'unrelated.txt')));
    // keep 大于存量：全留不炸；目录不存在：静默空
    assert.deepEqual(pruneBackups(dir, 100, 14, now), []);
    assert.deepEqual(pruneBackups(join(dir, 'nope'), 8, 14, now), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachBackupTimer：启动即备一次 + interval 后再备（env 注入短间隔）', async () => {
  const { db, dir } = freshDb();
  process.env.COLLECTOR_BACKUP_INTERVAL_MS = '80';
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = attachBackupTimer(db, join(dir, 'test.db'));
    await new Promise((r) => setTimeout(r, 30)); // 启动备份同步完成后
    let files = readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.db'));
    assert.equal(files.length, 1, '启动备份立即产生一份');
    // 文件名精确到秒：interval 触发若与启动备份同秒会撞已存在文件（VACUUM INTO 报错、文件不增）。
    // 等 1.1s 跨秒后必然产生新文件名的第二份。
    await new Promise((r) => setTimeout(r, 1100));
    files = readdirSync(join(dir, 'backups')).filter((n) => n.endsWith('.db'));
    assert.ok(files.length >= 2, '定时器触发追加备份');
  } finally {
    clearInterval(timer); // 停表：否则闭包定时器跨测试存活，closed db 每 tick 抛错 + 撞后续测试的 webhook env
    delete process.env.COLLECTOR_BACKUP_INTERVAL_MS;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// ---- A2 落盘自检（2026-10-04）----

test('checkSnapshotIntegrity：垃圾字节文件 → non-ok 且不 throw（better-sqlite3 打开异常折叠为结论）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-integ-'));
  try {
    // 夹具：纯文本字节 = 非 SQLite 文件，better-sqlite3 构造即 throw「file is not a database」
    const p = join(dir, 'garbage.db');
    writeFileSync(p, 'this is definitely not a sqlite database, just plain text bytes');
    const v = checkSnapshotIntegrity(p, 'quick_check');
    assert.equal(v.verdict, 'non-ok', '非库文件判 non-ok');
    assert.ok(v.detail.length > 0, 'detail 带错误信息供告警文案');
    assert.ok(typeof v.elapsedMs === 'number');
    // 缺失文件同型：构造 throw，同样折叠 non-ok
    assert.equal(checkSnapshotIntegrity(join(dir, 'no-such.db'), 'quick_check').verdict, 'non-ok');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('checkSnapshotIntegrity：真实备份产物 quick_check/integrity_check 两档均 ok', () => {
  const { db, dir } = freshDb();
  try {
    const r = backupOnce(db, join(dir, 'test.db'), new Date('2026-08-24T23:05:07'));
    for (const mode of ['quick_check', 'integrity_check'] as const satisfies readonly IntegrityMode[]) {
      const v = checkSnapshotIntegrity(r.path, mode);
      assert.equal(v.verdict, 'ok', `${mode} 通过`);
      assert.equal(v.detail, 'ok');
      assert.ok(v.elapsedMs >= 0);
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('checkSnapshotIntegrity：页数据清零的真库 → non-ok（损坏非仅「打不开」一种形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-integ-'));
  try {
    const real = new Database(join(dir, 'real.db'));
    real.exec(`CREATE TABLE t(a TEXT); INSERT INTO t VALUES ${Array.from({ length: 200 }, (_, i) => `('row${i}')`).join(',')}`);
    real.close();
    // 破坏第 1 页之后的页字节（保留文件头：头部破坏会「打不开」，走 non-ok 的 throw 分支而非 quick_check 报损坏）
    const buf = readFileSync(join(dir, 'real.db'));
    buf.fill(0, 4096, 4096 + 512);
    writeFileSync(join(dir, 'corrupt.db'), buf);
    const v = checkSnapshotIntegrity(join(dir, 'corrupt.db'), 'quick_check');
    assert.equal(v.verdict, 'non-ok');
    assert.match(v.detail, /in database main|error code/i, 'detail 含 quick_check 的损坏描述');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('attachBackupTimer A2：备份成功但校验连续两轮 non-ok → webhook 收到含「完整性」字样文案；单轮不推', async () => {
  const { db, dir } = freshDb();
  const posts: { url: string; body: string }[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    posts.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  // 注入恒 non-ok 的假校验（备份本身真实成功，只让校验环节失败）。
  // interval 取 1000ms：两次触发必跨秒（文件名不撞），且 1.1s 观察窗内恰好两轮、计数确定。
  const checkFn = () => ({ verdict: 'non-ok' as const, detail: 'page 5: bad btree', elapsedMs: 1 });
  process.env.COLLECTOR_BACKUP_INTERVAL_MS = '1000';
  process.env.COLLECTOR_BACKUP_WEBHOOK_URL = 'http://webhook.test/x';
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = attachBackupTimer(db, join(dir, 'test.db'), { checkFn });
    await new Promise((r) => setTimeout(r, 30)); // 第 1 轮：failStreak=1 < 2 → 不推
    assert.equal(posts.length, 0, '单轮 non-ok 不推 webhook');
    await new Promise((r) => setTimeout(r, 1100)); // 跨秒第 2 轮：streak=2 → 推
    assert.equal(posts.length, 1, '连续 ≥2 轮推一次 webhook');
    assert.match(posts[0].body, /完整性校验连续失败/);
    assert.match(posts[0].body, /integrity|完整性/);
    assert.ok(!/备份连续失败/.test(posts[0].body), '文案独立于「备份失败」型');
  } finally {
    clearInterval(timer);
    globalThis.fetch = origFetch;
    delete process.env.COLLECTOR_BACKUP_INTERVAL_MS;
    delete process.env.COLLECTOR_BACKUP_WEBHOOK_URL;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('attachBackupTimer A2：每日首份走 integrity_check 全量档，同日后续走 quick_check；主库日检 24h 节流', async () => {
  const { db, dir } = freshDb();
  const calls: { path: string; mode: IntegrityMode }[] = [];
  // 夹具：恒 ok 的记录型假校验，捕获 attachBackupTimer 内部选的档位
  const checkFn = (path: string, mode: IntegrityMode) => { calls.push({ path, mode }); return { verdict: 'ok' as const, detail: 'ok', elapsedMs: 1 }; };
  process.env.COLLECTOR_BACKUP_INTERVAL_MS = '80';
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = attachBackupTimer(db, join(dir, 'test.db'), { checkFn });
    await new Promise((r) => setTimeout(r, 30));
    // 启动备份 = 当日首份 → 全量档；且主库日检（lastDbCheckAt=0）同 tick 触发一次
    assert.ok(calls.length >= 2, '快照自检 + 主库日检');
    assert.equal(calls[0].mode, 'integrity_check', '每日首份全量档');
    assert.ok(calls[0].path.startsWith(join(dir, 'backups')), '首调用针对快照产物');
    assert.ok(calls.some((c) => c.path === join(dir, 'test.db')), '主库路径也进自检');
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 1100)); // 跨秒触发定时轮
    assert.ok(calls.length > before, '定时轮再触发');
    const snapshotCalls = calls.filter((c) => c.path.startsWith(join(dir, 'backups')));
    assert.ok(snapshotCalls.length >= 2);
    assert.equal(snapshotCalls[1].mode, 'quick_check', '同日第二份走快扫档');
    const dbCheckCalls = calls.filter((c) => c.path === join(dir, 'test.db'));
    assert.equal(dbCheckCalls.length, 1, '24h 节流：同进程第二 tick 不重复日检');
  } finally {
    clearInterval(timer);
    delete process.env.COLLECTOR_BACKUP_INTERVAL_MS;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('attachBackupTimer A2：主库日检 non-ok → [db-check] WARN 日志，不影响快照自检成功链路', async () => {
  const { db, dir } = freshDb();
  const dbPath = join(dir, 'test.db');
  // 夹具：主库路径恒 non-ok，快照路径放行真校验——两路共用同一 checkFn
  const checkFn = (path: string, mode: IntegrityMode) =>
    path === dbPath
      ? { verdict: 'non-ok' as const, detail: 'page 9: never used', elapsedMs: 1 }
      : checkSnapshotIntegrity(path, mode);
  const errors: unknown[][] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); }; // 捕获 + 静音（WARN 走 error 通道）
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = attachBackupTimer(db, dbPath, { checkFn });
    await new Promise((r) => setTimeout(r, 30)); // 启动 tick 同步完成后
    const line = errors.map((a) => a.join(' ')).find((s) => s.includes('[db-check]'));
    assert.ok(line, '主库 non-ok 必须打 [db-check] 日志');
    assert.match(line, /WARN/);
    assert.match(line, /integrity=non-ok/);
    assert.match(line, /test\.db/, '日志含主库文件名');
  } finally {
    clearInterval(timer);
    console.error = origError;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('attachBackupTimer：VACUUM INTO 连续两轮失败 → webhook「备份连续失败」文案；webhook 拒绝不带崩循环', async () => {
  const { db, dir } = freshDb();
  const bodies: string[] = [];
  const origFetch = globalThis.fetch;
  // 夹具：fetch 先捕获 body 再拒绝——既验证文案分型，又覆盖「告警通道故障被吞」路径
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ''));
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  const blocker = join(dir, 'not-a-dir');
  writeFileSync(blocker, 'x'); // 备份目录指到普通文件下：mkdirSync ENOTDIR，每轮 VACUUM 前即抛
  // interval 取 1000ms：1.1s 观察窗内恰好两轮（启动 + 一次定时触发），推送计数确定
  process.env.COLLECTOR_BACKUP_INTERVAL_MS = '1000';
  process.env.COLLECTOR_BACKUP_WEBHOOK_URL = 'http://webhook.test/x';
  process.env.COLLECTOR_BACKUP_DIR = join(blocker, 'backups');
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = attachBackupTimer(db, join(dir, 'test.db'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bodies.length, 0, '第 1 轮失败 failStreak=1 不推');
    await new Promise((r) => setTimeout(r, 1100)); // 跨秒第 2 轮仍失败 → streak=2 推
    assert.equal(bodies.length, 1, '第 2 轮尝试推送一次（fetch 被拒、异常被吞）');
    assert.match(bodies[0], /备份连续失败 2 次/);
    assert.ok(!/完整性/.test(bodies[0]), '文案独立于「备份成功但完整性 non-ok」型');
  } finally {
    clearInterval(timer);
    globalThis.fetch = origFetch;
    delete process.env.COLLECTOR_BACKUP_INTERVAL_MS;
    delete process.env.COLLECTOR_BACKUP_WEBHOOK_URL;
    delete process.env.COLLECTOR_BACKUP_DIR;
    db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
