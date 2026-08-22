// ── 原站外链统一组件 ──
// 新标签打开 B 站/YouTube 原页面；stopPropagation 防触发外层行点击（站内详情跳转）。
// 无 children 渲染 ExternalLink 小图标（标题旁 ↗）；有 children 渲染文本链接（hover 下划线）。
import type { MouseEvent, ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ExtLink({ href, label, className, children }: {
  href: string;
  label: string;                // aria-label / title（图标与文本模式共用）
  className?: string;
  children?: ReactNode;         // 传入即文本链接模式
}) {
  const stop = (e: MouseEvent) => e.stopPropagation(); // 只拦冒泡，默认行为照常开新标签
  if (children) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        title={label}
        onClick={stop}
        className={cn('text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      >
        {children}
      </a>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      onClick={stop}
      className={cn('inline-flex shrink-0 cursor-pointer items-center text-muted-foreground transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}
