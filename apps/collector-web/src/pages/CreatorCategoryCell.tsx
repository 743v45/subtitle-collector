// 创作者分类下拉单元（2026-10-05 自 CreatorsPage / CreatorDetailPage 两处重复的 Select 抽出）：
// 列表行用 w-32、详情页用 w-52；值域=共享分类集；value 为 null/未命中时回落 placeholder（未分类）。
// onPick 回传分类名（打标接口按名字写，沿用 setCreatorCategory 既有契约）。
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { Category } from '@/api';

export function CreatorCategoryCell({
  value, cats, disabled, placeholder, triggerClass, onPick,
}: {
  value: string | null;
  cats: Category[] | null | undefined; // useAsync data 是 T | null，调用方直传
  disabled: boolean;
  placeholder: string;
  triggerClass: string; // 'w-32'（列表行）/ 'w-52'（详情页）
  onPick: (name: string) => void;
}) {
  return (
    <Select value={value ?? undefined} onValueChange={onPick} disabled={disabled}>
      <SelectTrigger className={triggerClass}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {(cats ?? []).map((h) => (
          <SelectItem key={h.id} value={h.name}>{h.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
