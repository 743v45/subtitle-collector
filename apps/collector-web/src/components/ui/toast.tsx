import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

// 极简 toast（不引入 sonner 等新依赖；纯 Tailwind 类，符合「禁手写 CSS」政策）。
// 用法：const toast = useToast(); toast('保存成功', 'success'); toast('失败：xx', 'error');

type ToastKind = 'default' | 'success' | 'error';
interface ToastItem { id: number; kind: ToastKind; text: string; }

interface ToastApi {
  toast: (text: string, kind?: ToastKind) => void;
}

const ToastCtx = createContext<ToastApi>({ toast: () => {} });
export const useToast = () => useContext(ToastCtx).toast;

// 模块级自增 id（组件内 useState 也能做，但模块级更简单且实例唯一）。
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((text: string, kind: ToastKind = 'default') => {
    const id = nextId++;
    setItems((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setItems((ts) => ts.filter((t) => t.id !== id)), 3500);
  }, []);

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto max-w-sm rounded-md border px-4 py-2 text-sm shadow-md',
              t.kind === 'error' && 'border-destructive bg-destructive text-destructive-foreground',
              t.kind === 'success' && 'border-emerald-500 bg-emerald-600 text-white',
              t.kind === 'default' && 'border-border bg-popover text-popover-foreground',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
