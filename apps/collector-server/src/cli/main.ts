#!/usr/bin/env node
// CLI 入口：commander 装配全局选项 + 命令注册。
// 命令组（videos/changes/export/stats/clients/server）由同事阶段2 在 src/cli/commands/*.ts 实现，
// 在 main() 内 import 并 program.addCommand 注册（函数内动态 import 避免顶层循环依赖）。
// 设计参考 [设计文档第3章命令树](docs/superpowers/specs/2026-07-05-collector-cli-design.md)。

import { pathToFileURL } from 'node:url';
import { writeSync } from 'node:fs';
import { Command } from 'commander';
import { resolveConfig } from './config.js';
import { emitResult, setQuiet, EXIT_CODES, type Format } from './output.js';
import { getCliContext, setCliContext, peekCliContext, type CliContext } from './context.js';
// 版本单源：读 [package.json](../../package.json) 的 version（2026-10-05 P1-11 去硬编码），
// --version 旗标与 version 子命令共用；再导出供测试锁定同源（version.test.ts）。
import { VERSION } from './version.js';
export { VERSION };

const program = new Command();

program
  .name('collector-cli')
  .description('bilibili 字幕采集项目的 agent 友好 CLI（数据查询 / 导出 / 汇总 / 客户端管控 / server 运维）')
  .version(VERSION, '-v, --version', '输出版本号')
  .option('--format <json|ndjson|csv|table>', '输出格式', 'json')
  .option('--db <path>', 'SQLite 路径（默认 $COLLECTOR_DB_PATH 或 apps/collector-server/bilibili-collector.db 绝对解析）')
  .option('--server <url>', 'server URL（默认 $COLLECTOR_SERVER 或 http://127.0.0.1:21527）')
  .option('--token <token>', '鉴权 token（默认 $COLLECTOR_TOKEN）')
  .option('-q, --quiet', '抑制 stderr 人类日志（stdout JSON 仍输出）', false);

// DB-only 命令组（openDbOrEmit 只读本地库文件，--server 不参与）：不打缺省防呆提示——本提示指路
// 「生产库加 --server」，而 DB-only 命令加了 --server 会被 openDbOrEmit 警告「已忽略」，两条提示
// 自相矛盾；该家族的生产防呆由 openDbOrEmit 的显式 --server 警告承担（查生产走 export-bundle.mjs）。
const DB_ONLY_GROUPS = new Set(['videos', 'sub', 'export', 'stats', 'changes', 'versions']);

