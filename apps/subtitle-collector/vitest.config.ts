// vitest 独立配置（2026-10-07 popup 形态锁定测试引入，用户需求「popup 长什么样，测试用例能固定下来吗」）。
// 刻意**不复用** vite.config.ts：它被 @crxjs 接管（manifest 驱动入口 + dev server 端口烧录进产物），
// vitest 复用有兼容风险；本文件只服务 src/**/*.test.tsx 的 jsdom UI 测试，互不干扰。
// 栈对齐 apps/collector-web 先例：vitest + jsdom + @testing-library/react（版本照抄其 devDeps）；
// globals 保持 false（测试内显式 import { test, expect } from 'vitest'，对齐 collector-web 风格）；
// tsx 转换走 vitest 原生 esbuild（plugin-react 与 collector-web 同款，兜 jsx runtime）。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }, // shadcn 组件 @/ 引用，与 vite.config.ts 同源
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ui.ts'],
    // 只收 src/ 旁的 .tsx 组件测试；根目录 test/*.test.mjs（node:test + c8 口径）不归 vitest 管，
    // 两条测试链路互不重叠——package.json 的 test 脚本为「c8 ... && vitest run」串联双绿。
    include: ['src/**/*.test.tsx'],
  },
});
