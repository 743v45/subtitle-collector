// apps/subtitle-collector/src/popup/hooks-upper.ts
// UP/频道/博主 hooks 家族（2026-08-29 S8 从 hooks.ts 拆出，沿 hooks-collected.ts 先例偿还
// 复杂度/行数台账）：UP 详情与最新视频、UP 主页入口识别（B 站/YouTube/抖音三平台）、
// UP 全部视频、合集视频、YouTube 频道视频。行为与拆出前逐字一致。
import { useCallback, useEffect, useState } from 'react';
import { extractDouyinUpperKey } from '../../douyin-format.mjs';

// P4：UP 最新视频（从 background passive 缓存读，chrome.storage）。
// background 的 ensureUpperVideos 在被动采集时把 UP 最新视频写入
// chrome.storage.local[`upperVideos:${mid}`]（1h TTL）；本 hook 只读不写。
// 无缓存（首次/该 UP 从未被动采过）→ empty；缓存命中 → ok 携带 items + fetchedAt。
export interface UpperVideoItem {
  bvid: string;
  title: string;
  created: number | null;
}
export type UpperVideosState =
  | { state: 'loading' }
  | { state: 'empty' }
  | { state: 'ok'; items: UpperVideoItem[]; fetchedAt: number };

export function useUpperVideos(mid: string | null | undefined): UpperVideosState {
  const [state, setState] = useState<UpperVideosState>({ state: 'loading' });
  useEffect(() => {
    if (!mid) {
      setState({ state: 'empty' });
      return;
    }
    chrome.storage.local.get([`upperVideos:${mid}`], (items) => {
      const cached = items[`upperVideos:${mid}`] as
        | { items: UpperVideoItem[]; fetchedAt: number }
        | undefined;
      if (cached?.items?.length) {
        setState({ state: 'ok', items: cached.items, fetchedAt: cached.fetchedAt });
      } else {
        setState({ state: 'empty' });
      }
    });
  }, [mid]);
  return state;
}

// —— UP 主页入口：tabs.query 解析当前 URL ——
// B 站：space.bilibili.com/{mid}（纯数字首段路径，/upload/video 等子页不干扰）。
// YouTube：频道页（/@handle、/channel/UCxxx、/c/、/user/ 及任意子页，见 yt-channel.mjs 识别规则）。
// 抖音：博主页 /user/<sec_uid>（识别下沉 douyin-format.mjs extractDouyinUpperKey，与 server
// parseDouyinSecUid 同判据；批量展开走 server expandUpperVideos → 扩展 expand-douyin-upper）。
// 非三类 UP 主页（视频页/首页等）返回 null。2026-08-29 S8 台账性重构：识别拆纯函数
//（useUpperEntry 内联块复杂度超标偿还），逻辑逐字原样搬移。
export interface UpperEntry {
  source: 'bilibili' | 'youtube' | 'douyin';
  kind: 'mid' | 'handle' | 'channel' | 'custom' | 'secUid'; // B 站 mid / YouTube 三类标识 / 抖音 sec_uid
  key: string;                                    // mid | @handle | UCxxx | custom 名 | sec_uid
}

function biliUpperEntryOf(u: URL): UpperEntry | null {
  if (u.hostname !== 'space.bilibili.com') return null;
  const seg = u.pathname.split('/').filter(Boolean)[0];
  return seg && /^\d+$/.test(seg) ? { source: 'bilibili', kind: 'mid', key: seg } : null;
}

function ytUpperEntryOf(u: URL): UpperEntry | null {
  if (u.hostname.replace(/^(www|m|music)\./, '') !== 'youtube.com') return null;
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0] && /^@[\w.-]{3,30}$/.test(seg[0])) return { source: 'youtube', kind: 'handle', key: seg[0] };
  if (seg[0] === 'channel' && seg[1] && /^UC[\w-]{22}$/.test(seg[1])) return { source: 'youtube', kind: 'channel', key: seg[1] };
  if ((seg[0] === 'c' || seg[0] === 'user') && seg[1] && /^[\w.-]+$/.test(seg[1])) return { source: 'youtube', kind: 'custom', key: seg[1] };
  return null;
}

