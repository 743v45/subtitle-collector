// ── 设置页（2026-08-22）──
// 系统级配置的集中入口（区别于功能页内嵌的操作开关）。当前：采集超时（按平台分档）。
// 后续新配置项落本页，不再散进功能页。
import { useEffect, useState } from 'react';
import { getCollectTimeout, setCollectTimeout } from '../api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useAsync } from '@/lib/useAsync';
import { Loader2 } from 'lucide-react';

// 采集超时卡片：youtube=扩展无进展窗口（持续无新进展判超时,慢视频轨加载极慢时调大,如反复
// 「YouTube 采集超时（45s）」的长视频）;bilibili=server 等回执预算（扩展纯 API 拉取无自限）。
// 秒输入/毫秒存储,范围 [15,600]s;保存后立即生效（server 派发时直读 settings 并随命令下发
// 扩展——窗口调大对已在途的任务无效,须等它终态后重试）。
function CollectTimeoutCard() {
  const toast = useToast();
  const { data } = useAsync(() => getCollectTimeout(), []);
  const [yt, setYt] = useState<string | null>(null);
  const [bili, setBili] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data && yt === null) {
      setYt(String(Math.round(data.youtube / 1000)));
      setBili(String(Math.round(data.bilibili / 1000)));
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps -- 初次加载回填一次
  if (!data || yt === null || bili === null) {
    return (
      <Card>
        <CardContent className="p-4" aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  const save = async () => {
    const y = Number(yt), b = Number(bili);
    if (!Number.isInteger(y) || !Number.isInteger(b) || y < 15 || y > 600 || b < 15 || b > 600) {
      toast('超时须为 15–600 的整数秒', 'error');
      return;
    }
    setSaving(true);
    try {
      await setCollectTimeout({ youtube: y * 1000, bilibili: b * 1000 });
      toast('已保存采集超时（对之后派发的任务生效）', 'success');
    } catch (e: any) {
      toast(`保存失败：${String(e?.message ?? e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="text-sm font-medium">采集超时</div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
          <label className="flex items-center gap-1.5" title="扩展侧无进展窗口：导航后持续无新进展（就绪/轨数不变）此时长才判超时。反复 45s 超时的慢视频调大它">
            YouTube
            <Input className="h-8 w-20" type="number" min={15} max={600} value={yt} onChange={(e) => setYt(e.target.value)} />
            s
          </label>
          <label className="flex items-center gap-1.5" title="server 等扩展回执的总预算（B 站扩展为纯 API 拉取，无自限窗口）">
            B站
            <Input className="h-8 w-20" type="number" min={15} max={600} value={bili} onChange={(e) => setBili(e.target.value)} />
            s
          </label>
          <Button size="sm" className="h-8 px-4" disabled={saving} onClick={() => void save()}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            保存
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          YouTube 为扩展侧「无进展窗口」（持续无新进展才判超时，默认 45s，慢视频调大）；B站为 server 等回执预算（默认 90s）。保存后对之后派发的任务生效；server 等待预算自动按窗口联动，无需手动配。
        </div>
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold tracking-tight">设置</h2>
      <CollectTimeoutCard />
    </div>
  );
}
