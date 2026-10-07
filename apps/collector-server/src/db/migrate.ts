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

import { MIGRATIONS, type MigrationStep } from './migrations.js';
export { MIGRATIONS };
export type { MigrationStep };


export function runMigrations(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (current > latest) {
    throw new Error(`DB user_version=${current} 超出本代码支持的最大版本 ${latest}（库由更新版本的 collector-server 写入，拒绝降级运行）`);
  }
  for (const step of MIGRATIONS) {
    if (step.version <= current) continue; // 版本账本短路：已应用步骤跳过
    for (const stmt of step.statements) {
      try {
        db.exec(stmt);
      } catch (err) {
        const msg = (err as Error).message;
        // 容忍三类幂等性/部分库报错（双保险，见账本规则）：
        //   duplicate column name —— ADD COLUMN 在列已存在的库上重放；
        //   no such column        —— DROP COLUMN 在新 schema（列本就不存在）建的库上重放；
        //   no such table         —— UPDATE/SELECT 类步骤（如 v10 翻译轨订正）在缺表的部分
        //                             schema 库上重放（正规库必建全表，仅防御手工/损坏库）。
        if (!msg.includes('duplicate column name') && !msg.includes('no such column') && !msg.includes('no such table')) throw err;
      }
    }
    db.pragma(`user_version = ${step.version}`);
  }
}
