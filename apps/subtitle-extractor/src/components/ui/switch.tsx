import * as React from 'react';
import * as SwitchPrimitives from '@radix-ui/react-switch';

import { cn } from '@/lib/utils';

interface SwitchProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> {
  /** 传入后 toggle 加宽、track 内显示文字(checkedLabel 在滑块对侧);不传则用标准窄 toggle */
  checkedLabel?: string;
  uncheckedLabel?: string;
}

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  SwitchProps
>(({ className, checkedLabel, uncheckedLabel, ...props }, ref) => {
  const hasLabel = checkedLabel !== undefined || uncheckedLabel !== undefined;
  return (
    <SwitchPrimitives.Root
      className={cn(
        'group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        hasLabel ? 'h-6 w-14' : 'h-5 w-9',
        className,
      )}
      {...props}
      ref={ref}
    >
      {hasLabel ? (
        <>
          <SwitchPrimitives.Thumb
            className={cn(
              'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
              'data-[state=checked]:translate-x-8 data-[state=unchecked]:translate-x-0',
            )}
          />
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-[10px] font-medium leading-none text-primary-foreground transition-opacity',
              'group-data-[state=checked]:opacity-100 group-data-[state=unchecked]:opacity-0',
            )}
          >
            {checkedLabel}
          </span>
          <span
            className={cn(
              'pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] font-medium leading-none text-foreground transition-opacity',
              'group-data-[state=unchecked]:opacity-100 group-data-[state=checked]:opacity-0',
            )}
          >
            {uncheckedLabel}
          </span>
        </>
      ) : (
        <SwitchPrimitives.Thumb
          className={cn(
            'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform',
            'data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
          )}
        />
      )}
    </SwitchPrimitives.Root>
  );
});
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
