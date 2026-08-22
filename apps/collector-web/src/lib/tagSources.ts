// 标签五档来源（与 server tag-priority 五档一致）：
// manual=手动 / batch=批量 / bili=视频自带 / season=合集（只读，实时读 extra.ugc_season.title）/ ai=AI 标记。
// 颜色全部用静态 Tailwind 类字面量（JIT 扫描源码识别），禁内联 style / 动态拼接类名。

export type TagSource = 'manual' | 'batch' | 'bili' | 'season' | 'ai';

// 暗色媒体库主题（2026-08-22）：x-500/10 半透明底 + x-300 字（暗底对比 7-10:1）+ x-500/30 边。
export const TAG_SOURCE_CLASS: Record<TagSource, string> = {
  manual: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  batch: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  bili: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  season: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  ai: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
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
