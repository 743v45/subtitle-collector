#!/usr/bin/env node
// 备份恢复：从 collector-data volume 的 /data/backups 恢复生产库。
// 背景（2026-08-25 grilling 确认）：「没恢复过的备份不是备份」——本脚本把恢复路径固化，
// 事故现场不再靠记忆和 compose 注释。
//
// 用法：
//   node scripts/backup-restore.mjs --list            列卷内可用备份（时间倒序）
//   node scripts/backup-restore.mjs --drill [--pick <k|random>|--sample]
//                                                     恢复演练：备份 → 临时卷+临时容器（独立端口 21599）→
//                                                     /ping + integrity 校验 → 清理，并追加验收日志
//                                                     docs/plans/acceptance-log.md。不带 --pick 默认验最新；
//                                                     --pick k = 第 k 新份（1=最新）；--sample = random 别名。
//                                                     不碰生产容器与生产卷。
//   node scripts/backup-restore.mjs --apply <文件名>  真恢复生产（全部前置校验通过且交互输 yes 之后才：
//                                                     停容器 → 卷内换文件（旧库改名 .pre-restore-<ts> 留证）→
//                                                     起容器）。校验失败绝不 stop 生产。
//   --volume-name <n>                                 显式指定数据卷（优先级最高；容器已删的裸机重建场景用）；
//                                                     缺省从生产容器 /data 挂载反查。
//
// 数据卷解析失败逃生门：灾难形态下生产容器可能已删，可 `docker volume ls | grep collector-data`
// 人工指认卷名后用 --volume-name 传入。
//
// 硬化（改造项 A4，2026-10-04）：
//   1. 卷名动态解析（不再硬编码 subtitle-collector_collector-data）+ --volume-name 覆盖
//   2. auto-create 防线：任何 docker run -v 前先 docker volume inspect 确认卷存在（Docker 会把
//      不存在的命名卷静默建为空卷——恢复到空卷=假成功）
//   3. --apply 全部前置校验提到 docker stop 之前
//   4. --pick/--sample 历史抽验 + 每次 drill 追加 docs/plans/acceptance-log.md 验收行
//   5. 启动时扫除历史残留 collector-restore-drill-* 卷；finally 清理失败改为 stderr 警告
// 失败路径可观察（CLAUDE.md §9）：每步 [restore:*] 日志带步骤/输入/结果/耗时。

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomInt } from 'node:crypto';

const CONTAINER = 'collector-server';
const BACKUP_DIR = '/data/backups';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCEPTANCE_LOG_PATH = join(REPO_ROOT, 'docs/plans/acceptance-log.md');
export const ACCEPTANCE_LOG_HEADER = '| 日期 | 模式 | 备份文件 | integrity | videos 行数 | 耗时 |';
const DRILL_VOLUME_PREFIX = 'collector-restore-drill-';

// ── 纯函数层（单元测试覆盖，见 backup-restore.test.mjs）──

/**
 * 从 `docker inspect <ctr> --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'`
 * 的 stdout 解析数据卷名。恰好一个 /data 挂载 → 卷名；零个（容器不在/无 /data 挂载）或多个（歧义）→ null。
 */
export function resolveDataVolume(inspectStdout) {
  const names = String(inspectStdout).split('\n').map((s) => s.trim()).filter(Boolean);
  return names.length === 1 ? names[0] : null;
}

/**
 * 解析 --pick 参数 → 备份列表下标（names 新→旧，0=最新）。
 * null = 未传 --pick（缺省行为不变，验最新）→ 0；undefined = 传了 --pick 但缺值 → 抛错；
 * 'random' 用注入的 randomIntFn(count)（默认 crypto.randomInt，均匀无偏置）；
 * 非数字/越界抛 Error，消息含合法取值范围 1..count。
 */
export function parsePick(spec, count, randomIntFn = (n) => randomInt(n)) {
  if (spec === null) return 0;
  if (spec === 'random') return randomIntFn(count);
  if (!/^\d+$/.test(String(spec))) {
    throw new Error(`--pick 非法: ${JSON.stringify(String(spec))}（合法取值: 1..${count} 的整数，或 random）`);
  }
  const k = Number(spec);
  if (k < 1 || k > count) {
    throw new Error(`--pick 越界: ${k}（卷内共 ${count} 份，合法取值: 1..${count}）`);
  }
  return k - 1;
}

