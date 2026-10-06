// 变更日志行（2026-10-05 自 ChangesLog.tsx 抽出；Q8a 内链同批落地）：
// 「标识」列在行数据带 ref 定位字段时渲染为站内链接——video → #/videos/{ref_source}/{ref_vid}，
// creator → #/creators/{ref_creator_id}（Button+navigate 先例同 CategoriesPage 数量列）；
// ref 字段缺失保持纯文本 entity_id（向后兼容旧 server 响应，不炸不链）。
import { Button } from '@/components/ui/button';
import { Table, TableRow, TableCell } from '@/components/ui/table';
import { navigate } from '../router';
import { PlatformIcon, platformIconClass } from '@/components/PlatformIcon';
import { cn } from '@/lib/utils';
import type { ChangeRow } from '@/types';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN');
}

// old/new 值可能很长（如 extra JSON），截断显示，hover title 看全
function ValueCell({ v }: { v: string | null }) {
  if (v == null || v === '') return <span className="text-muted-foreground">—</span>;
  const display = v.length > 80 ? v.slice(0, 80) + '…' : v;
  return (
    <span className="break-all font-mono text-xs" title={v}>
      {display}
    </span>
  );
}

// 标识列：ref 齐备 → 站内跳详情；否则纯文本
function ChangeIdCell({ c }: { c: ChangeRow }) {
  const to = c.entity === 'video' && c.ref_source && c.ref_vid
    ? `/videos/${c.ref_source}/${encodeURIComponent(c.ref_vid)}`
    : c.entity === 'creator' && c.ref_creator_id != null
      ? `/creators/${c.ref_creator_id}`
      : null;
  if (!to) return <span className="font-mono text-xs text-muted-foreground">{c.entity_id}</span>;
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto p-0 font-mono text-xs"
      title={c.entity === 'video' ? '打开视频详情' : '打开创作者详情'}
      onClick={() => navigate(to)}
    >
      {c.entity_id}
    </Button>
  );
}

export function ChangesLogRow({ c }: { c: ChangeRow }) {
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{fmtTime(c.changed_at)}</TableCell>
      <TableCell className="text-xs">
        <span className="inline-flex items-center gap-1">
          {/* 派生 source 列：实体行所属平台（不可判时省略图标） */}
          {c.source && <PlatformIcon source={c.source} className={cn('h-3 w-3', platformIconClass(c.source))} />}
          {c.entity === 'video' ? '视频' : c.entity === 'creator' ? 'UP' : c.entity}
        </span>
      </TableCell>
      <TableCell><ChangeIdCell c={c} /></TableCell>
      <TableCell className="text-xs">{c.field}</TableCell>
      <TableCell>
        <span className="inline-flex flex-wrap items-center gap-1">
          <ValueCell v={c.old_value} />
          <span className="text-muted-foreground">→</span>
          <ValueCell v={c.new_value} />
        </span>
      </TableCell>
    </TableRow>
  );
}
