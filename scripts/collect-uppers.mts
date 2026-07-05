#!/usr/bin/env tsx
// 多 UP 主批量字幕采集脚本。
// 复用 collector-server 的纯函数：每个 mid upper-videos --all 全量拉列表 → dedupe 判重 → 对 missing 串行 fetch-subtitle。
// 字幕采集走 fetch-subtitle（纯 API，不开浏览器页面），每条之间 sleep 防风控。
//
// 用法（从仓库根）：
//   pnpm collect-uppers <mid1> <mid2> ... [--size 30] [--sleep 1000] [--dry-run]
//                        [--after-market | --since <unix秒>] [--retry-nosub] [--category <name>]
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
  collectNosub,
  type CollectClient,
} from '../apps/collector-server/src/cli/commands/collect.js';

// UNIX 秒 → YYYY-MM-DD（视频发布时间展示）。
function fmtDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ─── argv 解析 ───
const argv = process.argv.slice(2);
const mids: string[] = [];
let size = 30;
let sleepMs = 1000;
let dryRun = false;
let afterMarket = false;
let sinceTs: number | undefined;
let retryNosub = false;
let categoryName: string | undefined;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--size') size = Number(argv[++i]);
  else if (a === '--sleep') sleepMs = Number(argv[++i]);
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--after-market') afterMarket = true;
  else if (a === '--since') sinceTs = Number(argv[++i]);
  else if (a === '--retry-nosub') retryNosub = true;
  else if (a === '--category') categoryName = String(argv[++i]);
  else if (a.startsWith('--')) { console.error(`未知选项: ${a}`); process.exit(2); }
  else mids.push(a);
}
// --category 可独立提供 mid（从 DB 该分类下取），故显式 mid 缺省时允许仅给 --category。
if ((!mids.length && !categoryName) || !Number.isFinite(size) || !Number.isFinite(sleepMs)) {
  console.error('用法: pnpm collect-uppers <mid1> <mid2> ... [--size 30] [--sleep 1000] [--dry-run] [--after-market|--since <unix秒>] [--retry-nosub] [--category <name>]');
  process.exit(2);
}

