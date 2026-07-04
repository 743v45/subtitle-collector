#!/usr/bin/env node
// CLI 入口：commander 装配全局选项 + 命令注册。
// 命令组（videos/changes/export/stats/clients/server）由同事阶段2 在 src/cli/commands/*.ts 实现，
// 在 main() 内 import 并 program.addCommand 注册（函数内动态 import 避免顶层循环依赖）。
// 设计参考 [设计文档第3章命令树](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。

import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { resolveConfig } from './config.js';
import { emitResult, emitError, setQuiet, EXIT_CODES, type Format } from './output.js';

// 与 [package.json](apps/collector-server/package.json) version 保持一致；硬编码避免 tsx 跑 JSON import attribute 的兼容性麻烦。
const VERSION = '0.1.0';

// 全局上下文：把解析后的全局选项 + resolveConfig 结果打包，传给（未来的）命令处理。
// 命令组通过 getCliContext() 拿到当前上下文（在 commander action 内调用）。
export interface CliContext {
  format: Format;
  dbPath: string;
  serverUrl: string;
  token: string;
  quiet: boolean;
}

let currentContext: CliContext | null = null;

// 在 commander preAction 钩子里设置；命令 action 内调用。
// 设计取舍：用模块态而非参数注入，因为 commander 的 .action(callback) 签名不便多传 context，
// 而各命令 buildXxxCommand() 在模块加载时构造、context 在 parse 后才确定——只能延迟到 action 取。
export function getCliContext(): CliContext {
  if (!currentContext) {
    emitError('CLI context not initialized (preAction hook did not run)', 'RUNTIME');
  }
  return currentContext;
}

const program = new Command();

program
  .name('collector-cli')
  .description('bilibili 字幕采集项目的 agent 友好 CLI（数据查询 / 导出 / 汇总 / 客户端管控 / server 运维）')
  .version(VERSION, '-v, --version', '输出版本号')
  .option('--format <json|ndjson|csv|table>', '输出格式', 'json')
  .option('--db <path>', 'SQLite 路径（默认 $COLLECTOR_DB_PATH 或 ./apps/collector-server/bilibili-collector.db）')
  .option('--server <url>', 'server URL（默认 $COLLECTOR_SERVER 或 http://127.0.0.1:21527）')
  .option('--token <token>', '鉴权 token（默认 $COLLECTOR_TOKEN）')
  .option('-q, --quiet', '抑制 stderr 人类日志（stdout JSON 仍输出）', false);

// preAction：构造 CliContext + 同步 quiet 到 output 层。每个子命令 action 前都会跑。
program.hook('preAction', () => {
  const opts = program.opts() as {
    format?: string;
    db?: string;
    server?: string;
    token?: string;
    quiet?: boolean;
  };
  const format = normalizeFormat(opts.format);
  const cfg = resolveConfig({ db: opts.db, server: opts.server, token: opts.token });
  currentContext = { format, ...cfg, quiet: !!opts.quiet };
  setQuiet(currentContext.quiet);
});

function normalizeFormat(raw: string | undefined): Format {
  if (raw === 'json' || raw === 'ndjson' || raw === 'csv' || raw === 'table') return raw;
  // 非法值（commander 已收住 default 'json'，这里只兜底）：默认 json。
  return 'json';
}

// 占位：version 子命令证明骨架可跑（commander 内置的 --version 也已生效）。
program
  .command('version')
  .description('输出版本号')
  .action(() => {
    const ctx = getCliContext();
    emitResult({ name: 'collector-cli', version: VERSION }, ctx.format);
  });

// 命令组在 main() 内动态 import + addCommand 注册（避免顶层循环依赖：
// commands/*.ts 反向 import 本模块的 getCliContext，故须延迟到运行时解析）。

export async function main(): Promise<void> {
  try {
    const [
      { buildVideosCommand },
      { buildVersionsCommand },
      { buildChangesCommand },
      { buildExportCommand },
      { buildStatsCommand },
      { buildClientsCommand },
      { buildServerCommand },
    ] = await Promise.all([
      import('./commands/videos.js'),
      import('./commands/versions.js'),
      import('./commands/changes.js'),
      import('./commands/export.js'),
      import('./commands/stats.js'),
      import('./commands/clients.js'),
      import('./commands/server.js'),
    ]);
    program.addCommand(buildVideosCommand());   // videos list / get / get-by-id
    program.addCommand(buildVersionsCommand()); // versions get
    program.addCommand(buildChangesCommand());  // changes list
    program.addCommand(buildExportCommand());   // export subtitle / export videos
    program.addCommand(buildStatsCommand());    // stats overview / stats count --by
    program.addCommand(buildClientsCommand());  // clients list / reporting / command
    program.addCommand(buildServerCommand());   // server ping / status / start / stop

    await program.parseAsync(process.argv);
  } catch (err) {
    // action 处理函数内未捕获的异常：当运行时错误处理。
    // 注意：commander 自身的用法错误（未知选项/缺参数）由 commander 默认流程处理（默认退 1），
    // 不会走到这里——按设计文档约定先信任 commander 默认退出码。
    const message = err instanceof Error ? err.message : String(err);
    if (!currentContext?.quiet) {
      process.stderr.write(`[collector-cli] RUNTIME: ${message}\n`);
    }
    process.exit(EXIT_CODES.RUNTIME);
  }
}

// 仅在作为入口直接执行时跑（避免 commands/*.test.ts import 本模块时副作用触发 parseAsync）。
const isMain = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  void main();
}