// preAction：构造 CliContext + 同步 quiet 到 output 层。每个子命令 action 前都会跑。
// （commander hook 签名 = (thisCommand, actionCommand)：首参是挂 hook 的 program，次参才是待执行命令。）
program.hook('preAction', (_thisCmd: Command, actionCmd: Command) => {
  const opts = program.opts() as {
    format?: string;
    db?: string;
    server?: string;
    token?: string;
    quiet?: boolean;
  };
  const format = normalizeFormat(opts.format);
  const cfg = resolveConfig({ db: opts.db, server: opts.server, token: opts.token });
  const ctx: CliContext = {
    format,
    ...cfg,
    quiet: !!opts.quiet,
    // 只认命令行显式 --server（env/默认值不告警）——供 DB-only 命令组的 openDbOrEmit 输出忽略警告。
    serverExplicit: opts.server !== undefined,
  };
  setCliContext(ctx);
  setQuiet(ctx.quiet);
  // --server 缺省防呆（2026-10-02 CLI 完整度批次）：命令行与 env 都没指 server（真·默认值路径）时，
  // stderr 一行提示当前连的是本地 dev（数据偏旧）+ 生产库指路——防「以为查了生产实际查了 dev」。
  // -q 抑制（人类提示非安全互锁）；显式 --server / env 指定不提示（已 deliberate 指定目标）。
  // writeSync 直写 fd 2：本提示后可能紧跟 emitError 的 process.exit，pipe 上异步 stderr 队列会在
  // exit 时被丢（同 openDbOrEmit 警告的 2026-10-02 实测），防呆提示必须无条件落地。
  const group = actionCmd.parent?.name() ?? actionCmd.name();
  if (!ctx.quiet && opts.server === undefined && !process.env.COLLECTOR_SERVER && !DB_ONLY_GROUPS.has(group)) {
    writeSync(
      2,
      '[collector-cli] 未指定 --server：当前连本地 dev 库 http://127.0.0.1:21527（数据偏旧）；生产库需 --server https://collector.local.taevas.host --token <t>\n',
    );
  }
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

// 命令组在 main() 内动态 import + addCommand 注册（沿用既有结构；
// commands/*.ts 的上下文依赖已下沉到 ./context.js，不再反向 import 本模块）。

export async function main(): Promise<void> {
  try {
    const [
      { buildVideosCommand },
      { buildVersionsCommand },
      { buildChangesCommand },
      { buildExportCommand },
      { buildStatsCommand },
      { buildClientsCommand },
      { buildTasksCommand },
      { buildCreatorsCommand },
      { buildServerCommand },
      { buildCollectCommand },
      { buildYtSearchCommand },
      { buildSubCommand },
      { buildTagsCommand },
      { buildTranslateCommand },
      { buildAsrCommand },
      { buildCommentsCommand },
    ] = await Promise.all([
      import('./commands/videos.js'),
      import('./commands/versions.js'),
      import('./commands/changes.js'),
      import('./commands/export.js'),
      import('./commands/stats.js'),
      import('./commands/clients.js'),
      import('./commands/tasks.js'),
      import('./commands/creators.js'),
      import('./commands/server.js'),
      import('./commands/collect.js'),
      import('./commands/collect-yt-search.js'),
      import('./commands/sub.js'),
      import('./commands/tags.js'),
      import('./commands/translate.js'),
      import('./commands/asr.js'),
      import('./commands/comments.js'),
    ]);
    program.addCommand(buildVideosCommand());   // videos list / get / get-by-id
    program.addCommand(buildVersionsCommand()); // versions get
    program.addCommand(buildChangesCommand());  // changes list
    program.addCommand(buildExportCommand());   // export subtitle / export videos
    program.addCommand(buildStatsCommand());    // stats overview / stats count --by
    program.addCommand(buildClientsCommand());  // clients list / reporting / command
    program.addCommand(buildTasksCommand());    // tasks list / get / retry（采集任务查询与重试）
    program.addCommand(buildCreatorsCommand()); // creators list / get（UP 主查询,2026-10 账本 P1-7）
    program.addCommand(buildServerCommand());   // server ping / status / start / stop
    // collect search / subtitle / dedupe；yt-search 子命令在 collect 组装后挂载
    //（collect-yt-search.ts 复用 collect.ts 导出件，反向 import 会成环——在 main 组装层接线）
    const collectCmd = buildCollectCommand();
    collectCmd.addCommand(buildYtSearchCommand());
    program.addCommand(collectCmd);
    program.addCommand(buildSubCommand());   // sub search（字幕正文片段检索）
    program.addCommand(buildTagsCommand());  // tags list / apply / remove / rename / delete（视频标签与标签库纠错）
    program.addCommand(buildTranslateCommand()); // translate pending / source / fill（补翻工作流）
    program.addCommand(buildAsrCommand());       // asr backfill（无字幕兜底转写编排）
    program.addCommand(buildCommentsCommand());  // comments collect / tree / verify（评论采集与树查看,2026-10）

    await program.parseAsync(process.argv);
  } catch (err) {
    // action 处理函数内未捕获的异常：当运行时错误处理。
    // 注意：commander 自身的用法错误（未知选项/缺参数）由 commander 默认流程处理（默认退 1），
    // 不会走到这里——按设计文档约定先信任 commander 默认退出码。
    const message = err instanceof Error ? err.message : String(err);
    if (!peekCliContext()?.quiet) {
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
