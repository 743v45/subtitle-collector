// 一次性：给老视频补 duration / published_at / creator（owner.mid 重关联 + name/face）。
// 用法：node scripts/backfill-meta.mjs [--dry-run] [--limit N]
//
// 背景：详情页"作者/时长/发布时间"大面积缺失——duration/published_at 仅 24% 有值；
//   creator 多挂在 source_uid='unknown'（采集时 owner.mid 未拿到，buildIngestPayload 的 ?? 'unknown' 兜底）。
// 方案：调 /x/web-interface/view（免 wbi 免 cookie）：
//   1) videos.duration = data.duration；videos.published_at = data.pubdate*1000（仅补空，不覆盖已有）
//   2) 按 data.owner.mid 找/建正确 creator（带 name/face），UPDATE videos.creator_id 重关联；
//      已存在的 creator 用 COALESCE(NULLIF(...)) 仅补空的 name/avatar，不动已有 sign/level/fans 等。
import Database from 'better-sqlite3';

const DB_PATH = '/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server/bilibili-collector.db';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : 0;

const db = new Database(DB_PATH, { readonly: dryRun });
if (!dryRun) db.pragma('busy_timeout = 5000');

// 待补：duration 缺 / published_at 缺 / creator 是 unknown 或无名
const rows = db.prepare(`
  SELECT v.id, v.source_vid, v.duration, v.published_at, v.creator_id,
         c.source_uid AS c_uid, c.name AS c_name
  FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
  WHERE v.duration IS NULL OR v.published_at IS NULL
     OR c.source_uid = 'unknown' OR c.name IS NULL OR c.name = ''
`).all();
const todo = limit > 0 ? rows.slice(0, limit) : rows;
console.log(`[backfill-meta] 待补: ${todo.length}${dryRun ? ' (dry-run)' : ''}${limit > 0 ? ` (limit ${limit})` : ''}`);

const findCreator = db.prepare("SELECT id FROM creators WHERE source = 'bilibili' AND source_uid = ?");
const insCreator = db.prepare("INSERT INTO creators (source, source_uid, name, avatar, first_seen_at, updated_at) VALUES ('bilibili', ?, ?, ?, ?, ?)");
const updCreator = db.prepare("UPDATE creators SET name = COALESCE(NULLIF(name, ''), ?), avatar = COALESCE(NULLIF(avatar, ''), ?), updated_at = ? WHERE id = ?");
const updVid = db.prepare('UPDATE videos SET duration = ?, published_at = ?, creator_id = ?, updated_at = ? WHERE id = ?');

let done = 0, fail = 0, reassoc = 0;
for (const r of todo) {
  const bvid = r.source_vid;
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await res.json();
    if (j.code !== 0 || !j.data) {
      console.log(`  ✗ ${bvid}: code=${j.code} ${j.message || ''}`);
      fail++;
    } else {
      const d = j.data;
      // 仅补空字段，不覆盖已有非空值
      const dur = r.duration != null ? r.duration : (d.duration ?? null);
      const pub = r.published_at != null ? r.published_at : (d.pubdate != null ? d.pubdate * 1000 : null);
      // creator 按 owner.mid 找/建，重关联
      let cid = r.creator_id;
      if (d.owner?.mid != null) {
        const mid = String(d.owner.mid);
        const exist = findCreator.get(mid);
        if (exist) {
          cid = exist.id;
          if (!dryRun) updCreator.run(d.owner.name ?? null, d.owner.face ?? null, Date.now(), exist.id);
        } else {
          if (!dryRun) {
            const info = insCreator.run(mid, d.owner.name ?? null, d.owner.face ?? null, Date.now(), Date.now());
            cid = Number(info.lastInsertRowid);
          } else {
            cid = -1; // dry-run 下"会新建"
          }
        }
      }
      const moved = cid !== r.creator_id;
      if (!dryRun) updVid.run(dur, pub, cid, Date.now(), r.id);
      if (moved) reassoc++;
      done++;
      const pubStr = pub ? new Date(pub).toISOString().slice(0, 10) : '-';
      console.log(`  ✓ ${bvid}: dur=${dur ?? '-'}s pub=${pubStr} up=${d.owner?.name ?? '?'}/${d.owner?.mid ?? '?'}${moved ? ' (重关联)' : ''}`);
    }
  } catch (e) {
    console.log(`  ✗ ${bvid}: ${e.message}`);
    fail++;
  }
  await new Promise((rr) => setTimeout(rr, 250)); // 避免风控
}
console.log(`[backfill-meta] done=${done} fail=${fail} 重关联=${reassoc} / ${todo.length}`);
db.close();
