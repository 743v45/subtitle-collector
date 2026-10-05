import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// 容器内定时备份（2026-08-24 两次 SQLITE_CORRUPT 事故产物：备份空窗 14h，坏页数据救不回）。
// 每 15min VACUUM INTO 到库同目录 backups/ 下（docker 部署 = /data/backups，named volume 内，
// 纯容器侧文件操作——不经 virtiofs 跨虚拟机共享，无 mmap 一致性风险）。
// VACUUM INTO 在事务一致性快照上拷贝：server 写入进行中也不产生半截备份，无需暂停写入。
// RPO 分层（2026-08-25 与用户确认）：人工资产（分类/打标/译文）丢不起 → 15min 粒度保最近 8 份
// （2h 窗口）；灾备回退 → 每日最后一份保 14 天。两层并集约 7.8GB（355MB/份），单卷可容。
// 出机器的异地副本不经本模块：宿主侧 scripts/backup-export.mjs（docker cp → SynologyDrive）。
// A2 落盘自检（2026-10-04）：「没校验过的备份不是备份」——每次成功备份后对产物 readonly
// 跑 quick_check（每日首份全量 integrity_check），non-ok 走 failStreak 告警（文案与备份失败
// 区分）；另每 24h 对主库 quick_check 日检（只打日志）。校验异常一律不向上抛。

export interface BackupResult {
  path: string;
  sizeBytes: number;
  durationMs: number;
}

/** 备份文件名：bilibili-collector-backup-<yyyyMMdd-HHmmss>.db（同一秒内重跑会撞已存在文件，VACUUM INTO 报错可观察）。 */
export function backupFileName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `bilibili-collector-backup-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.db`;
}

/**
 * 单次备份：VACUUM INTO 一致性快照。
 * 失败抛错（磁盘满 / 目录不可写 / 目标已存在），由调用方记日志——失败路径必须可观察（§9）。
 */
export function backupOnce(db: Database.Database, dbPath: string, now: Date, dir?: string): BackupResult {
  const backupDir = dir ?? join(dirname(dbPath), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const target = join(backupDir, backupFileName(now));
  const startedAt = Date.now();
  db.prepare('VACUUM INTO ?').run(target);
  const durationMs = Date.now() - startedAt;
  return { path: target, sizeBytes: statSync(target).size, durationMs };
}

const NAME_RE = /^bilibili-collector-backup-(\d{4})(\d{2})(\d{2})-\d{6}\.db$/;

/** 自检档位：日常 quick_check（快扫，428MB 秒级）；每日首份 integrity_check（全量深扫）。 */
export type IntegrityMode = 'quick_check' | 'integrity_check';

/**
 * 备份产物落盘自检（A2，2026-10-04）：对刚落盘的快照 readonly 开连跑 quick_check /
 * integrity_check（mode 指定档位），结果 ok / non-ok + 明细。
 * 文件打不开 / 非 SQLite 文件（better-sqlite3 构造即 throw）折叠为 non-ok，**不向上抛**——
 * 校验失败不能带崩备份循环，由调用方走 failStreak 告警通道（§9：失败路径必须可观察）。
 */
export function checkSnapshotIntegrity(path: string, mode: IntegrityMode = 'quick_check'): { verdict: 'ok' | 'non-ok'; detail: string; elapsedMs: number } {
  const startedAt = Date.now();
  try {
    const snap = new Database(path, { readonly: true });
    try {
      const detail = String(snap.pragma(mode, { simple: true }));
      // quick_check/integrity_check 单行结果 'ok' = 通过；否则首行即第一处损坏描述
      return { verdict: detail === 'ok' ? 'ok' : 'non-ok', detail: detail.slice(0, 300), elapsedMs: Date.now() - startedAt };
    } finally { snap.close(); }
  } catch (err) {
    // 打不开（文件缺失/权限/非库文件）：结论 non-ok，错误信息进 detail 供告警文案
    return { verdict: 'non-ok', detail: String((err as Error).message ?? err).slice(0, 300), elapsedMs: Date.now() - startedAt };
  }
}

/**
 * 分层滚动清理：保留「最近 recent 份」∪「每日最后 1 份且该日距今 dailyDays 天内」。
 * 文件名时间戳字典序 = 时间序。非备份文件名的文件不动。返回被删路径。
 */
export function pruneBackups(dir: string, recent = 8, dailyDays = 14, now: Date = new Date()): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; } // 目录不存在（尚未备份过）：无事可清
  const parsed = names
    .map((n) => { const m = NAME_RE.exec(n); return m ? { n, day: `${m[1]}-${m[2]}-${m[3]}` } : null; })
    .filter((x): x is { n: string; day: string } => x != null)
    .sort((a, b) => (a.n < b.n ? -1 : 1));
  const keep = new Set(parsed.slice(-recent).map((x) => x.n));
  // 每日末份（该日字典序最大）且在窗口内：倒序扫，首见某日即该日最后一份
  const cutoff = new Date(now.getTime() - dailyDays * 86_400_000);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cutoffDay = fmt(cutoff);
  const seenDays = new Set<string>();
  for (let i = parsed.length - 1; i >= 0; i--) {
    const x = parsed[i];
    if (seenDays.has(x.day)) continue;
    seenDays.add(x.day);
    if (x.day >= cutoffDay) keep.add(x.n); // 字典序日期比较 = 时间序
  }
  const victims = parsed.filter((x) => !keep.has(x.n));
  for (const x of victims) unlinkSync(join(dir, x.n));
  return victims.map((x) => join(dir, x.n));
}

