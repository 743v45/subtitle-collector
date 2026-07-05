// 一次性：给 extra.tags 为空的老视频补 B 站标签（调 /x/tag/archive/tags，免 wbi 免 cookie）。
// 用法：pnpm -C apps/collector-server exec node scripts/backfill-tags.mjs [--limit N] [--dry-run]
//
// 背景：主动采集（view API）不返回 tags，老视频 extra.tags 多为空。扩展新代码已加 tag 采集
// （fetch-subtitle 内调 /x/tag/archive/tags），但对老视频需补全。本脚本 server 端直接调接口补。
import Database from 'better-sqlite3';

const DB_PATH = '/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server/bilibili-collector.db';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const db = new Database(DB_PATH, { readonly: dryRun });
if (!dryRun) db.pragma('busy_timeout = 5000');

const rows = db.prepare(`
  SELECT id, source_vid, extra FROM videos
  WHERE extra IS NOT NULL
    AND (json_extract(extra, '$.tags') IS NULL
         OR json_array_length(json_extract(extra, '$.tags')) = 0)
`).all();
const todo = limit > 0 ? rows.slice(0, limit) : rows;
console.log(`[backfill] 待补 tags: ${todo.length}${dryRun ? ' (dry-run)' : ''}${limit > 0 ? ` (limit ${limit})` : ''}`);

let done = 0, skip = 0, fail = 0;
const upd = db.prepare('UPDATE videos SET extra = ?, updated_at = ? WHERE id = ?');
for (const r of todo) {
  let extra;
  try { extra = JSON.parse(r.extra || '{}'); } catch { extra = {}; }
  const aid = extra.aid;
  if (!aid) { console.log(`  skip ${r.source_vid} (no aid)`); skip++; continue; }
  try {
    const res = await fetch(`https://api.bilibili.com/x/tag/archive/tags?aid=${aid}`, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await res.json();
    if (j.code === 0 && Array.isArray(j.data) && j.data.length > 0) {
      const tags = j.data.map((t) => ({ tag_id: t.tag_id, tag_name: t.tag_name }));
      extra.tags = tags;
      if (!dryRun) upd.run(JSON.stringify(extra), Date.now(), r.id);
      done++;
      console.log(`  ✓ ${r.source_vid}: ${tags.length} tags (${tags.slice(0, 3).map((t) => t.tag_name).join('/')}${tags.length > 3 ? '…' : ''})`);
    } else {
      console.log(`  ✗ ${r.source_vid} (aid=${aid}): code=${j.code} ${j.message || ''}`);
      fail++;
    }
  } catch (e) {
    console.log(`  ✗ ${r.source_vid}: ${e.message}`);
    fail++;
  }
  await new Promise((r) => setTimeout(r, 250)); // 避免风控
}
console.log(`[backfill] 完成: done=${done} skip=${skip} fail=${fail} / 总 ${todo.length}`);
db.close();
