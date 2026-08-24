import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// 平台筛选下拉（2026-08-24 平台区分批）：三选项固定（全部/哔哩哔哩/YouTube），
// 四页共用（StatsPage/CreatorsPage/TagsPage/ChangesLog）——从各页内联重复抽出的共享件。
// value 语义：null = 全部平台；'bilibili' | 'youtube' = 平台过滤。
export function PlatformSelect({ value, onChange, className }: {
  value: string | null;
  onChange: (next: string | null) => void;
  className?: string;
}) {
  return (
    <Select value={value ?? '__all'} onValueChange={(v) => onChange(v === '__all' ? null : v)}>
      <SelectTrigger className={className ?? 'w-[120px]'} aria-label="平台筛选">
        <SelectValue placeholder="平台" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">全部平台</SelectItem>
        <SelectItem value="bilibili">哔哩哔哩</SelectItem>
        <SelectItem value="youtube">YouTube</SelectItem>
      </SelectContent>
    </Select>
  );
}
