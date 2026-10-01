#!/usr/bin/env node
// 生产库 → 分析原料包一条命令（消费端闭环第一步，docs/plans/consumption-loop.md #1）：
//   ① 容器内 VACUUM INTO 打新快照 → docker cp 到宿主 data/exports/（生产库在 named volume，
//      宿主机严禁直开生产库文件——virtiofs 并发损库前科；docker cp 出来的静态副本只读安全，
//      通道先例 scripts/backup-export.mjs）；
//   ② collector-cli --db <快照绝对路径> export bundle --out <绝对目录> 出包（SKILL.md cwd 陷阱：路径一律绝对）。
//
// 用法：
//   node scripts/export-bundle.mjs --theme <主题> [过滤器...] [--out <dir>] [--max-age-hours <n>] [--force]
//   node scripts/export-bundle.mjs --help
//   - --theme <主题>      缺省输出 analysis/<主题>/bundle/（目录不存在自动建）；快照命名 snapshot-<主题>-<时间戳>.db
//   - --out <dir>         显式输出目录（优先于主题推导；已存在非空需 --force，同 export bundle 语义）
//   - --max-age-hours <n> data/exports/ 内 mtime 最新 .db 快照在 n 小时内则复用不打新（按 mtime 选，绝不按
//     文件名猜——2026-09-22 手工备份名"manual-now"字典序误选事故教训）；无快照/过期则照常打新
//   - --force             透传 export bundle（--out 已存在非空时允许写入）
//   - 其余参数全量透传 collector-cli export bundle（--creator/--tags/--tag/--source/--since/--until/
//     --limit/--track/--has-subtitle/--track-type/--lang/--q/--subtitle-q/--tid/--tname/--min-view/
//     --max-view/--min-duration/--max-duration/--sort/--desc/--name-order）
// 退出码：0 成功 / 2 用法错 / 3 快照失败（docker exec/cp）/ 其余=CLI 语义码透传（1 运行时 2 参数 4 库不可读…）。
// 日志纪律（CLAUDE.md §9）：stdout 只透传 CLI 机器可读回执；stderr 分步 [export-bundle] [snapshot]/[export]/[done]，
// 任何失败必带「跑了什么命令 + 什么错」，不允许裸失败。不自动删除任何旧快照。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = 'collector-server';
const CONTAINER_DB = '/data/bilibili-collector.db';
const CONTAINER_BACKUP_DIR = '/data/backups';
const EXPORTS_DIR = join(REPO_ROOT, 'data', 'exports');
// CLI 正规调用形态（docs/skills/collector/SKILL.md：禁 pnpm cli——banner 混 stdout；禁 pnpm -s——吞退出码）
const CLI = ['pnpm', '-C', 'apps/collector-server', 'exec', 'tsx', 'src/cli/main.ts'];

const log = (...a) => process.stderr.write(`[export-bundle] ${a.join(' ')}\n`);
const fail = (code, ...a) => { log(...a); process.exit(code); };

// ── 参数解析：自有 --theme/--out/--max-age-hours/--help，其余 token 原样透传 ──
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`用法: node scripts/export-bundle.mjs --theme <主题> [过滤器...] [--out <dir>] [--max-age-hours <n>] [--force]

生产库快照(容器内 VACUUM INTO → docker cp 到 data/exports/)后用 collector-cli --db <快照> export bundle 出包。

选项:
  --theme <主题>        缺省输出 analysis/<主题>/bundle/;快照命名 snapshot-<主题>-<时间戳>.db
  --out <dir>           显式输出目录(优先于主题推导;已存在非空需 --force)
  --max-age-hours <n>   data/exports/ 内 mtime 最新 .db 快照在 n 小时内则复用(按 mtime 不按文件名),否则打新快照
  --force               透传 export bundle(--out 已存在非空时允许写入)
  -h, --help            本帮助

过滤器(全量透传 collector-cli export bundle,同 videos list 无分页):
  --creator --tags --tag --source --q --subtitle-q --since --until --tid --tname --lang
  --track-type --has-subtitle --min-duration --max-duration --min-view --max-view
  --limit --track --sort --desc --name-order

示例:
  node scripts/export-bundle.mjs --theme 美国加息 --tags "美联储,加息" --has-subtitle
  node scripts/export-bundle.mjs --theme 某UP分析 --creator "某UP" --max-age-hours 24
`);
  process.exit(0);
}

