import { type ComponentType, useCallback, useEffect, useState } from 'react';
import {
  useBiliLogin,
  useCollected,
  useConnectionStatus,
  useCreator,
  useLocalCollected,
  useReporting,
  diffConsistency,
  type CollectedState,
  type ConnState,
  type CreatorState,
  type LocalCollectedState,
  type LoginState,
} from './hooks';
import { bili, type Platform, type StatIconName } from './platforms';
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

// 统计字段图标映射（接近 B 站官方语义：播放▶/点赞👍/投币🪙/收藏⭐/转发↗/弹幕💬）。
// StatIconName 来自 platform adapter，多平台时各 adapter 声明自己的字段图标。
const STAT_ICONS: Record<StatIconName, ComponentType<{ className?: string }>> = {
  play: PlayIcon,
  like: LikeIcon,
  coin: CoinIcon,
  star: StarIcon,
  share: ShareIcon,
  danmaku: DanmakuIcon,
};

// 复制到剪贴板：navigator.clipboard 优先，失败回退 execCommand（popup 失焦/老 Chrome 兼容）。
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
  // 非视频页精简：只显示平台头 + 底部上报开关；视频信息卡 / 手动补采是视频页专属。
  // currentBvid 在 tabs.query 回调后才就绪（视频页=bvid / 非视频页=null），首帧 null 即隐藏，
  // 回调后视频页才出现——既精简非视频页，也避免"非视频页 → BVxxx"的初始值闪烁。
  // 多平台时这里改用 detectPlatform(tabUrl)，平台头/统计自动按当前平台渲染。
  const isVideoPage = currentBvid !== null;
  // server ok 时从 video.creator_id 查 UP 主详情；其它态（loading/server-down/not-collected）
  // 没有 creator_id → useCreator 返回 none，CreatorCard 不渲染，无噪音。
  const creatorId =
    serverCollected.state === 'ok' ? serverCollected.video.creator_id : undefined;

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
      <PlatformHead platform={bili} conn={conn} login={login} />
      {currentBvid && (
        <>
          <CollectedBlock
            platform={bili}
            bvid={currentBvid}
            local={local}
            server={serverCollected}
            consistency={consistency}
          />
          <CreatorCard creatorId={creatorId} />
        </>
      )}
      <FooterActions
        reporting={reporting}
        onCapture={onCapture}
        isVideoPage={isVideoPage}
      />
    </div>
  );
}

// 平台头：平台 logo + 名称 + 全局连接状态点 + 该平台登录态。
// 连接是采集服务端（全局），登录是平台特定；多平台时都按当前平台显示。
function PlatformHead({
  platform,
  conn,
  login,
}: {
  platform: Platform;
  conn: ConnState;
  login: LoginState;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-2.5 py-2">
      <span
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-lg text-brand-foreground',
          platform.brandBgClass
        )}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="h-[18px] w-[18px]" aria-hidden="true">
          <path d={platform.logo} />
        </svg>
      </span>
      <span className="text-sm font-semibold">{platform.name}</span>
      <div className="ml-auto flex items-center gap-2">
        <ConnDot conn={conn} />
        <LoginBadge login={login} />
      </div>
    </div>
  );
}

function ConnDot({ conn }: { conn: ConnState }) {
  if (conn === 'loading') return <StatusPlaceholder className="h-3.5 w-14" />;
  const ok = conn === 'connected';
  return (
    <span className="flex items-center gap-1 text-xs">
      <span className={cn('h-1.5 w-1.5 rounded-full', ok ? 'bg-emerald-500' : 'bg-red-500')} />
      <span className={ok ? 'text-emerald-600' : 'text-red-600'}>{ok ? '已连接' : '未连接'}</span>
    </span>
  );
}

function LoginBadge({ login }: { login: LoginState }) {
  if (login.state === 'loading') return <StatusPlaceholder className="h-5 w-16" />;
  if (login.state === 'logged')
    return (
      <Badge variant="success" className="font-normal">
        已登录 {login.uname}
      </Badge>
    );
  if (login.state === 'guest')
    return (
      <Badge variant="destructive" className="font-normal">
        未登录
      </Badge>
    );
  return (
    <Badge variant="destructive" className="font-normal">
      检查失败
    </Badge>
  );
}

