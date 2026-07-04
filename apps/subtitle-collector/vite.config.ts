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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
  },
});
