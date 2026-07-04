import { useCallback, useEffect, useState } from 'react';
import { REPORTING_KEY } from '../../reporting.mjs';
import { API_BASE } from '../../config.js';
import type {
  BiliNavResponse,
  CollectedExtra,
  CollectedResponse,
  CollectedVideo,
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

export function useCollected(
  refreshKey: number
): { collected: CollectedState; currentBvid: string | null } {
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
            setCollected({ state: 'not-collected' });
            return;
          }
          const video = d.video ?? {};
          const extra = parseExtra(video.extra);
          setCollected({
            state: 'ok',
            bvid,
            video,
            extra,
            tracks: d.tracks?.length ?? 0,
          });
        })
        .catch(() => setCollected({ state: 'server-down' }));
    });
  }, [refreshKey]);

  return { collected, currentBvid };
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