// 抖音博主页：/user/<sec_uid>（识别规则在 douyin-format.mjs extractDouyinUpperKey 单点维护）
function dyUpperEntryOf(u: URL): UpperEntry | null {
  const secUid = extractDouyinUpperKey(u.href);
  return secUid ? { source: 'douyin', kind: 'secUid', key: secUid } : null;
}

/** 当前标签页 URL → UP 主页入口（三类平台；非 UP 主页 → null）。纯函数（识别规则可直测）。 */
export function upperEntryFromUrl(raw: string | null | undefined): UpperEntry | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return biliUpperEntryOf(u) ?? ytUpperEntryOf(u) ?? dyUpperEntryOf(u);
  } catch { /* 非法 URL 忽略 */ }
  return null;
}

export function useUpperEntry(): UpperEntry | null {
  const [entry, setEntry] = useState<UpperEntry | null>(null);
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      setEntry(upperEntryFromUrl(tab?.url));
    });
  }, []);
  return entry;
}

// —— UP 全部视频（background 全量分页拉取，storage 唯一数据真相，2026-08-19）——
// 挂载即触发 FETCH_UPPER_ALL（fresh 缓存命中直接读；否则 background 起任务/复用 inflight），
// background 每页写 chrome.storage.local[`upperAllVideos:${mid}`] → storage.onChanged 增量渲染进度。
export interface UpperAllVideoItem {
  bvid: string;
  title: string;
  created: number | null; // unix 秒（arc/search 原样）
  play: number | null;
  length: string | null;  // "MM:SS" / "HH:MM:SS"（arc/search 原样）
  pic?: string | null;    // 封面 URL（已归一 https:；旧缓存可能缺字段）
}
export type UpperAllState =
  | { state: 'loading' }
  | {
      state: 'ok';
      items: UpperAllVideoItem[];
      total: number;
      done: boolean;         // false = 拉取进行中（items 为已拉部分）
      error: string | null;  // 风控中断等（部分结果仍可用）
      fetchedAt: number;
    };

