// 把 transformers 的 onnxruntime wasm 后端文件本地化到 public/ort/。
// 原因:transformers 默认从 jsdelivr CDN 动态 import ort-wasm-*.mjs,
// 但 MV3 extension_pages CSP 硬性禁止远程脚本(script-src 只能 'self')。
// 故拷到扩展 public/ → vite 原样输出 dist/ort/,运行时 env.backends.onnx.wasm.wasmPaths 指向本地。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const require = createRequire(join(appRoot, 'package.json'));
// resolve 包主入口(exports '.'),其 dirname 即含 ort 文件的 dist 目录;
// 不能 resolve './dist/ort-*.mjs' 子路径——transformers 的 exports 未导出它,会 ERR_PACKAGE_PATH_NOT_EXPORTED。
const ortMjs = require.resolve('@huggingface/transformers');
const ortDir = dirname(ortMjs);
const outDir = join(appRoot, 'public', 'ort');
mkdirSync(outDir, { recursive: true });

const files = [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
];
for (const f of files) {
  const src = join(ortDir, f);
  if (!existsSync(src)) throw new Error(`ort 文件缺失: ${src}`);
  copyFileSync(src, join(outDir, f));
  console.log(`✓ copied ${f}`);
}
console.log('ort wasm 本地化完成 → public/ort/');
