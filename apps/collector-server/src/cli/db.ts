// CLI 只读 DB 连接 helper：复用 server 写入的 SQLite 文件（WAL 模式下只读连接可与 server 写并发）。
// 严格只读——CLI 永不写库；migrate / WAL 设置由 server 侧 [migrate.ts](apps/collector-server/src/db/migrate.ts) 负责。

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

// 打开只读连接。文件不存在时抛清晰错误（调用方捕获后 emitError DB_UNREADABLE）。
// 注意：better-sqlite3 默认会为新路径创建空文件，故先 existsSync 判存在再打开，避免生成空 DB 误导。
export function openReadonlyDb(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) {
    throw new Error(`DB file not found: ${dbPath}`);
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}
