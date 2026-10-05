#!/usr/bin/env node
// 备份巡检：四项只读检查，验证生产备份体系「仍在正常出卷」——防链路静默死再犯。
// 背景（2026-10-04）：异地导出链路因 cron 裸 node（/bin/sh PATH 无 nvm）静默死 40 天，
//   offsite.log 只剩 "node: command not found" 无人看——本脚本把「链路活着」变成可巡检项。
//
// 四项检查（全部只读：不写任何备份文件、不触碰生产卷路径；静态副本离开 volume 无并发，
//   宿主 sqlite3 -readonly 安全）：
//   1. volume-freshness   卷内最新备份距今 < 30min（15min 备份周期 × 2 容差）
//   2. offsite-freshness  异地目录最新 .db 距今 < 48h（每日 cron × 2 容差）
//   3. offsite-integrity  异地最新 .db 过 PRAGMA quick_check（sqlite3 -readonly）+ videos 行数
//                         （videos 表不存在记 warning 不 fail）
//   4. host-snapshots     宿主 data/exports/*.db 堆积盘点（份数/最老 mtime/总占用，仅日志）
//
// 用法：node scripts/backup-healthcheck.mjs [--dry-run]
//   任一检查失败 exit 1；env COLLECTOR_BACKUP_WEBHOOK_URL 存在时 POST 飞书告警。
//   --dry-run：照常跑检查并打印本应推送的告警文案，但不真发；exit code 照常。
//
// cron 用法（建议每周一行；【必须】用 node 绝对路径——cron 的 /bin/sh PATH 无 nvm，
//   裸 node 正是本链路上次静默死因）：
//   43 10 * * 1 /Users/taevas/.nvm/versions/node/v24.18.0/bin/node /Users/taevas/Code/yawyd/subtitle-collector/scripts/backup-healthcheck.mjs >> /Users/taevas/Code/yawyd/subtitle-collector/data/exports/healthcheck.log 2>&1
//
// 与 backup-restore --drill 的关系：本脚本只查时新性 + quick_check 快检（秒级，可进 cron）；
//   真恢复演练（临时卷 + 临时容器起服 + integrity 校验）见 scripts/backup-restore.mjs --drill，季度跑。
// 失败路径可观察（CLAUDE.md §9）：每步 [check:<name>] 日志带步骤/输入/结果/耗时，非零退出的 stderr 原样入日志。

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTAINER = 'collector-server';
const BACKUP_DIR = '/data/backups';
const VOLUME_MAX_AGE_MS = 30 * 60 * 1000; // 15min 备份周期 × 2 容差
const OFFSITE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 每日导出 cron × 2 容差
const DEFAULT_OFFSITE_DIR = '/Users/taevas/Library/CloudStorage/SynologyDrive-m4ni/collector-backups';
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 纯函数层（单元测试覆盖，见 backup-healthcheck.test.mjs）──

export function isDbFileName(name) {
  return name.endsWith('.db');
}

/** 解析 `docker exec ... ls -t` 输出 → 文件名数组（新→旧；过滤空行/尾换行）。 */
export function parseLsNames(stdout) {
  return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** mtime 时新性判定：距今 < maxAgeMs 则过（严格小于，恰在阈值上算超龄——宁误报不漏报）。 */
export function checkAge(mtimeMs, nowMs, maxAgeMs) {
  const ageMs = nowMs - mtimeMs;
  return { ok: ageMs < maxAgeMs, ageMs, maxAgeMs };
}

/** 从条目 [{name,mtimeMs,...}] 选 mtime 最新者；空数组返回 null（目录无 .db 的 fail 信号）。 */
export function pickNewestFile(entries) {
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/** 扫描目录下 *.db 文件（附 stat）；目录不存在返回 null（与「存在但无 .db」的 [] 区分），否则按新→旧排序。 */
export function scanDbDir(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!isDbFileName(name)) continue;
    const st = statSync(join(dir, name));
    entries.push({ name, path: join(dir, name), mtimeMs: st.mtimeMs, sizeBytes: st.size });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 宿主快照堆积盘点：份数 / 最老 mtime / 总占用字节。 */
export function summarizeSnapshots(entries) {
  if (entries.length === 0) return { count: 0, oldestMtimeMs: null, totalBytes: 0 };
  return {
    count: entries.length,
    oldestMtimeMs: Math.min(...entries.map((e) => e.mtimeMs)),
    totalBytes: entries.reduce((s, e) => s + (e.sizeBytes ?? 0), 0),
  };
}

export function buildWebhookText(name, reason) {
  return `[backup-healthcheck] ${name}: ${reason}`;
}

export function formatDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function formatStamp(ms) {
  return `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)}Z`;
}

// ── 运行时层（真实 docker/sqlite 调用；单元测试不覆盖，--dry-run 实跑兜底）──

/** 包一层 execFileSync：非零退出不抛，返回 {ok,stdout,stderr,ms}——stderr 进日志（§9），不丢现场。 */
function exec(cmd, args) {
  const t0 = Date.now();
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8' });
    return { ok: true, stdout, stderr: '', ms: Date.now() - t0 };
  } catch (err) {
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: (typeof err.stderr === 'string' && err.stderr.trim()) || err.message,
      ms: Date.now() - t0,
    };
  }
}

