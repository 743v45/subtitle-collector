// Dialog 组件测试：Trigger 打开 / 受控开关 / Header/Title/Description/Footer / 关闭按钮。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | Trigger 打开断言内容 + 受控 onOpenChange + 各子组件渲染 | 通过 | radix Portal 到 body，用 screen 查 |
import { test, expect, vi, afterEach } from 'vitest';

afterEach(cleanup);
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose,
} from './dialog';

test('DialogTrigger 点击打开：内容与关闭按钮出现在 Portal', async () => {
  render(
    <Dialog>
      <DialogTrigger asChild><button>打开</button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>弹窗标题</DialogTitle>
          <DialogDescription>弹窗描述</DialogDescription>
        </DialogHeader>
        正文区
      </DialogContent>
    </Dialog>,
  );
  expect(screen.queryByText('弹窗标题')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '打开' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('弹窗标题').className).toContain('text-lg');
  expect(screen.getByText('弹窗描述').className).toContain('text-muted-foreground');
  // 右上角自带 Close 按钮（sr-only「Close」）
  expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
});

test('受控模式：onOpenChange 随关闭按钮触发', async () => {
  const onOpenChange = vi.fn();
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>常开弹窗</DialogTitle>
        <DialogFooter className="gap-2"><button>页脚按钮</button></DialogFooter>
      </DialogContent>
    </Dialog>,
  );
  expect(screen.getByText('页脚按钮').closest('div')!.className).toContain('justify-end');
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('DialogClose：点击触发关闭（onOpenChange false）', async () => {
  const onOpenChange = vi.fn();
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>t</DialogTitle>
        <DialogClose asChild><button>关闭按钮</button></DialogClose>
      </DialogContent>
    </Dialog>,
  );
  fireEvent.click(screen.getByRole('button', { name: '关闭按钮' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('受控切换：open 状态驱动内容显隐', async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild><button>开</button></DialogTrigger>
        <DialogContent><DialogTitle>内容</DialogTitle></DialogContent>
      </Dialog>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: '开' }));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});