/** 验收日志行：| ISO 日期时间 | drill/apply | 备份文件名 | ok/失败原因 | videos 行数 | 耗时 | */
export function formatAcceptanceRow({ timestamp, mode, file, integrity, videos, ms }) {
  return `| ${timestamp} | ${mode} | ${file} | ${integrity} | ${videos} | ${ms} ms |`;
}

// ── 运行时层（真实 docker 调用；机器实测兜底）──

function die(msg, code = 1) { console.error(`[restore] ✗ ${msg}`); process.exit(code); }

/** 包一层 execFileSync：成功打 ok 日志并返回 stdout，失败打 ✗ 日志后抛 Error（调用方决定如何收场）。 */
function run(cmd, opts = {}) {
  const t0 = Date.now();
  const label = cmd.join(' ');
  try {
    const out = execFileSync(cmd[0], cmd.slice(1), { encoding: 'utf8', ...opts });
    console.log(`[restore:run] ${label} → ok (${Date.now() - t0}ms)`);
    return out;
  } catch (err) {
    const msg = `${label} 失败: ${err.stderr || err.message} (${Date.now() - t0}ms)`;
    console.error(`[restore:run] ✗ ${msg}`);
    throw new Error(msg);
  }
}

function listBackups() {
  const out = run(['docker', 'exec', CONTAINER, 'sh', '-c', `ls -1 ${BACKUP_DIR} 2>/dev/null | grep '^bilibili-collector-backup-' | sort -r`]);
  return out.split('\n').filter(Boolean);
}

/** 卷名解析：--volume-name 显式覆盖优先；否则从生产容器 /data 挂载反查，失败 die 并给逃生门。 */
function resolveVolumeName(args) {
  const t0 = Date.now();
  const flagIdx = args.indexOf('--volume-name');
  if (flagIdx >= 0) {
    const name = args[flagIdx + 1];
    if (!name || name.startsWith('--')) die('--volume-name 需要显式卷名参数', 2);
    console.log(`[restore:volume] 数据卷=${name} 来源=--volume-name 显式覆盖 (${Date.now() - t0}ms)`);
    return name;
  }
  let stdout = '';
  try {
    stdout = execFileSync('docker', ['inspect', CONTAINER, '--format',
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'], { encoding: 'utf8' });
  } catch { /* 容器不在/daemon 不可用 → 走下面统一失败分支 */ }
  const name = resolveDataVolume(stdout);
  if (!name) {
    die(`无法从生产容器 ${CONTAINER} 反查 /data 数据卷名（容器不在或无 /data 挂载）。`
      + '灾难形态下容器可能已删，可 `docker volume ls | grep collector-data` 人工指认，'
      + `或用 --volume-name <n> 显式指定。(${Date.now() - t0}ms)`, 2);
  }
  console.log(`[restore:volume] 数据卷=${name} 来源=docker inspect ${CONTAINER} /data 挂载 (${Date.now() - t0}ms)`);
  return name;
}

/** auto-create 防线：任何 docker run -v / 卷操作前确认卷真实存在，不存在即 die（拒绝静默空卷假成功）。 */
function ensureVolumeExists(vol) {
  const t0 = Date.now();
  try {
    execFileSync('docker', ['volume', 'inspect', vol], { stdio: 'pipe' });
  } catch {
    die(`卷 ${vol} 不存在（docker volume inspect 失败）——拒绝继续：docker run -v 会把不存在的命名卷`
      + `静默建为空卷，恢复到空卷等于假成功。请先 docker volume ls 核对卷名。(${Date.now() - t0}ms)`, 2);
  }
  console.log(`[restore:volume] 卷存在性确认: ${vol} ✓ (${Date.now() - t0}ms)`);
}

// 自用工具，无并发 drill 场景：启动时扫掉历史残留 drill 容器与卷（旧版 die() 跳过 finally 的遗留——
// process.exit 不执行 finally，实测 2026-08-25 曾留下 Exited 容器占卷导致卷删不掉），防垃圾无限堆积。
// 先删容器再删卷（卷被容器挂载时 docker volume rm 必失败）。若将来要并行演练，先改这里再加会话标识过滤。
function sweepStaleDrillContainers() {
  const t0 = Date.now();
  let psOut = '';
  try {
    psOut = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8' });
  } catch (err) {
    console.error(`[restore:sweep] docker ps -a 失败，跳过残留容器扫除: ${err.message} (${Date.now() - t0}ms)`);
    return;
  }
  const stale = psOut.split('\n').map((s) => s.trim()).filter((n) => n.startsWith(DRILL_VOLUME_PREFIX));
  for (const name of stale) {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'pipe' });
      console.log(`[restore:sweep] 清除残留容器 ${name} ✓`);
    } catch (err) {
      console.error(`[restore:sweep] 清除残留容器 ${name} 失败（不影响本次运行）: ${err.message}`);
    }
  }
  if (stale.length) console.log(`[restore:sweep] 残留容器扫除完成，共 ${stale.length} 个 (${Date.now() - t0}ms)`);
}

