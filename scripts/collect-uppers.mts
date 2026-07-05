#!/usr/bin/env tsx
// 多 UP 主批量字幕采集脚本。
// 复用 collector-server 的纯函数：每个 mid upper-videos --all 全量拉列表 → dedupe 判重 → 对 missing 串行 fetch-subtitle。
// 字幕采集走 fetch-subtitle（纯 API，不开浏览器页面），每条之间 sleep 防风控。
//
// 用法（从仓库根）：
//   pnpm collect-uppers <mid1> <mid2> ... [--size 30] [--sleep 1000] [--dry-run]
//
// 退出码：0 全部完成（含 no_subtitle 跳过）/ 2 用法错误 / 3 前置不满足（server 或扩展不在线）/ 4 风控或登录态中断。

import { ServerClient } from '../apps/collector-server/src/cli/http.js';
import { resolveConfig } from '../apps/collector-server/src/cli/config.js';
import { openReadonlyDb } from '../apps/collector-server/src/cli/db.js';
import {
  resolveClientId,
  collectUpperVideosAll,
  collectSubtitle,
  collectDedupe,
  type CollectClient,
} from '../apps/collector-server/src/cli/commands/collect.js';

// ─── argv 解析 ───
const argv = process.argv.slice(2);
const mids: string[] = [];
let size = 30;
let sleepMs = 1000;
let dryRun = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--size') size = Number(argv[++i]);
  else if (a === '--sleep') sleepMs = Number(argv[++i]);
  else if (a === '--dry-run') dryRun = true;
  else if (a.startsWith('--')) { console.error(`未知选项: ${a}`); process.exit(2); }
  else mids.push(a);
}
if (mids.length === 0 || !Number.isFinite(size) || !Number.isFinite(sleepMs)) {
  console.error('用法: pnpm collect-uppers <mid1> <mid2> ... [--size 30] [--sleep 1000] [--dry-run]');
  process.exit(2);
}

const cfg = resolveConfig();
const TIMEOUT = 30000; // 字幕采集（view+player+字幕体）给宽于默认 15s
const client = new ServerClient(cfg.serverUrl, cfg.token);

// ─── 前置检查：server 在线 + 扩展已连 ───
if (!await client.ping()) {
  console.error(`server 不在线: ${cfg.serverUrl}（先 pnpm cli server start）`);
  process.exit(3);
}
let clientId: string;
try {
  clientId = await resolveClientId(client as unknown as CollectClient, undefined);
} catch (e) {
  console.error(`扩展未连 server: ${(e as Error).message}（打开装了扩展的浏览器，确认已登录 B 站）`);
  process.exit(3);
}

// ─── 1. 每个 mid 拉全量视频列表（--all 翻页）───
console.error(`[1/3] 拉取 ${mids.length} 个 UP 主的全量视频列表（--all，size=${size}）...`);
const midToBvids = new Map<string, string[]>();
for (const mid of mids) {
  try {
    const resp = await collectUpperVideosAll(client as unknown as CollectClient, clientId, mid, size, TIMEOUT) as {
      result?: { data?: { total?: number; items?: Array<{ bvid: string }> } };
    };
    const items = resp.result?.data?.items ?? [];
    const bvids = items.map((it) => it.bvid).filter(Boolean);
    midToBvids.set(mid, bvids);
    console.error(`  ${mid}: ${bvids.length} 个视频（total=${resp.result?.data?.total ?? bvids.length}）`);
  } catch (e) {
    console.error(`  ${mid}: 拉取失败 - ${(e as Error).message}`);
    midToBvids.set(mid, []);
  }
}

// ─── 2. dedupe 判重（直读 SQLite，DB 路径来自 resolveConfig 绝对解析）───
const allBvids = [...new Set([...midToBvids.values()].flat())];
console.error(`[2/3] 判重 ${allBvids.length} 个 bvid（直读 SQLite）...`);
let missing: string[] = [];
try {
  const db = openReadonlyDb(cfg.dbPath);
  try {
    const d = collectDedupe(db, allBvids);
    missing = d.missing;
    console.error(`  collected=${d.collected.length}  missing=${d.missing.length}`);
  } finally {
    db.close();
  }
} catch (e) {
  console.error(`  DB 读失败: ${(e as Error).message}（全部视为 missing 重采）`);
  missing = allBvids;
}

if (missing.length === 0) {
  console.error('全部已入库，无需采集。');
  process.exit(0);
}
if (dryRun) {
  console.error(`[--dry-run] 将采集 ${missing.length} 个: ${missing.join(' ')}`);
  process.exit(0);
}

// ─── 3. 串行采字幕（fetch-subtitle，纯 API 不开页面；遇风控/未登录即停）───
console.error(`[3/3] 串行采集 ${missing.length} 个视频字幕（sleep ${sleepMs}ms 防风控）...`);
let ok = 0, nosub = 0, fail = 0;
for (const bv of missing) {
  const out = await collectSubtitle(client as unknown as CollectClient, clientId, bv, TIMEOUT) as {
    result?: { error?: string; data?: { reason?: string; tracks?: number } };
  };
  const err = out.result?.error;
  if (err === 'need_login' || err === 'risk_control') {
    console.error(`  ${bv}  STOP: ${err}（请处理后重跑）`);
    process.exit(4);
  }
  if (err) { console.error(`  ${bv}  ERROR=${err}`); fail++; }
  else if (out.result?.data?.reason === 'no_subtitle') { console.error(`  ${bv}  no_subtitle`); nosub++; }
  else { console.error(`  ${bv}  ok  tracks=${out.result?.data?.tracks ?? 0}`); ok++; }
  await new Promise((r) => setTimeout(r, sleepMs));
}

console.error(`===完成: ok=${ok}  no_subtitle=${nosub}  fail=${fail}  共 ${missing.length}===`);
