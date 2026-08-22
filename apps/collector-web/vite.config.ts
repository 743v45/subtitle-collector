/// <reference types="vitest/config" />
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
      // COLLECTOR_PROXY_PORT：本地验证时指向并行起的 dev server（默认 21527 生产/常规值不变）
      '/api': `http://127.0.0.1:${process.env.COLLECTOR_PROXY_PORT ?? 21527}`,
      '/ping': `http://127.0.0.1:${process.env.COLLECTOR_PROXY_PORT ?? 21527}`,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test-setup.ts', 'src/main.tsx', 'src/types.ts'],
      // 覆盖率阈值锁定（2026-08-23 实测值向下取整，只升不降）：statements 100 / branches 93.07→93 / functions 93.39→93 / lines 100。
      // 上调时机与流程见 CLAUDE.md 测试质量政策。
      thresholds: { statements: 100, branches: 93, functions: 93, lines: 100 },
    },
  },
});
