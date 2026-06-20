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
});
