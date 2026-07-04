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
import { formatSubtitle, SUBTITLE_FORMATS, type SubtitleFormat } from '../../subtitleFormat.mjs';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

const SUBTITLE_FORMAT_KEY = 'subtitleFormat';
const FORMAT_LABEL: Record<SubtitleFormat, string> = {
  text: '纯文本',
  timestamp: '带时间戳',
  srt: 'SRT',
};
// 从 SUBTITLE_FORMATS 派生，避免和模块常量两处漂移
const FORMAT_OPTIONS = SUBTITLE_FORMATS.map((value) => ({ value, label: FORMAT_LABEL[value] }));

// 复制到剪贴板：navigator.clipboard 优先，失败回退 execCommand（popup 失焦/老 Chrome 兼容）。
// 返回是否成功，调用方据此给反馈。
async function copyText(text: string): Promise<boolean> {
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
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

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
          <StatusPlaceholder className="w-16" />
        ) : conn === 'connected' ? (
          <Badge variant="success">已连接</Badge>
        ) : (
          <Badge variant="destructive">未连接</Badge>
        )}
      </Row>

      <Row label="B站登录">
        {login.state === 'loading' ? (
          <StatusPlaceholder className="w-16" />
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
          {reporting.enabled === null ? (
            <StatusPlaceholder className="w-20" />
          ) : (
            <>
              <span className="text-sm text-muted-foreground">
                {reporting.enabled ? '开' : '关'}
              </span>
              <Switch
                checked={reporting.enabled}
                onCheckedChange={reporting.setEnabled}
              />
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs"
            onClick={onCapture}
          >
            手动补采
          </Button>
        </div>
      </div>
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

// loading/未知态占位：不渲染任何语义值（不显示"检查中/开/已连接"等），仅一条中性脉冲条，
// 避免首帧默认值 → 异步真值的双次渲染闪烁（重点消除"开→关"的错误值翻转）。
function StatusPlaceholder({ className }: { className?: string }) {
  return (
    <span
      aria-label="加载中"
      className={cn('inline-block h-5 animate-pulse rounded-md bg-muted', className)}
    />
  );
}

// 「视频信息」主数据来自本地 content.js（local），server 仅作一致性校验 + 上报时间提示。
function CollectedBlock({
  local,
  server,
  consistency,
}: {
  local: LocalCollectedState;
  server: CollectedState;
  consistency: ConsistencyIssue[];
}) {
  // 非视频页判定走 server（useCollected 的 tabs.query 本地解析 URL）：
  // useLocalCollected 在 currentBvid 未就绪时保持 loading，不再判 non-video，
  // 避免 loading → 空 → loading 的卡片闪烁。
  if (server.state === 'non-video') return null;

  if (local.state === 'loading') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">
          视频信息: 查询中…
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
            <div className="text-sm font-medium">视频信息</div>
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

// 默认折叠；展开后选格式（横向抽屉，记忆）+ 每轨右侧复制按钮，点即复制「该轨 × 当前格式」。
function SubtitleCopySection({
  subs,
  bodies,
}: {
  subs: LocalSub[];
  bodies: Record<string, SubtitleBody>;
}) {
  const [format, setFormat] = useSubtitleFormat();
  const [open, setOpen] = useState(false);
  // 格式横向抽屉：收缩态只显示当前格式（点击展开），展开态横排三个，点选其一折叠并记忆。
  const [fmtOpen, setFmtOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const copyableSubs = subs.filter((s) => s.has_body);

  if (copyableSubs.length === 0) {
    // 字幕体均未抓到（如 url_missing / 仍在加载），不渲染复制区
    return null;
  }

  const onCopy = async (url: string) => {
    const body = bodies[url];
    if (!body) return;
    const ok = await copyText(formatSubtitle(body, format));
    if (ok) {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 1500);
    } else {
      setFailedUrl(url);
      setTimeout(() => setFailedUrl(null), 1500);
    }
  };

  // 抽屉收缩态只渲染当前格式（点击展开）；展开态渲染全部三个。
  const fmtShown = fmtOpen
    ? FORMAT_OPTIONS
    : FORMAT_OPTIONS.filter((o) => o.value === format);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronIcon
          className={cn('h-3 w-3 transition-transform', open && 'rotate-90')}
        />
        <span>复制字幕（{copyableSubs.length}/{subs.length} 轨已获取）</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pt-2">
        <div className="flex flex-wrap gap-1">
          {fmtShown.map((o) => {
            const isCurrent = o.value === format;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  if (fmtOpen) {
                    setFormat(o.value);
                    setFmtOpen(false);
                  } else {
                    setFmtOpen(true);
                  }
                }}
                className={cn(
                  'rounded border px-2 py-0.5 text-xs transition-colors',
                  isCurrent
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-input bg-background hover:bg-accent hover:text-accent-foreground'
                )}
              >
                {o.label}
                {!fmtOpen && ' ▸'}
              </button>
            );
          })}
        </div>

        <div className="space-y-1">
          {subs.map((s, i) => {
            const url = s.subtitle_url;
            const selectable = !!s.has_body && !!url;
            // B 站 AI 字幕走 aisubtitle.hdslb.com，用 URL 特征识别最稳。
            const isAi = !!url && url.includes('aisubtitle');
            const label = isAi ? 'AI' : (s.lan_doc ?? s.lan ?? '未知');
            const justCopied = !!url && copiedUrl === url;
            const justFailed = !!url && failedUrl === url;
            return (
              <div
                key={url ?? i}
                className="flex items-center justify-between rounded border border-input px-2 py-1 text-xs"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="font-medium">{label}</span>
                  {!isAi && s.lan && s.lan_doc && (
                    <span className="text-muted-foreground">{s.lan}</span>
                  )}
                </span>
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => url && onCopy(url)}
                  className={cn(
                    'shrink-0 rounded px-2 py-0.5 text-xs transition-colors',
                    justFailed
                      ? 'bg-destructive text-destructive-foreground'
                      : justCopied
                        ? 'bg-secondary text-secondary-foreground'
                        : 'bg-primary text-primary-foreground hover:bg-primary/90',
                    !selectable && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {!selectable
                    ? '未获取'
                    : justCopied
                      ? '已复制'
                      : justFailed
                        ? '失败'
                        : '复制'}
                </button>
              </div>
            );
          })}
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
