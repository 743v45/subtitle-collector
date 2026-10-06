import { useEffect, useRef, useState } from 'react';
import { toSrt, toTxt, toVtt, type SubtitleLine } from '@/components/SubtitleView';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';

export type { SubtitleLine } from '@/components/SubtitleView';

// ── 字幕正文面板（2026-10-05 Q4 视频详情改造：复制/下载六个平铺按钮 → 「复制 ▾」「下载 ▾」两下拉）──
// 格式转换复用 SubtitleView 导出的纯函数（toSrt/toVtt/toTxt，行为不变）；
// 下拉为手写受控实现——ui/ 无 dropdown-menu，按 TagMultiSelect 先例（button + absolute 面板，
// 菜单外 mousedown 关闭），不引入新依赖。复制/下载的处理逻辑与原 SubtitleView 逐行同构。
const FORMATS = [
  { key: 'srt', label: 'SRT', to: toSrt },
  { key: 'vtt', label: 'VTT', to: toVtt },
  { key: 'txt', label: 'TXT', to: toTxt },
] as const;

type FmtKey = (typeof FORMATS)[number]['key'];

export function SubtitlePanel({ body, sourceVid }: { body: SubtitleLine[]; sourceVid?: string }) {
  const toast = useToast();
  // 两菜单互斥：同一时刻至多展开一个（openMenu=null 全关）
  const [openMenu, setOpenMenu] = useState<'copy' | 'download' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 菜单外 mousedown → 关闭（mousedown 而非 click，避免面板内点击冒泡时序问题，同 TagMultiSelect）
  useEffect(() => {
    if (openMenu === null) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenu]);

  // 复制：navigator.clipboard 在非 secure context（http 域名）不可用 → execCommand 兜底；
  // 成功/失败都 toast 反馈（复制是静默操作，不报反馈用户无从得知是否已入剪贴板）
  const copy = async (text: string, label: string) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      document.body.removeChild(ta);
    }
    if (ok) toast(`已复制 ${label}`, 'success');
    else toast(`复制 ${label} 失败`, 'error');
  };

  // 下载：文本 → Blob → a.click 触发浏览器下载，文件名用视频 ID（无 id 回落 subtitle）
  const download = (fmt: FmtKey) => {
    const f = FORMATS.find((x) => x.key === fmt)!;
    const blob = new Blob([f.to(body)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sourceVid || 'subtitle'}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmt = (sec: number) => { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; };

  return (
    <div ref={rootRef}>
      <div className="mb-2 flex flex-wrap gap-2">
        {(['copy', 'download'] as const).map((kind) => {
          const label = kind === 'copy' ? '复制' : '下载';
          const open = openMenu === kind;
          return (
            <div key={kind} className="relative">
              <Button
                variant="outline"
                size="sm"
                aria-expanded={open}
                className="gap-1"
                onClick={() => setOpenMenu(open ? null : kind)}
              >
                {label}
                <ChevronDown className={cn('size-3.5 opacity-60 transition-transform duration-150', open && 'rotate-180')} />
              </Button>
              {open && (
                <div className="absolute left-0 z-50 mt-1 w-32 rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
                  {FORMATS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => {
                        setOpenMenu(null); // 选完即关（与原生 dropdown-menu 行为一致）
                        if (kind === 'copy') void copy(f.to(body), f.label);
                        else download(f.key);
                      }}
                      className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors duration-150 hover:bg-accent focus:bg-accent"
                    >
                      {label} {f.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="max-h-[400px] overflow-y-auto rounded border border-border p-2">
        {body.map((l, i) => (
          <div key={i} className="flex gap-3 py-0.5 leading-relaxed">
            <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{fmt(l.from)} → {fmt(l.to)}</span>
            <span>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
