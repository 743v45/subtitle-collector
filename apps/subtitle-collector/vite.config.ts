import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json';

// subtitle-collector 构建配置：crxjs 读 manifest.json 自动接管 popup/SW/content_scripts 入口；
// background/content/inject 是裸 JS，crxjs 当 Rollup 入口透传打包。
// 产物落 dist/，verify 脚本通过 --load-extension=apps/subtitle-collector/dist 加载。
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // dev server 端口必须钉死。CRXJS 会把 dev server 端口硬编码进 dist 产物
  // （loading-page 的 VITE_URL、service-worker-loader 的 import 'http://localhost:<port>/...'）。
  // monorepo 里 collector-web 也跑 Vite，默认都从 5173 起步、被占就 +1，本扩展会被挤到
  // 5174+ 而漂移；一旦实际端口与 dist 里烧死的端口不一致，popup 就陷入
  // 「探测 /@crx/dev-ready → reload → 仍是 loading-page」的闪烁死循环。
  // strictPort:true 让端口被占时直接报错，而不是悄悄漂移再触发该 bug。
  server: {
    port: 5174,
    strictPort: true,
    hmr: { port: 5174 },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
