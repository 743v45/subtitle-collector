// vitest 全局 setup：jest-dom matchers（toBeInTheDocument 等）。
import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// findBy*/waitFor 默认 1s，在满负荷机器（并行跑多 app 测试）上 jsdom 渲染偶发超时——
// 与 vite.config.ts 的 testTimeout=15s 对齐放宽墙钟预算（2026-08-29 douyin 接入用例扩容后实测需要），
// 只放宽等待上限不放宽断言。（configure 经 @testing-library/react 再导出，dom 是传递依赖不可直引）
configure({ asyncUtilTimeout: 5_000 });
