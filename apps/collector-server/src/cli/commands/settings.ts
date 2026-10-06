// settings 命令组：web 设置页键值的 CLI 读写通道（tag-priority 六档展示优先级 / collect-timeout
// 三平台采集超时）。全部经 server HTTP，对齐 tasks/creators.ts 装配模式。
// 端点契约见 [http/settings.ts](../../http/settings.ts)：
//   GET/PUT /api/settings/tag-priority     {priority: 六档数组}（非精确排列 server 400）
//   GET/PUT /api/settings/collect-timeout  {bilibili, youtube, douyin}（整数毫秒，[15s, 600s]，server 400 兜底）
// 背景：CLI 完整度台账 #9（docs/plans/cli-completeness.md）/ 改造账本 P1-9（2026-10-05）——
// 此前这两个键只能翻 web 设置页或 curl HTTP 改，agent 调度（如调抖音超时）没有 CLI 通道。
// CLI 侧前置同口径校验（键白名单 + 六档精确排列 + 毫秒区间），非法参数不发请求省一次往返。

import { Command } from 'commander';
import { ServerClient } from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../context.js';
import { handleHttpError } from './tasks.js';

/** settings 组的 client 依赖（ServerClient 结构子集；纯函数测试注入 mock 用）。 */
export interface SettingsClient {
  getTagPriority(): Promise<unknown>;
  setTagPriority(priority: string[]): Promise<unknown>;
  getCollectTimeout(): Promise<unknown>;
  setCollectTimeout(timeout: { bilibili: number; youtube: number; douyin: number }): Promise<unknown>;
}

/** 六档 tag-priority 来源（与 db/settings.ts isPermutationOfAllTiers 校验同口径，顺序即缺省展示序）。 */
export const TAG_PRIORITY_TIERS = ['manual', 'batch', 'bili', 'season', 'ai', 'system'] as const;

/** collect-timeout 允许区间（毫秒；与 db/settings.ts TIMEOUT_MIN_MS/TIMEOUT_MAX_MS 同口径）。 */
export const TIMEOUT_MIN_MS = 15_000;
export const TIMEOUT_MAX_MS = 600_000;

export type SettingsKey = 'tag-priority' | 'collect-timeout';

/** settings 键白名单（未知键 → ARGS，本地拦截不发请求）。 */
export function isSettingsKey(key: string): key is SettingsKey {
  return key === 'tag-priority' || key === 'collect-timeout';
}

// ── 纯处理函数（可测：注入 mock client + 参数，返回结构化数据；不直接碰 stdout/exit）──

/** `settings get <key>`：按键分派 GET 端点，响应透传（{ok,priority} / {ok,...三键}，不剥 ok）。 */
export async function settingsGet(client: SettingsClient, key: SettingsKey): Promise<unknown> {
  if (key === 'tag-priority') return client.getTagPriority();
  return client.getCollectTimeout();
}

/** 解析 --order CSV → 六档数组：逐项 trim；非六档精确排列（缺档/未知档/重复档/空串）→ null。
 *  排列判定用排序后全等（与集合比较等价且免手写双重循环）。 */
export function parseTagPriorityOrder(raw: string): string[] | null {
  const items = raw.split(',').map((s) => s.trim());
  if (items.length !== TAG_PRIORITY_TIERS.length) return null;
  const sorted = [...items].sort().join(',');
  const expected = [...TAG_PRIORITY_TIERS].sort().join(',');
  return sorted === expected ? items : null;
}

/** `settings set tag-priority`：PUT {priority} 透传（排列校验在装配层前置，此处纯透传）。 */
export async function settingsSetTagPriority(client: SettingsClient, priority: string[]): Promise<unknown> {
  return client.setTagPriority(priority);
}

/** `settings set collect-timeout`：PUT {三键毫秒} 透传（区间校验在装配层前置，此处纯透传）。 */
export async function settingsSetCollectTimeout(
  client: SettingsClient,
  timeout: { bilibili: number; youtube: number; douyin: number },
): Promise<unknown> {
  return client.setCollectTimeout(timeout);
}

// ── commander 装配 ──

/**
 * 装配 `settings` 命令组（`get <key>` / `set <key>`）。
 * 由 main.ts 在 main() 内动态 import 后 program.addCommand 注册。
 * 错误归一化复用 tasks.ts 的 handleHttpError（同为纯 server HTTP 通道组——单一来源，collect.ts 先例）。
 */
