// server 运维命令组：探活 / 状态 / 起停。
// 设计参考 [设计文档 §3.4](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。
//
// 拆分原则（对齐全局「命令处理拆为纯函数 + commander 薄包装」）：
// - 路径解析 / spawn 计划构造 / pid 文件读写：纯函数 + 纯 fs 包装，可单测。
// - ping / status 处理：依赖以参数注入（client / dbPath / pidFilePath），用 stub client 测。
// - start / stop：涉及真实 spawn / kill，不强测（手动验证 + 集成验收）。

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import { getCliContext } from '../main.js';
import { emitError, emitResult } from '../output.js';
import { openReadonlyDb } from '../db.js';
import { ServerClient } from '../http.js';
import { countOverview, type Overview } from '../../db/advanced.js';

// 与 [config.ts](../config.ts) 的 DEFAULT_TOKEN 一致；该常量未导出，这里原地复刻并标注，
// 仅为 status 的 token_configured 判断用——绝不输出 token 明文。
const DEFAULT_TOKEN = 'change-me-collector-token';

// ─────────────────────────────────────────────────────────────────────────────
// 路径解析（纯）
// ─────────────────────────────────────────────────────────────────────────────

// 本文件位于 apps/collector-server/src/cli/commands/server.ts（或 dist 等价结构），
// 向上 3 层正好是 apps/collector-server 绝对路径（src→cli→commands 反向）。
// 用 import.meta.url 解析，避免依赖 cwd（pnpm 可能从仓库根或本 app 内跑）。
export function serverRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/cli/commands
  return resolve(here, '../../..'); // .../apps/collector-server
}

// pid 文件绝对路径。root 参数仅为可测，默认指向真实 serverRoot。
export function pidFilePath(root: string = serverRoot()): string {
  return join(root, '.collector-server.pid');
}

// 日志文件绝对路径（start 时子进程 stdout/stderr 重定向到此）。
export function logFilePath(root: string = serverRoot()): string {
  return join(root, '.collector-server.log');
}

// ─────────────────────────────────────────────────────────────────────────────
// pid 文件读写（纯 fs 包装，路径作参便于测）
// ─────────────────────────────────────────────────────────────────────────────

// 读 pid 文件并解析为正整数 pid；不存在 / 内容非法 → null。
export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf-8').trim();
  const pid = Number(text);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

// 写 pid 到文件（覆盖）。pid 必须是正整数。
export function writePidFile(path: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`invalid pid: ${pid}`);
  }
  writeFileSync(path, String(pid), 'utf-8');
}

// 删 pid 文件；不存在时静默（幂等）。
export function removePidFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

// 用 signal 0 探活进程。ESRCH=不存在；EPERM=存在但无权限（仍视为存活）。
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// spawn 计划构造（纯）
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerStartOptions {
  // detached 默认 true（后台）。commander 用 --no-detached 取消。
  detached?: boolean;
  port?: number;
  db?: string;
}

// spawn 计划：纯数据，startServer 据此调用 child_process.spawn。
// cmd 固定 tsx、args 固定 ['src/main.ts']、cwd 固定为 apps/collector-server 绝对路径。
// env 继承 baseEnv（默认 process.env）并按选项覆盖 COLLECTOR_PORT / COLLECTOR_DB_PATH。
// detached 时 stdio 用 logPath 的 fd（startServer 打开），否则 inherit。
export interface SpawnPlan {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
  logPath: string;
}

