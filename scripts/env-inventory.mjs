#!/usr/bin/env node
// 外置配置只读盘点（2026-10-04 改造项 A5）：生产链路依赖的一批「仓库外」配置——crontab、主检出
// .env、B 站 cookie、异地备份目录、report 产物仓——散落各处且无单点视图，静默漂移（如 cron 裸 node）
// 只能靠事故发现。本脚本把「外置配置仍正确」变成一条命令可验的巡检项，验收日与 backup-healthcheck 同轮跑。
//
// 五项检查（全部只读：不写任何文件、不打印任何密钥值）：
//   1. crontab          `crontab -l` 存在 backup-export 行，node 用绝对路径（/*/bin/node——cron 的
//                       /bin/sh PATH 无 nvm，裸 node 是 2026-10-04 异地导出静默死 40 天的根因），
//                       且行内脚本路径存在
//   2. 主检出 .env      <主检出>/.env 存在，COLLECTOR_TOKEN 非空且非占位符、COLLECTOR_BACKUP_WEBHOOK_URL
//                       非空（值绝不打印——本脚本输出里不出现任何 secret 明文）
//   3. B 站 cookie      cookie 文件存在即过（路径单源见 scripts/bili-cookie-from-chrome.mjs DEFAULT_OUT：
//                       ~/Local/collector-secrets/bili-cookie.txt），打 mtime 与过期天数供人工判读
//   4. 异地目录         COLLECTOR_OFFSITE_DIR（缺省群晖同步盘）最新 .db 距今 < 48h（每日导出 × 2 容差）
//   5. report 产物仓    ~/Code/report 是 git 仓且工作区干净（`git status --porcelain` 为空，A6 断言）
//
// 用法：node scripts/env-inventory.mjs
//   任一检查失败 exit 1（纯巡检不告警——告警职责在 backup-healthcheck，本脚本定位是验收/人工巡检）。
// 失败路径可观察（CLAUDE.md §9）：每步 [check:<name>] 日志带步骤/输入/结果/耗时，非零退出 stderr 原样入日志。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAIN_ROOT = join(homedir(), 'Code/yawyd/subtitle-collector');
const MAIN_ENV_PATH = join(MAIN_ROOT, '.env');
const COOKIE_PATH = join(homedir(), 'Local/collector-secrets/bili-cookie.txt');
const DEFAULT_OFFSITE_DIR = '/Users/taevas/Library/CloudStorage/SynologyDrive-m4ni/collector-backups';
const OFFSITE_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 每日导出 cron × 2 容差
const REPORT_DIR = join(homedir(), 'Code/report');
const TOKEN_PLACEHOLDER = 'change-me-collector-token';

// ── 纯函数层（单元测试覆盖，见 env-inventory.test.mjs）──

/** 从 crontab 行集合找 backup-export 行；没有返回 null（fail 信号）。 */
export function findBackupExportLine(lines) {
  return lines.find((l) => l.includes('backup-export')) ?? null;
}

/** 解析 crontab 命令段：定位 backup-export.mjs 脚本 token，取其前一个 token 作 node。
 *  剥一层成对引号（acme.sh 行的 `"/Users/..."/acme.sh` 形态先例）。解析不出返回 null。 */
export function parseCronCommand(line) {
  const tokens = line.trim().split(/\s+/).map((t) => t.replace(/^"(.*)"$/, '$1'));
  const idx = tokens.findIndex((t) => t.endsWith('/backup-export.mjs') || t === 'backup-export.mjs');
  if (idx <= 0) return null; // idx=0 = 脚本占了 schedule 位，形态必然不对
  return { node: tokens[idx - 1], script: tokens[idx] };
}

/** node 必须是绝对路径二进制：/ 开头且以 /bin/node 结尾（/opt/homebrew/bin/node、
 *  ~/.nvm/versions/node/vX/bin/node 均命中；裸 `node`、`./node`、`/usr/local/node` 均不命中）。 */
export function isAbsoluteNodePath(token) {
  return token.startsWith('/') && token.endsWith('/bin/node');
}

/** crontab 检查全判定：行 → node 绝对路径 → 脚本存在。fileExists 注入便于测试。 */
export function assessCronEntry(line, fileExists) {
  const entry = parseCronCommand(line);
  if (!entry) {
    return { ok: false, reason: '行内未解析出 backup-export.mjs 脚本与 node 前缀（形态不对）' };
  }
  if (!isAbsoluteNodePath(entry.node)) {
    return {
      ok: false,
      reason: `node 非绝对路径("${entry.node}")——cron 的 /bin/sh PATH 无 nvm，裸 node 是上次异地导出静默死 40 天的根因`,
      node: entry.node,
      script: entry.script,
    };
  }
  if (!fileExists(entry.script)) {
    return { ok: false, reason: `行内脚本路径不存在: ${entry.script}`, node: entry.node, script: entry.script };
  }
  return { ok: true, node: entry.node, script: entry.script };
}