/** 检查 1：卷内时新性（docker exec ls -t 取最新 + stat -c %Y 取 mtime）。返回 fail 原因或 null。 */
function checkVolumeFreshness() {
  const name = 'volume-freshness';
  const t0 = Date.now();
  const ls = exec('docker', ['exec', CONTAINER, 'sh', '-c', `ls -t ${BACKUP_DIR}/*.db`]);
  if (!ls.ok) {
    console.error(`[check:${name}] ls -t ${BACKUP_DIR}/*.db → 非零退出 stderr="${ls.stderr}" (fail, ${ls.ms}ms)`);
    return `docker exec 列备份失败（容器 ${CONTAINER} 未起或 docker 不可用）: ${ls.stderr}`;
  }
  const names = parseLsNames(ls.stdout); // ls -t 新→旧
  if (names.length === 0) {
    console.error(`[check:${name}] ls 输出为空 → 卷内无备份 (fail, ${ls.ms}ms)`);
    return `容器内无备份（${BACKUP_DIR} 空——server 未跑过备份?）`;
  }
  const newestPath = names[0]; // ls -t 通配全路径输出,新→旧
  const newest = basename(newestPath);
  const st = exec('docker', ['exec', CONTAINER, 'stat', '-c', '%Y', newestPath]);
  if (!st.ok) {
    console.error(`[check:${name}] stat ${newest} → 非零退出 stderr="${st.stderr}" (fail, ${st.ms}ms)`);
    return `docker exec stat 备份 mtime 失败: ${st.stderr}`;
  }
  const mtimeMs = Number(st.stdout.trim()) * 1000;
  const elapsed = Date.now() - t0;
  if (Number.isNaN(mtimeMs)) {
    console.error(`[check:${name}] stat 输出非数字: "${st.stdout.trim()}" (fail, ${elapsed}ms)`);
    return `stat -c %Y 输出无法解析: "${st.stdout.trim()}"`;
  }
  const verdict = checkAge(mtimeMs, Date.now(), VOLUME_MAX_AGE_MS);
  const head = `[check:${name}] 最新备份=${newest} mtime=${formatStamp(mtimeMs)} 距今=${formatDuration(verdict.ageMs)} 阈值<${formatDuration(VOLUME_MAX_AGE_MS)}`;
  if (!verdict.ok) {
    console.error(`${head} → FAIL 超龄 (${elapsed}ms)`);
    return `卷内最新备份距现已 ${formatDuration(verdict.ageMs)}，超 ${formatDuration(VOLUME_MAX_AGE_MS)} 阈值（最新=${newest}）——15min 备份停了?`;
  }
  console.log(`${head} → PASS (${elapsed}ms)`);
  return null;
}

/** 检查 2：异地时新性。返回 {reason(null=过), newest(最新条目或 null)}——newest 供检查 3 复用。 */
function checkOffsiteFreshness(dir) {
  const name = 'offsite-freshness';
  const t0 = Date.now();
  const entries = scanDbDir(dir);
  if (entries === null) {
    console.error(`[check:${name}] 目录不存在: ${dir} (fail, ${Date.now() - t0}ms)`);
    return { reason: `异地备份目录不存在: ${dir}`, newest: null };
  }
  const newest = pickNewestFile(entries);
  if (newest === null) {
    console.error(`[check:${name}] 目录内无 .db: ${dir} (fail, ${Date.now() - t0}ms)`);
    return { reason: `异地备份目录内无 .db 文件: ${dir}`, newest: null };
  }
  const verdict = checkAge(newest.mtimeMs, Date.now(), OFFSITE_MAX_AGE_MS);
  const head = `[check:${name}] 目录=${dir} 共${entries.length}份 最新=${newest.name} mtime=${formatStamp(newest.mtimeMs)} 距今=${formatDuration(verdict.ageMs)} 阈值<${formatDuration(OFFSITE_MAX_AGE_MS)}`;
  if (!verdict.ok) {
    console.error(`${head} → FAIL 超龄 (${Date.now() - t0}ms)`);
    return {
      reason: `异地最新副本距现已 ${formatDuration(verdict.ageMs)}，超 ${formatDuration(OFFSITE_MAX_AGE_MS)} 阈值（最新=${newest.name}）——每日 10:23 导出 cron 没在跑（裸 node 静默死同款?）`,
      newest,
    };
  }
  console.log(`${head} → PASS (${Date.now() - t0}ms)`);
  return { reason: null, newest };
}