// 构造 spawn 计划。baseEnv 参数仅为可测（默认 process.env）。
export function buildSpawnOptions(
  opts: ServerStartOptions,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SpawnPlan {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  if (opts.port !== undefined) env.COLLECTOR_PORT = String(opts.port);
  if (opts.db !== undefined) env.COLLECTOR_DB_PATH = opts.db;
  return {
    cmd: 'tsx',
    args: ['src/main.ts'],
    cwd: serverRoot(),
    env,
    detached: opts.detached ?? true,
    logPath: logFilePath(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ping / status 处理（依赖注入，可测）
// ─────────────────────────────────────────────────────────────────────────────

// 仅需 ping 能力的最小 client 形状（ServerClient 满足；测试可用 stub）。
export interface PingClient {
  ping(): Promise<boolean>;
}

export interface ServerPingResult {
  online: boolean;
  server_url: string;
}

// ping 处理：ServerClient.ping() 返回 boolean（连不上不抛，见 [http.ts](../http.ts)）。
export async function handleServerPing(
  client: PingClient,
  serverUrl: string,
): Promise<ServerPingResult> {
  const online = await client.ping();
  return { online, server_url: serverUrl };
}

export interface ServerStatusInput {
  client: PingClient;
  dbPath: string;
  pidFilePath: string;
  serverUrl: string;
  token: string;
}

export interface ServerStatusResult {
  online: boolean;
  server_url: string;
  db: { path: string; exists: boolean; overview?: Overview };
  pid_file: { path: string; exists: boolean; pid?: number };
  config: { port: number | null; token_configured: boolean };
}

// 从 serverUrl 解析端口；非法 URL → null。
function parsePort(serverUrl: string): number | null {
  try {
    const u = new URL(serverUrl);
    return u.port ? Number(u.port) : null;
  } catch {
    return null;
  }
}

// status 处理：综合 online / db / pid 文件 / 配置。
// - online 由 ping 决定（连不上不抛，online:false）。
// - DB 用 openReadonlyDb 尝试打开；失败则 exists:false（可能文件不存在或非 sqlite），不抛。
// - pid 文件读不到 pid → exists 以 existsSync 为准。
// - token_configured：是否非默认 token（不输出 token 明文）。
export async function handleServerStatus(input: ServerStatusInput): Promise<ServerStatusResult> {
  const online = await input.client.ping();

  let dbInfo: { path: string; exists: boolean; overview?: Overview };
  try {
    const db = openReadonlyDb(input.dbPath);
    try {
      dbInfo = { path: input.dbPath, exists: true, overview: countOverview(db) };
    } finally {
      db.close();
    }
  } catch {
    // 文件不存在 / 非合法 sqlite / 只读打开失败：exists 以文件系统为准，不抛。
    dbInfo = { path: input.dbPath, exists: existsSync(input.dbPath) };
  }

  const pid = readPidFile(input.pidFilePath);
  const pidInfo =
    pid !== null
      ? { path: input.pidFilePath, exists: true, pid }
      : { path: input.pidFilePath, exists: existsSync(input.pidFilePath) };

  return {
    online,
    server_url: input.serverUrl,
    db: dbInfo,
    pid_file: pidInfo,
    config: {
      port: parsePort(input.serverUrl),
      token_configured: input.token !== DEFAULT_TOKEN,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// start / stop（涉及真实 fs + spawn/kill，不强测）
// ─────────────────────────────────────────────────────────────────────────────

// 命令处理层用的错误类型：带退出码语义（NOT_FOUND / RUNTIME），action 据此 emitError。
export class CliError extends Error {
  readonly exitCode: 'NOT_FOUND' | 'RUNTIME';
  constructor(message: string, exitCode: 'NOT_FOUND' | 'RUNTIME') {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export interface ServerStartResult {
  ok: true;
  pid: number;
  log_path: string;
  started_at: string;
}

// 优先用 apps/collector-server/node_modules/.bin/tsx（pnpm 未必把 .bin 放 PATH），
// 找不到则退回 PATH 上的 'tsx'。
function resolveTsx(cwd: string): string {
  const local = join(cwd, 'node_modules', '.bin', 'tsx');
  return existsSync(local) ? local : 'tsx';
}

// 校验 port 选项：必须是 [1,65535] 整数；非法抛 CliError(RUNTIME)（commander 自定义 parser 不报错）。
function validatePort(port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`invalid port: ${port}`, 'RUNTIME');
  }
}

// 启动 server：spawn tsx + 写 pid 文件 + detached 时 unref + 重定向 log。
// 若 pid 文件存在且进程存活 → CliError(RUNTIME) 'already running'。
// 陈旧 pid 文件（进程已死）→ 清理后继续启动。
export async function startServer(opts: ServerStartOptions): Promise<ServerStartResult> {
  validatePort(opts.port);

  const detached = opts.detached ?? true;
  const plan = buildSpawnOptions(opts);
  const pidPath = pidFilePath();

  const existingPid = readPidFile(pidPath);
  if (existingPid !== null) {
    if (isProcessAlive(existingPid)) {
      throw new CliError(`server already running, pid=${existingPid}`, 'RUNTIME');
    }
    // 陈旧 pid 文件：清理。
    removePidFile(pidPath);
  }

  const tsxPath = resolveTsx(plan.cwd);
  let logFd: number | undefined;
  let child: ReturnType<typeof spawn>;
  try {
    if (detached) {
      // 追加模式打开 log：多次 start 的日志不互相覆盖，便于排查。
      logFd = openSync(plan.logPath, 'a');
      child = spawn(tsxPath, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
    } else {
      // 前台：直接继承父进程 stdio，便于调试时肉眼观察 server 输出。
      child = spawn(tsxPath, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        detached: false,
        stdio: 'inherit',
      });
    }

    // 等 spawn 成功（'spawn' 事件）或失败（'error' 事件，如 tsx 不存在）。
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      const onError = (err: Error): void => {
        rejectSpawn(err);
      };
      child.once('error', onError);
      child.once('spawn', () => {
        child.removeListener('error', onError);
        resolveSpawn();
      });
    });
  } finally {
    // 父进程关闭 log fd（子进程已 dup）——即使 spawn 失败也要释放。
    if (logFd !== undefined) {
      try {
        closeSync(logFd);
      } catch {
        // 忽略：fd 可能已关。
      }
    }
  }

  const pid = child.pid;
  if (pid === undefined) {
    // 正常 'spawn' 后必有 pid；兜底。
    throw new CliError('spawn succeeded but child.pid undefined', 'RUNTIME');
  }

  writePidFile(pidPath, pid);
  if (detached) child.unref();

  return {
    ok: true,
    pid,
    log_path: plan.logPath,
    started_at: new Date().toISOString(),
  };
}

export interface ServerStopResult {
  ok: true;
  pid: number;
}

// 停 server：读 pid → SIGTERM → 删 pid 文件。
// pid 文件不存在 → CliError(NOT_FOUND)；进程已死 → 清理后 CliError(NOT_FOUND)
// （判断：从用户视角 server 本就没在跑，退 5 NOT_FOUND 比 RUNTIME 更贴近语义）。
export async function stopServer(): Promise<ServerStopResult> {
  const pidPath = pidFilePath();
  const pid = readPidFile(pidPath);
  if (pid === null) {
    throw new CliError('pid file not found, server not running', 'NOT_FOUND');
  }
  if (!isProcessAlive(pid)) {
    removePidFile(pidPath);
    throw new CliError(`stale pid file: pid ${pid} not alive (cleaned)`, 'NOT_FOUND');
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      // 进程在 isProcessAlive 与 kill 之间退出：清理 pid 文件后报 NOT_FOUND。
      removePidFile(pidPath);
      throw new CliError(`pid ${pid} exited before SIGTERM (cleaned)`, 'NOT_FOUND');
    }
    throw new CliError(`failed to kill pid ${pid}: ${(err as Error).message}`, 'RUNTIME');
  }
  removePidFile(pidPath);
  return { ok: true, pid };
}

// ─────────────────────────────────────────────────────────────────────────────
// commander 注册
// ─────────────────────────────────────────────────────────────────────────────

// 构造 server 命令组（ping / status / start / stop）。
export function buildServerCommand(): Command {
  const cmd = new Command('server');
  cmd.description('server 运维：探活 / 状态 / 起停（pid 文件 + 本地进程）');

  cmd.command('ping')
    .description('GET /ping 探活，输出 { online, server_url }')
    .action(async () => {
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      const result = await handleServerPing(client, ctx.serverUrl);
      emitResult(result, ctx.format);
    });

  cmd.command('status')
    .description('综合状态：online / DB / pid 文件 / 配置')
    .action(async () => {
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      const result = await handleServerStatus({
        client,
        dbPath: ctx.dbPath,
        pidFilePath: pidFilePath(),
        serverUrl: ctx.serverUrl,
        token: ctx.token,
      });
      emitResult(result, ctx.format);
    });

  cmd.command('start')
    .description('启动 collector-server（默认后台 detached，stdio 重定向到 .collector-server.log）')
    // commander 惯用法：定义 --no-detached 后，opts.detached 默认 true，传 --no-detached 置 false。
    .option('--no-detached', '前台运行（默认后台 detached）')
    .option('--port <port>', '端口（覆盖 COLLECTOR_PORT）', (v) => Number(v))
    .option('--db <path>', 'DB 路径（覆盖 COLLECTOR_DB_PATH，相对路径以 cwd 为准）')
    .action(async (opts: { detached: boolean; port?: number; db?: string }) => {
      const ctx = getCliContext();
      try {
        const result = await startServer({
          detached: opts.detached,
          port: opts.port,
          db: opts.db,
        });
        emitResult(result, ctx.format);
      } catch (err) {
        if (err instanceof CliError) {
          emitError(err.message, err.exitCode);
        }
        const message = err instanceof Error ? err.message : String(err);
        emitError(`failed to start server: ${message}`, 'RUNTIME');
      }
    });

  cmd.command('stop')
    .description('读 pid 文件 → SIGTERM → 删 pid 文件')
    .action(async () => {
      const ctx = getCliContext();
      try {
        const result = await stopServer();
        emitResult(result, ctx.format);
      } catch (err) {
        if (err instanceof CliError) {
          emitError(err.message, err.exitCode);
        }
        const message = err instanceof Error ? err.message : String(err);
        emitError(`failed to stop server: ${message}`, 'RUNTIME');
      }
    });

  return cmd;
}
