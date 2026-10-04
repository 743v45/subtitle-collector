#!/usr/bin/env node
// 生产全链路真值冒烟（2026-10-04 改造项 C2）：真实 server 派发 → 用户真实 Chrome 扩展采集 →
// collect_tasks 落 succeeded → 字幕入库 → export bundle 非空,一条命令闭环验真。
// 与切段验收的分工:verify-collector/verify-active-collect 是 puppeteer mock 冒烟,verify-deployed
// 是只读 API 段——「派发→采集→入库→导出」闭环此前零覆盖,本工具补位。
//
// 用法:
//   node scripts/verify-full-chain.mjs --server <url> --token <t> [--bvid <BV…>] [--timeout <秒>]
//   - --server  缺省 http://127.0.0.1:21527(生产容器 collector-server)
//   - --token   Bearer;也可走环境变量 COLLECTOR_TOKEN(读取使用,绝不打印)
//   - --bvid    显式指定目标;缺省取最近一条 succeeded 的 bilibili 任务 source_vid(允许重采)
//   - --timeout 轮询上限秒数,缺省 135
// 步骤:①前置在线检查(GET /api/clients,须有 connected 且派发未关的扩展)→②目标选取→③建任务
//   (POST /api/collect-tasks)→④每 5s 轮询至终态→⑤快照通道(容器内 VACUUM INTO+docker cp——
//   生产库唯一合法读取方式,宿主机禁直开生产库,virtiofs 红线)跑 bundle 导出 --limit 1 并断言
//   manifest.json/ANALYZE.md/videos/*.txt 全存在且非空→⑥删除本脚本所建任务(created:true 才删)。
// 退出码:0 全链路通过 / 1 参数·基础设施·导出断言·清理失败 / 2 扩展离线或派发已关闭(即刻退出
//   不空转) / 3 created:false 复用既有在途任务(防线:非本脚本所建,绝不写/删) / 4 采集任务超时或
//   failed/limited / 5 无 succeeded 任务可作目标(需 --bvid)。
// 日志:stdout 每步 [步骤] 前缀 + 耗时(CLAUDE.md §9);临时目录用后必清理,容器内快照文件同删。

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = 'collector-server';
const CONTAINER_DB = '/data/bilibili-collector.db';
// CLI 正规调用形态(docs/skills/collector/SKILL.md:禁 pnpm cli——banner 混 stdout;禁 pnpm -s——吞退出码)
const CLI = ['pnpm', '-C', 'apps/collector-server', 'exec', 'tsx', 'src/cli/main.ts'];
const POLL_INTERVAL_MS = 5000;

// ── 纯逻辑(导出供单测;main 流程见下半) ──

export const BV_RE = /^BV[0-9A-Za-z]{10}$/; // 口径对齐 server tasks.ts VID_RE.bilibili

// 目标选取:--bvid 显式优先(校验 BV 形态);否则从任务列表 items(可能含批次补全的非 succeeded
// 成员,须逐行过滤)取第一条 succeeded+bilibili+BV 形态的 source_vid。
export function pickBvid(explicit, items) {
  if (explicit != null && explicit !== '') {
    if (!BV_RE.test(explicit)) return { ok: false, error: `--bvid 非 BV 号格式(应形如 BV1xx411c7mD): ${explicit}` };
    return { ok: true, bvid: explicit, from: '显式 --bvid' };
  }
  const hit = (Array.isArray(items) ? items : []).find(
    (t) => t?.source === 'bilibili' && t?.status === 'succeeded' && BV_RE.test(String(t?.source_vid ?? '')),
  );
  if (!hit) return { ok: false, error: '无 succeeded 的 bilibili 任务可作目标' };
  return { ok: true, bvid: hit.source_vid, from: `最近 succeeded 任务 id=${hit.id}` };
}

// 轮询状态判定:succeeded→done;failed/limited→fail(带 error 字段);pending/dispatched→继续等;其余→unknown(等满超时,日志可见)
export function classifyTaskStatus(status) {
  if (status === 'succeeded') return 'done';
  if (status === 'failed' || status === 'limited') return 'fail';
  if (status === 'pending' || status === 'dispatched') return 'wait';
  return 'unknown';
}

