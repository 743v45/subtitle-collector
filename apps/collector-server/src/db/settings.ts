// server 侧 KV 设置（settings 表）。当前只存标签展示优先级 tag_priority。
// 每次直读 DB（better-sqlite3 同步单进程微秒级，不做内存缓存——缓存要处理失效，不值）。
import type Database from 'better-sqlite3';

// 四档固定集合（含 bili）；顺序即展示优先级（高 → 低）。
export type TagPrioritySource = 'manual' | 'batch' | 'bili' | 'ai';
export const DEFAULT_TAG_PRIORITY: readonly TagPrioritySource[] = ['manual', 'batch', 'bili', 'ai'] as const;

function isPermutationOfAllFour(arr: unknown): arr is TagPrioritySource[] {
  return Array.isArray(arr) && arr.length === 4 &&
    DEFAULT_TAG_PRIORITY.every((s) => arr.includes(s));
}

// 读标签优先级：缺行 / JSON 损坏 / 非四档精确排列 → 回落默认（不炸调用方）。
export function getTagPriority(db: Database.Database): TagPrioritySource[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('tag_priority') as { value: string } | undefined;
  if (!row) return [...DEFAULT_TAG_PRIORITY];
  try {
    const parsed = JSON.parse(row.value);
    if (isPermutationOfAllFour(parsed)) return parsed;
  } catch { /* 损坏回落 */ }
  return [...DEFAULT_TAG_PRIORITY];
}

// 写标签优先级：必须是四档的精确排列，否则抛错（http 层转 400）。
export function setTagPriority(db: Database.Database, priority: unknown): TagPrioritySource[] {
  if (!isPermutationOfAllFour(priority)) {
    throw new Error('priority must be an exact permutation of manual|batch|bili|ai');
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('tag_priority', JSON.stringify(priority));
  return priority;
}
