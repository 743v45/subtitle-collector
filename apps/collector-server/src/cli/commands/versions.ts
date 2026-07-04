// collector-cli 数据查询命令组：versions get。
// 设计参考 [设计文档 §3.1](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
// 架构同 videos.ts：commander 薄包装 + 纯处理函数。措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { getCliContext } from '../main.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import * as queries from '../../db/queries.js';

// getVersionPayload 返回结构（payload 已 JSON.parse 为对象，非字符串）。
export interface VersionPayload {
  id: number;
  origin: string;
  payload: unknown;
  captured_at: number;
}

// versions get <id> 纯处理：取单条字幕版本的 payload，null 表示未找到。
export function versionsGet(
  db: Database.Database,
  id: number,
): VersionPayload | null {
  return queries.getVersionPayload(db, id);
}

// 打开只读 DB；失败 → DB_UNREADABLE。emitError 返回 never，两条路径都满足返回类型。
function openDbOrEmit(dbPath: string): Database.Database {
  try {
    return openReadonlyDb(dbPath);
  } catch (err) {
    return emitError((err as Error).message, 'DB_UNREADABLE');
  }
}

export function buildVersionsCommand(): Command {
  const versions = new Command('versions')
    .description('查询字幕版本（直连 SQLite 只读）：get');

  versions
    .command('get <id>')
    .description('按 version id 取该字幕版本的 payload（B 站字幕 JSON，含 body）')
    .action((idRaw: string) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      const id = Number(idRaw);
      if (!Number.isFinite(id)) {
        emitError(`<id> 不是合法数字: ${idRaw}`, 'ARGS');
      }
      const data = versionsGet(db, id);
      if (data === null) {
        emitError(`version not found: id=${id}`, 'NOT_FOUND');
      }
      emitResult(data, ctx.format);
    });

  return versions;
}