export function useUpperAllVideos(mid: string | null | undefined): UpperAllState {
  const [state, setState] = useState<UpperAllState>({ state: 'loading' });
  const read = useCallback((m: string) => {
    const key = `upperAllVideos:${m}`;
    chrome.storage.local.get([key], (items) => {
      const cached = items[key] as Omit<Extract<UpperAllState, { state: 'ok' }>, 'state'> | undefined;
      if (cached && Array.isArray(cached.items)) {
        setState({
          state: 'ok',
          items: cached.items,
          total: cached.total ?? cached.items.length,
          done: !!cached.done,
          error: cached.error ?? null,
          fetchedAt: cached.fetchedAt ?? 0,
        });
      } else {
        setState({ state: 'loading' });
      }
    });
  }, []);
  useEffect(() => {
    if (!mid) {
      setState({ state: 'loading' });
      return;
    }
    setState({ state: 'loading' });
    read(mid);
    // 触发全量任务（回执仅表状态，数据走 storage）
    chrome.runtime.sendMessage({ type: 'FETCH_UPPER_ALL', mid }, () => void chrome.runtime.lastError);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (`upperAllVideos:${mid}` in changes) read(mid);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [mid, read]);
  return state;
}

// —— 合集（ugc_season）视频列表（background 全量分页拉取，storage 唯一数据真相，2026-08-19）——
// 挂载即触发 FETCH_SEASON_ALL（fresh 缓存命中直接读；否则 background 起任务/复用 inflight），
// background 每页写 chrome.storage.local[`seasonVideos:${seasonId}`] → storage.onChanged 增量渲染进度。
// item 字段与 UpperAllVideoItem 同构（length 为 "M:SS" 字符串），复用 popup 行渲染。
export interface SeasonVideoItem {
  bvid: string;
  title: string;
  created: number | null; // unix 秒（seasons_archives_list 的 pubdate）
  play: number | null;
  length: string | null;  // "MM:SS" / "HH:MM:SS"（duration 秒转换）
  pic?: string | null;    // 封面 URL（已归一 https:）
}
export type SeasonAllState =
  | { state: 'loading' }
  | {
      state: 'ok';
      items: SeasonVideoItem[];
      total: number;
      done: boolean;         // false = 拉取进行中（items 为已拉部分）
      error: string | null;  // 风控中断等（部分结果仍可用）
      fetchedAt: number;
    };

export function useSeasonVideos(season: { id: number; title: string } | null): SeasonAllState {
  const [state, setState] = useState<SeasonAllState>({ state: 'loading' });
  const read = useCallback((seasonId: number) => {
    const key = `seasonVideos:${seasonId}`;
    chrome.storage.local.get([key], (items) => {
      const cached = items[key] as Omit<Extract<SeasonAllState, { state: 'ok' }>, 'state'> | undefined;
      if (cached && Array.isArray(cached.items)) {
        setState({
          state: 'ok',
          items: cached.items,
          total: cached.total ?? cached.items.length,
          done: !!cached.done,
          error: cached.error ?? null,
          fetchedAt: cached.fetchedAt ?? 0,
        });
      } else {
        setState({ state: 'loading' });
      }
    });
  }, []);
  useEffect(() => {
    if (!season) {
      setState({ state: 'loading' });
      return;
    }
    setState({ state: 'loading' });
    read(season.id);
    // 触发全量任务（回执仅表状态，数据走 storage）
    chrome.runtime.sendMessage({ type: 'FETCH_SEASON_ALL', seasonId: season.id }, () => void chrome.runtime.lastError);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (`seasonVideos:${season.id}` in changes) read(season.id);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [season, read]);
  return state;
}

// —— YouTube 频道（UP 主页）视频列表（background 全量分页拉取，storage 唯一真相，2026-08-21）——
// 挂载即触发 FETCH_YT_CHANNEL_ALL（fresh 缓存命中直接读；否则 background 起任务/复用 inflight），
// background 每页写 chrome.storage.local[`ytChannelVideos:${key}`] → storage.onChanged 增量渲染进度。
// ident 三类标识（handle/channel/custom）；channelId 在首页解析后随 storage 流出（已采标注等它就绪）。
export interface YtChannelVideoItem {
  vid: string;
  title: string | null;
  created: number | null; // unix 秒（publishedTimeText 相对时间估算）
  agoText?: string | null; // 原始相对时间文本（"7 months ago"；档位过滤口径，旧缓存缺省）
  play: number | null;
  length: string | null;  // "MM:SS" / "HH:MM:SS"
  pic?: string | null;    // i.ytimg.com 稳定缩略图 URL
}
export interface YtChannelIdent {
  handle?: string;
  channelId?: string;
  custom?: string;
}
export type YtChannelState =
  | { state: 'loading' }
  | {
      state: 'ok';
      channelId: string | null;  // 首页解析后到位（已采标注用；解析失败 null 不阻断列表）
      channelName: string | null;
      items: YtChannelVideoItem[];
      total: number | null;      // 频道 header 视频总数（解析失败 null → 进度行用 items.length）
      done: boolean;
      error: string | null;
      fetchedAt: number;
    };

export function useYoutubeChannelVideos(ident: YtChannelIdent | null, key: string | null): YtChannelState {
  const [state, setState] = useState<YtChannelState>({ state: 'loading' });
  const read = useCallback((k: string) => {
    const storageKey = `ytChannelVideos:${k}`;
    chrome.storage.local.get([storageKey], (items) => {
      const cached = items[storageKey] as
        | (Omit<Extract<YtChannelState, { state: 'ok' }>, 'state'> & { channelId?: string | null })
        | undefined;
      if (cached && Array.isArray(cached.items)) {
        setState({
          state: 'ok',
          channelId: cached.channelId ?? null,
          channelName: cached.channelName ?? null,
          items: cached.items,
          total: cached.total ?? null,
          done: !!cached.done,
          error: cached.error ?? null,
          fetchedAt: cached.fetchedAt ?? 0,
        });
      } else {
        setState({ state: 'loading' });
      }
    });
  }, []);
  useEffect(() => {
    if (!ident || !key) {
      setState({ state: 'loading' });
      return;
    }
    setState({ state: 'loading' });
    read(key);
    chrome.runtime.sendMessage({ type: 'FETCH_YT_CHANNEL_ALL', ident }, () => void chrome.runtime.lastError);
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (`ytChannelVideos:${key}` in changes) read(key);
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [ident, key, read]);
  return state;
}
