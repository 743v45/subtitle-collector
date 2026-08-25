// collector-cli 变更历史命令组：changes list。
// 设计参考 [设计文档 §3.1](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
// 架构同 videos.ts：commander 薄包装（action 内 openReadonlyDb → 调纯函数 → emitResult）
// + 纯处理函数（接 db 实例 + 解析后的 opts，返回数据，便于单测）。
// 措辞：字幕（subtitle），非弹幕。

import type Database from 'better-sqlite3';
import { Command } from 'commander';
import { getCliContext } from '../context.js';
import { emitResult, emitError } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { getChanges, type ChangeFilter, type ChangeRow, type PageResult } from '../../db/advanced.js';
import { CHANGE_SORT_KEYS, type ChangeSortKey } from '../../db/sort.js';
// normalizeTimestamp / parseDesc 由 videos.ts 统一实现并导出（秒/毫秒/ISO8601 → 毫秒；--desc 解析），全命令组复用。
import { normalizeTimestamp, parseDesc } from './videos.js';

// ── 纯处理函数 opts 类型（解析后；since/until 已是毫秒数字，比对 changed_at）──
export interface ChangesListOpts {
  entity?: string;
  entityId?: number;
  field?: string;
  source?: string;  // 平台过滤（经实体行 JOIN 判定，change_log 表无平台列）
  since?: number;   // 已规范化毫秒，比对 changed_at
  until?: number;
  sort?: ChangeSortKey;
  desc?: boolean;
  page?: number;
  size?: number;
}

// changes list 纯处理：构造 ChangeFilter + 分页默认，委托 getChanges。
// page/size 非正数或缺省 → 默认 1 / 20（与 advanced.getChanges 一致）。
// sort 仅 changed_at 一个键（参数形态与其他列表端点统一）；desc 缺省 true（最新在前 = 现状）。
export function changesList(db: Database.Database, opts: ChangesListOpts): PageResult<ChangeRow> {
  const filter: ChangeFilter = {};
  if (opts.entity !== undefined) filter.entity = opts.entity;
  if (opts.entityId !== undefined) filter.entity_id = opts.entityId;
  if (opts.field !== undefined) filter.field = opts.field;
  if (opts.source !== undefined) filter.source = opts.source;
  if (opts.since !== undefined) filter.since = opts.since;
  if (opts.until !== undefined) filter.until = opts.until;
  const page = opts.page && opts.page > 0 ? Math.floor(opts.page) : 1;
  const size = opts.size && opts.size > 0 ? Math.floor(opts.size) : 20;
  return getChanges(db, filter, page, size, opts.sort ?? 'changed_at', opts.desc ?? true);
}

// ── commander 装配 ──

// commander 解析出的原始选项（字符串），action 内转成 ChangesListOpts。
interface ChangesRawOpts {
  entity?: string;
  entityId?: string;
  field?: string;
  source?: string;
  since?: string;
  until?: string;
  sort?: string;
  desc?: string | boolean;
  page?: string;
  size?: string;
}

// 字符串 → 数字；非法 → ARGS。undefined 透传（filter 不应用）。
function parseNum(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return emitError(`${name} 不是合法数字: ${raw}`, 'ARGS');
  }
  return n;
}

// since/until 字符串 → 毫秒数字；格式非法（normalizeTimestamp 抛错）→ ARGS。
function parseTime(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  try {
    return normalizeTimestamp(raw);
  } catch (err) {
    return emitError(`${name}: ${(err as Error).message}`, 'ARGS');
  }
}

// 打开只读 DB；失败 → DB_UNREADABLE。emitError 返回 never，两条路径都满足返回类型。
function openDbOrEmit(dbPath: string): Database.Database {
  try {
    return openReadonlyDb(dbPath);
  } catch (err) {
    return emitError((err as Error).message, 'DB_UNREADABLE');
  }
}

export function buildChangesCommand(): Command {
  const changes = new Command('changes')
    .description('查询变更历史（change_log，直连 SQLite 只读）：list');

  changes
    .command('list')
    .description('按 entity / field / 时间范围过滤 change_log，返回 {total,page,size,items}（items 含派生 source 平台列）')
    .option('--entity <name>', '按实体类型过滤（如 video / creator）')
    .option('--entity-id <id>', '按实体 id 过滤（建议配合 --entity）')
    .option('--field <name>', '按字段名过滤')
    .option('--source <src>', '按平台过滤（bilibili|youtube，经实体行判定）')
    .option('--since <ts>', '起始时间（Unix 秒/毫秒 或 ISO8601），比对 changed_at')
    .option('--until <ts>', '结束时间（Unix 秒/毫秒 或 ISO8601），比对 changed_at')
    .option('--sort <key>', `排序键：${CHANGE_SORT_KEYS.join('|')}（仅此一键：实体/字段文本排序无意义）`)
    .option('--desc [value]', '降序（默认降序，最新在前；升序传 --desc=false）')
    .option('--page <n>', '页码（从 1 起，默认 1）')
    .option('--size <n>', '每页条数（默认 20）')
    .action((raw: ChangesRawOpts) => {
      const ctx = getCliContext();
      const db = openDbOrEmit(ctx.dbPath);
      // sort 白名单校验（非法 → ARGS 退 2，对齐 HTTP 400 口径）
      if (raw.sort !== undefined && !(CHANGE_SORT_KEYS as readonly string[]).includes(raw.sort)) {
        emitError(`非法 --sort: ${raw.sort}（可选: ${CHANGE_SORT_KEYS.join('|')}）`, 'ARGS');
      }
      const opts: ChangesListOpts = {
        entity: raw.entity,
        entityId: parseNum(raw.entityId, '--entity-id'),
        field: raw.field,
        source: raw.source,
        since: parseTime(raw.since, '--since'),
        until: parseTime(raw.until, '--until'),
        sort: raw.sort as ChangeSortKey | undefined,
        desc: parseDesc(raw.desc),
        page: parseNum(raw.page, '--page'),
        size: parseNum(raw.size, '--size'),
      };
      const data = changesList(db, opts);
      emitResult(data, ctx.format);
    });

  return changes;
}
