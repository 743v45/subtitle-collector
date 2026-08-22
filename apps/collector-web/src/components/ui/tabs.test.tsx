// Tabs 组件测试：TabsList/Trigger/Content 组合 + 切换交互 + 受控 value。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 默认 value 渲染 + 点击切换 + onValueChange + 类名合并 | 通过 | |
import { test, expect, vi, afterEach } from 'vitest';

afterEach(cleanup);
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs';

test('默认 value 内容渲染 + tablist/tab 语义', () => {
  render(
    <Tabs defaultValue="a">
      <TabsList aria-label="轨选择">
        <TabsTrigger value="a">中文</TabsTrigger>
        <TabsTrigger value="b">英文</TabsTrigger>
      </TabsList>
      <TabsContent value="a">内容A</TabsContent>
      <TabsContent value="b">内容B</TabsContent>
    </Tabs>,
  );
  expect(screen.getByRole('tablist')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '中文', selected: true })).toBeInTheDocument();
  expect(screen.getByText('内容A')).toBeInTheDocument();
  expect(screen.queryByText('内容B')).not.toBeInTheDocument();
});

test('点击 Trigger：切换内容 + onValueChange + active 类', () => {
  const onValueChange = vi.fn();
  render(
    <Tabs defaultValue="a" onValueChange={onValueChange}>
      <TabsList>
        <TabsTrigger value="a" className="px-4">A</TabsTrigger>
        <TabsTrigger value="b">B</TabsTrigger>
      </TabsList>
      <TabsContent value="a">内容A</TabsContent>
      <TabsContent value="b">内容B</TabsContent>
    </Tabs>,
  );
  expect(screen.getByRole('tab', { name: 'A' }).className).toContain('px-4');
  // radix tabs 激活走 mousedown（click 不触发 onValueChange）
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'B' }));
  expect(onValueChange).toHaveBeenCalledWith('b');
  expect(screen.getByText('内容B')).toBeInTheDocument();
  expect(screen.queryByText('内容A')).not.toBeInTheDocument();
  expect(screen.getByRole('tab', { name: 'B', selected: true }).className).toContain('bg-background');
});
