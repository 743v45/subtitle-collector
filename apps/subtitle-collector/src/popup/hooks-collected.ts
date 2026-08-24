// 「已采」集合 hook(2026-08-24 从 hooks.ts 拆出偿还行数台账:hooks.ts 948 行超 400 阈值,
// 拆后 ~899 行台账回落,本文件新文件达标)。依赖 hooks.ts 的 authInit(Bearer 注入)。
import { useEffect, useState } from 'react';
import { createCollectedRefresh } from '../../collected-refresh.mjs';
import { authInit } from './hooks';

// —— UP 已采集合：server /api/videos?creator_uid 分页拉已采 vid 集合（采集状态标注用）——
// server-down / standalone → null（列表照常展示，采集状态与批量按钮隐藏）。
// source 参数化（2026-08-21，YouTube 频道卡用；uid 语义=bilibili mid / youtube channelId）。
// 分页上限 10 页（×100 条）：万级视频的 UP 极罕见，防失控足够。
// 刷新（2026-08-24 修复「已采不随采集入库同步」）：INGEST_RESULT / TASK_UPDATE 终态经
// createCollectedRefresh 去抖 bump refreshKey 重拉——popup 开着时绿点与「已采 N」随采集落地更新，
// 不再需要关掉重开 popup。
export function useCreatorCollected(
  mid: string | null | undefined,
  httpBase: string,
  enabled: boolean,
  source: 'bilibili' | 'youtube' = 'bilibili',
): Set<string> | null {
  const [set, setSet] = useState<Set<string> | null>(null);
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
  useEffect(() => {
    if (!mid || !enabled) {
      setSet(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const acc = new Set<string>();
        const size = 100;
        for (let page = 1; page <= 10; page++) {
          const r = await fetch(
            `${httpBase}/api/videos?source=${source}&creator_uid=${encodeURIComponent(mid)}&page=${page}&size=${size}`,
            authInit({ cache: 'no-cache' }),
          );
          const d = await r.json();
          if (!d?.ok) break;
          const items: Array<{ source_vid?: string }> = d.items ?? [];
          for (const it of items) if (typeof it.source_vid === 'string') acc.add(it.source_vid);
          if (items.length < size) break;
        }
        if (alive) setSet(acc);
      } catch {
        if (alive) setSet(null);
      }
    })();
    return () => { alive = false; };
  }, [mid, httpBase, enabled, source, refreshKey]);
  return set;
}