// 取 --flag 的值（下一个 token）；缺值直接参数错退 2。
function valueOf(flag) {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) fail(2, `参数错: ${flag} 缺值（后面紧跟的是: ${v ?? '<参数表末尾>'}）`);
  return v;
}

const theme = valueOf('--theme');
const outArg = valueOf('--out');
const maxAgeRaw = valueOf('--max-age-hours');
let maxAgeHours;
if (maxAgeRaw !== undefined) {
  maxAgeHours = Number(maxAgeRaw);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    fail(2, `参数错: --max-age-hours 不是合法非负数字: ${maxAgeRaw}`);
  }
}

if (!theme && !outArg) {
  fail(2, '参数错: --theme 与 --out 至少给一个（--theme 决定缺省输出 analysis/<主题>/bundle/ 与快照命名）');
}

// CLI 全局选项由脚本统一接管，不透传（--db 固定指向快照；--server 对 bundle 无效——DB-only 命令）。
const RESERVED = new Set(['--db', '--server', '--token', '--format', '-q', '--quiet']);
const OWN = new Set(['--theme', '--out', '--max-age-hours']);
const passthrough = [];
for (let i = 0; i < argv.length; i++) {
  if (OWN.has(argv[i])) { i++; continue; } // 自有 flag 连值跳过（值缺失已在 valueOf 拦下）
  if (RESERVED.has(argv[i])) {
    fail(2, `参数错: ${argv[i]} 不透传（--db 由脚本固定指向快照;查生产用本脚本即可,无需 --server/--token）`);
  }
  passthrough.push(argv[i]);
}

// 主题 slug：只留字母/数字/中日韩文/下划线/连字符，其余折叠成 -（只用于快照命名，输出目录仍用原始主题名）
const slug = (theme ?? 'manual').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'manual';
const outDir = resolve(outArg ?? join(REPO_ROOT, 'analysis', theme, 'bundle'));

// ── [snapshot] 快照获取 ──

// data/exports/ 内 mtime 最新的 .db（绝不按文件名猜——backup-export.mjs 同款纪律）。
function latestSnapshot() {
  if (!existsSync(EXPORTS_DIR)) return null;
  const dbs = readdirSync(EXPORTS_DIR).filter((f) => f.endsWith('.db'));
  if (dbs.length === 0) return null;
  const withM = dbs.map((f) => {
    const p = join(EXPORTS_DIR, f);
    return { path: p, mtimeMs: statSync(p).mtimeMs, size: statSync(p).size };
  });
  withM.sort((a, b) => b.mtimeMs - a.mtimeMs); // 新 → 旧
  return withM[0];
}

