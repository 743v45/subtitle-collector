import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

// shadcn/ui 标准 Skeleton：纯 Tailwind animate-pulse，用于列表/详情加载占位。
function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}

export { Skeleton };
