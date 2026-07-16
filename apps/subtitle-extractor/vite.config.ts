import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { fileURLToPath } from 'node:url';
import manifest from './manifest.json';

// subtitle-extractor 构建配置：crxjs 读 manifest.json 自动接管 popup / SW 入口。
// offscreen.html 是扩展内页面（offscreen document 宿主），不在 manifest 标准字段里，
// 故显式加进 rollupOptions.input，让 vite 构建它 + 它引用的 offscreen.js（含 @voicetxt/core / transformers）。
// dev 端口钉死 5175（5173=collector-web、5174=subtitle-collector 已占），strictPort 防 crxjs
// 把端口烧死进 dist 后漂移触发 popup 闪烁死循环（见 subtitle-collector/vite.config.ts 注释）。
export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5175,
    strictPort: true,
    hmr: { port: 5175 },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        offscreen: fileURLToPath(new URL('./offscreen.html', import.meta.url)),
      },
    },
  },
});
