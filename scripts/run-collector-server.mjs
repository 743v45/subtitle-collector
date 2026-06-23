#!/usr/bin/env node
// 用 node22 启动 collector-server（避免 better-sqlite3 native 版本不匹配）
import { spawn } from "node:child_process";
import { chdir } from "node:process";

const SERVER_DIR = "/Users/taevas/code/mymy/bilibili-extensions/apps/collector-server";
const NODE22 = "/Users/taevas/.nvm/versions/node/v22.21.1/bin";

chdir(SERVER_DIR);
const child = spawn(`${NODE22}/npx`, ["tsx", "src/main.ts"], {
  stdio: "inherit",
  env: { ...process.env, PATH: `${NODE22}:${process.env.PATH}` },
});
child.on("exit", (c) => process.exit(c ?? 0));
