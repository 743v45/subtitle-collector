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
const positional = args.filter((a, i) => !a.startsWith('--') && i !== keepIdx + 1);
const target = resolve(positional[0] ?? 'data/exports');

if (!existsSync(target)) mkdirSync(target, { recursive: true });

let names;
try {
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'sh', '-c', `ls -1 ${BACKUP_DIR} 2>/dev/null | grep '^bilibili-collector-backup-' | sort`],
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

const picked = all ? names : names.slice(-Math.max(1, keep));
console.log(`[backup-export] volume 内共 ${names.length} 份，导出 ${picked.length} 份 → ${target}`);

for (const n of picked) {
  try {
    execFileSync('docker', ['cp', `${CONTAINER}:${BACKUP_DIR}/${n}`, `${target}/`], { stdio: 'pipe' });
    const size = (statSync(join(target, n)).size / 1024 / 1024).toFixed(1);
    console.log(`[backup-export] ✓ ${n} (${size}MB)`);
  } catch (err) {
    console.error(`[backup-export] ✗ ${n}: ${err.message}`);
    process.exit(3);
  }
}
console.log(`[backup-export] 完成：最新一份在 ${join(target, picked[picked.length - 1])}`);
