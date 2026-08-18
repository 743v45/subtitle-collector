#!/usr/bin/env node
// 启动 collector-server（node24：better-sqlite3 已按 node24 ABI 重编译（原 node22 路径已失效））
import { spawn } from "node:child_process";
import { chdir } from "node:process";

const SERVER_DIR = "/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server";
const NODE = "/Users/taevas/.nvm/versions/node/v24.13.0/bin";

chdir(SERVER_DIR);
const child = spawn(`${NODE}/npx`, ["tsx", "src/main.ts"], {
  stdio: "inherit",
  env: { ...process.env, PATH: `${NODE}:${process.env.PATH}` },
});
child.on("exit", (c) => process.exit(c ?? 0));
