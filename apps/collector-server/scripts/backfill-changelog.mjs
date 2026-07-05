// one-shot：给老数据补 change_log「created」记录（首次采集流水）。
// 幂等：已有 created 记录的跳过。新采集已由 ingest.ts 自动记 created。
// 措辞：字幕（subtitle），非弹幕。
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const dbPath = process.env.COLLECTOR_DB_PATH ?? resolve(here, '..', 'bilibili-collector.db');
const db = new Database(dbPath);

const ins = db.prepare(
  'INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
);
const hasStmt = db.prepare(
  'SELECT 1 AS x FROM change_log WHERE entity = ? AND entity_id = ? AND field = ?',
);
const has = (entity, entityId, field) => hasStmt.get(entity, entityId, field);

const tx = db.transaction(() => {
  let nv = 0;
  let nc = 0;
  for (const v of db.prepare('SELECT id, title, first_seen_at FROM videos').all()) {
    if (!has('video', v.id, 'created')) {
      ins.run('video', v.id, 'created', null, v.title, v.first_seen_at);
      nv++;
    }
  }
  for (const c of db.prepare('SELECT id, name, first_seen_at FROM creators').all()) {
    if (!has('creator', c.id, 'created')) {
      ins.run('creator', c.id, 'created', null, c.name ?? null, c.first_seen_at);
      nc++;
    }
  }
  return { nv, nc };
});

const r = tx();
console.log(JSON.stringify({ ok: true, db: dbPath, ...r }));
