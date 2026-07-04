import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  useBiliLogin,
  useCollected,
  useConnectionStatus,
  useLocalCollected,
  useReporting,
  diffConsistency,
  type CollectedState,
  type LocalCollectedState,
} from './hooks';
import { fmtNum } from './format';
import { cn } from '@/lib/utils';
import type { ConsistencyIssue, LocalSub, SubtitleBody } from './types';
import { formatSubtitle, type SubtitleFormat } from '../../subtitleFormat.mjs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const SUBTITLE_FORMAT_KEY = 'subtitleFormat';
const FORMAT_OPTIONS: { value: SubtitleFormat; label: string }[] = [
  { value: 'text', label: '纯文本' },
  { value: 'timestamp', label: '带时间戳' },
  { value: 'srt', label: 'SRT' },
];

// 字幕复制格式记忆：启动从 storage 读，切换时回写。
function useSubtitleFormat(): [SubtitleFormat, (f: SubtitleFormat) => void] {
  const [fmt, setFmt] = useState<SubtitleFormat>('text');
  useEffect(() => {
    chrome.storage.local.get([SUBTITLE_FORMAT_KEY], (items) => {
      const v = items[SUBTITLE_FORMAT_KEY];
      if (v === 'text' || v === 'timestamp' || v === 'srt') setFmt(v);
    });
  }, []);
  const set = useCallback((f: SubtitleFormat) => {
    setFmt(f);
    chrome.storage.local.set({ [SUBTITLE_FORMAT_KEY]: f });
  }, []);
  return [fmt, set];
}

