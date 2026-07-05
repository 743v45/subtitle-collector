// 一次性：给老视频补 extra.tid（调 /x/web-interface/view，免 wbi 免 cookie）+ extra.tname（本地字典反查）。
// 用法：pnpm -C apps/collector-server exec node scripts/backfill-region.mjs [--dry-run] [--limit N]
//
// 背景：102 个存量视频里 51 个缺 extra.tid；另 51 个有 tid 但 extra.tname 是空串
// （B 站 view API 返回的 tname 恒空，必须用分区字典反查）。
// 字典：apps/collector-server/data/zones-v1.json，{ "<tid>": { name, code, parent, main } }。
//
// 两步顺序执行：
//   1) 补 tid：对 extra.tid 为空的视频，用 source_vid 作 bvid 调 view API，写 data.tid（顺带补缺失的 aid）。
//   2) 补 tname：对有 tid 但 tname 空的视频，查字典写 zone.name。纯本地，不联网。
// 先 1 后 2，第 2 步重新 SELECT 会捞到第 1 步刚写入 tid 的视频，保证本轮补完 tid 的也立刻补上 tname。
// dry-run 时 readonly 打开 DB，只打印不写（注意：dry-run 下第 1 步不落库，第 2 步 SELECT 捞不到刚算的 tid，
// 属预期行为）。--limit N 对两个阶段各自独立截断（测试用）。
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DB_PATH = '/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server/bilibili-collector.db';
const ZONES_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'zones-v1.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const zones = JSON.parse(readFileSync(ZONES_PATH, 'utf8'));

const db = new Database(DB_PATH, { readonly: dryRun });
if (!dryRun) db.pragma('busy_timeout = 5000');
const upd = db.prepare('UPDATE videos SET extra = ?, updated_at = ? WHERE id = ?');

// ───────────────── step 1: 补 tid（联网） ─────────────────
const rowsTid = db.prepare(`
  SELECT id, source_vid, extra FROM videos
  WHERE json_extract(extra, '$.tid') IS NULL
`).all();
const todoTid = limit > 0 ? rowsTid.slice(0, limit) : rowsTid;
console.log(`[backfill-region] 补 tid: 待处理 ${todoTid.length}${dryRun ? ' (dry-run)' : ''}${limit > 0 ? ` (limit ${limit})` : ''}`);

let tidDone = 0, tidSkip = 0, tidFail = 0;
for (const r of todoTid) {
  let extra;
  try { extra = JSON.parse(r.extra || '{}'); } catch { extra = {}; }
  const bvid = r.source_vid;
  if (!bvid) { console.log(`  skip id=${r.id} (no source_vid)`); tidSkip++; continue; }
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await res.json();
    if (j.code === 0 && j.data && j.data.tid != null) {
      extra.tid = j.data.tid;
      const aidNew = extra.aid == null && j.data.aid != null;
      if (aidNew) extra.aid = j.data.aid;
      if (!dryRun) upd.run(JSON.stringify(extra), Date.now(), r.id);
      tidDone++;
      console.log(`  ✓ ${bvid}: tid=${j.data.tid}${aidNew ? ` aid=${j.data.aid}` : ''}`);
    } else {
      console.log(`  ✗ ${bvid}: code=${j.code} ${j.message || ''}`);
      tidFail++;
    }
  } catch (e) {
    console.log(`  ✗ ${bvid}: ${e.message}`);
    tidFail++;
  }
  await new Promise((rr) => setTimeout(rr, 250)); // 避免风控，仅联网后 sleep
}
console.log(`[backfill-region] 补 tid: done=${tidDone} skip=${tidSkip} fail=${tidFail} / ${todoTid.length}`);

// ───────────────── step 2: 补 tname（本地字典） ─────────────────
const rowsTname = db.prepare(`
  SELECT id, source_vid, extra FROM videos
  WHERE json_extract(extra, '$.tid') IS NOT NULL
    AND (json_extract(extra, '$.tname') IS NULL OR json_extract(extra, '$.tname') = '')
`).all();
const todoTname = limit > 0 ? rowsTname.slice(0, limit) : rowsTname;
console.log(`[backfill-region] 补 tname: 待处理 ${todoTname.length}${dryRun ? ' (dry-run)' : ''}${limit > 0 ? ` (limit ${limit})` : ''}`);

let tnameDone = 0, tnameMiss = 0;
for (const r of todoTname) {
  let extra;
  try { extra = JSON.parse(r.extra || '{}'); } catch { extra = {}; }
  const zone = zones[String(extra.tid)];
  if (zone && zone.name) {
    extra.tname = zone.name;
    if (!dryRun) upd.run(JSON.stringify(extra), Date.now(), r.id);
    tnameDone++;
    console.log(`  ✓ ${r.source_vid}: tid=${extra.tid} tname=${zone.name}`);
  } else {
    tnameMiss++;
    console.log(`  · ${r.source_vid}: tid=${extra.tid} 字典未命中`);
  }
}
console.log(`[backfill-region] 补 tname: done=${tnameDone} miss(字典未命中)=${tnameMiss} / ${todoTname.length}`);

db.close();
