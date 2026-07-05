import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SubtitleLine { from: number; to: number; content: string; }

// 时间戳 HH:MM:SS{msSep}mmm —— SRT 用逗号、VTT 用点
function tc(sec: number, msSep: ',' | '.'): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

// 纯文本：无时间轴
export function toTxt(body: SubtitleLine[]): string {
  return body.map((l) => l.content).join('\n');
}

// SRT：序号 + HH:MM:SS,mmm --> HH:MM:SS,mmm + 内容，块间空行
export function toSrt(body: SubtitleLine[]): string {
  return body
    .map((l, i) => `${i + 1}\n${tc(l.from, ',')} --> ${tc(l.to, ',')}\n${l.content}`)
    .join('\n\n');
}

// WebVTT：WEBVTT 头 + HH:MM:SS.mmm --> HH:MM:SS.mmm + 内容，块间空行
export function toVtt(body: SubtitleLine[]): string {
  return 'WEBVTT\n\n' + body
    .map((l) => `${tc(l.from, '.')} --> ${tc(l.to, '.')}\n${l.content}`)
    .join('\n\n');
}

export function SubtitleView({ body, sourceVid }: { body: SubtitleLine[]; sourceVid?: string }) {
  const fmt = (sec: number) => { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; };
  const copy = (text: string) => { navigator.clipboard.writeText(text); };
  // 下载：生成文本 → Blob → 触发浏览器下载，文件名用 BV 号
  const download = (fmt: 'srt' | 'vtt' | 'txt') => {
    const text = fmt === 'srt' ? toSrt(body) : fmt === 'vtt' ? toVtt(body) : toTxt(body);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sourceVid || 'subtitle'}.${fmt}`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-2">
        <Button variant="outline" size="sm" onClick={() => copy(toSrt(body))}>复制 SRT</Button>
        <Button variant="outline" size="sm" onClick={() => copy(toVtt(body))}>复制 VTT</Button>
        <Button variant="outline" size="sm" onClick={() => copy(toTxt(body))}>复制 TXT</Button>
        <Button variant="outline" size="sm" onClick={() => download('srt')}>下载 SRT</Button>
        <Button variant="outline" size="sm" onClick={() => download('vtt')}>下载 VTT</Button>
        <Button variant="outline" size="sm" onClick={() => download('txt')}>下载 TXT</Button>
      </div>
      <div className="max-h-[400px] overflow-y-auto rounded border border-border p-2">
        {body.map((l, i) => (
          <div key={i} className="flex gap-3 py-0.5 leading-relaxed">
            <span className={cn('whitespace-nowrap text-xs text-muted-foreground tabular-nums')}>{fmt(l.from)} → {fmt(l.to)}</span>
            <span>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
