// 弹幕查看 hook（2026-10-07 弹幕采集树进 popup，用户现场指令「popup 也要同步支持复制」）。
// 拉取 collector-server GET /api/danmaku/list?bvid=<BV>，Bearer 注入复用 hooks.ts 的 authInit
//（先例 hooks-collected.ts）。仅 bilibili 源调用（danmaku 表以 bvid 为键），由调用方以 enabled 控制。
import { useEffect, useRef, useState } from 'react';
import { createCollectedRefresh } from '../../collected-refresh.mjs';
import { authInit } from './hooks';

// 单条弹幕（server /api/danmaku/list 行；只声明展示/复制消费的字段）
export interface DanmakuItem {
  progress_ms: number | null;
  mode: number | null;
  content: string | null;
  ctime_s: number | null;
}

// 弹幕分页行（cid+page 维度行数）；danmakus 已由 server 按 cid,page,progress_ms 升序摊平
export interface DanmakuPage {
  cid: number;
  page: number;
  rows: number;
}

export interface DanmakuData {
  rows: number;
  pages: DanmakuPage[];
  danmakus: DanmakuItem[];
}

interface DanmakuListResponse {
  ok: boolean;
  bvid?: string;
  rows?: number;
  pages?: DanmakuPage[];
  danmakus?: DanmakuItem[];
  error?: string;
}

// 响应归一（模块内纯函数，拆出以控 useDanmaku fetch 体的圈复杂度 ≤15）：
//   404 → 0 条（视频不在库=未采集，非错误）；!ok → data=null + error 文案；ok → 摊平数据。
//   rows 容错：契约必回总数，缺失时回落 danmakus 长度。
function normalizeDanmakuList(
  d: DanmakuListResponse | null,
  status: number,
): { data: DanmakuData | null; error: string | null } {
  if (status === 404) return { data: { rows: 0, pages: [], danmakus: [] }, error: null };
  if (!d?.ok) return { data: null, error: d?.error ?? `HTTP ${status}` };
  const rows = typeof d.rows === 'number' ? d.rows : (d.danmakus?.length ?? 0);
  return { data: { rows, pages: d.pages ?? [], danmakus: d.danmakus ?? [] }, error: null };
}

// —— 弹幕列表：bvid → server 弹幕（视频未采弹幕/不在库 → 0 条，非错误）——
// 状态语义（消费方 DanmakuCard）：
//   data.rows > 0            → 已采，渲染「弹幕 N 条 + 复制」；
//   data.rows === 0          → 未采集（含 server 404「视频不在库」，hook 归一为 0 条，灰字提示非错误）；
//   data=null 且 error=null  → 首拉中（loading）；
//   data=null 且 error 非 null → server 不可达/响应异常，UI 静默隐藏（对齐 hooks-collected 的 server-down 处置）。
// 刷新接线说明：弹幕入库走 collector-server 自有采集链路（danmaku-collect），不经扩展 ingest，
// INGEST_RESULT 实际不会改变弹幕数据；仍接 createCollectedRefresh——TASK_UPDATE 终态兜底重拉 +
// 与 hooks-collected 家族形态一致，多一次去抖重拉无害（2026-10-07 取舍记录）。
export function useDanmaku(
  bvid: string | null | undefined,
  httpBase: string,
  enabled: boolean,
): { data: DanmakuData | null; error: string | null; loading: boolean } {
  const [data, setData] = useState<DanmakuData | null>(null);
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
  // 记上次 bvid：仅切视频时清旧数据（防止 SPA 切视频后短暂展示上一视频的弹幕/复制错内容），
  // refreshKey 变更（去抖重拉）保留旧数据，避免「数据→空→数据」闪烁（对齐 useLocalCollected）。
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
          `${httpBase}/api/danmaku/list?bvid=${encodeURIComponent(bvid)}`,
          authInit({ cache: 'no-cache' }),
        );
        // 404 不解析 body（视频不在库，契约 body 无消费价值，也避开网关非 JSON 错误页）
        const d = r.status === 404 ? null : ((await r.json()) as DanmakuListResponse);
        const n = normalizeDanmakuList(d, r.status);
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
