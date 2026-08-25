import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// 容器内定时备份（2026-08-24 两次 SQLITE_CORRUPT 事故产物：备份空窗 14h，坏页数据救不回）。
// 每 15min VACUUM INTO 到库同目录 backups/ 下（docker 部署 = /data/backups，named volume 内，
// 纯容器侧文件操作——不经 virtiofs 跨虚拟机共享，无 mmap 一致性风险）。
// VACUUM INTO 在事务一致性快照上拷贝：server 写入进行中也不产生半截备份，无需暂停写入。
// RPO 分层（2026-08-25 与用户确认）：人工资产（分类/打标/译文）丢不起 → 15min 粒度保最近 8 份
// （2h 窗口）；灾备回退 → 每日最后一份保 14 天。两层并集约 7.8GB（355MB/份），单卷可容。
// 出机器的异地副本不经本模块：宿主侧 scripts/backup-export.mjs（docker cp → SynologyDrive）。

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
async function notifyBackupFailure(failStreak: number, lastError: string): Promise<void> {
  const url = process.env.COLLECTOR_BACKUP_WEBHOOK_URL;
  if (!url || failStreak < 2) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: `[collector-server] 备份连续失败 ${failStreak} 次：${lastError}（/data/backups 可能已停更，尽快排查磁盘/卷）` } }),
    });
  } catch { /* webhook 不可达：日志已留痕 */ }
}

/**
 * 挂接定时备份（main.ts 启动时调用）：启动立即备一次（重启即有最新快照），此后每 intervalMs 一次，
 * 每次分层滚动清理。interval/目录/webhook 经 env 覆盖（COLLECTOR_BACKUP_INTERVAL_MS / COLLECTOR_BACKUP_DIR / COLLECTOR_BACKUP_WEBHOOK_URL）。
 * 失败只记日志不抛（备份失败不该带崩 server）+ 连续失败告警；timer unref 不阻止进程退出。
 */
export function attachBackupTimer(db: Database.Database, dbPath: string): void {
  const intervalMs = Number(process.env.COLLECTOR_BACKUP_INTERVAL_MS ?? 900_000);
  const dir = process.env.COLLECTOR_BACKUP_DIR ?? join(dirname(dbPath), 'backups');
  let failStreak = 0;
  let lastError = '';
  const run = (label: string) => {
    try {
      const r = backupOnce(db, dbPath, new Date(), dir);
      const pruned = pruneBackups(dir);
      failStreak = 0;
      const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(`[backup] ${label} path=${basename(r.path)} size=${mb}MB elapsed=${r.durationMs}ms${pruned.length ? ` pruned=${pruned.length}` : ''}`);
    } catch (err) {
      failStreak += 1;
      lastError = (err as Error).message;
      console.error(`[backup] ${label} 失败（连续 ${failStreak} 次，下次重试）: ${lastError}`);
      void notifyBackupFailure(failStreak, lastError);
    }
  };
  run('启动备份');
  const timer = setInterval(() => run('定时备份'), Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 900_000);
  timer.unref();
}
