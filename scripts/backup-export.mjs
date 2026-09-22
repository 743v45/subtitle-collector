#!/usr/bin/env node
// 备份导出：把 collector-data volume 里最近 N 份备份 docker cp 到宿主目录（默认 repo 根 data/exports/）。
// 背景（2026-08-24）：生产库迁 named volume 后宿主机不再有库文件，备份导出须经 docker cp——
// 本脚本是规范通道（导出文件是静态副本，离开 volume 后不再有并发访问，安全）。
//
// 用法：node scripts/backup-export.mjs [目标目录] [--all] [--keep N]
//   默认导出最新 1 份；--all 导出全部现存；--keep N 导出最新 N 份。
// 失败路径可观察（§9）：docker exec 列目录 / docker cp 失败均带信息退出非 0。

import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CONTAINER = 'collector-server';
const BACKUP_DIR = '/data/backups';

const args = process.argv.slice(2);
const all = args.includes('--all');
const keepIdx = args.indexOf('--keep');
const keep = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 1;
// 跳过 --keep 的值参数本身；无 --keep 时不得误伤位置参数（keepIdx=-1 时 keepIdx+1=0 曾吃掉目标目录）
const positional = args.filter((a, i) => !a.startsWith('--') && !(keepIdx >= 0 && i === keepIdx + 1));
const target = resolve(positional[0] ?? 'data/exports');

if (!existsSync(target)) mkdirSync(target, { recursive: true });

// 「最新」按容器内 mtime 排序（ls -1t 新→旧），不用文件名字典序——手工备份名如
// manual-now 字典序恒大于日期名（m > 2），曾导致默认导出选到旧手工备份（2026-09-22 事故）。
let names; // 新→旧
try {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'sh', '-c', `ls -1t ${BACKUP_DIR} 2>/dev/null | grep '^bilibili-collector-backup-'`],
    { encoding: 'utf8' },
  );
  names = out.split('\n').filter(Boolean);
} catch (err) {
  console.error(`[backup-export] 列备份失败（容器未起或 docker 不可用）: ${err.message}`);
  process.exit(1);
}

if (names.length === 0) {
  console.error(`[backup-export] 容器内无备份文件（${BACKUP_DIR} 空——server 未跑过备份？）`);
  process.exit(2);
}

const picked = all ? names : names.slice(0, Math.max(1, keep)); // names 新→旧，取前 N
console.log(`[backup-export] volume 内共 ${names.length} 份，导出 ${picked.length} 份 → ${target}`);

for (const n of picked) {
  try {
    execFileSync('docker', ['cp', `${CONTAINER}:${BACKUP_DIR}/${n}`, `${target}/`], { stdio: 'pipe' });
    const st = statSync(join(target, n));
    const size = (st.size / 1024 / 1024).toFixed(1);
    const mtime = new Date(st.mtimeMs).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[backup-export] ✓ ${n} (${size}MB, 备份产生于 ${mtime} UTC)`);
  } catch (err) {
    console.error(`[backup-export] ✗ ${n}: ${err.message}`);
    process.exit(3);
  }
}
console.log(`[backup-export] 完成：最新一份在 ${join(target, picked[0])}`);
