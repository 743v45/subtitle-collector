// 标签五档来源（与 server tag-priority 五档一致）：
// manual=手动 / batch=批量 / bili=视频自带 / season=合集（只读，实时读 extra.ugc_season.title）/ ai=AI 标记。
// 颜色全部用静态 Tailwind 类字面量（JIT 扫描源码识别），禁内联 style / 动态拼接类名。

export type TagSource = 'manual' | 'batch' | 'bili' | 'season' | 'ai';

export const TAG_SOURCE_CLASS: Record<TagSource, string> = {
  manual: 'border-blue-200 bg-blue-100 text-blue-800',
  batch: 'border-amber-200 bg-amber-100 text-amber-800',
  bili: 'border-pink-200 bg-pink-100 text-pink-800',
  season: 'border-teal-200 bg-teal-100 text-teal-800',
  ai: 'border-violet-200 bg-violet-100 text-violet-800',
};

export const TAG_SOURCE_LABEL: Record<TagSource, string> = {
  manual: '手动',
  batch: '批量',
  bili: 'B站',
  season: '合集',
  ai: 'AI',
};

// 优先级列表里的档位色点（与 TAG_SOURCE_CLASS 同色系、加深一档保证小圆点可见）
export const TAG_SOURCE_DOT: Record<TagSource, string> = {
  manual: 'bg-blue-500',
  batch: 'bg-amber-500',
  bili: 'bg-pink-500',
  season: 'bg-teal-500',
  ai: 'bg-violet-500',
};