// created 分支决策(POST /api/collect-tasks 响应):created:true→本脚本所建可清理;
// created:false→复用既有在途任务(findActiveTask 命中 pending/dispatched),防线约定绝不写/删;形态不符→invalid。
export function decideCreatedBranch(resp) {
  if (resp?.ok !== true || typeof resp.task?.id !== 'number') return { branch: 'invalid' };
  if (resp.created === false) return { branch: 'reused', taskId: resp.task.id };
  if (resp.created === true) return { branch: 'created', taskId: resp.task.id };
  return { branch: 'invalid' };
}

// bundle 产物断言:manifest.json/ANALYZE.md 必在且非空;videos/ 至少一条 .txt 且所有 .txt 非空
// (export bundle --limit 1 出 0 条视频即链路断言失败)。entries=[{path 相对路径, size 字节}]。
export function auditBundleFiles(entries) {
  const problems = [];
  const byPath = new Map(entries.map((e) => [e.path, e.size]));
  for (const required of ['manifest.json', 'ANALYZE.md']) {
    const size = byPath.get(required);
    if (size === undefined) problems.push(`缺少 ${required}`);
    else if (!(size > 0)) problems.push(`${required} 为空(0 字节)`);
  }
  const txts = entries.filter((e) => /^videos\/[^/]+\.txt$/.test(e.path));
  if (txts.length === 0) problems.push('videos/ 下无任何 .txt(导出 0 条视频——「字幕入库→bundle 非空」断言失败)');
  const emptyTxt = txts.filter((t) => !(t.size > 0));
  for (const t of emptyTxt) problems.push(`${t.path} 为空(0 字节)`);
  const minTxt = txts.length ? Math.min(...txts.map((t) => t.size)) : 0;
  const summary = [
    `manifest.json=${byPath.get('manifest.json') ?? '缺失'}B`,
    `ANALYZE.md=${byPath.get('ANALYZE.md') ?? '缺失'}B`,
    `videos/*.txt ${txts.length} 个(最小 ${minTxt}B)`,
  ];
  return { ok: problems.length === 0, problems, summary };
}

// 递归列目录为 [{path, size}](bundle 根两层结构,手写免依赖 Node 版本行为)
export function listFilesWithSize(root, rel = '') {
  const out = [];
  for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...listFilesWithSize(root, r));
    else out.push({ path: r, size: statSync(join(root, r)).size });
  }
  return out;
}

// ── CLI 主流程(仅直接运行时执行,isMain 守卫对齐 quality-baseline.mjs 先例) ──

const log = (...a) => process.stdout.write(`[chain] ${a.join(' ')}\n`);
const failLog = (code, ...a) => { log(...a); return code; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const argOf = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
  };
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    server: argOf('server') ?? 'http://127.0.0.1:21527',
    token: argOf('token') ?? process.env.COLLECTOR_TOKEN,
    bvid: argOf('bvid'),
    timeoutSec: argOf('timeout') === undefined ? 135 : Number(argOf('timeout')),
  };
}

function usage() {
  log(`用法: node scripts/verify-full-chain.mjs --server <url> --token <t> [--bvid <BV…>] [--timeout <秒>]

生产全链路真值冒烟:server 派发 → 用户 Chrome 扩展采集 → 任务 succeeded → 快照通道 export bundle --limit 1 非空。

选项:
  --server <url>    缺省 http://127.0.0.1:21527
  --token <t>       Bearer token(或环境变量 COLLECTOR_TOKEN;读取使用,不打印)
  --bvid <BV…>      显式目标;缺省取最近 succeeded 的 bilibili 任务(允许重采)
  --timeout <秒>    轮询上限,缺省 135
  -h, --help        本帮助

退出码:0 通过 / 1 参数·基础设施·断言·清理失败 / 2 扩展离线或派发关闭 / 3 created:false 复用在途 / 4 超时或 failed/limited / 5 无 succeeded 任务(需 --bvid)`);
}