/** 解析 .env 文本 → {KEY: value}：跳过空行/# 注释/无 = 行；值剥一层成对引号；值内可含 =。 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2)
      || (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** 单变量判定：非空、（可选）非占位符。reason 只描述形态，绝不回显值。 */
export function assessEnvValue(value, { placeholder } = {}) {
  if (value === undefined || value === '') return { ok: false, reason: '缺失或空' };
  if (placeholder !== undefined && value === placeholder) {
    return { ok: false, reason: `仍是占位符(${placeholder})——等效未配置` };
  }
  return { ok: true };
}

/** 扫描目录下 *.db（附 stat），按新→旧排序；目录不存在返回 null（与「存在但无 .db」的 [] 区分）。 */
export function scanDbs(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue;
    const abs = join(dir, name);
    entries.push({ name, path: abs, mtimeMs: statSync(abs).mtimeMs });
  }
  return entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 取 mtime 最新者；空数组返回 null（目录无 .db 的 fail 信号）。 */
export function pickNewest(entries) {
  if (entries.length === 0) return null;
  return entries.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
}

/** 距今天数（浮点，调用方自行 toFixed）。 */
export function ageDays(mtimeMs, nowMs) {
  return (nowMs - mtimeMs) / 86_400_000;
}

/** `git status --porcelain` 输出判净：全空白 = 干净。 */
export function isPorcelainClean(stdout) {
  return stdout.trim() === '';
}

// ── 运行时层（真实 crontab/.env/git 调用；单元测试不覆盖，真机实跑兜底）──