// 底部操作：上报开关（开=自动 / 关=手动）+ 手动补采（视频页）。无外部文字 label。
function FooterActions({
  reporting,
  onCapture,
  isVideoPage,
}: {
  reporting: { enabled: boolean | null; setEnabled: (v: boolean) => void };
  onCapture: () => void;
  isVideoPage: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      {reporting.enabled === null ? (
        <StatusPlaceholder className="h-6 w-14" />
      ) : (
        <Switch
          checked={reporting.enabled}
          onCheckedChange={reporting.setEnabled}
          checkedLabel="自动"
          uncheckedLabel="手动"
          className="data-[state=checked]:bg-brand"
        />
      )}
      {isVideoPage && (
        <Button
          size="sm"
          onClick={onCapture}
          className="ml-auto h-7 bg-brand px-3 text-xs text-brand-foreground hover:bg-brand/90"
        >
          手动补采
        </Button>
      )}
    </div>
  );
}

// loading/未知态占位：不渲染任何语义值，仅一条中性脉冲条，避免首帧默认值→真值的双次渲染闪烁。
function StatusPlaceholder({ className }: { className?: string }) {
  return (
    <span
      aria-label="加载中"
      className={cn('inline-block h-5 animate-pulse rounded-md bg-muted', className)}
    />
  );
}

