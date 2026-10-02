// tasks 命令组：采集任务查询与重试（全部经 server HTTP，对齐 clients.ts 装配模式）。
// 端点契约见 [http/tasks.ts](../../http/tasks.ts)：
//   GET  /api/collect-tasks        列表（筛选/排序/分页；筛选只作用种子行，批次成员全量带出）
//   GET  /api/collect-tasks/:id    单任务详情（error=失败原因 / result=回执摘要）
//   POST /api/collect-tasks/retry  失败/限流任务原地重置回 pending（非可重试行静默跳过）
// 背景：CLI 完整度台账 #3（docs/plans/cli-completeness.md）——此前 agent 建任务后查不了结果、
// 重试不了失败任务（只能 curl HTTP 或翻 web），本命令组补齐任务生命周期闭环（2026-10-02）。

import { Command } from 'commander';
import {
  ServerClient,
  ServerUnreachableError,
  ServerResponseError,
} from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { TASK_SORT_KEYS, type TaskSortKey } from '../../db/sort.js';
import { parseDesc } from './videos.js';

/** tasks 组的 client 依赖（ServerClient 结构子集；纯函数测试注入 mock 用）。 */
export interface TasksClient {
  listCollectTasks(params: Record<string, string | number | boolean>): Promise<unknown>;
  getCollectTask(id: number): Promise<unknown>;
  retryCollectTasks(ids: number[]): Promise<unknown>;
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据；不直接碰 stdout/exit）──

/** `tasks list` 选项（camelCase；action 层已把数字/布尔原始字符串解析成此形状）。 */
export interface TasksListParams {
  status?: string;     // CSV（pending|dispatched|succeeded|failed|limited），端点忽略非法值
  source?: string;     // bilibili|youtube|douyin
  batchId?: string;    // 批次筛选（批量提交同批共享 batch_id）
  batch?: string;      // batch|single 批量/单点档
  creator?: string;    // UP 名模糊（任务行冗余归属，未入库任务也命中）
  creatorUid?: string; // UP mid/channelId 精确
  q?: string;          // 库内标题模糊 + vid 段匹配（可搜 BV 号）
  since?: number;      // created_at 毫秒下界（含）
  until?: number;      // created_at 毫秒上界（含）
  limit?: number;      // 最近 N 条（端点钳 1..100，默认 20）
  page?: number;       // 与 pageSize 成对 → 分页形态
  pageSize?: number;
  sort?: TaskSortKey;  // created_at（端点默认）|finished_at|status
  desc?: boolean;      // 端点默认降序
}

/** `tasks list`：参数组装 query（未传不进）→ GET /api/collect-tasks → 去掉 ok 外壳
 *  （对齐全局 list 输出规范，output.ts extractItems 认 items 拆 ndjson/csv/table）。 */
export async function tasksList(client: TasksClient, params: TasksListParams): Promise<Record<string, unknown>> {
  // camelCase 选项 → snake_case query（对齐端点参数名），undefined 不进（不带多余参数）
  const pairs: Array<[string, string | number | boolean | undefined]> = [
    ['status', params.status], ['source', params.source],
    ['batch_id', params.batchId], ['batch', params.batch],
    ['creator', params.creator], ['creator_uid', params.creatorUid], ['q', params.q],
    ['since', params.since], ['until', params.until],
    ['limit', params.limit], ['page', params.page], ['page_size', params.pageSize],
    ['sort', params.sort], ['desc', params.desc],
  ];
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of pairs) if (v !== undefined) query[k] = v;
  const data = await client.listCollectTasks(query) as Record<string, unknown> | null;
  const rest: Record<string, unknown> = { ...(data ?? {}) };
  delete rest.ok; // ok 外壳不进输出（对齐 clientsList 的 {items,total} 归一口径）
  return rest;
}

/** `tasks get <id>`：GET /api/collect-tasks/:id 透传（{ok, task}；不存在 server 404 → NOT_FOUND）。 */
export async function tasksGet(client: TasksClient, id: number): Promise<unknown> {
  return client.getCollectTask(id);
}

/** `tasks retry <id...>`：POST /api/collect-tasks/retry {ids} 透传（{ok, retried, tasks}）。 */
export async function tasksRetry(client: TasksClient, ids: number[]): Promise<unknown> {
  return client.retryCollectTasks(ids);
}

// ── commander 装配 ──

/** 整数选项/位置参数解析：非法 → ARGS 退 2。端点侧对非法数字是静默忽略，CLI 显式报错
 *  （agent 拼错参数不该被吞成「查了个寂寞」，对齐 clients command --timeout 口径）。 */
function parseIntOpt(raw: string, name: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return emitError(`非法 ${name}: ${raw}（需整数）`, 'ARGS');
  return n;
}

/**
 * 统一 HTTP 错误归一化（对齐 clients.ts 模式；tasks 组无扩展命令，无 ExtCommandError 分支）：
 * - `ServerUnreachableError`（server 没开/ECONNREFUSED）→ `SERVER_UNREACHABLE`（退 3）。
 * - `ServerResponseError` status 404 → `NOT_FOUND`（退 5）；其余非 2xx → `RUNTIME`（退 1，带 status/body）。
 * - 非上述异常：重新抛出，由 main.ts 兜底按 RUNTIME 处理。
 */
