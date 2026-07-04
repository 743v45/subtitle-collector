import { useCallback, useEffect, useState } from 'react';
import { REPORTING_KEY } from '../../reporting.mjs';
import { API_BASE } from '../../config.js';
import type {
  BiliNavResponse,
  CollectedExtra,
  CollectedResponse,
  CollectedVideo,
  ConsistencyIssue,
  LocalStateResponse,
  LocalSub,
  SubtitleBody,
} from './types';

// —— 连接状态：每 2s 向 background 查 WS_STATUS ——
export type ConnState = 'loading' | 'connected' | 'disconnected';

export function useConnectionStatus(): ConnState {
  const [state, setState] = useState<ConnState>('loading');
  useEffect(() => {
    const check = () => {
      chrome.runtime.sendMessage({ type: 'WS_STATUS' }, (resp) => {
        setState(resp?.connected ? 'connected' : 'disconnected');
      });
    };
    check();
    const t = setInterval(check, 2000);
    return () => clearInterval(t);
  }, []);
  return state;
}

// —— B 站登录态：每 30s 直连官方 nav 接口 ——
export type LoginState =
  | { state: 'loading' }
  | { state: 'logged'; uname: string }
  | { state: 'guest' }
  | { state: 'error' };

export function useBiliLogin(): LoginState {
  const [login, setLogin] = useState<LoginState>({ state: 'loading' });
  useEffect(() => {
    const check = () => {
      fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
        .then((r) => r.json())
        .then((d: BiliNavResponse) => {
          if (d.code === 0 && d.data?.isLogin) {
            setLogin({ state: 'logged', uname: d.data.uname || '用户' });
          } else {
            setLogin({ state: 'guest' });
          }
        })
        .catch(() => setLogin({ state: 'error' }));
    };
    check();
    const t = setInterval(check, 30000);
    return () => clearInterval(t);
  }, []);
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
  source_vid?: string;
  inserted?: number;
  skipped?: number;
}

export function useCollected(): {
  collected: CollectedState;
  currentBvid: string | null;
  refresh: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);
  const [collected, setCollected] = useState<CollectedState>({ state: 'loading' });
  const [currentBvid, setCurrentBvid] = useState<string | null>(null);

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      const m = tab?.url?.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
      if (!m) {
        setCurrentBvid(null);
        setCollected({ state: 'non-video' });
        return;
      }
      const bvid = m[1];
      setCurrentBvid(bvid);
      setCollected({ state: 'loading' });
      fetch(`${API_BASE}/api/videos/bilibili/${bvid}`)
        .then((r) => r.json())
        .then((d: CollectedResponse) => {
          if (!d.ok) {
            console.log('[popup] collected query: not collected', { bvid, ok: false });
            setCollected({ state: 'not-collected' });
            return;
          }
          const video = d.video ?? {};
          const extra = parseExtra(video.extra);
          const trackCount = d.tracks?.length ?? 0;
          console.log('[popup] collected query: ok', { bvid, ok: true, tracks: trackCount });
          setCollected({
            state: 'ok',
            bvid,
            video,
            extra,
            tracks: trackCount,
          });
        })
        .catch((err) => {
          console.log('[popup] collected query: error', { bvid, err: String(err) });
          setCollected({ state: 'server-down' });
        });
    });
  }, [refreshKey]);

  // background 上报成功后广播 INGEST_RESULT：source_vid 命中当前 bvid 时触发重查
  useEffect(() => {
    const handler = (msg: unknown) => {
      const m = msg as IngestResultMessage | undefined;
      if (!m || m.type !== 'INGEST_RESULT') return;
      if (currentBvid && m.source_vid === currentBvid) {
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
  }, [currentBvid]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  return { collected, currentBvid, refresh };
}

// —— 上报开关：启动从 storage 读（默认开，!==false），切换时发 SET_REPORTING ——
export function useReporting(): { enabled: boolean; setEnabled: (v: boolean) => void } {
  const [enabled, setEnabled] = useState(true);
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

// —— 本地数据源：popup 经 chrome.tabs.sendMessage 直取 content.js 的 collected ——
// 「已收集」改用本地提取的数据展示（轨道/正文/extra），server 数据仅作一致性校验。
export type LocalCollectedState =
  | { state: 'loading' }
  | { state: 'non-video' }
  | { state: 'not-loaded' } // 视频页但 content.js 还没拦到 player API / 正文未就绪
  | { state: 'no-subtitle' } // player API subtitles 数组为空，真无字幕
  | {
      state: 'has-subtitle';
      bvid: string;
      extra: CollectedExtra;
      subs: LocalSub[];
      bodies: Record<string, SubtitleBody>;
    };

export function useLocalCollected(currentBvid: string | null): {
  local: LocalCollectedState;
  refreshLocal: () => void;
} {
  const [refreshKey, setRefreshKey] = useState(0);
  const [local, setLocal] = useState<LocalCollectedState>({ state: 'loading' });

  useEffect(() => {
    if (!currentBvid) {
      setLocal({ state: 'non-video' });
      return;
    }
    setLocal({ state: 'loading' });
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (!tab?.id) {
        setLocal({ state: 'not-loaded' });
        return;
      }
      chrome.tabs.sendMessage(
        tab.id,
        { type: 'GET_LOCAL_STATE', bvid: currentBvid },
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
            setLocal({ state: 'no-subtitle' });
            return;
          }
          setLocal({
            state: 'has-subtitle',
            bvid: currentBvid,
            extra: resp.extra ?? {},
            subs: resp.subs ?? [],
            bodies: resp.bodies ?? {},
          });
        }
      );
    });
  }, [currentBvid, refreshKey]);

  // background 上报成功后 content.js 的 collected 已更新，命中当前 bvid 时刷新本地
  useEffect(() => {
    if (!currentBvid) return;
    const handler = (msg: unknown) => {
      const m = msg as IngestResultMessage | undefined;
      if (m?.type === 'INGEST_RESULT' && m.source_vid === currentBvid) {
        setRefreshKey((k) => k + 1);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [currentBvid]);

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
  const localTrackCount = local.subs.filter((s) => s.has_body).length;
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
