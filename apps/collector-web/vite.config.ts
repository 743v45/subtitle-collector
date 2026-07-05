import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }, // shadcn 组件用 @/components/ui 引用
  },
  build: {
    outDir: resolve(__dirname, '../collector-server/public'),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:21527',
      '/ping': 'http://127.0.0.1:21527',
    },
  },
});
