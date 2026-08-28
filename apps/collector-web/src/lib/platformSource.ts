// 平台源白名单（2026-08-29 douyin 接入后三平台）：URL query ?source= 的解析收敛共享件。
// 五页（Creators/Tags/Stats/ChangesLog/TasksHistory）页内重复的三连等值白名单抽出——
// 加第四平台时只改这里（逻辑沉淀：一处值域，页内不再散落分支）。
// VideoList 的 source 是自由透传（不白名单），不在此列。

export const PLATFORM_SOURCES = ['bilibili', 'youtube', 'douyin'] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];

// 非法/缺失值收敛 null（=全部平台）；合法值原样返回（窄类型，直接传 api 层）。
export function parseSourceFilter(raw: string | null): PlatformSource | null {
  return (PLATFORM_SOURCES as readonly string[]).includes(raw ?? '') ? (raw as PlatformSource) : null;
}
