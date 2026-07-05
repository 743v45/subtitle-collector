// CLI 全局配置解析：把 --db / --server / --token 选项 + 环境变量收敛成一份确定配置。
// 命令组（videos/changes/clients/...）通过 main.ts 的 CliContext 拿到本文件 resolveConfig 的结果，
// 自身不直接读 process.env，便于在测试里注入任意配置。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolvedConfig {
  dbPath: string;
  serverUrl: string;
  token: string;
}

export interface ResolveConfigOpts {
  db?: string;
  server?: string;
  token?: string;
}

// apps/collector-server 绝对路径，用 import.meta.url 解析——不依赖 cwd。
// 背景：根 package.json 的 `pnpm cli` 走 `pnpm -C apps/collector-server exec`，会把 cwd 切到
// app 内，旧相对路径 './apps/collector-server/...' 错位成 app 内再套一层（DB_UNREADABLE）。
// 与 [server.ts](cli/commands/server.ts) 的 serverRoot() 同模式（那里向上 3 层；本文件在
// src/cli/config.ts，向上 2 层 = apps/collector-server）。
function appRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../src/cli
  return resolve(here, '../..'); // .../apps/collector-server
}

// 默认 DB 路径：apps/collector-server/bilibili-collector.db（绝对路径，与 server 侧
// [main.ts](apps/collector-server/src/main.ts) 写库位置一致）。不依赖 cwd。
// 也允许 env COLLECTOR_DB_PATH 覆盖，或 --db 显式传绝对/相对路径。
const DEFAULT_DB_PATH = join(appRoot(), 'bilibili-collector.db');
// server 默认 loopback，与 [main.ts](apps/collector-server/src/main.ts) 的 PORT 一致。
const DEFAULT_SERVER_URL = 'http://127.0.0.1:21527';
// 与扩展端 config.js / server main.ts 的默认 token 保持一致。
const DEFAULT_TOKEN = 'change-me-collector-token';

export function resolveConfig(opts: ResolveConfigOpts = {}): ResolvedConfig {
  const dbPath = opts.db ?? process.env.COLLECTOR_DB_PATH ?? DEFAULT_DB_PATH;
  const serverUrl = opts.server ?? process.env.COLLECTOR_SERVER ?? DEFAULT_SERVER_URL;
  const token = opts.token ?? process.env.COLLECTOR_TOKEN ?? DEFAULT_TOKEN;
  return { dbPath, serverUrl, token };
}