// Bearer fetch 封装(对齐 verify-deployed 风格;token 只进请求头,绝不打印/落盘)。
// 网络异常归一为 status=0,上层统一按失败分支打日志,不 throw 打断流程。
function makeApi(server, token) {
  return async (method, path, body) => {
    try {
      const r = await fetch(`${server}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await r.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* 非 JSON 保持 null,上层打 text 摘要 */ }
      return { status: r.status, data, text };
    } catch (e) {
      return { status: 0, data: null, text: `请求失败: ${String(e?.message ?? e)}` };
    }
  };
}

// 步骤①:前置在线检查——没有「在线且派发未关」的扩展即刻 exit 2,绝不空转等待
// (扩展客户端连不上找用户在 popup 操作,AI 不自行拉 Chrome,见 memory 纪律)。
async function preflight(api) {
  const t = Date.now();
  const r = await api('GET', '/api/clients');
  if (r.status !== 200 || r.data?.ok !== true) {
    return { code: failLog(1, `[preflight] ✗ GET /api/clients 失败(HTTP ${r.status}): ${r.text.slice(0, 160)}`) };
  }
  const clients = Array.isArray(r.data.clients) ? r.data.clients : [];
  const ready = clients.filter((c) => c.connected === true && c.task_dispatch_enabled !== false);
  if (ready.length === 0) {
    log('[preflight] ✗ 扩展离线(或派发已关闭)——真值链路需用户 Chrome 扩展在线(.popup 操作纪律,AI 不自行拉 Chrome)');
    for (const c of clients) {
      log(`[preflight]   client=${c.client_id}(${c.client_name ?? '无名'}) connected=${c.connected} task_dispatch_enabled=${c.task_dispatch_enabled}`);
    }
    return { code: 2 };
  }
  log(`[preflight] ✓ 可派发客户端: ${ready.map((c) => `${c.client_id}(${c.client_name ?? '无名'} v${c.ext_version ?? '?'})`).join(', ')}(${Date.now() - t}ms)`);
  return { client: ready[0] };
}

// 步骤②:目标选取
async function pickTarget(api, explicit) {
  const t = Date.now();
  if (explicit) {
    const picked = pickBvid(explicit, []);
    if (!picked.ok) return { code: failLog(1, `[target] ✗ ${picked.error}`) };
    log(`[target] 目标 bvid=${picked.bvid}(显式 --bvid)`);
    return { bvid: picked.bvid };
  }
  const r = await api('GET', '/api/collect-tasks?status=succeeded&source=bilibili&limit=10');
  if (r.status !== 200 || r.data?.ok !== true) {
    return { code: failLog(1, `[target] ✗ 任务列表查询失败(HTTP ${r.status}): ${r.text.slice(0, 160)}`) };
  }
  const picked = pickBvid(null, r.data.items);
  if (!picked.ok) return { code: failLog(5, '[target] ✗ 无 succeeded 的 bilibili 任务可作为采集目标——请 --bvid <BV…> 显式指定') };
  log(`[target] 目标 bvid=${picked.bvid}(${picked.from},${Date.now() - t}ms)`);
  return { bvid: picked.bvid };
}

// 步骤④:每 5s 轮询单任务至终态;failed/limited 打 error 即刻退 4;超时退 4。
// 轮询本身异常(网络抖动/瞬时 5xx)不致命,打日志继续等,超时兜底。
async function pollUntilDone(api, taskId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const t0 = Date.now();
  for (;;) {
    const r = await api('GET', `/api/collect-tasks/${taskId}`);
    if (r.status === 200 && r.data?.ok === true && r.data.task) {
      const task = r.data.task;
      const cls = classifyTaskStatus(task.status);
      log(`[poll] id=${taskId} status=${task.status}${task.error ? ` error=${task.error}` : ''}(${Date.now() - t0}ms)`);
      if (cls === 'done') return 0;
      if (cls === 'fail') return failLog(4, `[poll] ✗ 任务终态失败 status=${task.status} error=${task.error ?? '(无 error 字段)'}`);
    } else {
      log(`[poll] ⚠ 轮询异常(继续等): HTTP ${r.status} ${r.text.slice(0, 120)}`);
    }
    if (Date.now() >= deadline) return failLog(4, `[poll] ✗ 超时(>${timeoutSec}s)任务未到 succeeded——扩展采集未完成或派发链路卡住`);
    await sleep(POLL_INTERVAL_MS);
  }
}

// 步骤⑤辅助:快照通道——容器内 VACUUM INTO 到 /tmp + docker cp 到宿主临时目录
// (export-bundle.mjs 同款;生产库在 named volume,宿主机严禁直开,静态副本只读安全)。
function takeSnapshot(tmpRoot) {
  const containerPath = `/tmp/verify-full-chain-snapshot-${Date.now()}-${process.pid}.db`;
  const hostPath = join(tmpRoot, basename(containerPath));
  const vacuumCode = `const db=require("better-sqlite3")(${JSON.stringify(CONTAINER_DB)},{readonly:true});`
    + `db.exec("VACUUM INTO '${containerPath}'");db.close();console.log("snapshot-ok")`;
  log(`[snapshot] docker exec ${CONTAINER} node -e '<VACUUM INTO ${containerPath}>'`);
  let out;
  try {
    out = execFileSync('docker', ['exec', CONTAINER, 'node', '-e', vacuumCode], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`容器内 VACUUM INTO 失败(查 docker ps / 容器 ${CONTAINER} 是否在跑): ${e.message}; stderr=${String(e.stderr ?? '').slice(0, 200)}`);
  }
  log(`[snapshot] 容器回执: ${out.trim().split('\n').pop()}`);
  try {
    execFileSync('docker', ['cp', `${CONTAINER}:${containerPath}`, hostPath], { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`docker cp 失败(跑了: docker cp ${CONTAINER}:${containerPath} ${hostPath}): ${e.message}`);
  }
  const size = statSync(hostPath).size; // cp 声称成功但宿主未见 → 这里 throw,上层归为基础设施失败
  log(`[snapshot] ✓ 快照落宿主临时目录: ${hostPath}(${(size / 1024 / 1024).toFixed(1)}MB)`);
  try {
    execFileSync('docker', ['exec', CONTAINER, 'rm', '-f', containerPath], { stdio: 'pipe' });
  } catch (e) {
    log(`[snapshot] ⚠ 容器内快照清理失败(残留 ${containerPath}): ${e.message}`);
  }
  return hostPath;
}

// 步骤⑤:快照 → bundle 导出 --limit 1 → 文件清单断言;临时目录 finally 清理。
function exportAndAssert() {
  const t = Date.now();
  const tmpRoot = mkdtempSync(join(tmpdir(), 'verify-full-chain-'));
  try {
    const snapPath = takeSnapshot(tmpRoot);
    const outDir = join(tmpRoot, 'bundle');
    const cliArgs = [...CLI.slice(1), '--db', snapPath, 'export', 'bundle', '--out', outDir, '--limit', '1'];
    log(`[export] 跑: ${CLI[0]} ${cliArgs.map((a) => JSON.stringify(a)).join(' ')}`);
    let stdout;
    try {
      stdout = execFileSync(CLI[0], cliArgs, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return failLog(1, `[export] ✗ collector-cli export bundle 失败(退出码 ${e.status}): ${e.message}\n[export]   stdout: ${String(e.stdout ?? '').trim().slice(0, 200)}\n[export]   stderr: ${String(e.stderr ?? '').trim().slice(0, 200)}`);
    }
    // 回执解析只为日志计数;解析失败不掩盖后续文件断言
    let receipt = null;
    try { receipt = JSON.parse(stdout); } catch { log(`[export] ⚠ 回执非 JSON(前 120 字: ${stdout.slice(0, 120)})`); }
    if (receipt) log(`[export] 回执: 导出 ${receipt.exported}/${receipt.videos_total},文件 ${receipt.files}(${Date.now() - t}ms)`);
    const audit = auditBundleFiles(listFilesWithSize(outDir));
    for (const line of audit.summary) log(`[assert] ${audit.ok ? '✓' : '✗'} ${line}`);
    for (const p of audit.problems) log(`[assert] ✗ ${p}`);
    if (!audit.ok) return failLog(1, '[assert] ✗ bundle 产物断言未过——「字幕入库→导出非空」闭环存疑');
    log(`[assert] ✓ bundle 产物断言通过(${Date.now() - t}ms)`);
    return 0;
  } catch (e) {
    return failLog(1, `[export] ✗ 快照/导出阶段异常: ${String(e?.message ?? e)}`);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    log(`[tmp] 临时目录已清理: ${tmpRoot}`);
  }
}

// 步骤③-⑤串联:建任务(created:false 防线:复用在途任务绝不写/删,直接退 3)→轮询→导出断言
async function runChain(api, bvid, timeoutSec, state) {
  const t = Date.now();
  const created = await api('POST', '/api/collect-tasks', { text: `https://www.bilibili.com/video/${bvid}` });
  if (created.status !== 200 || created.data?.ok !== true) {
    return failLog(1, `[create] ✗ POST /api/collect-tasks HTTP ${created.status}: ${created.text.slice(0, 160)}`);
  }
  const decision = decideCreatedBranch(created.data);
  if (decision.branch === 'invalid') {
    return failLog(1, `[create] ✗ 响应形态不符(缺 task.id / created): ${JSON.stringify(created.data).slice(0, 160)}`);
  }
  if (decision.branch === 'reused') {
    log(`[create] created:false——该视频已有在途任务 id=${decision.taskId}(pending/dispatched),非本脚本所建`);
    return failLog(3, '[create] 按防线约定不对该任务做任何写/删操作,直接退出(可待其在途结束后重跑)');
  }
  state.createdByUs = true;
  state.taskId = decision.taskId;
  log(`[create] ✓ created:true id=${state.taskId} bvid=${bvid}(${Date.now() - t}ms)`);
  const pollCode = await pollUntilDone(api, state.taskId, timeoutSec);
  if (pollCode !== 0) return pollCode;
  return exportAndAssert();
}

// 参数校验(抽出降 main 圈复杂度):返回 { error, exitCode } 或 { args }
export function validateArgs(args) {
  if (args.help) return { args, help: true };
  if (!args.token) return { error: '[args] ✗ 缺 token:--token <t> 或环境变量 COLLECTOR_TOKEN(读取使用,不打印)', exitCode: 1 };
  if (!Number.isFinite(args.timeoutSec) || args.timeoutSec <= 0) return { error: `[args] ✗ --timeout 非法: ${args.timeoutSec}(须正数秒)`, exitCode: 1 };
  return { args };
}

// 收场清理:只删本脚本 created:true 的任务;失败路径也清理(超时残留的在途任务会让下一轮
// 同 bvid 命中 created:false 防线,清掉才可重跑)。删除失败把 0 抬成 1(清理不干净须人工)。
async function cleanupTask(api, state) {
  if (!state.createdByUs || state.taskId == null) return 0;
  const del = await api('DELETE', `/api/collect-tasks/${state.taskId}`);
  if (del.status === 200 && del.data?.ok === true) { log(`[cleanup] ✓ 已删除冒烟任务 id=${state.taskId}`); return 0; }
  if (del.status === 404) { log(`[cleanup] 任务 id=${state.taskId} 已不存在(404),视为已清理`); return 0; }
  log(`[cleanup] ⚠ 删除冒烟任务 id=${state.taskId} 失败: HTTP ${del.status} ${del.text.slice(0, 120)}——请人工清理,防下轮 created:false`);
  return 1;
}

async function main(argv) {
  const args = parseArgs(argv);
  const v = validateArgs(args);
  if (v.error) return failLog(v.exitCode, v.error);
  if (v.help) { usage(); return 0; }
  const t0 = Date.now();
  log(`verify-full-chain 开始 server=${args.server} timeout=${args.timeoutSec}s bvid=${args.bvid ?? '(自动选取)'}`);
  const api = makeApi(args.server, args.token);

  const pre = await preflight(api);
  if (pre.code) return pre.code;
  const tgt = await pickTarget(api, args.bvid);
  if (tgt.code) return tgt.code;

  const state = { taskId: null, createdByUs: false };
  let code = await runChain(api, tgt.bvid, args.timeoutSec, state);
  const cleanupFail = await cleanupTask(api, state);
  if (cleanupFail && code === 0) code = 1;
  log(code === 0 ? `✓ 全链路真值冒烟通过(总耗时 ${Date.now() - t0}ms)` : `✗ 冒烟未通过 exit=${code}(总耗时 ${Date.now() - t0}ms)`);
  return code;
}

// 仅直接运行时执行 CLI(被测试 import 时不执行)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
