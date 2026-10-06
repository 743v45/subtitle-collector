// 401 访问 token 横幅（2026-10-07，账本 U-1）：api 层任何请求收到 401 → authToken.AUTH_REQUIRED_EVENT
// → 本横幅显示。输入 token 保存 localStorage（即时生效：后续请求自动带 Bearer）并提示刷新；
// 「不再提醒」关闭本次会话横幅（sessionStorage 记忆，下次 401 仍会再弹——静默失败不可取）。
// 不自动弹窗打断：横幅常驻顶部，页面其余部分照常渲染（各页错误态各自可见）。
import { useEffect, useRef, useState } from 'react';
import { AUTH_REQUIRED_EVENT, getToken, setToken } from '../authToken';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const DISMISS_KEY = 'collector-auth-banner-dismissed';

export function AuthTokenBanner() {
  const [show, setShow] = useState(false);
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  // dismissed 用 ref 而非 useEffect 闭包变量——闭包快照在「不再提醒」点击后不更新，后续 401 会重弹（R1 测试抓到）
  const dismissedRef = useRef(false);

  useEffect(() => {
    // 已dismiss的会话内不再弹（401 仍会打 console——各页错误态可见）
    try { dismissedRef.current = sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { /* 忽略 */ }
    const onAuthRequired = () => { if (!dismissedRef.current) setShow(true); };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  if (!show) return null;

  const save = () => {
    setToken(value);
    setSaved(true);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm dark:bg-amber-950/40" role="alert">
      <span className="font-medium text-amber-800 dark:text-amber-200">接口需要访问 token（HTTP 401）</span>
      {saved ? (
        <>
          <span className="text-emerald-700 dark:text-emerald-300">已保存，后续请求将自动携带。</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => window.location.reload()}>刷新页面</Button>
        </>
      ) : (
        <>
          <Input
            className="h-7 w-64 font-mono text-xs"
            aria-label="访问 token"
            placeholder="粘贴 server 访问 token"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) save(); }}
            type="password"
          />
          <Button size="sm" className="h-7" disabled={!value.trim()} onClick={save}>保存</Button>
          <span className="text-xs text-muted-foreground">保存本机 localStorage，仅本浏览器生效</span>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto h-7"
        onClick={() => {
          dismissedRef.current = true;
          try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* 忽略 */ }
          setShow(false);
        }}
      >
        不再提醒
      </Button>
    </div>
  );
}

// 供测试与外部判断：当前是否已配置 token（横幅显示前可先行避免无意义提示——当前逻辑 401 才弹，
// 已配置但 token 过期同样会 401 再弹，属预期：提示更新 token）
export function hasToken(): boolean {
  return getToken().length > 0;
}