/** 包一层 execFileSync：非零退出不抛，返回 {ok,stdout,stderr,ms}——stderr 进日志（§9），不丢现场。 */
function exec(cmd, args, opts = {}) {
  const t0 = Date.now();
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
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

/** 检查 1：crontab backup-export 行（node 绝对路径 + 行内脚本存在）。返回 fail 原因或 null。 */
function checkCrontab() {
  const name = 'crontab';
  const t0 = Date.now();
  const cron = exec('crontab', ['-l']);
  if (!cron.ok) {
    console.error(`[check:${name}] crontab -l → 非零退出 stderr="${cron.stderr}" (fail, ${cron.ms}ms)`);
    return `crontab -l 失败（当前用户无 crontab?）: ${cron.stderr}`;
  }
  const line = findBackupExportLine(cron.stdout.split('\n'));
  if (line === null) {
    console.error(`[check:${name}] crontab -l 输出 ${cron.stdout.split('\n').filter(Boolean).length} 行,无 backup-export 行 (fail, ${Date.now() - t0}ms)`);
    return `crontab 无 backup-export 行——每日异地导出没挂（crontab -e 补挂,node 用绝对路径）`;
  }
  const verdict = assessCronEntry(line, existsSync);
  const elapsed = Date.now() - t0;
  if (!verdict.ok) {
    console.error(`[check:${name}] 行="${line}" → FAIL ${verdict.reason} (${elapsed}ms)`);
    return `crontab backup-export 行不合规: ${verdict.reason}`;
  }
  console.log(`[check:${name}] backup-export 行在,node=${verdict.node},脚本=${verdict.script} 存在 → PASS (${elapsed}ms)`);
  return null;
}

/** 检查 2：主检出 .env（token 非空非占位符 + webhook 非空；值绝不打印）。 */
function checkMainEnv() {
  const name = 'env';
  const t0 = Date.now();
  if (!existsSync(MAIN_ENV_PATH)) {
    console.error(`[check:${name}] .env 不存在: ${MAIN_ENV_PATH} (fail, ${Date.now() - t0}ms)`);
    return `主检出 .env 不存在: ${MAIN_ENV_PATH}`;
  }
  const env = parseEnvFile(readFileSync(MAIN_ENV_PATH, 'utf8'));
  const token = assessEnvValue(env.COLLECTOR_TOKEN, { placeholder: TOKEN_PLACEHOLDER });
  const webhook = assessEnvValue(env.COLLECTOR_BACKUP_WEBHOOK_URL);
  const elapsed = Date.now() - t0;
  const problems = [];
  if (!token.ok) problems.push(`COLLECTOR_TOKEN ${token.reason}`);
  if (!webhook.ok) problems.push(`COLLECTOR_BACKUP_WEBHOOK_URL ${webhook.reason}`);
  if (problems.length > 0) {
    console.error(`[check:${name}] ${MAIN_ENV_PATH} → FAIL ${problems.join('; ')} (值不打印, ${elapsed}ms)`);
    return `主检出 .env 不合规: ${problems.join('; ')}`;
  }
  console.log(`[check:${name}] ${MAIN_ENV_PATH} COLLECTOR_TOKEN 已设置(非空,非占位符) / COLLECTOR_BACKUP_WEBHOOK_URL 非空 → PASS (${elapsed}ms)`);
  return null;
}

/** 检查 3：B 站 cookie 文件（存在即过；mtime 过期天数供人工判读）。 */
function checkCookie() {
  const name = 'cookie';
  const t0 = Date.now();
  if (!existsSync(COOKIE_PATH)) {
    console.error(`[check:${name}] cookie 文件不存在: ${COOKIE_PATH} (fail, ${Date.now() - t0}ms)`);
    return `B 站 cookie 文件不存在: ${COOKIE_PATH}（路径单源见 scripts/bili-cookie-from-chrome.mjs DEFAULT_OUT）`;
  }
  const days = ageDays(statSync(COOKIE_PATH).mtimeMs, Date.now());
  console.log(`[check:${name}] ${COOKIE_PATH} 存在,mtime 距今 ${days.toFixed(1)} 天 → PASS (${Date.now() - t0}ms)`);
  if (days > 30) {
    console.log(`[check:${name}] warning: cookie 已 ${days.toFixed(0)} 天未刷新——过期与否以实际采集为准,过旧建议重跑 bili-cookie-from-chrome.mjs`);
  }
  return null;
}

/** 检查 4：异地目录最新 .db 时新性（< 48h）。 */
function checkOffsite(dir) {
  const name = 'offsite';
  const t0 = Date.now();
  const entries = scanDbs(dir);
  if (entries === null) {
    console.error(`[check:${name}] 目录不存在: ${dir} (fail, ${Date.now() - t0}ms)`);
    return `异地备份目录不存在: ${dir}`;
  }
  const newest = pickNewest(entries);
  if (newest === null) {
    console.error(`[check:${name}] 目录内无 .db: ${dir} (fail, ${Date.now() - t0}ms)`);
    return `异地备份目录内无 .db 文件: ${dir}`;
  }
  const ageMs = Date.now() - newest.mtimeMs;
  const elapsed = Date.now() - t0;
  if (ageMs >= OFFSITE_MAX_AGE_MS) {
    console.error(`[check:${name}] 最新=${newest.name} 距今 ${(ageMs / 3_600_000).toFixed(1)}h ≥ 48h (fail, ${elapsed}ms)`);
    return `异地最新副本距现已 ${(ageMs / 3_600_000).toFixed(1)}h,超 48h 阈值（最新=${newest.name}）——每日导出 cron 没在跑?（crontab 检查项联动看）`;
  }
  console.log(`[check:${name}] 目录=${dir} 共${entries.length}份 最新=${newest.name} 距今 ${(ageMs / 3_600_000).toFixed(1)}h < 48h → PASS (${elapsed}ms)`);
  return null;
}

/** 检查 5：report 产物仓（是 git 仓 + 工作区干净,A6 断言）。 */
function checkReportGit() {
  const name = 'report-git';
  const t0 = Date.now();
  if (!existsSync(join(REPORT_DIR, '.git'))) {
    console.error(`[check:${name}] 非 git 仓（.git 不存在）: ${REPORT_DIR} (fail, ${Date.now() - t0}ms)`);
    return `report 产物仓不是 git 仓（.git 不存在）: ${REPORT_DIR}`;
  }
  const st = exec('git', ['-C', REPORT_DIR, 'status', '--porcelain']);
  if (!st.ok) {
    console.error(`[check:${name}] git status → 非零退出 stderr="${st.stderr}" (fail, ${st.ms}ms)`);
    return `report 仓 git status 执行失败: ${st.stderr}`;
  }
  const elapsed = Date.now() - t0;
  if (!isPorcelainClean(st.stdout)) {
    const n = st.stdout.split('\n').filter(Boolean).length;
    console.error(`[check:${name}] git status --porcelain ${n} 条未提交变更 (fail, ${elapsed}ms)\n${st.stdout.trimEnd()}`);
    return `report 产物仓工作区不干净（${n} 条未提交）: ${REPORT_DIR}`;
  }
  console.log(`[check:${name}] ${REPORT_DIR} 是 git 仓且工作区干净 → PASS (${elapsed}ms)`);
  return null;
}

// ── 入口（仅直接执行时跑;测试 import 本模块取纯函数不触发,对齐 backup-healthcheck.mjs 先例）──

async function main() {
  const offsiteDir = process.env.COLLECTOR_OFFSITE_DIR || DEFAULT_OFFSITE_DIR;
  console.log(`[env-inventory] start offsiteDir=${offsiteDir} mainEnv=${MAIN_ENV_PATH}`);

  const failures = [];
  function runCheck(name, fn) {
    const reason = fn();
    if (reason) failures.push({ name, reason });
  }

  runCheck('crontab', checkCrontab);
  runCheck('env', checkMainEnv);
  runCheck('cookie', checkCookie);
  runCheck('offsite', () => checkOffsite(offsiteDir));
  runCheck('report-git', checkReportGit);

  if (failures.length === 0) {
    console.log('[summary] 5 checks: 0 fail');
    return;
  }
  console.error(`[summary] 5 checks: ${failures.length} fail(${failures.map((f) => f.name).join(', ')})`);
  process.exitCode = 1;
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  await main();
}