// 叹号圈警示图标（等高线 inline SVG，stroke 跟随 currentColor → 配 amber-500 用）。
function AlertCircleIcon({ className }: { className?: string }) {
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
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

// not-loaded 卡片：叹号圈图标 + 主信息一行；点击图标展开/折叠原因详情（默认折叠，保持简洁）。
function NotLoadedCard() {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <Card>
      <CardContent className="space-y-1 p-3">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <button
            type="button"
            onClick={() => setShowDetail((v) => !v)}
            aria-expanded={showDetail}
            aria-label="查看原因"
            className="inline-flex text-amber-500"
          >
            <AlertCircleIcon className="h-4 w-4" />
          </button>
          <span>未获取到视频信息</span>
        </div>
        {showDetail && (
          <div className="pl-5 text-xs text-muted-foreground">
            刷新当前页后重开本弹窗（扩展更新后页面需刷新才会注入采集脚本）
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 视频信息卡：标题 + 同步/一致性 badge + bvid + 统计（数据驱动 platform.statFields）+ 复制 + tags。
function CollectedBlock({
  platform,
  bvid,
  local,
  server,
  consistency,
}: {
  platform: Platform;
  bvid: string;
  local: LocalCollectedState;
  server: CollectedState;
  consistency: ConsistencyIssue[];
}) {
  // 非视频页判定走 server（useCollected 的 tabs.query 本地解析 URL）：
  // useLocalCollected 在 currentBvid 未就绪时保持 loading，不再判 non-video，避免 loading→空→loading 闪烁。
  if (server.state === 'non-video') return null;

  if (local.state === 'loading') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">视频信息: 查询中…</CardContent>
      </Card>
    );
  }

  // 视频页但拿不到本地采集：最常见是扩展更新后页面未重新注入 content.js。
  // 主信息 + 叹号圈图标（点击展开原因），细节默认折叠 → 见 NotLoadedCard。
  if (local.state === 'not-loaded') return <NotLoadedCard />;

  if (local.state === 'no-subtitle') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">当前视频没有字幕</CardContent>
      </Card>
    );
  }

  const { extra, subs, bodies } = local;
  const stat = extra.stat ?? {};
  const tags = Array.isArray(extra.tags) ? extra.tags : [];
  const pages = Array.isArray(extra.pages) ? extra.pages : [];

  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold">视频信息</div>
            <SyncStatusBadge server={server} />
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
          <div className="text-xs text-muted-foreground tabular-nums">{bvid}</div>
        </div>

        {(pages.length > 1 || extra.tname) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
        )}

        {/* 统计：platform.statFields 数据驱动。大数值（font-bold）+ 图标小 label。 */}
        <div className="grid grid-cols-3 gap-x-2 gap-y-3">
          {platform.statFields.map((f) => {
            const Icon = STAT_ICONS[f.icon];
            return (
              <div key={f.key} className="space-y-0.5">
                <div className="text-base font-bold tabular-nums">{fmtNum(stat[f.key])}</div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <Icon className="h-3 w-3" />
                  <span>{f.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        <SubtitleCopySection subs={subs} bodies={bodies} />

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

// UP 主资料卡：视频信息卡下方，name + level + official 认证 Badge + sign + fans/following。
// loading 显示查询中；none（无 creator_id / server-down / 未采集）不渲染，避免噪音。
function CreatorCard({ creatorId }: { creatorId: number | null | undefined }) {
  const creator = useCreator(creatorId);

  if (creator.state === 'loading') {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">UP 主查询中…</CardContent>
      </Card>
    );
  }
  if (creator.state === 'none') return null;

  const c = creator.creator;
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-sm font-semibold">{c.name ?? '未知 UP'}</div>
          {c.level != null && (
            <Badge variant="secondary" className="font-normal tabular-nums">
              Lv{c.level}
            </Badge>
          )}
          {c.official_title && (
            <Badge variant="success" className="font-normal">
              {c.official_title}
            </Badge>
          )}
        </div>
        {c.sign && (
          <div className="line-clamp-2 text-xs text-muted-foreground">{c.sign}</div>
        )}
        {(c.fans != null || c.following != null) && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {c.fans != null && (
              <span className="tabular-nums">粉丝 {fmtNum(c.fans)}</span>
            )}
            {c.following != null && (
              <span className="tabular-nums">关注 {fmtNum(c.following)}</span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// 服务端同步状态 badge（标题旁）：颜色区分 + 上次同步时间；loading 用中性占位避免闪烁。
function SyncStatusBadge({ server }: { server: CollectedState }) {
  if (server.state === 'loading') {
    return <StatusPlaceholder className="h-5 w-16" />;
  }
  // server-down 不显示 badge：和平台头「未连接」语义重复（都是服务端连不上）；
  // 一致性校验在 server-down 时本就不可用（diffConsistency 返回空），不显示即代表不可用。
  if (server.state === 'server-down') return null;
  let variant: 'success' | 'secondary';
  let text: string;
  if (server.state === 'ok') {
    const t = server.video.updated_at ? fmtSyncTime(server.video.updated_at) : '';
    variant = 'success';
    text = t ? `同步 ${t}` : '已同步';
  } else {
    variant = 'secondary';
    text = '未同步';
  }
  return (
    <Badge variant={variant} className="font-normal">
      {text}
    </Badge>
  );
}

// 同步时间短格式：M/D HH:MM（badge 内显示，比 toLocaleString 短）。
function fmtSyncTime(ts: number | string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
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
  const fmtShown = fmtOpen ? FORMAT_OPTIONS : FORMAT_OPTIONS.filter((o) => o.value === format);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronIcon className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        <span>复制字幕 · {copyableSubs.length}/{subs.length} 轨</span>
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
                    ? 'border-brand bg-brand text-brand-foreground'
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
                        : 'bg-brand text-brand-foreground hover:bg-brand/90',
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

// 统计项图标（等高线 inline SVG，stroke 跟随 currentColor）。接近 B 站官方语义。
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function LikeIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  );
}

function CoinIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="9" cy="9" r="6" />
      <path d="M18.09 11.37A6 6 0 1 1 10.34 19" />
      <path d="M8 7h1v4" />
      <path d="m17 14.88.7.71-2.82 2.82" />
    </svg>
  );
}

function StarIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  );
}

function ShareIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

function DanmakuIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 9h8" />
    </svg>
  );
}

function PagesIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}

function CategoryIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 4h6l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}
