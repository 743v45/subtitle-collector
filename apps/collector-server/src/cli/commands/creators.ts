// creators 命令组：UP 主（创作者）查询（全部经 server HTTP，对齐 tasks.ts 装配模式）。
// 端点契约见 [http/creators.ts](../../http/creators.ts)：
//   GET /api/creators       列表（q/category/source/scope 筛选 + 七键排序 + 分页；{ok,total,items}）
//   GET /api/creators/:id   单创作者详情（P2 字段 sign/level/... + 分类名 join；{ok,creator}）
// 背景：CLI 完整度台账 #7（docs/plans/cli-completeness.md）/ 改造账本 P1-7（2026-10-05）——
// 存量 no-subtitle 回填时查缺资料 UP 清单（账本 P1-5 配套），此前只能 curl HTTP 或翻 web。

import { Command } from 'commander';
import { ServerClient } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { CREATOR_SORT_KEYS, type CreatorSortKey } from '../../db/queries.js';
import { handleHttpError, parseIntOpt } from './tasks.js';
import { parseDesc } from './videos.js';

/** creators 组的 client 依赖（ServerClient 结构子集；纯函数测试注入 mock 用）。 */
export interface CreatorsClient {
  listCreators(params: Record<string, string | number | boolean>): Promise<unknown>;
  getCreator(id: number): Promise<unknown>;
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据；不直接碰 stdout/exit）──

/** `creators list` 选项（scope 值域与 http/creators.ts parseScopeParam 同源：agent|human）。 */
export interface CreatorsListParams {
  q?: string;          // UP 名 / 平台 uid 模糊（LIKE 两侧通配）
  category?: string;   // 分类名精确（配 --scope 选槽位；省略两槽位任一命中）
  scope?: 'agent' | 'human'; // 分类匹配槽位；单独使用（无 category）= 该槽位已打标的 UP
  source?: string;     // 平台过滤（bilibili|youtube|douyin）
  page?: number;       // 页码（1 起，端点钳下界 1，默认 1）
  size?: number;       // 每页条数（端点钳 1..100，默认 20）
  sort?: CreatorSortKey; // first_seen（端点默认）|fans|video_count|following|level|updated_at|name
  desc?: boolean;      // 端点默认降序
}

/** `creators list`：参数组装 query（未传不进）→ GET /api/creators → 去掉 ok 外壳
 *  （对齐全局 list 输出规范，output.ts extractItems 认 items 拆 ndjson/csv/table）。 */
export async function creatorsList(client: CreatorsClient, params: CreatorsListParams): Promise<Record<string, unknown>> {
  // 选项 → query（端点参数名同名；undefined 不进，不带多余参数）
  const pairs: Array<[string, string | number | boolean | undefined]> = [
    ['q', params.q], ['category', params.category], ['scope', params.scope], ['source', params.source],
    ['page', params.page], ['size', params.size], ['sort', params.sort], ['desc', params.desc],
  ];
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of pairs) if (v !== undefined) query[k] = v;
  const data = await client.listCreators(query) as Record<string, unknown> | null;
  const rest: Record<string, unknown> = { ...(data ?? {}) };
  delete rest.ok; // ok 外壳不进输出（对齐 tasksList 的 {total,items} 归一口径）
  return rest;
}

/** `creators get <id>`：GET /api/creators/:id 透传（{ok, creator}；不存在 server 404 → NOT_FOUND）。 */
export async function creatorsGet(client: CreatorsClient, id: number): Promise<unknown> {
  return client.getCreator(id);
}

// ── commander 装配 ──

/** commander 解析出的 creators list 原始选项（数字字段还是字符串）。 */
interface CreatorsListRawOpts {
  q?: string; category?: string; scope?: string; source?: string;
  page?: string; size?: string; sort?: string; desc?: string | boolean;
}

/**
 * 装配 `creators` 命令组（`list` / `get`）。
 * 由 main.ts 在 main() 内动态 import 后 program.addCommand 注册。
 * 错误归一化复用 tasks.ts 的 handleHttpError（同为纯 server HTTP 通道组：SERVER_UNREACHABLE /
 * NOT_FOUND / RUNTIME，无扩展命令分支——单一来源，collect.ts 先例）。
 */
export function buildCreatorsCommand(): Command {
  const cmd = new Command('creators');
  cmd.description('UP 主（创作者）查询：列表筛选排序分页 / 单创作者详情（经 server HTTP）');

  // creators list
  cmd
    .command('list')
    .description('UP 主列表：关键词/分类/平台筛选 + 七键排序 + 分页（GET /api/creators）')
    .option('--q <text>', 'UP 名 / 平台 uid 模糊')
    .option('--category <name>', '分类名精确（配 --scope 选匹配槽位；省略两槽位任一命中）')
    .option('--scope <s>', '分类槽位：agent|human（配 --category；单独传=该槽位已打标的 UP）')
    .option('--source <src>', '平台过滤：bilibili|youtube|douyin')
    .option('--page <n>', '页码（1 起，默认 1）')
    .option('--size <n>', '每页条数（端点钳上限 100，默认 20）')
    .option('--sort <key>', `排序键：${CREATOR_SORT_KEYS.join('|')}（name 可空 NULLS LAST 排尾）`)
    .option('--desc [value]', '降序（默认降序；升序传 --desc=false）')
    .action(async (opts: CreatorsListRawOpts) => {
      // sort 白名单校验（非法 → ARGS 退 2，对齐 HTTP 400 口径与 tasks list 先例）
      if (opts.sort !== undefined && !(CREATOR_SORT_KEYS as readonly string[]).includes(opts.sort)) {
        emitError(`非法 --sort: ${opts.sort}（可选: ${CREATOR_SORT_KEYS.join('|')}）`, 'ARGS');
      }
      // scope 值域本地校验（非法 → ARGS 退 2；server 侧 400 同口径，CLI 前置拦截省一次往返）
      if (opts.scope !== undefined && opts.scope !== 'agent' && opts.scope !== 'human') {
        emitError(`非法 --scope: ${opts.scope}（可选: agent|human）`, 'ARGS');
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await creatorsList(client, {
          q: opts.q,
          category: opts.category,
          scope: opts.scope as CreatorsListParams['scope'],
          source: opts.source,
          page: opts.page !== undefined ? parseIntOpt(opts.page, '--page') : undefined,
          size: opts.size !== undefined ? parseIntOpt(opts.size, '--size') : undefined,
          sort: opts.sort as CreatorSortKey | undefined,
          desc: opts.desc !== undefined ? parseDesc(opts.desc) : undefined,
        });
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // creators get <id>
  cmd
    .command('get <id>')
    .description('单创作者详情：P2 字段（sign/level/sex/official/fans/following）+ 分类 join（GET /api/creators/:id）')
    .action(async (id: string) => {
      const numId = parseIntOpt(id, '<id>');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await creatorsGet(client, numId);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return cmd;
}