function handleHttpError(err: unknown): never {
  if (err instanceof ServerUnreachableError) {
    emitError(err.message, 'SERVER_UNREACHABLE');
  }
  if (err instanceof ServerResponseError) {
    if (err.status === 404) {
      emitError(err.message, 'NOT_FOUND', { status: err.status, body: err.body });
    }
    emitError(err.message, 'RUNTIME', { status: err.status, body: err.body });
  }
  throw err;
}

/** commander 解析出的 tasks list 原始选项（数字字段还是字符串）。 */
interface TasksListRawOpts {
  status?: string; source?: string; batchId?: string; batch?: string;
  creator?: string; creatorUid?: string; q?: string;
  since?: string; until?: string; limit?: string; page?: string; pageSize?: string;
  sort?: string; desc?: string | boolean;
}

/**
 * 装配 `tasks` 命令组（`list` / `get` / `retry`）。
 * 由 main.ts 在 main() 内动态 import 后 program.addCommand 注册。
 */
export function buildTasksCommand(): Command {
  const cmd = new Command('tasks');
  cmd.description('采集任务查询与重试：列表筛选 / 单任务详情 / 失败重试（经 server HTTP）');

  // tasks list
  cmd
    .command('list')
    .description('采集任务列表：状态/平台/批次/UP/标题筛选 + 排序 + 最近N或分页（GET /api/collect-tasks）')
    .option('--status <csv>', '状态筛选，逗号分隔：pending|dispatched|succeeded|failed|limited（非法值端点忽略）')
    .option('--source <src>', '平台筛选：bilibili|youtube|douyin')
    .option('--batch-id <id>', '批次筛选（批量提交同批共享 batch_id）')
    .option('--batch <scope>', '批量/单点档：batch|single')
    .option('--creator <name>', 'UP 名模糊（任务行冗余归属，未入库任务也命中）')
    .option('--creator-uid <uid>', 'UP mid/channelId 精确')
    .option('--q <text>', '库内标题模糊 + vid 段匹配（可搜 BV 号）')
    .option('--since <ms>', '创建时间下界（毫秒，含）')
    .option('--until <ms>', '创建时间上界（毫秒，含）')
    .option('--limit <n>', '最近 N 条（默认 20，端点钳上限 100；与 --page/--page-size 同传分页优先）')
    .option('--page <n>', '页码（1 起；与 --page-size 成对走分页形态）')
    .option('--page-size <n>', '每页条数（端点钳上限 100）')
    .option('--sort <key>', `排序键：${TASK_SORT_KEYS.join('|')}（finished_at 未完成恒排尾）`)
    .option('--desc [value]', '降序（默认降序；升序传 --desc=false）')
    .action(async (opts: TasksListRawOpts) => {
      // sort 白名单校验（非法 → ARGS 退 2，对齐 HTTP 400 口径）
      if (opts.sort !== undefined && !(TASK_SORT_KEYS as readonly string[]).includes(opts.sort)) {
        emitError(`非法 --sort: ${opts.sort}（可选: ${TASK_SORT_KEYS.join('|')}）`, 'ARGS');
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await tasksList(client, {
          status: opts.status,
          source: opts.source,
          batchId: opts.batchId,
          batch: opts.batch,
          creator: opts.creator,
          creatorUid: opts.creatorUid,
          q: opts.q,
          since: opts.since !== undefined ? parseIntOpt(opts.since, '--since') : undefined,
          until: opts.until !== undefined ? parseIntOpt(opts.until, '--until') : undefined,
          limit: opts.limit !== undefined ? parseIntOpt(opts.limit, '--limit') : undefined,
          page: opts.page !== undefined ? parseIntOpt(opts.page, '--page') : undefined,
          pageSize: opts.pageSize !== undefined ? parseIntOpt(opts.pageSize, '--page-size') : undefined,
          sort: opts.sort as TaskSortKey | undefined,
          desc: opts.desc !== undefined ? parseDesc(opts.desc) : undefined,
        });
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // tasks get <id>
  cmd
    .command('get <id>')
    .description('单任务详情：状态/平台/vid/UP/失败原因(error)/回执摘要(result)（GET /api/collect-tasks/:id）')
    .action(async (id: string) => {
      const numId = parseIntOpt(id, '<id>');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await tasksGet(client, numId);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // tasks retry <id...>
  cmd
    .command('retry <id...>')
    .description('重试失败/限流任务：原地重置回 pending 重跑（POST /api/collect-tasks/retry；多 id 批量，非可重试行静默跳过）')
    .action(async (ids: string[]) => {
      // 任一 id 非数字 → ARGS（map 内 parseIntOpt 抛出即终结，无部分提交——此时尚未发请求）
      const numIds = ids.map((id) => parseIntOpt(id, '<id>'));
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await tasksRetry(client, numIds);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return cmd;
}