// 飞书自定义 bot webhook 告警（env COLLECTOR_BACKUP_WEBHOOK_URL 配置；缺省只打日志不推）。
// 连续失败 ≥2 次才推（单次偶发不扰民），成功即清零计数。fetch 失败不抛——告警通道故障不能带崩备份循环。
// A2 起文案分两型（2026-10-04）：backup-failure = VACUUM INTO 失败（备份停更）；
// integrity-failure = 备份成功但落盘自检 non-ok（快照可能不可恢复）——两者处置方向不同，不混用文案。
type FailKind = 'backup-failure' | 'integrity-failure';
async function notifyBackupFailure(failStreak: number, lastError: string, kind: FailKind = 'backup-failure'): Promise<void> {
  const url = process.env.COLLECTOR_BACKUP_WEBHOOK_URL;
  if (!url || failStreak < 2) return;
  const text = kind === 'integrity-failure'
    ? `[collector-server] 备份成功但完整性校验连续失败 ${failStreak} 次：${lastError}（最新快照可能不可恢复，尽快排查磁盘/卷）`
    : `[collector-server] 备份连续失败 ${failStreak} 次：${lastError}（/data/backups 可能已停更，尽快排查磁盘/卷）`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text } }),
    });
  } catch { /* webhook 不可达：日志已留痕 */ }
}

/**
 * 挂接定时备份（main.ts 启动时调用）：启动立即备一次（重启即有最新快照），此后每 intervalMs 一次，
 * 每次分层滚动清理。interval/目录/webhook 经 env 覆盖（COLLECTOR_BACKUP_INTERVAL_MS / COLLECTOR_BACKUP_DIR / COLLECTOR_BACKUP_WEBHOOK_URL）。
 * 失败只记日志不抛（备份失败不该带崩 server）+ 连续失败告警；timer unref 不阻止进程退出。
 * A2（2026-10-04）起每次成功备份后对产物跑落盘自检（checkSnapshotIntegrity；checkFn 可注入供测试）：
 * 每日首份成功产物跑全量 integrity_check，其余 quick_check。校验 non-ok 走同一 failStreak
 * 通道（连续 ≥2 推 webhook）但文案独立；另每 24h 对主库跑一次 quick_check 日检（只打日志）。
 * 返回 timer（供测试/优雅停机 clearInterval；生产 main.ts 忽略返回值）。
 */
