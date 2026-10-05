// 创作者详情页骨架屏（2026-10-05 自 CreatorDetailPage.tsx 抽出，偿还行数台账）
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function CreatorDetailSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      <Card>
        <CardContent className="flex items-center gap-4 p-4">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-24" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><Skeleton className="h-4 w-16" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><Skeleton className="h-4 w-16" /></CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-9 w-52" />
            <Skeleton className="h-9 w-52" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
