import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseAsyncResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  setData: (d: T | null) => void;
}

// 统一异步数据 hook：loading / error / data 三态 + 防竞态（seq 标记丢弃过期响应）+ 手动 reload。
// fn 在 deps 变化时自动重跑；reload() 触发强制重取；setData 暴露给调用方做乐观/本地更新。
// 解决项目里普遍的 `.catch(() => 静默吞)` 问题：错误显式落到 error，由 UI 展示。
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): UseAsyncResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    fn()
      .then((d) => { if (seq === seqRef.current) { setData(d); setLoading(false); } })
      .catch((e: unknown) => {
        if (seq === seqRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    // deps 由调用方控制；reloadTick 是 reload 触发器。fn 闭包不进依赖（与原项目 useEffect 风格一致）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadTick]);

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);
  return { data, loading, error, reload, setData };
}
