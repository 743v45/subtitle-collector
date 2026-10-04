// UP 主区段 API（2026-10-05 自 api.ts 抽出，偿还 api.ts maxLines 台账；沿 db 层 changes-log.ts
// 先例做单向拆分）。api.ts 仍是对外唯一入口（'@/api'）：调用方不经本文件直接 import，
// api.ts 以 re-export 保持既有 import 路径不变；本文件禁止反向 import api.ts（防依赖环）。
import type { CreatorDetail } from './types';
import { ensureOk, BASE } from './apiCore';

// UP 主列表行（server /api/creators items 元素）
export interface CreatorListItem {
  id: number;
  source: string;
  source_uid: string;
  name: string | null;
  avatar: string | null;
  fans: number | null;
  video_count: number;
  category_agent_id: number | null;
  category_agent_name: string | null;
  category_human_id: number | null;
  category_human_name: string | null;
  first_seen_at: number;
}

export async function listCreators(params: {
  q?: string;
  category?: string;
  scope?: 'agent' | 'human';
  source?: string;   // 平台过滤（bilibili|youtube|douyin）
  sort?: 'first_seen' | 'fans' | 'video_count';
  page?: number;
  size?: number;
}): Promise<{ total: number; items: CreatorListItem[] }> {
  const u = new URLSearchParams();
  if (params.q) u.set('q', params.q);
  if (params.category) u.set('category', params.category);
  if (params.scope) u.set('scope', params.scope);
  if (params.source) u.set('source', params.source);
  if (params.sort) u.set('sort', params.sort);
  u.set('page', String(params.page ?? 1));
  u.set('size', String(params.size ?? 20));
  const r = await fetch(`${BASE}/api/creators?${u}`);
  return ensureOk(r, (j) => ({ total: j.total ?? 0, items: j.items ?? [] }));
}

export async function getCreatorDetail(id: number): Promise<CreatorDetail> {
  const r = await fetch(`${BASE}/api/creators/${id}`);
  return ensureOk(r, (j) => j.creator);
}

// 刷新 UP 主资料（POST /api/creators/{id}/refresh）：响应 {ok, creator}。
// creator 即服务端 creators 行（snake_case），复用 types.ts 已有 CreatorDetail（同域同形，
// 无需另立 CreatorInfo 别名）。
export async function refreshCreatorProfile(id: number): Promise<{ creator: CreatorDetail }> {
  const r = await fetch(`${BASE}/api/creators/${id}/refresh`, { method: 'POST' });
  return ensureOk(r, (j) => ({ creator: j.creator }));
}

// 打分类：路径带平台段（2026-08-24）——uid 两平台命名空间独立，不带平台会写错行。
export async function setCreatorCategory(
  source: string,
  source_uid: string,
  scope: 'agent' | 'human',
  name: string,
): Promise<void> {
  const r = await fetch(`${BASE}/api/creators/by-uid/${source}/${encodeURIComponent(source_uid)}/category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, name }),
  });
  await ensureOk(r, () => undefined); // await：否则失败被吞成 floating promise，调用方以为设置成功
}

// 批量改分类（POST /api/creators/batch-category）：body {ids, agent_category_id?, human_category_id?}，
// 槽位三态（2026-10-05 对抗审查 blocker 修复后契约，与 server parseCategorySlot 逐字对齐）：
// undefined（键省略，JSON.stringify 丢键）= 保持原值；null = 清空该槽；数字 = 写该分类 id。
// 响应 {ok, updated}。
export async function setCreatorsCategoryBatch(
  ids: number[],
  agentCategoryId?: number | null,
  humanCategoryId?: number | null,
): Promise<{ updated: number }> {
  const r = await fetch(`${BASE}/api/creators/batch-category`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, agent_category_id: agentCategoryId, human_category_id: humanCategoryId }),
  });
  return ensureOk(r, (j) => ({ updated: j.updated ?? 0 }));
}