// ─── sinceCreated 计算（--since 覆盖 > --after-market > 不过滤）───
// 「今日收盘后」= 最近交易日 15:00（本地时区）。周一~五=今日；周六=昨日(五)；周日=前日(五)。
// 节假日交易日历不在本脚本范围，由 --since 手动覆盖。
function marketOpenTs(): number {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  let back = 0;
  if (day === 6) back = 1;       // 周六 → 周五
  else if (day === 0) back = 2;  // 周日 → 周五
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  d.setHours(15, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
let sinceCreated: number | undefined;
if (sinceTs != null) sinceCreated = sinceTs;
else if (afterMarket) sinceCreated = marketOpenTs();

const cfg = resolveConfig();
const TIMEOUT = 30000; // 字幕采集（view+player+字幕体）给宽于默认 15s
const client = new ServerClient(cfg.serverUrl, cfg.token);

// ─── 前置检查：server 在线 ───
if (!await client.ping()) {
  console.error(`server 不在线: ${cfg.serverUrl}（先 pnpm cli server start）`);
  process.exit(3);
}

// ─── 0. --category：解析为 categoryId（agent scope）+ 并入该分类下 mid ───
// 在 resolveClientId 之前跑：确定「采什么」先于「怎么采」，且无扩展时也能观察分类解析结果。
let categoryAgentId: number | undefined;
if (categoryName) {
  const authHeaders: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
  const catResp = await fetch(`${cfg.serverUrl}/api/categories?scope=agent`, { headers: authHeaders });
  const catJson = await catResp.json() as { ok: boolean; items?: Array<{ id: number; name: string }> };
  const found = catJson.items?.find((c) => c.name === categoryName);
  if (!found) {
    console.error(`分类不存在（agent scope）: ${categoryName}（先在后台或 POST /api/categories 建分类）`);
    process.exit(2);
  }
  categoryAgentId = found.id;
  // 从 DB（经 HTTP API）取该 agent 分类下的 mid，并入 mids
  const cr = await fetch(`${cfg.serverUrl}/api/creators?category=${encodeURIComponent(categoryName)}&scope=agent&size=100`, { headers: authHeaders });
  const crJson = await cr.json() as { ok: boolean; items?: Array<{ source_uid: string }> };
  for (const it of crJson.items ?? []) if (!mids.includes(it.source_uid)) mids.push(it.source_uid);
  console.error(`[category] agent 分类「${categoryName}」(#${categoryAgentId})，并入后共 ${mids.length} 个 mid`);
  if (mids.length === 0) {
    console.error(`分类「${categoryName}」下无 UP 主，无可采集。`);
    process.exit(0);
  }
}

// ─── 前置检查：扩展已连 server ───
let clientId: string;
try {
  clientId = await resolveClientId(client as unknown as CollectClient, undefined);
} catch (e) {
  console.error(`扩展未连 server: ${(e as Error).message}（打开装了扩展的浏览器，确认已登录 B 站）`);
  process.exit(3);
}

// ─── 1. 每个 mid 拉全量视频列表（--all 翻页）───
console.error(`[1/3] 拉取 ${mids.length} 个 UP 主的全量视频列表（--all，size=${size}${sinceCreated != null ? `，since=${fmtDate(sinceCreated)}` : ''}）...`);
const midToItems = new Map<string, Array<{ bvid: string; created?: number }>>();
for (const mid of mids) {
  try {
    const resp = await collectUpperVideosAll(client as unknown as CollectClient, clientId, mid, size, TIMEOUT, sinceCreated) as {
      result?: { data?: { total?: number; items?: Array<{ bvid: string; created?: number }> } };
    };
    const items = (resp.result?.data?.items ?? []).map((it) => ({ bvid: it.bvid, created: it.created }));
    midToItems.set(mid, items);
    // upper-videos 默认 order=pubdate 倒序，翻页合并后 items[0] 为最新一条。
    const latest = items[0]?.created;
    console.error(`  ${mid}: ${items.length} 个视频（total=${resp.result?.data?.total ?? items.length}${latest ? `，最新 ${fmtDate(latest)}` : ''}）`);
  } catch (e) {
    console.error(`  ${mid}: 拉取失败 - ${(e as Error).message}`);
    midToItems.set(mid, []);
  }
}

// ─── 2. dedupe 判重（直读 SQLite，DB 路径来自 resolveConfig 绝对解析）───
const allItems = [...midToItems.values()].flat();
const allBvids = [...new Set(allItems.map((it) => it.bvid))];
// bvid → 发布时间（采集进度行展示用）。
const bvidToCreated = new Map<string, number | undefined>();
for (const it of allItems) bvidToCreated.set(it.bvid, it.created);
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

// ─── 2.5 --retry-nosub：把「时间窗内 + 已入库但无字幕轨」的 bvid 并入采集队列 ───
// 安全性：fetch-subtitle 不查 dedupe（dedupe 仅本脚本用），ingest upsert 幂等，重采无字幕视频无副作用。
if (retryNosub) {
  try {
    const db2 = openReadonlyDb(cfg.dbPath);
    try {
      const nosub = collectNosub(db2, allBvids);
      // 仅重采时间窗内的（sinceCreated=null 时全量）；null created 视为窗口内。
      const inWindow = nosub.filter((bv) => {
        const c = bvidToCreated.get(bv);
        return sinceCreated == null || c == null || (c ?? 0) >= sinceCreated;
      });
      let added = 0;
      for (const bv of inWindow) if (!missing.includes(bv)) { missing.push(bv); added++; }
      console.error(`  --retry-nosub: 候选 ${nosub.length}，时间窗内 ${inWindow.length}，新增入队 ${added}（去重后 missing=${missing.length}）`);
    } finally {
      db2.close();
    }
  } catch (e) {
    console.error(`  collectNosub 失败（降级，仅采 missing）: ${(e as Error).message}`);
  }
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
  else {
    const pub = bvidToCreated.get(bv);
    console.error(`  ${bv}  ${pub ? `发布=${fmtDate(pub)} ` : ''}ok  tracks=${out.result?.data?.tracks ?? 0}`);
    ok++;
  }
  await new Promise((r) => setTimeout(r, sleepMs));
}

// ─── 采后：--category 经 HTTP 给所有涉及的 mid 打 agent 分类 ───
if (categoryAgentId && categoryName) {
  let marked = 0;
  for (const mid of mids) {
    try {
      const r = await fetch(`${cfg.serverUrl}/api/creators/by-uid/${encodeURIComponent(mid)}/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ scope: 'agent', name: categoryName }),
      });
      if (r.ok) marked++;
    } catch { /* 单条失败不阻断整体 */ }
  }
  console.error(`[category] 已标记 ${marked}/${mids.length} 个 mid 的 agent 分类=「${categoryName}」`);
}

console.error(`===完成: ok=${ok}  no_subtitle=${nosub}  fail=${fail}  共 ${missing.length}===`);
