// 客户端标识栏（2026-08-24 拆自 Popup.tsx/hooks.ts，偿还行数台账）：
// 底部极小灰字——主体点击复制 ID（CLI 用此 id 寻址本机），「改名」进入内联编辑
//（id 不变，名字落本地 storage 并经 client-name-state 同步 server）。
import { useCallback, useEffect, useState } from 'react';
import { CLIENT_ID_KEY, CLIENT_NAME_KEY } from '../../reporting.mjs';
import { Button } from '@/components/ui/button';
import { useClientId } from './hooks';

// —— 客户端名字：读 storage + onChanged 实时回流 + SET_CLIENT_NAME 落盘推送 ——
// onChanged 对齐 useTaskDispatch：background 落盘后，别处打开的 popup/options 也能实时见到新名。
// null=未命名或首帧未读到（UI 等价：只显示 ID）；setName('') 即清除（归一在 background）。
export function useClientName(): { name: string | null; setName: (v: string) => void } {
  const [name, setNameState] = useState<string | null>(null);
  useEffect(() => {
    chrome.storage.local.get([CLIENT_NAME_KEY], (items) => {
      setNameState(typeof items[CLIENT_NAME_KEY] === 'string' ? items[CLIENT_NAME_KEY] as string : null);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'local' && changes[CLIENT_NAME_KEY]) {
        setNameState(typeof changes[CLIENT_NAME_KEY].newValue === 'string' ? changes[CLIENT_NAME_KEY].newValue as string : null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const set = useCallback((v: string) => {
    // 乐观更新（trim；超长截断等归一由 background 做完后经 onChanged 回流校正）
    const optimistic = v.trim() ? v.trim() : null;
    setNameState(optimistic);
    chrome.runtime.sendMessage({ type: 'SET_CLIENT_NAME', name: v });
  }, []);
  return { name, setName: set };
}

export function ClientIdFoot() {
  const clientId = useClientId();
  const { name, setName } = useClientName();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!clientId) return null;
  if (editing) {
    const save = () => {
      setName(draft); // 空串=清除名字（background 归一为 null）
      setEditing(false);
    };
    return (
      <div className="flex items-center gap-1.5 pb-0.5">
        <input
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            else if (e.key === 'Escape') setEditing(false);
          }}
          placeholder="客户端名称（如：书房 iMac）"
          maxLength={64}
          className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-[11px] outline-none focus:border-brand"
        />
        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={save}>保存</Button>
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => setEditing(false)}>取消</Button>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center gap-2 text-[10px] text-muted-foreground/50">
      <button
        type="button"
        onClick={async () => {
          if (await copyText(clientId)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        title="客户端 ID（点击复制，CLI 用此 id 寻址本机）"
        className="truncate tabular-nums transition-colors hover:text-muted-foreground"
      >
        {copied ? '已复制 ✓' : name ? `${name} · ID ${clientId}` : `ID ${clientId}`}
      </button>
      <button
        type="button"
        onClick={() => { setDraft(name ?? ''); setEditing(true); }}
        title="给本机客户端命名（ID 不变，名字同步 server；清空保存即删除名字）"
        className="shrink-0 transition-colors hover:text-muted-foreground"
      >
        改名
      </button>
    </div>
  );
}

// 复制到剪贴板（2026-08-24 随组件拆入；Popup.tsx 字幕导出复制共用）：navigator.clipboard 优先，
// 失败回退 execCommand（popup 失焦/老 Chrome 兼容）。
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
