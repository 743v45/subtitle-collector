// server 侧 KV 设置（settings 表）。当前只存标签展示优先级 tag_priority。
// 每次直读 DB（better-sqlite3 同步单进程微秒级，不做内存缓存——缓存要处理失效，不值）。
import type Database from 'better-sqlite3';

// 六档固定集合（含 bili/season 只读档）；顺序即展示优先级（高 → 低）。
// season=合集档：只读实时读 extra.ugc_season.title（对齐 bili，不落表，见 http/queries.ts 富化）。
// system=系统状态档（2026-08-23，如 no-subtitle）：采集链路自动打，默认排最后（状态标不抢展示位）。
export type TagPrioritySource = 'manual' | 'batch' | 'bili' | 'season' | 'ai' | 'system';
export const DEFAULT_TAG_PRIORITY: readonly TagPrioritySource[] = ['manual', 'batch', 'bili', 'season', 'ai', 'system'] as const;

function isPermutationOfAllTiers(arr: unknown): arr is TagPrioritySource[] {
  return Array.isArray(arr) && arr.length === DEFAULT_TAG_PRIORITY.length &&
    DEFAULT_TAG_PRIORITY.every((s) => arr.includes(s));
}

// 读标签优先级：缺行 / JSON 损坏 / 非六档精确排列 → 回落默认（不炸调用方）。
// 五档时代存的 settings 不含 system → 校验失败回落新默认（一次性自动升级，自定义顺序重置）。
export function getTagPriority(db: Database.Database): TagPrioritySource[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('tag_priority') as { value: string } | undefined;
  if (!row) return [...DEFAULT_TAG_PRIORITY];
  try {
    const parsed = JSON.parse(row.value);
    if (isPermutationOfAllTiers(parsed)) return parsed;
  } catch { /* 损坏回落 */ }
  return [...DEFAULT_TAG_PRIORITY];
}

// 写标签优先级：必须是六档的精确排列，否则抛错（http 层转 400）。
export function setTagPriority(db: Database.Database, priority: unknown): TagPrioritySource[] {
  if (!isPermutationOfAllTiers(priority)) {
    throw new Error('priority must be an exact permutation of manual|batch|bili|season|ai|system');
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('tag_priority', JSON.stringify(priority));
  return priority;
}

// ── 采集超时配置（2026-08-22，按平台分档，单位毫秒）──
// 两平台超时语义不同（对齐各自采集链路）：
//   youtube：扩展侧「无进展窗口」——navigate 后台 tab 里持续无新进展（就绪/轨数/正文数指纹
//            不变）此时长才判超时，默认 45s。慢视频（轨加载极慢）调大它；派发时随命令下发
//            （background.js 读 msg.timeout_ms，旧扩展忽略未知字段回落内置 45s）。
//   bilibili：server 等扩展回执的总预算——扩展纯 API 拉取无自限窗口，默认 90s。
// server 对 youtube 的等回执预算 = 窗口 + 135s 余量（覆盖关 tab/INGEST 落库，对齐原 45s+180s 关系），
// 见 tasks.commandTimeoutMs。
export interface CollectTimeoutMs { bilibili: number; youtube: number; }
export const DEFAULT_COLLECT_TIMEOUT_MS: CollectTimeoutMs = { bilibili: 90_000, youtube: 45_000 };
const TIMEOUT_MIN_MS = 15_000;  // 下限：再短必误杀（navigate 就要 ~20s）
const TIMEOUT_MAX_MS = 600_000; // 上限：10 分钟防呆

function isValidTimeout(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= TIMEOUT_MIN_MS && v <= TIMEOUT_MAX_MS;
}

// 读采集超时：缺行 / JSON 损坏 / 单项越界 → 逐项回落默认（不炸调用方）。
export function getCollectTimeout(db: Database.Database): CollectTimeoutMs {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('collect_timeout_ms') as { value: string } | undefined;
  if (!row) return { ...DEFAULT_COLLECT_TIMEOUT_MS };
  try {
    const parsed = JSON.parse(row.value) as Partial<CollectTimeoutMs>;
    return {
      bilibili: isValidTimeout(parsed.bilibili) ? parsed.bilibili : DEFAULT_COLLECT_TIMEOUT_MS.bilibili,
      youtube: isValidTimeout(parsed.youtube) ? parsed.youtube : DEFAULT_COLLECT_TIMEOUT_MS.youtube,
    };
  } catch { /* 损坏回落 */ }
  return { ...DEFAULT_COLLECT_TIMEOUT_MS };
}

// 写采集超时：两键齐全且均为 [15s, 600s] 整数毫秒，否则抛错（http 层转 400，失败可见）。
export function setCollectTimeout(db: Database.Database, value: unknown): CollectTimeoutMs {
  const v = value as Partial<CollectTimeoutMs> | null;
  if (!v || !isValidTimeout(v.bilibili) || !isValidTimeout(v.youtube)) {
    throw new Error(`collect timeout must be {bilibili, youtube} integer ms in [${TIMEOUT_MIN_MS}, ${TIMEOUT_MAX_MS}]`);
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('collect_timeout_ms', JSON.stringify(v));
  return { bilibili: v.bilibili, youtube: v.youtube };
}