export function buildSettingsCommand(): Command {
  const cmd = new Command('settings');
  cmd.description('web 设置页键值读写：tag-priority（标签展示优先级）/ collect-timeout（三平台采集超时）');

  // settings get <key>
  cmd
    .command('get <key>')
    .description('读设置：tag-priority → {ok,priority}（六档，高→低）；collect-timeout → {ok,bilibili,youtube,douyin}（毫秒）')
    .action(async (key: string) => {
      if (!isSettingsKey(key)) {
        emitError(`未知设置键: ${key}（可选: tag-priority|collect-timeout）`, 'ARGS');
        return;
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await settingsGet(client, key);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // settings set <key>
  cmd
    .command('set <key>')
    .description('写设置：tag-priority 用 --order 六档 CSV；collect-timeout 用 --bilibili/--youtube/--douyin 整数毫秒')
    .option('--order <csv>', 'tag-priority 用：六档顺序 CSV（六档缺一不可），如 manual,batch,bili,season,ai,system')
    .option('--bilibili <ms>', 'collect-timeout 用：B 站采集超时（整数毫秒，[15000, 600000]）')
    .option('--youtube <ms>', 'collect-timeout 用：YouTube 采集超时（整数毫秒，[15000, 600000]）')
    .option('--douyin <ms>', 'collect-timeout 用：抖音采集超时（整数毫秒，[15000, 600000]）')
    .action(async (key: string, opts: { order?: string; bilibili?: string; youtube?: string; douyin?: string }) => {
      if (!isSettingsKey(key)) {
        emitError(`未知设置键: ${key}（可选: tag-priority|collect-timeout）`, 'ARGS');
        return;
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        if (key === 'tag-priority') {
          if (opts.order === undefined) {
            emitError(`需 --order 指定六档顺序（例：--order ${TAG_PRIORITY_TIERS.join(',')}）`, 'ARGS');
            return;
          }
          // 先分拣未知档（错误信息列全六档可选值），再查精确排列（缺档/重复）——两类错各自可定位
          const items = opts.order.split(',').map((s) => s.trim());
          const unknown = items.filter((t) => !(TAG_PRIORITY_TIERS as readonly string[]).includes(t));
          if (unknown.length > 0) {
            emitError(`未知档位: ${unknown.join(',')}（可选: ${TAG_PRIORITY_TIERS.join('|')}）`, 'ARGS');
            return;
          }
          const priority = parseTagPriorityOrder(opts.order);
          if (!priority) {
            emitError(`--order 需为六档的精确排列（缺档或重复）: ${TAG_PRIORITY_TIERS.join(',')}`, 'ARGS');
            return;
          }
          const data = await settingsSetTagPriority(client, priority);
          emitResult(data, ctx.format);
          return;
        }
        // collect-timeout：三键齐全 + 整数 + 区间，逐键校验（首错即停，全部通过才发请求）
        if (opts.bilibili === undefined || opts.youtube === undefined || opts.douyin === undefined) {
          emitError(`三键需齐全：--bilibili/--youtube/--douyin（整数毫秒，[${TIMEOUT_MIN_MS}, ${TIMEOUT_MAX_MS}]）`, 'ARGS');
          return;
        }
        const parsed: Record<'bilibili' | 'youtube' | 'douyin', number> = { bilibili: 0, youtube: 0, douyin: 0 };
        for (const [flag, raw] of [['--bilibili', opts.bilibili], ['--youtube', opts.youtube], ['--douyin', opts.douyin]] as const) {
          const n = Number(raw);
          if (!Number.isInteger(n)) {
            emitError(`非法 ${flag}: ${raw}（需整数毫秒）`, 'ARGS');
            return;
          }
          if (n < TIMEOUT_MIN_MS || n > TIMEOUT_MAX_MS) {
            emitError(`${flag}: ${raw} 超出允许区间 [${TIMEOUT_MIN_MS}, ${TIMEOUT_MAX_MS}]`, 'ARGS');
            return;
          }
          parsed[flag.slice(2) as 'bilibili' | 'youtube' | 'douyin'] = n;
        }
        const data = await settingsSetCollectTimeout(client, parsed);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  return cmd;
}
