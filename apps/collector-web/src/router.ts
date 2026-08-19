// ── 手写 hash 路由：URL 是唯一真相 ──
// 形态：#/collect | #/videos?source=youtube&page=2 | #/videos/:source/:vid | #/creators/:id | #/<tab>
// 设计：刷新/分享/后退还原视图；query 承载各页参数（VideoList 全量筛选、看板 groupBy 等）。
// 不引 react-router：8 tab + 2 详情 + query 的规模，手写 ~80 行成本低于引库（含 20 筛选同步胶水仍要自写）。
import { useEffect, useState } from 'react';

export type Tab = 'collect' | 'videos' | 'stats' | 'clients' | 'categories' | 'tags' | 'creators' | 'changes';

export const TABS: readonly Tab[] = ['collect', 'videos', 'stats', 'creators', 'categories', 'tags', 'clients', 'changes'];

export interface Route {
  tab: Tab;
  path: string;               // 去掉 # 与 query 的路径段（如 /videos/bilibili/BV1xx），updateQuery 回写用
  query: URLSearchParams;     // 各页参数（空值约定：不写入）
  videoView: { source: string; sourceVid: string } | null; // #/videos/:source/:vid
  creatorView: number | null; // #/creators/:id
}

// hash → Route。未知路径容错回落 collect；详情段残缺（缺 vid / 非数字 id）回落列表态。
export function parseHash(hash: string): Route {
  let raw = hash.replace(/^#/, '');
  if (!raw.startsWith('/')) raw = raw ? `/${raw}` : '/';
  const qIdx = raw.indexOf('?');
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  const query = new URLSearchParams(qIdx >= 0 ? raw.slice(qIdx + 1) : '');
  const segs = path.split('/').filter(Boolean).map(decodeURIComponent);

  const head = segs[0] ?? '';
  const tab: Tab = (TABS as readonly string[]).includes(head) ? (head as Tab) : 'collect';

  let videoView: Route['videoView'] = null;
  if (tab === 'videos' && segs[1] && segs[2]) videoView = { source: segs[1], sourceVid: segs[2] };

  let creatorView: number | null = null;
  if (tab === 'creators' && segs[1] && /^\d+$/.test(segs[1])) creatorView = Number(segs[1]);

  return { tab, path, query, videoView, creatorView };
}

// 跳转：path 如 '/videos?tag=游戏'。push 写历史（可后退）；replace 原位替换（筛选/防抖不打爆历史栈）。
// pushState/replaceState 改 hash 不触发 hashchange，手动 dispatch 让 useRoute 订阅者更新；
// back/forward 引起 hash 变化时浏览器原生触发 hashchange，同样被监听。
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (opts.replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

// 当前 path 下原位更新 query（replace 不进历史栈，筛选/防抖不打爆后退）。
// patch 值 null/''/undefined = 删该参数（回默认态 URL 干净）；resetPage 把 page 清掉（回第 1 页）。
export function useQueryUpdater(): (patch: Record<string, string | null | undefined>, opts?: { resetPage?: boolean }) => void {
  const route = useRoute();
  return (patch, opts = {}) => {
    const u = new URLSearchParams(route.query);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '') u.delete(k);
      else u.set(k, v);
    }
    if (opts.resetPage) u.delete('page');
    const qs = u.toString();
    navigate(route.path + (qs ? `?${qs}` : ''), { replace: true });
  };
}
