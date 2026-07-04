import { useState, type ReactNode } from 'react';
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
  const [refreshKey, setRefreshKey] = useState(0);
  const { collected, currentBvid } = useCollected(refreshKey);

  const onCapture = () => {
    chrome.runtime.sendMessage({ type: 'MANUAL_CAPTURE' });
    setTimeout(() => setRefreshKey((k) => k + 1), 1500);
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

  return (
    <Card>
      <CardContent className="space-y-1 p-3 text-sm">
        <div className="font-medium">已收集</div>
        <div className="text-muted-foreground">上次收集 {updated}</div>
        <div className="text-muted-foreground">
          字幕轨 {tracks}
          {pages.length > 1 ? ` · 分P ${pages.length}` : ''}
          {extra.tname ? ` · ${extra.tname}` : ''}
        </div>
        <div className="text-muted-foreground tabular-nums">
          播放 {fmtNum(stat.view)} · 点赞 {fmtNum(stat.like)} · 投币 {fmtNum(stat.coin)} · 收藏{' '}
          {fmtNum(stat.fav)}
        </div>
        {/* stat.danmaku = 该视频收到的弹幕条数（B 站公开统计字段），非本项目采集的弹幕内容 */}
        <div className="text-muted-foreground tabular-nums">
          转发 {fmtNum(stat.share)} · 弹幕数 {fmtNum(stat.danmaku)}
        </div>
        {tags.length > 0 && (
          <div className="text-muted-foreground">
            标签({tags.length}): {tags.slice(0, 6).map((t) => t.tag_name).join(' / ')}
            {tags.length > 6 ? ' …' : ''}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
