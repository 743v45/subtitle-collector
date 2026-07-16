import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useExtract, useWhisperConfig } from './hooks';

const MODELS = [
  { v: 'tiny', l: 'tiny · 最小最快' },
  { v: 'base', l: 'base · 推荐' },
  { v: 'small', l: 'small · 较准' },
  { v: 'medium', l: 'medium · 慢' },
  { v: 'turbo', l: 'turbo' },
];
const LANGS = [
  { v: 'auto', l: '自动检测' },
  { v: 'zh', l: '中文' },
  { v: 'en', l: '英语' },
  { v: 'ja', l: '日语' },
  { v: 'ko', l: '韩语' },
  { v: 'fr', l: '法语' },
  { v: 'de', l: '德语' },
  { v: 'es', l: '西语' },
];

type Phase = 'idle' | 'download' | 'transcribe' | 'done' | 'error';

export function Popup() {
  const { enabled, toggle } = useExtract();
  const { config, update } = useWhisperConfig();
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [ratio, setRatio] = useState(0);
  const [message, setMessage] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const idRef = useRef(0);

  useEffect(() => {
    const listener = (msg: any) => {
      if (!msg?.type) return;
      if (msg.type === 'PROGRESS') {
        setPhase(msg.phase as Phase);
        setRatio(typeof msg.ratio === 'number' ? msg.ratio : 0);
        setMessage(msg.message ?? '');
      } else if (msg.type === 'RESULT') {
        setPhase('done');
        setText(msg.text);
      } else if (msg.type === 'ERROR') {
        setPhase('error');
        setError(msg.message);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const onTranscribe = useCallback(async () => {
    if (!file) return;
    setPhase('download');
    setRatio(0);
    setText('');
    setError('');
    setMessage('准备…');
    const id = ++idRef.current;
    // FileReader → base64 data URL:chrome.runtime.sendMessage 跨 SW/offscreen 传 ArrayBuffer 不可靠
    const reader = new FileReader();
    reader.onload = () => {
      chrome.runtime.sendMessage(
        {
          type: 'TRANSCRIBE_FILE',
          id,
          filename: file.name,
          mime: file.type,
          dataUrl: reader.result,
        },
        (resp: any) => {
          if (chrome.runtime.lastError || !resp?.ok) {
            setPhase('error');
            setError(chrome.runtime.lastError?.message || resp?.error || '发送失败');
          }
        },
      );
    };
    reader.onerror = () => {
      setPhase('error');
      setError('读取文件失败');
    };
    reader.readAsDataURL(file);
  }, [file]);

  const pct = Math.round(ratio * 100);
  const busy = phase === 'download' || phase === 'transcribe';

  return (
    <div className="flex flex-col gap-3 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-base font-semibold">语音转字幕</h1>
        <span className="text-xs text-muted-foreground">本地 Whisper</span>
      </header>

      {/* 配置区:开关 + 模型 + 语言 */}
      <div className="flex flex-col gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm">自动提取</span>
            <span className="text-[10px] text-muted-foreground">B站视频页自动转写(Phase 2)</span>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={toggle}
            checkedLabel="开"
            uncheckedLabel="关"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">模型</span>
          <Select value={config.model} onValueChange={(v) => update({ model: v })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODELS.map((m) => (
                <SelectItem key={m.v} value={m.v} className="text-xs">
                  {m.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-xs text-muted-foreground">语言</span>
          <Select value={config.language} onValueChange={(v) => update({ language: v })}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGS.map((l) => (
                <SelectItem key={l.v} value={l.v} className="text-xs">
                  {l.l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <label className="flex cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-3 py-4 text-sm text-muted-foreground hover:bg-accent">
        {file ? file.name : '点击选择音频/视频文件'}
        <input
          type="file"
          accept="audio/*,video/*"
          className="hidden"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <Button data-testid="transcribe" onClick={onTranscribe} disabled={!file || busy}>
        {busy ? '处理中…' : '开始转写'}
      </Button>

      {busy && (
        <div className="text-xs text-muted-foreground">
          {message || (phase === 'download' ? `下载模型 ${pct}%` : `识别中 ${pct}%`)}
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</div>
      )}

      {text && (
        <div className="flex flex-col gap-1">
          <textarea
            className="h-40 w-full rounded-md border border-input bg-background p-2 text-xs"
            value={text}
            readOnly
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigator.clipboard?.writeText(text)}
          >
            复制
          </Button>
        </div>
      )}
    </div>
  );
}