export function Popup() {
  const conn = useConnectionStatus();
  const login = useBiliLogin();
  const reporting = useReporting();
  const { collected: serverCollected, currentBvid, refresh } = useCollected();
  const { local, refreshLocal } = useLocalCollected(currentBvid);
  const consistency = diffConsistency(local, serverCollected);

  const onCapture = () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
    // RE_AGG → INGEST → INGEST_RESULT 会自动触发两边刷新；setTimeout 作兜底
    setTimeout(() => {
      refresh();
      refreshLocal();
    }, 1500);
  };

  return (
    <div className="space-y-3 p-3">
      <Row label="连接">
        {conn === 'loading' ? (
          <Badge variant="secondary">检查中</Badge>
        ) : conn === 'connected' ? (
          <Badge variant="success">已连接</Badge>
        ) : (
          <Badge variant="destructive">未连接</Badge>
        )}
      </Row>

      <Row label="B站登录">
        {login.state === 'loading' ? (
          <Badge variant="secondary">检查中</Badge>
        ) : login.state === 'logged' ? (
          <Badge variant="success">已登录 ({login.uname})</Badge>
        ) : login.state === 'guest' ? (
          <Badge variant="destructive">未登录</Badge>
        ) : (
          <Badge variant="destructive">检查失败</Badge>
        )}
      </Row>

      <Row label="当前视频">
        <span className="text-sm tabular-nums">{currentBvid ?? '非视频页'}</span>
      </Row>

      <CollectedBlock local={local} server={serverCollected} consistency={consistency} />

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">自动上报</span>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {reporting.enabled ? '开' : '关'}
          </span>
          <Switch
            checked={reporting.enabled}
            onCheckedChange={reporting.setEnabled}
          />
        </div>
      </div>

      <Button size="sm" className="w-full" onClick={onCapture}>
        手动补采
      </Button>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// 「已收集」主数据来自本地 content.js（local），server 仅作一致性校验 + 上报时间提示。
function CollectedBlock({
  local,
  server,
  consistency,
}: {
  local: LocalCollectedState;
  server: CollectedState;
  consistency: ConsistencyIssue[];
}) {
  if (local.state === 'non-video') return null;

  if (local.state === 'loading') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">
          已收集: 查询中…
        </CardContent>
      </Card>
    );
  }

  // 视频页但 content.js 还没拦到 player API（页面刚加载/未播放）
  if (local.state === 'not-loaded') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">
          正在获取当前视频信息，请确保视频已开始加载
        </CardContent>
      </Card>
    );
  }

  // player API subtitles 数组为空，真无字幕（区别于"有字幕但没获取到"）
  if (local.state === 'no-subtitle') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">
          当前视频没有字幕
        </CardContent>
      </Card>
    );
  }

  const { extra, subs, bodies } = local;
  const stat = extra.stat ?? {};
  const tags = Array.isArray(extra.tags) ? extra.tags : [];
  const pages = Array.isArray(extra.pages) ? extra.pages : [];

  // 字段名对齐 inject.js readVideoExtra 写入的 stat：view/like/coin/favorite/share/danmaku
  const stats: Array<{ label: string; value: number | null | undefined }> = [
    { label: '播放', value: stat.view },
    { label: '点赞', value: stat.like },
    { label: '投币', value: stat.coin },
    { label: '收藏', value: stat.favorite },
    { label: '转发', value: stat.share },
    { label: '弹幕数', value: stat.danmaku },
  ];

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium">已收集</div>
            {consistency.map((c) => (
              <Badge
                key={c.field}
                variant="destructive"
                className="font-normal"
                title={`本地 ${c.local} / 服务端 ${c.server}`}
              >
                ⚠ {c.field}不一致
              </Badge>
            ))}
          </div>
          <ReportedSubstatus server={server} />
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <TrackIcon className="h-3.5 w-3.5" />
            <span className="tabular-nums">{subs.length}</span>
            <span>轨字幕</span>
          </span>
          {pages.length > 1 && (
            <span className="inline-flex items-center gap-1">
              <PagesIcon className="h-3.5 w-3.5" />
              <span className="tabular-nums">{pages.length}</span>
              <span>P</span>
            </span>
          )}
          {extra.tname && (
            <span className="inline-flex items-center gap-1">
              <CategoryIcon className="h-3.5 w-3.5" />
              <span>{extra.tname}</span>
            </span>
          )}
        </div>

        <SubtitleCopySection subs={subs} bodies={bodies} />

        <div className="grid grid-cols-3 gap-x-2 gap-y-2">
          {stats.map((s) => (
            <div key={s.label} className="space-y-0.5">
              <div className="text-xs text-muted-foreground">{s.label}</div>
              <div className="text-sm font-medium tabular-nums">{fmtNum(s.value)}</div>
            </div>
          ))}
        </div>

        {/* stat.danmaku = 该视频收到的弹幕条数（B 站公开统计字段），非本项目采集的弹幕内容 */}
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {tags.slice(0, 8).map((t, i) => (
              <Badge key={`${t.tag_name}-${i}`} variant="secondary" className="font-normal">
                {t.tag_name}
              </Badge>
            ))}
            {tags.length > 8 && (
              <span className="text-xs text-muted-foreground">+{tags.length - 8}</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 服务端上报状态：仅作副标题提示（主数据来自本地），并说明一致性校验是否可用
function ReportedSubstatus({ server }: { server: CollectedState }) {
  let text: string | null = null;
  if (server.state === 'ok') {
    const updated = server.video.updated_at
      ? new Date(server.video.updated_at).toLocaleString()
      : null;
    text = updated ? `上次上报 ${updated}` : '已上报';
  } else if (server.state === 'not-collected') {
    text = '未上报到服务端';
  } else if (server.state === 'server-down') {
    text = '服务端未运行（一致性校验不可用）';
  } else if (server.state === 'loading') {
    text = '校验查询中…';
  }
  if (!text) return null;
  return <div className="text-xs text-muted-foreground">{text}</div>;
}

// 默认折叠；展开后选一轨 + 选格式 + 复制。格式选择记忆上次。
function SubtitleCopySection({
  subs,
  bodies,
}: {
  subs: LocalSub[];
  bodies: Record<string, SubtitleBody>;
}) {
  const [format, setFormat] = useSubtitleFormat();
  const [open, setOpen] = useState(false);
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyableSubs = subs.filter((s) => s.has_body);
  const effectiveUrl =
    selectedUrl && copyableSubs.some((s) => s.subtitle_url === selectedUrl)
      ? selectedUrl
      : (copyableSubs[0]?.subtitle_url ?? null);

  if (copyableSubs.length === 0) {
    // 字幕体均未抓到（如 url_missing / 仍在加载），不渲染复制区
    return null;
  }

  const onCopy = async () => {
    if (!effectiveUrl) return;
    const body = bodies[effectiveUrl];
    if (!body) return;
    const text = formatSubtitle(body, format);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard 不可用（焦点丢失/权限），静默忽略
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronIcon
          className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
        />
        <span>复制字幕（{copyableSubs.length}/{subs.length} 轨已获取）</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        <div className="space-y-1">
          {subs.map((s, i) => {
            const selectable = !!s.has_body && !!s.subtitle_url;
            const isSelected = s.subtitle_url === effectiveUrl;
            return (
              <button
                key={s.subtitle_url ?? i}
                type="button"
                disabled={!selectable}
                onClick={() => s.subtitle_url && setSelectedUrl(s.subtitle_url)}
                className={cn(
                  'flex w-full items-center justify-between rounded border px-2 py-1 text-xs',
                  isSelected ? 'border-primary bg-accent text-accent-foreground' : 'border-input',
                  !selectable && 'cursor-not-allowed opacity-50'
                )}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{s.lan_doc ?? s.lan ?? '未知'}</span>
                  {s.lan && <span className="text-muted-foreground">{s.lan}</span>}
                </span>
                <span className="text-muted-foreground">
                  {!selectable ? '未获取' : isSelected ? '已选' : '可复制'}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Select value={format} onValueChange={(v) => setFormat(v as SubtitleFormat)}>
            <SelectTrigger className="h-8 flex-1 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMAT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 px-3" onClick={onCopy} disabled={!effectiveUrl}>
            {copied ? '已复制' : '复制'}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// lucide-react 未引入（避免新增依赖），用等高线 inline SVG 替代，stroke 跟随 currentColor。
function TrackIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function PagesIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

function CategoryIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 4h6l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
