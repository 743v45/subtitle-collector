// 评论查看 hook（2026-10-08 popup 评论卡，用户现场指令「照抄弹幕卡先例」）。
// 拉取 collector-server GET /api/comments/list?bvid=<BV>&limit=200，Bearer 注入复用 hooks.ts 的 authInit
//（先例 hooks-danmaku.ts / hooks-collected.ts）。仅 bilibili 源调用（comments 表以 bvid 为键），
// 由调用方以 enabled 控制。措辞红线：本 hook 是评论（comment），与弹幕（danmaku）/字幕（subtitle）互不相干。
import { useEffect, useRef, useState } from 'react';
import { createCollectedRefresh } from '../../collected-refresh.mjs';
import { authInit } from './hooks';

// popup 拉取根评论上限（根评论条数上限，楼中楼随其根带出——防巨量视频撑爆 popup，
// server 端同名默认 LIST_LIMIT_DEFAULT；CommentsCard 截断提示文案复用此值）
export const COMMENTS_LIST_LIMIT = 200;

// 单条评论（server GET /api/comments/list 行；白名单子集 + has_picture 库内派生，0/1 与库内旗标同形态）
export interface CommentItem {
  rpid_str: string;
  is_root: number;
  uname: string | null;
  like_count: number;
  ctime_s: number | null;
  message: string | null;
  parent_reply_name: string | null;
  ip_location: string | null;
  pin_kind: string | null;
  state: number;
  folded: number;
  up_like: number;
  up_reply: number;
  is_up: number;
  has_picture: number;
  root_rpid: string;
  parent_rpid: string;
  dialog_rpid: string;
}

export interface CommentsData {
  /** 库内全部评论行（含根已删的孤儿楼层）——「未采集」判定与「N 条」徽标口径 */
  total_rows: number;
  total_roots: number;
  /** 根评论数超 limit 被截（本 hook 恒 limit=COMMENTS_LIST_LIMIT） */
  truncated: boolean;
  /** 渲染序平铺：置顶前置，其余根赞降序，楼随其根（组内 ctime 升序，与导出 md 同序） */
  comments: CommentItem[];
}

interface CommentsListResponse {
  ok: boolean;
  bvid?: string;
  total_rows?: number;
  total_roots?: number;
  truncated?: boolean;
  comments?: CommentItem[];
  error?: string;
}

// 响应归一（模块内纯函数，拆出以控 useComments fetch 体的圈复杂度 ≤15，对齐 normalizeDanmakuList）：
//   404 → 0 条（视频不在库=未采集，非错误）；!ok → data=null + error 文案；ok → 归一数据。
//   total_rows 容错：契约必回总数，缺失时回落 comments 长度。
function normalizeCommentsList(
  d: CommentsListResponse | null,
  status: number,
): { data: CommentsData | null; error: string | null } {
  if (status === 404) {
    return { data: { total_rows: 0, total_roots: 0, truncated: false, comments: [] }, error: null };
  }
  if (!d?.ok) return { data: null, error: d?.error ?? `HTTP ${status}` };
  const totalRows = typeof d.total_rows === 'number' ? d.total_rows : (d.comments?.length ?? 0);
  return {
    data: {
      total_rows: totalRows,
      total_roots: d.total_roots ?? 0,
      truncated: d.truncated === true,
      comments: d.comments ?? [],
    },
    error: null,
  };
}

// —— 评论列表：bvid → server 评论（视频未采评论/不在库 → 0 条，非错误）——
// 状态语义（消费方 CommentsCard，对齐 useDanmaku）：
//   data.total_rows > 0       → 已采，渲染「评论 N 条 + 可展开列表」；
//   data.total_rows === 0     → 未采集（含 server 404「视频不在库」，hook 归一为 0 条，灰字提示非错误）；
//   data=null 且 error=null   → 首拉中（loading）；
//   data=null 且 error 非 null → server 不可达/响应异常，UI 静默隐藏（对齐 hooks 家族 server-down 处置）。
// 刷新接线说明（对齐 useDanmaku 取舍记录）：评论入库走 collector-server 自有采集链路（comments collect），
// 不经扩展 ingest，INGEST_RESULT 实际不会改变评论数据；仍接 createCollectedRefresh——TASK_UPDATE 终态
// 兜底重拉 + 与 hooks 家族形态一致，多一次去抖重拉无害。
export function useComments(
  bvid: string | null | undefined,
  httpBase: string,
  enabled: boolean,
): { data: CommentsData | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<CommentsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const ctrl = createCollectedRefresh({ onRefresh: () => setRefreshKey((k) => k + 1) });
    const handler = (msg: unknown) => ctrl.notify(msg);
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
      ctrl.dispose();
    };
  }, []);
  // 记上次 bvid：仅切视频时清旧数据（防止 SPA 切视频后短暂展示上一视频的评论），
  // refreshKey 变更（去抖重拉）保留旧数据，避免「数据→空→数据」闪烁（对齐 useDanmaku）。
  const lastBvidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bvid || !enabled) {
      lastBvidRef.current = null;
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (bvid !== lastBvidRef.current) {
      lastBvidRef.current = bvid;
      setData(null);
      setError(null);
    }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await fetch(
          `${httpBase}/api/comments/list?bvid=${encodeURIComponent(bvid)}&limit=${COMMENTS_LIST_LIMIT}`,
          authInit({ cache: 'no-cache' }),
        );
        // 404 不解析 body（视频不在库，契约 body 无消费价值，也避开网关非 JSON 错误页）
        const d = r.status === 404 ? null : ((await r.json()) as CommentsListResponse);
        const n = normalizeCommentsList(d, r.status);
        if (alive) {
          setData(n.data);
          setError(n.error);
        }
      } catch (err) {
        // server 不可达 / 响应非 JSON：error 态，UI 静默隐藏（不弹错、组件不崩）
        if (alive) {
          setData(null);
          setError(String(err));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [bvid, httpBase, enabled, refreshKey]);
  return { data, error, loading };
}