/** 检查 3：异地副本完整性（quick_check 须含 ok；videos 行数——表不存在记 warning 不 fail）。 */
function checkOffsiteIntegrity(newest, offsiteDir) {
  const name = 'offsite-integrity';
  if (newest === null) {
    console.error(`[check:${name}] 无副本可检（检查 2 未在 ${offsiteDir} 找到 .db）(fail)`);
    return `无异地副本可检（offsite-freshness 未找到 .db: ${offsiteDir}）`;
  }
  const t0 = Date.now();
  const file = newest.path;
  const qk = exec('sqlite3', ['-readonly', file, 'PRAGMA quick_check;']);
  if (!qk.ok) {
    console.error(`[check:${name}] quick_check ${file} → 非零退出 stderr="${qk.stderr}" (fail, ${qk.ms}ms)`);
    return `quick_check 执行失败（${file}）: ${qk.stderr}`;
  }
  if (!qk.stdout.includes('ok')) {
    console.error(`[check:${name}] quick_check 输出未含 ok: "${qk.stdout.trim()}" (fail, ${qk.ms}ms)`);
    return `quick_check 未通过（${file}）: "${qk.stdout.trim()}"`;
  }
  console.log(`[check:${name}] quick_check=${file} → "ok" (${qk.ms}ms)`);
  const cnt = exec('sqlite3', ['-readonly', file, 'SELECT COUNT(*) FROM videos;']);
  if (!cnt.ok) {
    // 表缺失属 schema 差异不是副本损坏——warning 不 fail，但日志留痕
    console.log(`[check:${name}] warning: videos 行数查询失败（表不存在?）stderr="${cnt.stderr}"——记 warning 不 fail (${Date.now() - t0}ms)`);
    return null;
  }
  console.log(`[check:${name}] videos 行数=${cnt.stdout.trim()} (${Date.now() - t0}ms)`);
  return null;
}

/** 检查 4：宿主快照堆积（信息项，只打日志，恒 pass 不影响 exit code）。 */
function checkHostSnapshots(dir) {
  const name = 'host-snapshots';
  const t0 = Date.now();
  const entries = scanDbDir(dir) ?? [];
  const sum = summarizeSnapshots(entries);
  const oldest = sum.oldestMtimeMs === null ? '无' : formatStamp(sum.oldestMtimeMs);
  console.log(`[check:${name}] 目录=${dir} 份数=${sum.count} 最老mtime=${oldest} 总占用=${(sum.totalBytes / 1024 / 1024).toFixed(1)}MB (信息项,不影响 exit, ${Date.now() - t0}ms)`);
  return null;
}

// ── 入口（仅直接执行时跑;测试 import 本模块取纯函数不触发,对齐 verify-skill-sync.mjs 先例）──

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const offsiteDir = process.env.COLLECTOR_OFFSITE_DIR || DEFAULT_OFFSITE_DIR;
  console.log(`[backup-healthcheck] start dryRun=${dryRun} offsiteDir=${offsiteDir}`);

  const failures = [];
  function runCheck(name, fn) {
    const reason = fn();
    if (reason) failures.push({ name, reason });
  }

  runCheck('volume-freshness', checkVolumeFreshness);

  let offsiteNewest = null;
  runCheck('offsite-freshness', () => {
    const r = checkOffsiteFreshness(offsiteDir);
    offsiteNewest = r.newest;
    return r.reason;
  });
  runCheck('offsite-integrity', () => checkOffsiteIntegrity(offsiteNewest, offsiteDir));
  runCheck('host-snapshots', () => checkHostSnapshots(join(REPO_ROOT, 'data/exports')));

  if (failures.length === 0) {
    console.log('[summary] 4 checks: 0 fail');
    process.exit(0);
  }

  // 告警：每条失败各推一条（文案格式见 buildWebhookText）；发送失败只打日志不改 exit code（§9）
  const webhookUrl = process.env.COLLECTOR_BACKUP_WEBHOOK_URL;
  for (const f of failures) {
    const text = buildWebhookText(f.name, f.reason);
    if (dryRun) {
      console.log(`[webhook] dry-run 本应推送: ${JSON.stringify({ msg_type: 'text', content: { text } })}`);
      continue;
    }
    if (!webhookUrl) {
      console.log(`[webhook] 未配置 COLLECTOR_BACKUP_WEBHOOK_URL，跳过推送（文案: ${text}）`);
      continue;
    }
    const t0 = Date.now();
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
        signal: AbortSignal.timeout(5000),
      });
      console.log(`[webhook] 飞书推送 ${f.name} → HTTP ${res.status} (${Date.now() - t0}ms)`);
      if (!res.ok) console.error(`[webhook] 响应非 2xx: HTTP ${res.status}（不影响 exit code）`);
    } catch (err) {
      console.error(`[webhook] 推送失败（不影响 exit code）: ${err.message}`);
    }
  }

  console.error(`[summary] 4 checks: ${failures.length} fail(${failures.map((f) => f.name).join(', ')})`);
  process.exit(1);
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await main();
}
