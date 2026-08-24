import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// 容器内定时备份（2026-08-24 两次 SQLITE_CORRUPT 事故产物：备份空窗 14h，坏页数据救不回）。
// 每小时 VACUUM INTO 到库同目录 backups/ 下（docker 部署 = /data/backups，named volume 内，
// 纯容器侧文件操作——不经 virtiofs 跨虚拟机共享，无 mmap 一致性风险）。
// VACUUM INTO 在事务一致性快照上拷贝：server 写入进行中也不产生半截备份，无需暂停写入。
// 滚动保留最近 N 份（默认 24 ≈ 1 天），文件名时间戳字典序 = 时间序。

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

/** 滚动清理：按文件名排序（时间戳字典序 = 时间序）保留最近 keep 份，返回被删路径。非备份文件名的文件不动。 */
export function pruneBackups(dir: string, keep: number): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; } // 目录不存在（尚未备份过）：无事可清
  const backups = names.filter((n) => /^bilibili-collector-backup-\d{8}-\d{6}\.db$/.test(n)).sort();
  const victims = backups.slice(0, Math.max(0, backups.length - keep));
  for (const n of victims) unlinkSync(join(dir, n));
  return victims.map((n) => join(dir, n));
}

/**
 * 挂接定时备份（main.ts 启动时调用）：启动立即备一次（重启即有最新快照），此后每 intervalMs 一次，
 * 每次滚动清理。interval/keep/dir 经 env 覆盖（COLLECTOR_BACKUP_INTERVAL_MS / COLLECTOR_BACKUP_KEEP / COLLECTOR_BACKUP_DIR）。
 * 失败只记日志不抛（备份失败不该带崩 server）；timer unref 不阻止进程退出。
 */
export function attachBackupTimer(db: Database.Database, dbPath: string): void {
  const intervalMs = Number(process.env.COLLECTOR_BACKUP_INTERVAL_MS ?? 3600_000);
  const keep = Number(process.env.COLLECTOR_BACKUP_KEEP ?? 24);
  const dir = process.env.COLLECTOR_BACKUP_DIR ?? join(dirname(dbPath), 'backups');
  const run = (label: string) => {
    try {
      const r = backupOnce(db, dbPath, new Date(), dir);
      const pruned = pruneBackups(dir, keep);
      const mb = (r.sizeBytes / 1024 / 1024).toFixed(1);
      console.log(`[backup] ${label} path=${basename(r.path)} size=${mb}MB elapsed=${r.durationMs}ms${pruned.length ? ` pruned=${pruned.length}` : ''}`);
    } catch (err) {
      console.error(`[backup] ${label} 失败（下次重试）: ${(err as Error).message}`);
    }
  };
  run('启动备份');
  const timer = setInterval(() => run('定时备份'), Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 3600_000);
  timer.unref();
}
