#!/usr/bin/env node
// 备份恢复：从 collector-data volume 的 /data/backups 恢复生产库。
// 背景（2026-08-25 grilling 确认）：「没恢复过的备份不是备份」——本脚本把恢复路径固化，
// 事故现场不再靠记忆和 compose 注释。
//
// 用法：
//   node scripts/backup-restore.mjs --list            列卷内可用备份（时间倒序）
//   node scripts/backup-restore.mjs --drill           恢复演练：最新备份 → 临时卷+临时容器（独立端口
//                                                     21599）→ /ping + integrity 校验 → 清理。
//                                                     不碰生产容器与生产卷。
//   node scripts/backup-restore.mjs --apply <文件名>  真恢复生产（停容器 → 卷内换文件（旧库改名
//                                                     .pre-restore-<ts> 留证）→ 起容器）。需交互输 yes。
// 失败路径可观察（§9）：每步 docker 操作失败即中止并打印 stderr。

import { execFileSync } from 'node:child_process';

const CONTAINER = 'collector-server';
const BACKUP_DIR = '/data/backups';

const args = process.argv.slice(2);
const mode = args.includes('--list') ? 'list' : args.includes('--drill') ? 'drill' : 'apply';
const applyIdx = args.indexOf('--apply');
const target = applyIdx >= 0 ? args[applyIdx + 1] : null;

function die(msg, code = 1) { console.error(`[restore] ✗ ${msg}`); process.exit(code); }
function run(cmd, opts = {}) {
  try { return execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', ...opts }); }
  catch (err) { die(`${cmd.join(' ')} 失败: ${err.stderr || err.message}`); }
}

function listBackups() {
  const out = run(['docker', 'exec', CONTAINER, 'sh', '-c', `ls -1 ${BACKUP_DIR} 2>/dev/null | grep '^bilibili-collector-backup-' | sort -r`]);
  return out.split('\n').filter(Boolean);
}

if (mode === 'list') {
  const names = listBackups();
  if (!names.length) die('卷内无备份', 2);
  console.log(`[restore] ${names.length} 份（新→旧）：\n  ${names.join('\n  ')}`);
  process.exit(0);
}

if (mode === 'drill') {
  const names = listBackups();
  if (!names.length) die('卷内无备份', 2);
  const pick = names[0];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const vol = `collector-restore-drill-${stamp}`;
  const ctr = `collector-restore-drill-${stamp}`;
  console.log(`[restore] 演练：用最新备份 ${pick} 恢复到临时卷 ${vol}（生产不受影响）`);
  try {
    run(['docker', 'volume', 'create', vol]);
    // 卷间拷贝：备份 → 临时卷根（作为该演练库的主文件名）
    run(['docker', 'run', '--rm', '-v', 'subtitle-collector_collector-data:/src:ro', '-v', `${vol}:/dst`, 'alpine',
      'cp', `/src/backups/${pick}`, '/dst/bilibili-collector.db']);
    // 临时容器：同镜像、独立端口、独立卷；只验证可起 + 库完好
    run(['docker', 'run', '-d', '--name', ctr, '-p', '21599:21527',
      '-e', 'COLLECTOR_PORT=21527', '-e', 'COLLECTOR_HOST=0.0.0.0', '-e', 'COLLECTOR_TOKEN=drill-only',
      '-e', 'COLLECTOR_DB_PATH=/data/bilibili-collector.db',
      '-v', `${vol}:/data`, 'collector-server:latest']);
    // 等启动 + 探活
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { execFileSync('curl', ['-sf', 'http://127.0.0.1:21599/ping']); ok = true; } catch { /* 未起 */ }
    }
    if (!ok) die('演练容器 15s 内未通过 /ping');
    const integrity = run(['docker', 'exec', ctr, 'node', '-e',
      'const db=require("better-sqlite3")("/data/bilibili-collector.db",{readonly:true});console.log(db.pragma("integrity_check",{simple:true})+" videos="+db.prepare("SELECT COUNT(*) c FROM videos").get().c);db.close()']).trim();
    console.log(`[restore] ✓ 演练通过：${pick} 可恢复——${integrity}`);
  } finally {
    try { execFileSync('docker', ['rm', '-f', ctr], { stdio: 'pipe' }); } catch { /* 已退 */ }
    try { execFileSync('docker', ['volume', 'rm', vol], { stdio: 'pipe' }); } catch { /* 已删 */ }
  }
  process.exit(0);
}

// --apply：真恢复生产
if (!target || !/^bilibili-collector-backup-\d{8}-\d{6}\.db$/.test(target)) {
  die('--apply 需要备份文件名（先 --list 查看；形如 bilibili-collector-backup-20260825-090000.db）', 2);
}
if (!listBackups().includes(target)) die(`卷内不存在 ${target}`, 2);
console.log(`[restore] 即将用 ${target} 覆盖生产库（当前库将改名为 .pre-restore-<ts> 留证）。\n[restore] 此操作会停服 ~1 分钟。确认请输入 yes：`);
const answer = await new Promise((r) => process.stdin.once('data', (d) => r(d.toString().trim())));
if (answer !== 'yes') die('已取消', 0);
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
run(['docker', 'stop', CONTAINER]);
run(['docker', 'run', '--rm', '-v', 'subtitle-collector_collector-data:/data', 'alpine', 'sh', '-c',
  `mv /data/bilibili-collector.db /data/bilibili-collector.db.pre-restore-${stamp} && cp /data/backups/${target} /data/bilibili-collector.db && rm -f /data/bilibili-collector.db-shm /data/bilibili-collector.db-wal && ls -la /data/`]);
run(['docker', 'start', CONTAINER]);
console.log('[restore] ✓ 生产已从备份恢复；旧库留证为 bilibili-collector.db.pre-restore-' + stamp);
console.log('[restore] 下一步：pnpm verify:deployed -- --token <t> 做完整自检');
