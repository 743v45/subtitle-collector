// CLI 只读 DB 连接 helper：复用 server 写入的 SQLite 文件（WAL 模式下只读连接可与 server 写并发）。
// 严格只读——CLI 永不写库；migrate / WAL 设置由 server 侧 [migrate.ts](apps/collector-server/src/db/migrate.ts) 负责。

// 值导入（构造器）与类型导入分开：`import type Database` 会被 tsx/esbuild 整体剥掉，
// 构造器处变 undefined（TS1361），openReadonlyDb 运行时必抛 DB_UNREADABLE。
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { existsSync, writeSync } from 'node:fs';
import { getCliContext } from './context.js';
import { emitError } from './output.js';

// 打开只读连接。文件不存在时抛清晰错误（调用方捕获后 emitError DB_UNREADABLE）。
// 注意：better-sqlite3 默认会为新路径创建空文件，故先 existsSync 判存在再打开，避免生成空 DB 误导。
export function openReadonlyDb(dbPath: string): Database {
  if (!existsSync(dbPath)) {
    throw new Error(`DB file not found: ${dbPath}`);
  }
  return new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
}

// 打开只读 DB；失败 → DB_UNREADABLE（emitError 返回 never，两条路径都满足返回类型）。
// 同时承担 DB-only 命令组的 --server 静默警告（一处生效）：videos/sub/export/stats/changes/comments/danmaku 七组
// （comments 为 2026-10-04 C5 新增的 tree/verify 只读查看组；danmaku verify 为 2026-10-07 同款只读校验组）
// 全部只读 --db，全局 --server 被静默忽略已两次造成「以为查了生产实际查了 dev 库」——
// 用户显式给了 --server 时 stderr 输出一行中文警告指路快照脚本；env COLLECTOR_SERVER / 默认值不告警。
// 警告走 fs.writeSync 直写 fd 2 而非 process.stderr.write：后者在 pipe（被脚本/测试子进程捕获时）
// 上是异步队列，本警告后紧跟 emitError 的 process.exit——全量并发实测排队中的首行会在 exit 时被
// 丢弃（单跑正常、并发全量必丢，2026-10-02）。安全互锁警告必须无条件落地，故同步直写；
// 不走 logInfo 同理：不受 -q 抑制（恰恰要打扰用了错误姿势的调用方）。
export function openDbOrEmit(dbPath: string): Database {
  const ctx = getCliContext();
  if (ctx.serverExplicit) {
    writeSync(
      2,
      '警告: 该命令只读本地 --db，--server 已忽略（查生产先做快照: node scripts/export-bundle.mjs 或 scripts/backup-export.mjs）\n',
    );
  }
  try {
    return openReadonlyDb(dbPath);
  } catch (err) {
    return emitError((err as Error).message, 'DB_UNREADABLE');
  }
}
