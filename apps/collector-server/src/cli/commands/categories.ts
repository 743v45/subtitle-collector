// categories 命令组：UP 主（创作者）分类 CRUD（全部经 server HTTP，对齐 tasks/creators.ts 装配模式）。
// 端点契约见 [http/categories.ts](../../http/categories.ts)：
//   GET    /api/categories       列表（items 含 creator_count：agent/human 两槽位任一引用计数）
//   POST   /api/categories       新建 {name}（重名 409）
//   PATCH  /api/categories/:id   改名/排序 {name?, sort_order?}（不存在 404，撞名 409）
//   DELETE /api/categories/:id   删除（引用该分类的创作者两槽位置 NULL，server 应用层级联）
// 背景：CLI 完整度台账 #9（docs/plans/cli-completeness.md）/ 改造账本 P1-9（2026-10-05）——
// web 分类页既有能力补 CLI 通道（打分类/分类治理此前只能 curl HTTP 或翻 web）。
// 注：分类值域已合一（无 scope 属性，http/categories.ts:14 非空 scope 一律 400），CLI 不暴露该参数。

import { Command } from 'commander';
import { ServerClient } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { handleHttpError, parseIntOpt } from './tasks.js';

/** categories 组的 client 依赖（ServerClient 结构子集；纯函数测试注入 mock 用）。 */
export interface CategoriesClient {
  listCategories(): Promise<unknown>;
  createCategory(name: string): Promise<unknown>;
  updateCategory(id: number, patch: { name?: string; sort_order?: number }): Promise<unknown>;
  deleteCategory(id: number): Promise<unknown>;
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据；不直接碰 stdout/exit）──

/** `categories list`：GET /api/categories → 去 ok 外壳 + 补 total（对齐全局 list 输出规范
 *  {total,items}，output.ts extractItems 认 items 拆 ndjson/csv/table；端点无分页/筛选，全量返回）。 */
export async function categoriesList(client: CategoriesClient): Promise<{ total: number; items: unknown[] }> {
  const data = await client.listCategories() as { items?: unknown[] } | null;
  const items = Array.isArray(data?.items) ? data!.items! : [];
  return { total: items.length, items };
}

/** `categories add <name>`：POST /api/categories {name} 透传（重名 server 409 → 装配层归一 RUNTIME）。 */
export async function categoriesAdd(client: CategoriesClient, name: string): Promise<unknown> {
  return client.createCategory(name);
}

/** `categories update <id>`：PATCH /api/categories/:id 透传（patch 只含已传键；不存在 404 →
 *  NOT_FOUND 退 5，撞名 409 → RUNTIME 退 1）。 */
export async function categoriesUpdate(
  client: CategoriesClient,
  id: number,
  patch: { name?: string; sort_order?: number },
): Promise<unknown> {
  return client.updateCategory(id, patch);
}

/** `categories delete <id>`：DELETE /api/categories/:id 透传（server 侧引用置 NULL，无孤儿）。 */
export async function categoriesDelete(client: CategoriesClient, id: number): Promise<unknown> {
  return client.deleteCategory(id);
}

// ── commander 装配 ──

/**
 * 装配 `categories` 命令组（`list` / `add` / `update` / `delete`）。
 * 由 main.ts 在 main() 内动态 import 后 program.addCommand 注册。
 * 错误归一化复用 tasks.ts 的 handleHttpError（同为纯 server HTTP 通道组：SERVER_UNREACHABLE /
 * NOT_FOUND / RUNTIME，无扩展命令分支——单一来源，collect.ts 先例）。
 */
export function buildCategoriesCommand(): Command {
  const cmd = new Command('categories');
  cmd.description('UP 主分类 CRUD：列表 / 新建 / 改名排序 / 删除（经 server HTTP；agent 与人工两槽位共用分类值域）');

  // categories list
  cmd
    .command('list')
    .description('分类列表：含 creator_count（agent/human 两槽位任一引用即计入），按 sort_order 排（GET /api/categories）')
    .action(async () => {
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await categoriesList(client);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // categories add <name>
  cmd
    .command('add <name>')
    .description('新建分类（重名 server 409 → RUNTIME 退 1）')
    .action(async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) { emitError('分类 name 不能为空', 'ARGS'); return; }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await categoriesAdd(client, trimmed);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // categories update <id>
  cmd
    .command('update <id>')
    .description('改分类：--name 改名 / --sort-order 改排序（至少传一个；不存在 404 → NOT_FOUND 退 5，撞名 409 → RUNTIME 退 1）')
    .option('--name <name>', '新分类名')
    .option('--sort-order <n>', '排序值（整数，列表按此升序排）')
    .action(async (id: string, opts: { name?: string; sortOrder?: string }) => {
      const patch: { name?: string; sort_order?: number } = {};
      if (opts.name !== undefined) {
        const trimmed = opts.name.trim();
        if (!trimmed) { emitError('--name 不能为空', 'ARGS'); return; }
        patch.name = trimmed;
      }
      if (opts.sortOrder !== undefined) {
        // 排序值需整数（非法 → ARGS 退 2，对齐 parseIntOpt 口径；Number 收住小数/非数字）
        const n = Number(opts.sortOrder);
        if (!Number.isInteger(n)) { emitError(`非法 --sort-order: ${opts.sortOrder}（需整数）`, 'ARGS'); return; }
        patch.sort_order = n;
      }
      if (Object.keys(patch).length === 0) {
        emitError('至少传一个要改的字段（--name / --sort-order）', 'ARGS');
        return;
      }
      const numId = parseIntOpt(id, '<id>');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await categoriesUpdate(client, numId, patch);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // categories delete <id>
  cmd
    .command('delete <id>')
    .description('删除分类（引用该分类的创作者两槽位自动置 NULL，无孤儿；不存在 server 404 → NOT_FOUND 退 5）')
    .action(async (id: string) => {
      const numId = parseIntOpt(id, '<id>');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await categoriesDelete(client, numId);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return cmd;
}
