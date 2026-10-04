// CLI 版本号单源：从 [package.json](../../package.json) 的 version 字段读取，杜绝硬编码漂移
// （2026-10-05 P1-11 / cli-completeness #11：VERSION 曾在 main.ts 硬编码 '0.1.0'）。
//
// 相对路径在三种运行形态下都成立——main 模块恒位于「package.json 所在目录」的下两级：
//   tsx 直跑   src/cli/main.ts       → apps/collector-server/package.json
//   tsc 产物   dist/cli/main.js      → apps/collector-server/package.json（tsconfig outDir=dist, rootDir=src）
//   容器内     /app/dist/cli/main.js → /app/package.json（Dockerfile runtime 阶段把 package.json 拷到 /app）
//
// 用 readFileSync + JSON.parse 而非 JSON import attribute：原硬编码注释即因 tsx 对 import attribute
// 的兼容性麻烦（main.ts:14 旧注），readFileSync 在两种形态下行为一致、无需 loader 支持。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// package.json 不可读/字段异常时的兜底：不崩整个 CLI（import 期抛错会废掉所有子命令），
// 但版本号明显异常（0.0.0-unknown）+ stderr 日志，部署问题当场可见。
export const FALLBACK_VERSION = '0.0.0-unknown';

export interface ReadCliVersionDeps {
  /** 读原始 JSON 文本（默认 readFileSync utf8）；测试注入用。 */
  read?: (url: URL) => string;
  /** 异常路径日志（默认 console.error 一行 stderr）；测试收集断言用。 */
  log?: (line: string) => void;
}

export function readCliVersion(deps: ReadCliVersionDeps = {}): string {
  const read = deps.read ?? ((url: URL) => readFileSync(url, 'utf8'));
  const log = deps.log ?? ((line: string) => { console.error(line); });
  const pkgUrl = new URL('../../package.json', import.meta.url);
  try {
    const raw = read(pkgUrl);
    const pkg = JSON.parse(raw) as { version?: unknown };
    if (typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
    log(`[collector-cli] package.json 缺少非空 version 字段（path=${fileURLToPath(pkgUrl)} got=${JSON.stringify(pkg.version)}）→ 兜底 ${FALLBACK_VERSION}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[collector-cli] 读取 package.json 失败（path=${fileURLToPath(pkgUrl)} err=${message}）→ 兜底 ${FALLBACK_VERSION}`);
  }
  return FALLBACK_VERSION;
}

// 模块加载期求值一次：main.ts（--version 旗标 + version 子命令）与未来任何消费方共用同一常量。
export const VERSION = readCliVersion();
