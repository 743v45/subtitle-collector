// clients 命令组：客户端管控（list / reporting / command），全部经 server HTTP。
// 设计参考 [设计文档 §3.3 客户端管控](../../../docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
//
// 字段映射约定：
// - `clients list`：server `GET /api/clients` 返回 `{clients: [...]}`（见
//   [http/clients.ts](../http/clients.ts)），`ServerClient.listClients` 已拆出数组。
//   本 CLI 为对齐全局 list 输出规范（`{total,page,size,items}`，见
//   [output.ts](../output.ts) 的 extractItems），统一 emit `{items, total}`。
//   本命令无分页概念，故省略 page/size。
//
// 关于 `--wait`（设计 §3.3 列出了 `--wait`）：server 端
// [ws/server.ts](../ws/server.ts) 的 `requestCommand` 总是同步等扩展 result 回执或
// timeout，行为恒为"等"。YAGNI 收窄：不暴露 `--wait` / `--no-wait` flag——语义上
// wait 恒真，等待上限由 `--timeout` 控制（默认 5000ms，与 server 端默认一致）。

import { Command } from 'commander';
import {
  ServerClient,
  ServerUnreachableError,
  ServerResponseError,
} from '../http.js';
import { emitResult, emitError } from '../output.js';
import { getCliContext } from '../main.js';

/** `clients command` 下发给扩展的可选参数；undefined 字段不会被收进发送体。 */
export interface CommandParams {
  op?: string;
  url?: string;
  vid?: string;
}

/** 默认等待扩展回执的超时（毫秒），与 server 端 requestCommand 默认一致。 */
const DEFAULT_COMMAND_TIMEOUT_MS = 5000;

// ── 纯处理函数（可测：注入 ServerClient + 参数，返回结构化数据；不直接碰 stdout/exit） ──

/**
 * `clients list`：取在线客户端列表，包裹成全局 list 规范 `{items, total}`。
 * server `GET /api/clients` → `{clients: [...]}`；`ServerClient.listClients` 已拆出数组。
 */
export async function clientsList(
  client: ServerClient,
): Promise<{ items: unknown[]; total: number }> {
  const items = await client.listClients();
  return { items, total: items.length };
}

/**
 * `clients reporting <id> <on|off>`：定向切上报开关，返回 server 透传体。
 * server `POST /api/clients/:id/reporting` → `{ok, client_id, reporting_enabled}`。
 */
export async function clientsReporting(
  client: ServerClient,
  clientId: string,
  enabled: boolean,
): Promise<unknown> {
  return client.setReporting(clientId, enabled);
}

/**
 * `clients command <id> <action> [--op --url --vid --timeout]`：下发命令并等扩展回执。
 * 只把用户实际传入的 op/url/vid 收进 params（undefined 不下发），再调 sendCommand。
 * server `POST /api/clients/:id/command` → `{ok, client_id, action, result}`，
 * 其中 result 含扩展回执的 ok/data。
 */
export async function clientsCommand(
  client: ServerClient,
  clientId: string,
  action: string,
  params: CommandParams,
  timeout: number,
): Promise<unknown> {
  const sentParams: Record<string, unknown> = {};
  if (params.op !== undefined) sentParams.op = params.op;
  if (params.url !== undefined) sentParams.url = params.url;
  if (params.vid !== undefined) sentParams.vid = params.vid;
  return client.sendCommand(clientId, action, sentParams, timeout);
}

// ── commander 装配 ──

/**
 * 统一 HTTP 错误归一化（三个子命令共用）：
 * - `ServerUnreachableError`（DNS/TCP/ECONNREFUSED）→ `SERVER_UNREACHABLE`（退 3）。
 * - `ServerResponseError` status 404 → `NOT_FOUND`（退 5）；其余非 2xx → `RUNTIME`（退 1，带 status/body）。
 * - 非上述异常：重新抛出，由 main.ts 兜底按 RUNTIME 处理。
 *
 * 返回 `never`：所有 HTTP 错误分支均经 emitError（process.exit）终结；仅未识别错误 throw。
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

/**
 * 装配 `clients` 命令组（`list` / `reporting` / `command`）。
 * 由 main.ts 在 main() 内动态 import 后 program.addCommand 注册。
 */
export function buildClientsCommand(): Command {
  const cmd = new Command('clients');
  cmd.description('客户端管控：列表 / 切上报开关 / 下发命令（经 server HTTP）');

  // clients list
  cmd
    .command('list')
    .description('列出在线客户端（GET /api/clients）')
    .action(async () => {
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await clientsList(client);
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // clients reporting <client_id> <on|off>
  cmd
    .command('reporting <clientId> <state>')
    .description('定向切上报开关：state ∈ on|off（POST /api/clients/:id/reporting）')
    .action(async (clientId: string, state: string) => {
      // 手动校验 state 取值：commander 缺省走默认退 1，这里走 ARGS 语义（退 2）。
      if (state !== 'on' && state !== 'off') {
        emitError(`invalid reporting state "${state}" (expected on|off)`, 'ARGS');
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await clientsReporting(client, clientId, state === 'on');
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    });

  // clients command <client_id> <action> [--op --url --vid --timeout]
  const commandCmd = cmd
    .command('command <clientId> <action>')
    .description('下发命令并等扩展回执（POST /api/clients/:id/command；wait 恒真，由 --timeout 控制上限）')
    .option('--op <op>', '传给扩展端 action 处理器的 op 字段（仅在传入时下发）')
    .option('--url <url>', '传给扩展端的 url 字段（仅在传入时下发）')
    .option('--vid <vid>', '传给扩展端的 vid 字段（仅在传入时下发）')
    .option(
      '--timeout <ms>',
      '等待扩展回执的超时毫秒（默认 5000）',
      (v) => Number.parseInt(v, 10),
      DEFAULT_COMMAND_TIMEOUT_MS,
    );
  commandCmd.action(
    async (
      clientId: string,
      action: string,
      opts: {
        op?: string;
        url?: string;
        vid?: string;
        timeout: number;
      },
    ) => {
      // 非数字 / 非正 timeout 走 ARGS（commander 解析后可能是 NaN）。
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) {
        emitError(
          `invalid --timeout: ${String(opts.timeout)} (expected positive integer ms)`,
          'ARGS',
        );
      }
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const data = await clientsCommand(
          client,
          clientId,
          action,
          { op: opts.op, url: opts.url, vid: opts.vid },
          opts.timeout,
        );
        emitResult(data, ctx.format);
      } catch (err) {
        handleHttpError(err);
      }
    },
  );

  return cmd;
}
