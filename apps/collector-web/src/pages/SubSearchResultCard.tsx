// 字幕检索结果卡（SubSearchPage 结果区）：单视频卡（标题跳详情 + 元信息 + 片段列表）
// 与片段行（[mm:ss] + buildSegments 高亮分段 + 上下文 details 原生折叠）。
import type { SubSearchItem, SubSearchSnippet } from '../api-extra';
import type { SubSearchQueryState } from '../subSearchFilterUrl';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { ExtLink } from '@/components/ExtLink';
import { videoUrl } from '../lib/externalLinks';
import { navigate } from '../router';
import { buildSegments } from './subSearchHighlight';

// 秒 → [mm:ss]（超一小时 m 自然进位如 62:05，片段定位语义不变）
function fmtTs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// 单视频结果卡：标题跳详情（#/videos/:source/:vid），元信息行 + 片段列表
export function SearchResultCard({ item, f }: { item: SubSearchItem; f: SubSearchQueryState }) {
  const v = item.video;
  const lan = item.track.lan_doc ?? item.track.lan;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => navigate(`/videos/${v.source}/${encodeURIComponent(v.source_vid)}`)}
            className="cursor-pointer text-left text-sm font-medium hover:underline"
          >
            {v.title}
          </button>
          {lan && <Badge variant="outline" className="shrink-0 font-normal">{lan}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{v.creator_name ?? '—'}</span>
          {v.published_at ? <span>{new Date(v.published_at).toLocaleDateString('zh-CN')}</span> : null}
          <ExtLink href={videoUrl(v.source, v.source_vid)} label="在原站打开视频" />
        </div>
        <div className="space-y-1.5">
          {item.snippets.map((sn, i) => (
            <SnippetRow key={i} sn={sn} f={f} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// 单片段行：[mm:ss] + 命中行（高亮分段）+ 上下文折叠（默认收起，details 原生折叠）
function SnippetRow({ sn, f }: { sn: SubSearchSnippet; f: SubSearchQueryState }) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-start gap-2 text-sm leading-relaxed">
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">[{fmtTs(sn.from)}]</span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap">
          {buildSegments(sn.content, f.kw, { regex: f.regex, caseSensitive: f.caseSensitive }).map((seg, i) =>
            seg.hit ? (
              <mark key={i} className="rounded-sm bg-primary/20 px-0.5 text-primary">{seg.text}</mark>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </p>
      </div>
      {sn.context && (
        <details className="mt-1.5">
          <summary className="cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">上下文</summary>
          <div className="mt-1 whitespace-pre-wrap border-t pt-1.5 text-xs text-muted-foreground">{sn.context}</div>
        </details>
      )}
    </div>
  );
}
