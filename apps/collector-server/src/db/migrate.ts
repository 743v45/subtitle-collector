import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function migrate(db: Database.Database): void {
  // WAL：DB 持久属性，server 启动设一次后，CLI 只读连接（readonly: true）即可与 server 写并发不抢锁（设计文档 §2）
  db.pragma('journal_mode = WAL');
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
}

// P2: 旧 creators 表（建库时只有 name/avatar）补 P2 新列。幂等：列已存在时 SQLite 报
// "duplicate column name"，吞掉即可。新建库（schema.sql 已含新列）调这个也无副作用。
const CREATOR_COLUMNS: Array<{ name: string; type: string }> = [
  { name: 'sign', type: 'TEXT' },
  { name: 'level', type: 'INTEGER' },
  { name: 'sex', type: 'TEXT' },
  { name: 'official_type', type: 'INTEGER' },
  { name: 'official_title', type: 'TEXT' },
  { name: 'fans', type: 'INTEGER' },
  { name: 'following', type: 'INTEGER' },
  { name: 'category_agent_id', type: 'INTEGER' },
  { name: 'category_human_id', type: 'INTEGER' },
];

export function runMigrations(db: Database.Database): void {
  for (const col of CREATOR_COLUMNS) {
    try {
      db.exec(`ALTER TABLE creators ADD COLUMN ${col.name} ${col.type}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('duplicate column name')) throw err;
    }
  }
}
