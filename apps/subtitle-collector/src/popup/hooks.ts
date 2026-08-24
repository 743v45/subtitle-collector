import { useCallback, useEffect, useRef, useState } from 'react';
import { CLIENT_ID_KEY, REPORTING_KEY } from '../../reporting.mjs';
import { TASK_DISPATCH_KEY } from '../../task-dispatch.mjs';
import { API_BASE } from '../../config.js';
import {
  SERVERS_KEY,
  ACTIVE_SERVER_KEY,
  parseServerUrl,
  resolveActiveServer,
  normalizeServers,
  genServerId,
} from '../../servers.mjs';
import { detectPlatform, extractVid, type Platform } from './platforms';
import type {
  BiliNavResponse,
  CollectedExtra,
  CollectedResponse,
  CollectedVideo,
  CollectTask,
  ConsistencyIssue,
  CreatorDetail,
  LocalStateResponse,
  LocalSub,
  SubtitleBody,
} from './types';

// —— 连接状态 + 模式：每 2s 向 background 查 WS_STATUS（含 mode）——
// mode=server 时 connected 反映 WS 客观连通性；mode=standalone（纯扩展）时 connected 恒 false。

// popup → server HTTP 请求统一带 Bearer：激活 server 的 token（URL ?token= 解析所得，
// useServerConfig 读 storage 时同步更新）。暴露部署（非 loopback）的 server 强制校验；
// loopback server 不校验，多带一个头也无影响。
let activeServerToken: string | null = null;
export function authInit(init?: RequestInit): RequestInit {
  if (!activeServerToken) return init ?? {};
  return {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${activeServerToken}` },
  };
}

export type ConnectionMode = 'server' | 'standalone';
export interface ConnectionStatus {
  loading: boolean; // 首帧未拿到 WS_STATUS 时 true，避免闪烁
  connected: boolean;
  mode: ConnectionMode;
  error: string | null; // 未连接时的原因（hello-nack error / 不可达 / 连接错误）；已连接或纯扩展时 null
}

export function useConnectionStatus(): ConnectionStatus & { setMode: (m: ConnectionMode) => void } {
  const [status, setStatus] = useState<ConnectionStatus>({
    loading: true,
    connected: false,
    mode: 'server',
    error: null,
  });
  useEffect(() => {
    const check = () => {
      chrome.runtime.sendMessage({ type: 'WS_STATUS' }, (resp) => {
        setStatus({
          loading: false,
          connected: !!resp?.connected,
          mode: resp?.mode === 'standalone' ? 'standalone' : 'server',
          error: resp?.error ?? null,
        });
      });
    };
    check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, []);
  // 乐观更新：切 standalone 立即置灰（connected=false）；切 server 保持原 connected，等轮询修正（WS 异步重连）
  const setMode = useCallback((m: ConnectionMode) => {
    setStatus((s) => ({ loading: false, mode: m, connected: m === 'standalone' ? false : s.connected, error: m === 'standalone' ? null : s.error }));
    chrome.runtime.sendMessage({ type: 'SET_CONNECTION_MODE', mode: m });
  }, []);
  return { ...status, setMode };
}

// —— 多 server 配置：popup 读 storage(servers + activeServerId)，切换/增删回写 + 发 SET_ACTIVE_SERVER ——
// httpBase 供 useCollected/useCreator 直连激活 server 的 HTTP API（替代旧静态 API_BASE，支持热切换）。
export interface ServerEntry {
  id: string;
  name: string;
  url: string;
}
export interface ServerConfig {
  servers: ServerEntry[];
  activeServerId: string | null;
  httpBase: string; // 激活 server 的 httpBase；loading/无 server 时回退 API_BASE
  loading: boolean;
  setActive: (id: string) => void;
  addServer: (name: string, url: string) => string | null; // url 非法（非 ws/wss）返回 null
  updateServer: (id: string, name: string, url: string) => boolean; // url 非法返回 false；改激活项触发 background 重连
  removeServer: (id: string) => void;
}

export function useServerConfig(): ServerConfig {
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [activeServerId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    chrome.storage.local.get([SERVERS_KEY, ACTIVE_SERVER_KEY], (items) => {
      const s = normalizeServers(items[SERVERS_KEY]) as ServerEntry[];
      const storedActive = (items[ACTIVE_SERVER_KEY] as string | undefined) ?? null;
      const activeEntry = resolveActiveServer(s, storedActive);
      // 同步 Bearer token 缓存（authInit 消费）：激活 server 变化即刷新
      activeServerToken = activeEntry ? (parseServerUrl(activeEntry.url)?.token ?? null) : null;
      setServers(s);
      setActiveId(activeEntry?.id ?? null);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    load();
    // storage 变化（background 首启初始化默认 server / 其他 popup 改动）→ 重读同步
    const handler = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (SERVERS_KEY in changes || ACTIVE_SERVER_KEY in changes) load();
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }, [load]);

  const activeEntry = resolveActiveServer(servers, activeServerId);
  const httpBase = activeEntry ? (parseServerUrl(activeEntry.url)?.httpBase ?? API_BASE) : API_BASE;

  const setActive = useCallback((id: string) => {
    setActiveId(id); // 乐观更新；background SET_ACTIVE_SERVER 回执后 storage.onChanged 兜底修正
    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SERVER', id });
  }, []);

  const addServer = useCallback((name: string, url: string): string | null => {
    if (!parseServerUrl(url)) return null; // url 非法（非 ws/wss / 解析失败）
    const entry: ServerEntry = { id: genServerId(), name: name.trim() || url.trim(), url: url.trim() };
    chrome.storage.local.get([SERVERS_KEY], (items) => {
      const s = normalizeServers(items[SERVERS_KEY]);
      chrome.storage.local.set({ [SERVERS_KEY]: [...s, entry] }); // storage.onChanged → load 重读
    });
    return entry.id;
  }, []);

  const removeServer = useCallback((id: string) => {
    chrome.storage.local.get([SERVERS_KEY, ACTIVE_SERVER_KEY], (items) => {
      const s = normalizeServers(items[SERVERS_KEY]).filter((x) => x.id !== id);
      const storedActive = (items[ACTIVE_SERVER_KEY] as string | undefined) ?? null;
      const wasActive = storedActive === id;
      const newActive = wasActive ? (resolveActiveServer(s, null)?.id ?? '') : storedActive;
      const patch: Record<string, unknown> = { [SERVERS_KEY]: s };
      if (wasActive) patch[ACTIVE_SERVER_KEY] = newActive || null;
      chrome.storage.local.set(patch);
      // 删的是激活项 → 触发 background 热切换到新激活（列表空 → newActive='' → activeServer null → 不连）
      if (wasActive) chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SERVER', id: newActive });
    });
  }, []);

  // 改 server 的 name/url：落盘 + 若是激活项,发 SET_ACTIVE_SERVER 触发 background 重新解析 url + 重连（id 不变）
  const updateServer = useCallback((id: string, name: string, url: string): boolean => {
    if (!parseServerUrl(url)) return false; // url 非法（非 ws/wss）
    const trimmedName = name.trim() || url.trim();
    const trimmedUrl = url.trim();
    chrome.storage.local.get([SERVERS_KEY, ACTIVE_SERVER_KEY], (items) => {
      const servers = normalizeServers(items[SERVERS_KEY]).map((x) => x.id === id ? { ...x, name: trimmedName, url: trimmedUrl } : x);
      chrome.storage.local.set({ [SERVERS_KEY]: servers });
      if ((items[ACTIVE_SERVER_KEY] as string | undefined) === id) chrome.runtime.sendMessage({ type: 'SET_ACTIVE_SERVER', id });
    });
    return true;
  }, []);

  return { servers, activeServerId, httpBase, loading, setActive, addServer, updateServer, removeServer };
}

// —— B 站登录态：每 30s 直连官方 nav 接口 ——
export type LoginState =
  | { state: 'loading' }
  | { state: 'logged'; uname: string; mid: number }
  | { state: 'guest' }
  | { state: 'error' };

export function useBiliLogin(enabled: boolean = true): LoginState {
  const [login, setLogin] = useState<LoginState>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return; // 非 B 站平台（YouTube/无关页）不查 B 站 nav，保持 loading 占位（PlatformHead 也仅 bili 显示 LoginBadge）
    const check = () => {
      fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        .then((r) => r.json())
        .then((d: BiliNavResponse) => {
          if (d.code === 0 && d.data?.isLogin) {
            setLogin({ state: 'logged', uname: d.data.uname || '用户', mid: d.data.mid ?? 0 });
          } else {
            setLogin({ state: 'guest' });
          }
        })
        .catch(() => setLogin({ state: 'error' }));
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, [enabled]);
  return login;
}

// —— 已收集：从当前 tab URL 提 bvid，直连本地 API；refreshKey 变更时重查 ——
export type CollectedState =
  | { state: 'loading' }
  | { state: 'non-video' }
  | { state: 'server-down' }
  | { state: 'not-collected' }
  | {
      state: 'ok';
      bvid: string;
      video: CollectedVideo;
      extra: CollectedExtra;
      tracks: number;
    };

function parseExtra(s: string | CollectedExtra | null | undefined): CollectedExtra {
  try {
    return typeof s === 'string' ? JSON.parse(s) : (s ?? {});
  } catch {
    return {};
  }
}

// background.js 上报成功后广播：{type:'INGEST_RESULT', source_vid, inserted, skipped}
interface IngestResultMessage {
  type?: string;
  ok?: boolean;
  source_vid?: string;
  inserted?: number;
  skipped?: number;
}

export function useCollected(httpBase: string): {
  collected: CollectedState;
  currentVid: string | null;
  currentPlatform: Platform | null;
  refresh: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);
  const [collected, setCollected] = useState<CollectedState>({ state: 'loading' });
  const [currentVid, setCurrentVid] = useState<string | null>(null);
  const [currentPlatform, setCurrentPlatform] = useState<Platform | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const url = tab?.url;
      const platform = detectPlatform(url); // 域名判断（任意页面：首页/搜索/视频页都识别）
      const vid = platform ? extractVid(url, platform) : null; // 仅视频页提取 vid
      setCurrentPlatform(platform);
      setCurrentVid(vid);
      if (!platform) {
        // 无关站：空状态，popup 只渲染 BrandHeader + FooterActions
        setCollected({ state: 'non-video' });
        return;
      }
      if (!vid) {
        // 平台页但非视频页（如 B 站首页/搜索页）：显示平台头 + 登录态，但不查 server、不显示视频卡
        setCollected({ state: 'non-video' });
        return;
      }
      if (platform.id === 'bilibili' || platform.id === 'youtube') {
        // B 站 / YouTube：fetch server（server /api/videos/:source/:vid 通用，source = platform.id）
        // 不清 loading：保留上次数据，避免刷新（手动补采 / INGEST_RESULT）时"数据→查询中→数据"闪烁
        fetch(`${httpBase}/api/videos/${platform.id}/${vid}`, authInit({ cache: 'no-cache' }))
          .then((r) => r.json())
          .then((d: CollectedResponse) => {
            if (!d.ok) {
              console.log('[popup] collected query: not collected', { bvid: vid, ok: false });
              setCollected({ state: 'not-collected' });
              return;
            }
            const video = d.video ?? {};
            const extra = parseExtra(video.extra);
            const trackCount = d.tracks?.length ?? 0;
            console.log('[popup] collected query: ok', { bvid: vid, ok: true, tracks: trackCount });
            setCollected({
              state: 'ok',
              bvid: vid,
              video,
              extra,
              tracks: trackCount,
            });
          })
          .catch((err) => {
            console.log('[popup] collected query: error', { bvid: vid, err: String(err) });
            setCollected({ state: 'server-down' });
          });
      } else {
        // 其它平台（抖音/小红书等未接入）：暂不查 server
        setCollected({ state: 'not-collected' });
      }
    });
  }, [refreshKey, httpBase]);

  // background 上报成功后广播 INGEST_RESULT：source_vid 命中当前 vid 时触发重查
  useEffect(() => {
    const handler = (msg: unknown) => {
      const m = msg as IngestResultMessage | undefined;
      if (!m || m.type !== 'INGEST_RESULT') return;
      if (currentVid && m.source_vid === currentVid) {
        console.log('[popup] INGEST_RESULT received', {
          source_vid: m.source_vid,
          inserted: m.inserted,
          skipped: m.skipped,
        });
        setRefreshKey((k) => k + 1);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [currentVid]);

  // SPA 切视频时（B 站列表播放页 /list/*?bvid= 切下一集、video 页切相关视频，pushState 改 URL
  // 不触发 status:'complete'）刷新：changeInfo.url 变化 → 重查 tabs.query 提新 vid。
  // vid 更新后 useLocalCollected（依赖 currentVid）自动跟着重发 GET_LOCAL_STATE。
  // 用 ref 去重：onUpdated 对一次导航可能发多次 changeInfo（url/title/status 各一次）。
  useEffect(() => {
    let lastUrl = '';
    const handler = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (!tab?.active || !changeInfo.url) return;
      if (changeInfo.url === lastUrl) return;
      lastUrl = changeInfo.url;
      setRefreshKey((k) => k + 1);
    };
    chrome.tabs.onUpdated.addListener(handler);
    return () => chrome.tabs.onUpdated.removeListener(handler);
  }, []);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { collected, currentVid, currentPlatform, refresh };
}

// —— UP 主详情：从 useCollected 的 serverCollected.video.creator_id 查 /api/creators/:id ——
// creator_id 为空（视频未关联 UP / server-down / 非 ok 态）→ none，popup 不展示卡片。
// fetch 失败（server 关）也落到 none，优雅降级为不显示，避免红色错误噪音。
export type CreatorState =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'ok'; creator: CreatorDetail };

export function useCreator(creatorId: number | null | undefined, httpBase: string): CreatorState {
  const [creator, setCreator] = useState<CreatorState>({ state: 'loading' });
  useEffect(() => {
    if (creatorId == null) {
      setCreator({ state: 'none' });
      return;
    }
    setCreator({ state: 'loading' });
    fetch(`${httpBase}/api/creators/${creatorId}`, authInit({ cache: 'no-cache' }))
      .then((r) => r.json())
      .then((d: { ok: boolean; creator?: CreatorDetail }) => {
        if (d?.ok && d.creator) setCreator({ state: 'ok', creator: d.creator });
        else setCreator({ state: 'none' });
      })
      .catch(() => setCreator({ state: 'none' }));
  }, [creatorId, httpBase]);
  return creator;
}

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
// 非两类 UP 主页（视频页/首页等）返回 null。
export interface UpperEntry {
  source: 'bilibili' | 'youtube';
  kind: 'mid' | 'handle' | 'channel' | 'custom'; // B 站 mid / YouTube 三类标识
  key: string;                                    // mid | @handle | UCxxx | custom 名
}
export function useUpperEntry(): UpperEntry | null {
  const [entry, setEntry] = useState<UpperEntry | null>(null);
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      let e: UpperEntry | null = null;
      try {
        const u = tab?.url ? new URL(tab.url) : null;
        if (u && u.hostname === 'space.bilibili.com') {
          const seg = u.pathname.split('/').filter(Boolean)[0];
          if (seg && /^\d+$/.test(seg)) e = { source: 'bilibili', kind: 'mid', key: seg };
        } else if (u && u.hostname.replace(/^(www|m|music)\./, '') === 'youtube.com') {
          const seg = u.pathname.split('/').filter(Boolean);
          if (seg[0] && /^@[\w.-]{3,30}$/.test(seg[0])) e = { source: 'youtube', kind: 'handle', key: seg[0] };
          else if (seg[0] === 'channel' && seg[1] && /^UC[\w-]{22}$/.test(seg[1])) e = { source: 'youtube', kind: 'channel', key: seg[1] };
          else if ((seg[0] === 'c' || seg[0] === 'user') && seg[1] && /^[\w.-]+$/.test(seg[1])) e = { source: 'youtube', kind: 'custom', key: seg[1] };
        }
      } catch { /* 非法 URL 忽略 */ }
      setEntry(e);
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

// —— UP 已采集合：已拆至 hooks-collected.ts(2026-08-24 偿还行数台账)——

// —— 上报开关：启动从 storage 读（默认开，!==false），切换时发 SET_REPORTING ——
// enabled 初始 null=未知：避免首帧硬编码 true（"开"）→ storage 实际 false 时"开→关"的翻转闪烁；
// storage 回调回来才落到真实 boolean，Popup 在 null 期间显示中性占位。
export function useReporting(): { enabled: boolean | null; setEnabled: (v: boolean) => void } {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    chrome.storage.local.get([REPORTING_KEY], (items) => {
      setEnabled(items[REPORTING_KEY] !== false);
    });
  }, []);
  const set = useCallback((v: boolean) => {
    setEnabled(v);
    chrome.runtime.sendMessage({ type: 'SET_REPORTING', enabled: v });
  }, []);
  return { enabled, setEnabled: set };
}

// —— 任务派发开关（2026-08-23 仅上报状态）：默认开（!==false），切换发 SET_TASK_DISPATCH ——
// 与 useReporting 的差异：监听 storage.onChanged——server 远程切换（set-task-dispatch 改
// storage）时 popup 开着也能实时翻转开关，不等到下次打开 popup 才见到新状态。
export function useTaskDispatch(): { enabled: boolean | null; setEnabled: (v: boolean) => void } {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    chrome.storage.local.get([TASK_DISPATCH_KEY], (items) => {
      setEnabled(items[TASK_DISPATCH_KEY] !== false);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[TASK_DISPATCH_KEY]) setEnabled(changes[TASK_DISPATCH_KEY].newValue !== false);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const set = useCallback((v: boolean) => {
    setEnabled(v);
    chrome.runtime.sendMessage({ type: 'SET_TASK_DISPATCH', enabled: v });
  }, []);
  return { enabled, setEnabled: set };
}

// —— 客户端 ID：从 storage 读（background 首次启动生成并回写），popup 只读不写 ——
// null=尚未读到（首帧），调用方据此隐藏，避免空 ID 闪烁。
export function useClientId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    chrome.storage.local.get([CLIENT_ID_KEY], (items) => {
      setId((items[CLIENT_ID_KEY] as string | undefined) ?? null);
    });
  }, []);
  return id;
}

// —— 采集任务列表：快照 + TASK_UPDATE 推送 + 低频兜底轮询 ——
// 打开时 GET /api/collect-tasks 全量；之后 background 转发的 server 推送按 id upsert/移除
// （TASK_UPDATE 的 task 整对象 upsert，含推送专属的 batch_total）。
// 10s 兜底重拉覆盖两类盲区：旧 server 无推送（慢实时）、popup 关闭/断线期间错过的推送。
// pull 响应是请求时刻的快照：在途期间到达的推送先暂存，落地后按到达序重放——直接 setTasks
// 会把在途推送覆盖回滚（UI 状态回退 / TASK_DELETE 已删行复活，直到下次推送/轮询）。
// null=未拉到（loading/server 不可达，保留 null 让调用方隐藏）；[]=已拉到且无任务。
export function useCollectTasks(httpBase: string, enabled: boolean): CollectTask[] | null {
  const [tasks, setTasks] = useState<CollectTask[] | null>(null);
  useEffect(() => {
    if (!enabled) {
      setTasks(null);
      return;
    }
    // httpBase 变化（切换激活 server）：进入即清旧数据（对齐 enabled=false 分支）——
    // 新 server 不可达时不永久显示冻结的旧 server 数据；同 httpBase 下 pull 失败保留旧数据不变
    setTasks(null);
    let alive = true;
    let pullInFlight = false;
    const pending: Array<{ type: 'TASK_UPDATE'; task: CollectTask } | { type: 'TASK_DELETE'; taskId: number }> = [];
    // upsert（推送直应用与重放共用）：按 id 原位替换，不在则插到队头
    const upsert = (list: CollectTask[], incoming: CollectTask): CollectTask[] => {
      const i = list.findIndex((t) => t.id === incoming.id);
      if (i === -1) return [incoming, ...list];
      const next = [...list];
      next[i] = incoming;
      return next;
    };
    // 把暂存推送按到达序重放到 base 上（pull 响应落地后调用）
    const replay = (base: CollectTask[]): CollectTask[] => {
      let list = base;
      for (const p of pending) {
        if (p.type === 'TASK_UPDATE') list = upsert(list, p.task);
        else list = list.filter((t) => t.id !== p.taskId);
      }
      return list;
    };
    const pull = async () => {
      pullInFlight = true;
      try {
        const r = await fetch(`${httpBase}/api/collect-tasks?limit=50`, authInit({ cache: 'no-cache' }));
        const d = await r.json();
        if (alive && d?.ok) setTasks(replay((d.items ?? []) as CollectTask[]));
      } catch {
        // server 不可达：保留上次数据（推送断流与拉取失败同表现,不额外提示）；
        // 暂存推送随之作废——同 id 后续推送覆盖、≤10s 下次快照修正
      } finally {
        pullInFlight = false;
        pending.length = 0;
      }
    };
    void pull();
    const timer = setInterval(() => { void pull(); }, 10_000);
    const handler = (msg: unknown) => {
      const m = msg as { type?: string; task?: CollectTask; taskId?: number };
      if (m?.type === 'TASK_UPDATE' && m.task && typeof m.task.id === 'number') {
        const incoming = m.task;
        // pull 在途：暂存（直接应用会被响应快照覆盖回滚）
        if (pullInFlight) {
          pending.push({ type: 'TASK_UPDATE', task: incoming });
          return;
        }
        setTasks((prev) => upsert(prev ?? [], incoming));
      } else if (m?.type === 'TASK_DELETE' && typeof m.taskId === 'number') {
        const removed = m.taskId;
        if (pullInFlight) {
          pending.push({ type: 'TASK_DELETE', taskId: removed });
          return;
        }
        setTasks((prev) => (prev ? prev.filter((t) => t.id !== removed) : prev));
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      alive = false;
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(handler);
      pending.length = 0; // 在途 pull 已因 alive=false 丢弃响应，暂存推送一并作废
    };
  }, [httpBase, enabled]);
  return tasks;
}

// —— 本地数据源：popup 经 chrome.tabs.sendMessage 直取 content.js 的 collected ——
// 「视频信息」改用本地提取的数据展示（轨道/正文/extra），server 数据仅作一致性校验。
export type LocalCollectedState =
  | { state: 'loading' }
  | { state: 'not-loaded' } // 视频页但 content.js 还没拦到 player API / 正文未就绪
  | { state: 'no-subtitle'; extra: CollectedExtra } // player API subtitles 数组为空，真无字幕（但仍带视频元数据 extra）
  | {
      state: 'has-subtitle';
      bvid: string;
      extra: CollectedExtra;
      subs: LocalSub[];
      bodies: Record<string, SubtitleBody>;
    };

export function useLocalCollected(currentVid: string | null): {
  local: LocalCollectedState;
  refreshLocal: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);
  const [local, setLocal] = useState<LocalCollectedState>({ state: 'loading' });
  // 记上次 vid：仅切视频时清 loading，refreshKey 变（刷新）保留旧数据避免闪烁
  const lastVidRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!currentVid) {
      // currentVid 未就绪（useCollected 的 tabs.query 尚未回调）—— 保持 loading，
      // 不判 non-video；非视频页由 server 状态在 CollectedBlock 决定，避免 loading→空→loading 闪烁。
      setLocal({ state: 'loading' });
      return;
    }
    const isNewVid = currentVid !== lastVidRef.current;
    lastVidRef.current = currentVid;
    if (isNewVid) setLocal({ state: 'loading' });
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        setLocal({ state: 'not-loaded' });
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        // vid 通用：content.js / content-yt.js 均兼容 msg.vid ?? msg.bvid
        { type: 'GET_LOCAL_STATE', vid: currentVid },
        (resp: LocalStateResponse | undefined) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            setLocal({ state: 'not-loaded' });
            return;
          }
          if (resp.state === 'not-loaded') {
            setLocal({ state: 'not-loaded' });
            return;
          }
          if (resp.state === 'no-subtitle') {
            setLocal({ state: 'no-subtitle', extra: resp.extra ?? {} });
            return;
          }
          setLocal({
            state: 'has-subtitle',
            // LocalCollectedState 字段名沿用 bvid（语义为 vid，兼容类型不改）
            bvid: currentVid,
            extra: resp.extra ?? {},
            subs: resp.subs ?? [],
            bodies: resp.bodies ?? {},
          });
        }
      );
    });
  }, [currentVid, refreshKey]);

  // background 上报成功后 content.js 的 collected 已更新，命中当前 vid 时刷新本地
  useEffect(() => {
    if (!currentVid) return;
    const handler = (msg: unknown) => {
      const m = msg as IngestResultMessage | undefined;
      if (m?.type === 'INGEST_RESULT' && m.source_vid === currentVid) {
        setRefreshKey((k) => k + 1);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [currentVid]);

  // 当前 tab 刷新（扩展更新后页面重注入 content.js）时自动重查，省去手动重开弹窗。
  // B 站播放器 / player API 在 onload 后约 1-2s 才就绪，延迟 2s 兜底再查一次。
  useEffect(() => {
    if (!currentVid) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = (
      _tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (!tab?.active || changeInfo.status !== 'complete') return;
      timer = setTimeout(() => setRefreshKey((k) => k + 1), 2000);
    };
    chrome.tabs.onUpdated.addListener(handler);
    return () => {
      chrome.tabs.onUpdated.removeListener(handler);
      if (timer) clearTimeout(timer);
    };
  }, [currentVid]);

  const refreshLocal = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { local, refreshLocal };
}

// 一致性校验：仅对字幕轨数（本地有正文的轨数 vs server tracks）。
// stat 是时点值（播放/点赞随时间涨），本地新拉的必然 ≠ server 上次上报，数值差不视为不一致。
export function diffConsistency(
  local: LocalCollectedState,
  server: CollectedState
): ConsistencyIssue[] {
  if (local.state !== 'has-subtitle' || server.state !== 'ok') return [];
  // 分子用「会入轨的轨数」（有 url 且非 url_missing），对齐 content.js flushIfReady 的入轨过滤，
  // 也对齐 server tracks（subtitle_tracks 行数）。不用 has_body：那是 body fetch 状态，
  // body 异步流入时抖动；reporting 关时 body 到齐也不触发 INGEST_RESULT，has_body 永不刷新 → 误报。
  const localTrackCount = local.subs.filter(
    (s) => !!s.subtitle_url && !s.url_missing
  ).length;
  if (localTrackCount !== server.tracks) {
    return [
      {
        field: '字幕轨数',
        local: String(localTrackCount),
        server: String(server.tracks),
      },
    ];
  }
  return [];
}
