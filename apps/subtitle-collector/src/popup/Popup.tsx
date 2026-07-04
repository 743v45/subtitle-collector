import { type ReactNode } from 'react';
import {
  useBiliLogin,
  useCollected,
  useConnectionStatus,
  useReporting,
  type CollectedState,
} from './hooks';
import { fmtNum } from './format';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function Popup() {
  const conn = useConnectionStatus();
  const login = useBiliLogin();
  const reporting = useReporting();
  const { collected, currentBvid, refresh } = useCollected();

  const onCapture = () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
    setTimeout(refresh, 1500);
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

      <CollectedBlock state={collected} />

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">上报</span>
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

function CollectedBlock({ state }: { state: CollectedState }) {
  if (state.state === 'non-video') return null;

  if (state.state !== 'ok') {
    const text =
      state.state === 'loading'
        ? '已收集: 查询中…'
        : state.state === 'server-down'
          ? '服务端未运行，无法查询已收集数据'
          : '未收集（在视频页打开字幕后会自动采集）';
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">{text}</CardContent>
      </Card>
    );
  }

  const { video, extra, tracks } = state;
  const stat = extra.stat ?? {};
  const tags = Array.isArray(extra.tags) ? extra.tags : [];
  const pages = Array.isArray(extra.pages) ? extra.pages : [];
  const updated = video.updated_at ? new Date(video.updated_at).toLocaleString() : '-';

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
          <div className="text-sm font-medium">已收集</div>
          <div className="text-xs text-muted-foreground">上次收集 {updated}</div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <TrackIcon className="h-3.5 w-3.5" />
            <span className="tabular-nums">{tracks}</span>
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