function sweepStaleDrillVolumes() {
  const t0 = Date.now();
  let lsOut = '';
  try {
    lsOut = execFileSync('docker', ['volume', 'ls', '--format', '{{.Name}}'], { encoding: 'utf8' });
  } catch (err) {
    console.error(`[restore:sweep] docker volume ls 失败，跳过残留扫除: ${err.message} (${Date.now() - t0}ms)`);
    return;
  }
  const stale = lsOut.split('\n').map((s) => s.trim()).filter((n) => n.startsWith(DRILL_VOLUME_PREFIX));
  if (!stale.length) {
    console.log(`[restore:sweep] 无残留 ${DRILL_VOLUME_PREFIX}* 卷 (${Date.now() - t0}ms)`);
    return;
  }
  for (const name of stale) {
    try {
      execFileSync('docker', ['volume', 'rm', name], { stdio: 'pipe' });
      console.log(`[restore:sweep] 清除残留卷 ${name} ✓`);
    } catch (err) {
      console.error(`[restore:sweep] 清除残留卷 ${name} 失败（不影响本次运行）: ${err.message}`);
    }
  }
  console.log(`[restore:sweep] 残留扫除完成，共 ${stale.length} 个 (${Date.now() - t0}ms)`);
}

/** 每次 drill/apply 执行完追加一行验收日志（文件不存在则先建含表头）；写失败只警告不影响主流程。 */
function appendAcceptanceRow(row) {
  const t0 = Date.now();
  const line = formatAcceptanceRow(row);
  try {
    if (!existsSync(ACCEPTANCE_LOG_PATH)) {
      mkdirSync(dirname(ACCEPTANCE_LOG_PATH), { recursive: true });
      writeFileSync(ACCEPTANCE_LOG_PATH,
        `# 恢复演练/恢复执行验收日志（backup-restore.mjs 自动追加）\n\n${ACCEPTANCE_LOG_HEADER}\n|---|---|---|---|---|---|\n`);
      console.log(`[restore:log] 已新建验收日志含表头: ${ACCEPTANCE_LOG_PATH}`);
    }
    appendFileSync(ACCEPTANCE_LOG_PATH, line + '\n');
    console.log(`[restore:log] 验收日志已追加: ${line} (${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`[restore:log] ⚠ 验收日志写入失败（不影响 drill/apply 本身）: ${err.message}`);
  }
}

function runList(volumeName) {
  const names = listBackups();
  if (!names.length) die('卷内无备份', 2);
  console.log(`[restore] 数据卷=${volumeName} 共 ${names.length} 份（新→旧）：\n  ${names.join('\n  ')}`);
  process.exit(0);
}

async function runDrill(volumeName, pickSpec) {
  const t0 = Date.now();
  const names = listBackups();
  if (!names.length) die('卷内无备份', 2);
  let idx;
  try { idx = parsePick(pickSpec, names.length); } catch (err) { die(`${err.message}（可先 --list 查看；不带 --pick 默认验最新）`, 2); }
  const pick = names[idx];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const vol = DRILL_VOLUME_PREFIX + stamp;
  const ctr = DRILL_VOLUME_PREFIX + stamp;
  console.log(`[restore:drill] 开始：第 ${idx + 1} 新备份（共 ${names.length} 份）${pick} → 临时卷 ${vol} + 临时容器 ${ctr}（端口 21599，生产不受影响）`);
  ensureVolumeExists(volumeName); // 源卷：docker run -v 挂载前确认存在
  let failure = null;
  let integrity = 'ok';
  let videos = '-';
  try {
    run(['docker', 'volume', 'create', vol]);
    ensureVolumeExists(vol); // 临时卷：create 后实证存在，才允许后续 docker run -v
    // 卷间拷贝：备份 → 临时卷根（作为该演练库的主文件名）
    run(['docker', 'run', '--rm', '-v', `${volumeName}:/src:ro`, '-v', `${vol}:/dst`, 'alpine',
      'cp', `/src/backups/${pick}`, '/dst/bilibili-collector.db']);
    // 临时容器：同镜像、独立端口、独立卷；只验证可起 + 库完好
    run(['docker', 'run', '-d', '--name', ctr, '-p', '21599:21527',
      '-e', 'COLLECTOR_PORT=21527', '-e', 'COLLECTOR_HOST=0.0.0.0', '-e', 'COLLECTOR_TOKEN=drill-only',
      '-e', 'COLLECTOR_DB_PATH=/data/bilibili-collector.db',
      '-v', `${vol}:/data`, 'collector-server:latest']);
    // 等启动 + 探活
    const pollT0 = Date.now();
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { execFileSync('curl', ['-sf', 'http://127.0.0.1:21599/ping'], { stdio: 'pipe' }); ok = true; } catch { /* 未起，继续等 */ }
    }
    console.log(`[restore:drill] /ping 探活 → ${ok ? 'ok' : '超时'} (${Date.now() - pollT0}ms)`);
    if (!ok) failure = '演练容器 15s 内未通过 /ping';
    else {
      const out = run(['docker', 'exec', ctr, 'node', '-e',
        'const db=require("better-sqlite3")("/data/bilibili-collector.db",{readonly:true});console.log(db.pragma("integrity_check",{simple:true})+" videos="+db.prepare("SELECT COUNT(*) c FROM videos").get().c);db.close()']).trim();
      const m = /^(.+)\s+videos=(\d+)$/.exec(out);
      integrity = m ? m[1] : out;
      videos = m ? m[2] : '?';
      console.log(`[restore:drill] integrity_check=${integrity} videos=${videos}`);
      if (integrity !== 'ok') failure = `integrity_check=${integrity}`;
    }
  } catch (err) {
    failure = err.message;
  } finally {
    const rmT0 = Date.now();
    try { execFileSync('docker', ['rm', '-f', ctr], { stdio: 'pipe' }); console.log(`[restore:cleanup] 临时容器 ${ctr} 已删 (${Date.now() - rmT0}ms)`); }
    catch (err) { console.error(`[restore:cleanup] ⚠ 删临时容器 ${ctr} 失败（残留由下次启动 sweep 兜底）: ${err.message}`); }
    try { execFileSync('docker', ['volume', 'rm', vol], { stdio: 'pipe' }); console.log(`[restore:cleanup] 临时卷 ${vol} 已删 (${Date.now() - rmT0}ms)`); }
    catch (err) { console.error(`[restore:cleanup] ⚠ 删临时卷 ${vol} 失败（残留由下次启动 sweep 兜底）: ${err.message}`); }
  }
  const ms = Date.now() - t0;
  if (failure) {
    appendAcceptanceRow({ timestamp: new Date().toISOString(), mode: 'drill', file: pick, integrity: `失败:${failure}`, videos, ms });
    die(`演练失败: ${failure} (${ms}ms)`);
  }
  console.log(`[restore] ✓ 演练通过：${pick} 可恢复——integrity=ok videos=${videos} (${ms}ms)`);
  appendAcceptanceRow({ timestamp: new Date().toISOString(), mode: 'drill', file: pick, integrity: 'ok', videos, ms });
  process.exit(0);
}

async function runApply(volumeName, target) {
  const t0 = Date.now();
  if (!target || !/^bilibili-collector-backup-\d{8}-\d{6}\.db$/.test(target)) {
    die('--apply 需要备份文件名（先 --list 查看；形如 bilibili-collector-backup-20260825-090000.db）', 2);
  }
  // 列备份失败（容器不在的灾难形态）不拦路——卷内文件校验兜底；容器在但名单里没有 → 拦
  let names = null;
  try { names = listBackups(); } catch (err) { console.error(`[restore:precheck] ⚠ 列备份失败（容器不在?）改由卷内文件校验兜底: ${err.message}`); }
  if (names && !names.includes(target)) die(`卷内不存在 ${target}`, 2);

  // ── 全部前置校验（硬化 #3）：任何一步失败都绝不 docker stop 生产 ──
  ensureVolumeExists(volumeName);
  run(['docker', 'run', '--rm', '-v', `${volumeName}:/src:ro`, 'alpine', 'sh', '-c', 'test -f /src/bilibili-collector.db']);
  console.log('[restore:precheck] ✓ 卷内生产库文件存在: /data/bilibili-collector.db');
  run(['docker', 'run', '--rm', '-v', `${volumeName}:/src:ro`, 'alpine', 'sh', '-c', `test -f /src/backups/${target}`]);
  console.log(`[restore:precheck] ✓ 卷内目标备份存在: /data/backups/${target}`);
  console.log('[restore] 各项校验通过（卷存在 / 生产库存在 / 目标备份存在）。');

  console.log(`[restore] 即将用 ${target} 覆盖生产库（当前库将改名为 .pre-restore-<ts> 留证）。\n[restore] 此操作会停服 ~1 分钟。确认请输入 yes：`);
  const answer = await new Promise((r) => process.stdin.once('data', (d) => r(d.toString().trim())));
  if (answer !== 'yes') die('已取消', 0);

  const stopT0 = Date.now();
  run(['docker', 'stop', CONTAINER]);
  console.log(`[restore:apply] 生产容器已停 (${Date.now() - stopT0}ms)`);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  try {
    const swapOut = run(['docker', 'run', '--rm', '-v', `${volumeName}:/data`, 'alpine', 'sh', '-c',
      `mv /data/bilibili-collector.db /data/bilibili-collector.db.pre-restore-${stamp} && cp /data/backups/${target} /data/bilibili-collector.db && rm -f /data/bilibili-collector.db-shm /data/bilibili-collector.db-wal && ls -la /data/`]).trim();
    if (swapOut) console.log(`[restore:apply] 换库后卷内清单:\n${swapOut}`);
  } catch (err) {
    // 换库失败保持生产停止（防半换库状态起服到空/缺库），人工检查卷内文件后自行 docker start
    console.error(`[restore:apply] ⚠ 换库失败，生产容器保持停止。人工处理：检查卷内文件后 docker start ${CONTAINER}`);
    throw err;
  }
  run(['docker', 'start', CONTAINER]);
  console.log(`[restore:apply] 生产容器已重启 (停服 ${Date.now() - stopT0}ms)`);
  console.log('[restore] ✓ 生产已从备份恢复；旧库留证为 bilibili-collector.db.pre-restore-' + stamp);
  console.log('[restore] 下一步：pnpm verify:deployed -- --token <t> 做完整自检');

  let videos = '-';
  try {
    videos = execFileSync('docker', ['exec', CONTAINER, 'node', '-e',
      'const db=require("better-sqlite3")(process.env.COLLECTOR_DB_PATH,{readonly:true});console.log(db.prepare("SELECT COUNT(*) c FROM videos").get().c);db.close()'], { encoding: 'utf8' }).trim();
  } catch (err) { console.error(`[restore:apply] ⚠ 恢复后 videos 行数查询失败（记 '-'）: ${err.message}`); }
  appendAcceptanceRow({ timestamp: new Date().toISOString(), mode: 'apply', file: target, integrity: '未检(verify:deployed 跟进)', videos, ms: Date.now() - t0 });
}

// ── 入口（仅直接执行时跑；测试 import 本模块取纯函数不触发，对齐 backup-healthcheck.mjs 先例）──

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--list') ? 'list' : args.includes('--drill') ? 'drill' : 'apply';
  const pickIdx = args.indexOf('--pick');
  // 语义:缺值时 args[pickIdx+1] 为 undefined(=传了 --pick 没给值,parsePick 抛错);null=没传(缺省最新)
  const pickSpec = pickIdx >= 0 ? args[pickIdx + 1] : args.includes('--sample') ? 'random' : null;
  const applyIdx = args.indexOf('--apply');
  const target = applyIdx >= 0 ? args[applyIdx + 1] : null;

  sweepStaleDrillContainers(); // 硬化 #5：每次启动先扫残留 drill 容器（占卷者）
  sweepStaleDrillVolumes(); // 硬化 #5：再扫残留 drill 卷
  const volumeName = resolveVolumeName(args);
  if (mode === 'list') runList(volumeName);
  if (mode === 'drill') await runDrill(volumeName, pickSpec);
  await runApply(volumeName, target);
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  try {
    await main();
  } catch (err) {
    console.error(`[restore] ✗ ${err.message}`);
    process.exit(1);
  }
}
