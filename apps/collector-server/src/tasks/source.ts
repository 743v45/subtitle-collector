// 采集平台枚举——server 全链路（任务/URL 解析/派发/HTTP 白名单/CLI）的统一 source 类型。
// 独立最小模块（不 import 任何东西）：tasks/tasks.ts 与 tasks/upper-expand.ts 都要用，
// 放任一侧会让另一侧反向 import 成环（depcruise 禁循环）。
// DB 侧 CHECK 约束见 schema.sql collect_tasks.source 与 migrate.ts v18（表重建放行 douyin）。
export type Source = 'bilibili' | 'youtube' | 'douyin';