export function attachBackupTimer(
  db: Database.Database,
  dbPath: string,
  opts: { checkFn?: (path: string, mode: IntegrityMode) => ReturnType<typeof checkSnapshotIntegrity> } = {},
): NodeJS.Timeout {
  const intervalMs = Number(process.env.COLLECTOR_BACKUP_INTERVAL_MS ?? 900_000);
  const dir = process.env.COLLECTOR_BACKUP_DIR ?? join(dirname(dbPath), 'backups');
  const checkFn = opts.checkFn ?? checkSnapshotIntegrity;
  let failStreak = 0;
  let lastError = '';
  let lastFullCheckDay = ''; // 每日首份判定（快照文件名 yyyyMMdd 段，进程内记忆：首备/重启后首份必为全量）
  let lastDbCheckAt = 0;     // 主库日检节流：距上次 ≥24h 才跑（0 = 启动首 tick 即检一次）
  const run = (label: string) => {
    let r: ReturnType<typeof backupOnce>;
    try {
      r = backupOnce(db, dbPath, new Date(), dir);
    } catch (err) {
      failStreak += 1;
      lastError = (err as Error).message;
      console.error(`[backup] ${label} 失败（连续 ${failStreak} 次，下次重试）: ${lastError}`);
      void notifyBackupFailure(failStreak, lastError, 'backup-failure');
      return;
    }
    const pruned = pruneBackups(dir);
    // ---- 落盘自检（A2）：每日首份成功产物全量 integrity_check，其余 quick_check。
    // 「每日首份」取快照文件名内嵌日期对照 lastFullCheckDay（不依赖目录扫描/时钟推断，
    // 实现简单且可测）；标记按「当日已跑过」记，不随校验成败变化。
    const m = NAME_RE.exec(basename(r.path));
    const day = m ? m[1] + m[2] + m[3] : '';
    const mode: IntegrityMode = day !== lastFullCheckDay ? 'integrity_check' : 'quick_check';
    const v = checkFn(r.path, mode);
    lastFullCheckDay = day;
    if (v.verdict === 'ok') {
      failStreak = 0; // 恢复即清零（备份 + 自检双 ok 才算成功，对齐既有 failStreak 语义）
      const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(`[backup] ${label} path=${basename(r.path)} size=${mb}MB elapsed=${r.durationMs}ms integrity=ok(${mode},${v.elapsedMs}ms)${pruned.length ? ` pruned=${pruned.length}` : ''}`);
    } else {
      // 备份成功但校验 non-ok：不 throw、不中断循环，走同一 failStreak 计数（≥2 推 webhook），文案独立含文件名
      failStreak += 1;
      lastError = `完整性校验 non-ok: ${basename(r.path)} ${mode} ${v.detail}`;
      console.error(`[backup] ${label} 备份成功但完整性校验 non-ok（连续 ${failStreak} 次，下次重试）: path=${basename(r.path)} mode=${mode} elapsed=${v.elapsedMs}ms detail=${v.detail}`);
      void notifyBackupFailure(failStreak, lastError, 'integrity-failure');
    }
    // ---- 主库日检（A2）：每 24h 一次 readonly 新连跑 quick_check。WAL 模式（openDb 启动即设）
    // 下 readonly 读不阻塞写；结果只打日志，主库损坏处置（换库/恢复）不在本模块自动执行。
    if (Date.now() - lastDbCheckAt >= 86_400_000) {
      lastDbCheckAt = Date.now();
      const dv = checkFn(dbPath, 'quick_check');
      if (dv.verdict === 'ok') console.log(`[db-check] 主库日检 path=${basename(dbPath)} integrity=ok(quick_check,${dv.elapsedMs}ms)`);
      else console.error(`[db-check] WARN 主库日检 integrity=non-ok path=${basename(dbPath)} elapsed=${dv.elapsedMs}ms detail=${dv.detail}`);
    }
  };
  run('启动备份');
  const timer = setInterval(() => run('定时备份'), Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 900_000);
  timer.unref();
  return timer;
}