function fmtAge(ms) {
  const h = ms / 3600e3;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.max(0, ms / 60e3).toFixed(1)}min`;
}

let snapshot = null; // { path, reused }

if (maxAgeHours !== undefined) {
  const fresh = latestSnapshot();
  if (!fresh) {
    log(`[snapshot] ${EXPORTS_DIR} 无 .db 快照，打新快照`);
  } else {
    const ageMs = Date.now() - fresh.mtimeMs;
    const mb = (fresh.size / 1024 / 1024).toFixed(1);
    if (ageMs <= maxAgeHours * 3600e3) {
      log(`[snapshot] 复用快照: ${fresh.path} (${mb}MB, mtime ${fmtAge(ageMs)} 前 ≤ ${maxAgeHours}h)`);
      snapshot = { path: fresh.path, reused: true };
    } else {
      log(`[snapshot] 最新快照 ${fresh.path} (${mb}MB) 已 ${fmtAge(ageMs)} 前 > ${maxAgeHours}h，打新快照`);
    }
  }
}

if (!snapshot) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const containerPath = `${CONTAINER_BACKUP_DIR}/snapshot-${slug}-${ts}.db`;
  // 容器内 VACUUM INTO：经 node + better-sqlite3（SKILL.md「容器内 exec」同款通道）。
  // 路径经 JSON.stringify 注入 JS 字面量，execFileSync 走参数数组不经 shell，主题含特殊字符也安全。
  // SQL 侧目标必须是字符串字面量：VACUUM INTO '<path>'（不带引号会 near "/": syntax error）。
  const vacuumCode = `const db=require("better-sqlite3")(${JSON.stringify(CONTAINER_DB)},{readonly:true});`
    + `db.exec("VACUUM INTO '"+${JSON.stringify(containerPath)}.replaceAll("'","''")+"'");db.close();console.log("snapshot-ok")`;
  log(`[snapshot] 新打快照: docker exec ${CONTAINER} node -e '<VACUUM INTO ${containerPath}>'`);
  let out;
  try {
    out = execFileSync('docker', ['exec', CONTAINER, 'node', '-e', vacuumCode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = [
      `跑了: docker exec ${CONTAINER} node -e <vacuum ${containerPath}>`,
      `错误: ${e.message}`,
      e.stdout ? `容器 stdout: ${String(e.stdout).trim()}` : null,
      e.stderr ? `容器 stderr: ${String(e.stderr).trim()}` : null,
      '排查: 容器 collector-server 未起(docker ps)/docker 不可用/目标重名(VACUUM INTO 不覆盖已有文件)',
    ].filter(Boolean).join('\n[export-bundle] [snapshot]   ');
    fail(3, `[snapshot] ✗ 容器内 VACUUM INTO 失败:\n[export-bundle] [snapshot]   ${detail}`);
  }
  log(`[snapshot] 容器回执: ${out.trim().split('\n').pop()}（${CONTAINER_DB} → ${containerPath}）`);
  if (!existsSync(EXPORTS_DIR)) mkdirSync(EXPORTS_DIR, { recursive: true });
  try {
    execFileSync('docker', ['cp', `${CONTAINER}:${containerPath}`, `${EXPORTS_DIR}/`], { stdio: 'pipe' });
  } catch (e) {
    fail(3, `[snapshot] ✗ docker cp 失败（跑了: docker cp ${CONTAINER}:${containerPath} ${EXPORTS_DIR}/）: ${e.message}`);
  }
  const snapPath = join(EXPORTS_DIR, `snapshot-${slug}-${ts}.db`);
  if (!existsSync(snapPath)) {
    fail(3, `[snapshot] ✗ docker cp 声称成功但宿主未见 ${snapPath}——查 ${EXPORTS_DIR} 权限/容器路径挂载`);
  }
  const st = statSync(snapPath);
  if (st.size === 0) {
    fail(3, `[snapshot] ✗ 快照落地 0 字节: ${snapPath}——VACUUM INTO 可能静默失败,勿用此副本`);
  }
  log(`[snapshot] ✓ 新快照: ${snapPath} (${(st.size / 1024 / 1024).toFixed(1)}MB)`);
  snapshot = { path: snapPath, reused: false };
}

// ── [export] collector-cli export bundle ──

const cliArgs = ['--db', snapshot.path, 'export', 'bundle', '--out', outDir, ...passthrough];
log(`[export] 跑: ${CLI.join(' ')} ${cliArgs.map((a) => JSON.stringify(a)).join(' ')}`);

let stdout;
try {
  stdout = execFileSync(CLI[0], [...CLI.slice(1), ...cliArgs], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  const code = typeof e.status === 'number' ? e.status : 1;
  const detail = [
    `跑了: ${CLI.join(' ')} ${cliArgs.map((a) => JSON.stringify(a)).join(' ')}`,
    `CLI 退出码: ${code}`,
    e.stdout ? `CLI stdout: ${String(e.stdout).trim()}` : null,
    e.stderr ? `CLI stderr: ${String(e.stderr).trim()}` : null,
  ].filter(Boolean).join('\n[export-bundle] [export]   ');
  fail(code, `[export] ✗ collector-cli 失败:\n[export-bundle] [export]   ${detail}`);
}

// stdout 只透传 CLI 机器可读回执（原样，不二次包装）
process.stdout.write(stdout);

// 回执解析只为 [done] 日志计数；解析失败不掩盖已完成的导出（stderr 注明即可）
try {
  const r = JSON.parse(stdout);
  log(`[export] 回执: 命中 ${r.videos_total} / 导出 ${r.exported}（有轨 ${r.with_subtitle} / 无轨 ${r.without_subtitle}）/ 文件 ${r.files}`);
} catch (e) {
  log(`[export] ⚠ 回执 JSON 解析失败(${e.message})——导出已完成,stdout 已原样透传,请人工核对`);
}

log(`[done] 原料包就绪: ${outDir}（${snapshot.reused ? '复用' : '新'}快照 ${snapshot.path}）`);
