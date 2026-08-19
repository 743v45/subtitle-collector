# Web 布局优化（移动优先导航 + 视频网格）— 设计文档

- 日期:2026-08-19
- 状态:已实现(本文档为实现后补记,内容与代码一致)
- 相关提交:feat(web): 移动端底部导航 + 视频列表响应式网格

## 1. 背景与目标

手机是第一使用场景(发起采集、看任务状态),桌面次之(浏览/复制字幕)。原布局单一骨架:

- **移动端**:8 个顶部 tab 按钮 `flex-wrap` 折成 4 行,头部占 ~300px,第一屏几乎全是导航;
- **桌面端**:`max-w-5xl` 单列卡片流,1280px 下两侧大片留白,视频列表信息密度低。

目标:移动第一屏全给内容;桌面视频页多列提密度。改动范围限定**导航骨架 + 视频列表**,其余页面不动。

## 2. 导航骨架([App.tsx](../../../apps/collector-web/src/App.tsx))

导航分级(8 tab 一套定义,lucide 图标):

- **高频 3 格**(移动底部直达):采集 / 视频 / 看板;
- **低频 5 格**(「更多」弹层):创作者 / 分类 / 标签 / 客户端 / 日志。

**移动端(<md)**:

- 头部只剩标题一行(桌面 nav `hidden`);
- 底部固定 Tab Bar(`fixed bottom-0 z-40`,4 等分:3 高频 + ⋯更多),icon 上文字下,active 高亮 `text-primary`;当前 tab 属于低频集合时「更多」格高亮;
- `h-[env(safe-area-inset-bottom)]` 适配 iPhone 小黑条(index.html 已有 `viewport-fit=cover`);
- 内容区 `pb-24` 让位 bar;
- 「更多」点开 shadcn `Dialog`(复用既有组件),`DialogContent` 传类覆盖为底部 sheet 样式(`top-auto bottom-0 translate-x-0 translate-y-0 rounded-t-lg`),5 入口 `grid-cols-3`,点击 `switchTab` 并关闭。

**桌面端(≥md)**:保持顶部单行全量 tab(现状可用),底部 bar `md:hidden`。

## 3. 容器宽度

`main` 与 header 容器 `max-w-5xl` → `max-w-6xl`(1152px),为视频网格第三列留空间;表单/看板类页面宽度略增无副作用。

## 4. 视频列表([VideoList.tsx](../../../apps/collector-web/src/pages/VideoList.tsx))

- 列表容器 `space-y-2` → **响应式网格** `grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3 xl:grid-cols-3`;
- 卡片紧凑化:`p-4 → p-3`、标题 `text-base → text-sm` 且 `truncate → line-clamp-2`(两行截断,网格内近似等高;平台图标 `mt-0.5` 对齐首行);
- loading skeleton 4 → 6(适配三列两行);错误/空态卡 `col-span-full` 横跨整行。

## 5. 测试

- collector-web 无组件单测,按项目政策走 `vite build` 冒烟(含在 `turbo run test`);
- puppeteer 截图人工验收:移动 390px(采集/视频/更多弹层)+ 桌面 1280px(采集/视频三列网格),5 张全部符合设计。

### 测试轮次记录表

| 轮次 | 命令 | 结果 | 备注 |
|---|---|---|---|
| 1 | `pnpm build:web` | 通过 | 产物 index-VeM6DbRs.js |
| 2 | 临时 server(tsx,21599)puppeteer 截图 | 5/5 符合设计 | 移动第一屏全内容;桌面 3 列网格 |
| 3 | `pnpm test`(turbo 全量) | 3 包全绿 | server 264/264 |

## 6. 边界与已知取舍

- 底部 bar 用原生 `<button>` + Tailwind 而非 shadcn Button——shadcn 无 tab bar 组件,flex-col 布局原生更干净(符合项目样式政策:Tailwind 工具类,无手写 CSS);
- 「更多」用 Dialog 而非 Drawer——项目未装 Drawer 组件,Dialog 传类已够底部 sheet 效果,不为此引新依赖;
- 不做路由(URL 不含 tab 状态,刷新回默认「采集」)——与现状一致,超本期范围。
