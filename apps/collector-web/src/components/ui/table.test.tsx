// Table 组件族测试：全部子组件（Table/Header/Body/Footer/Head/Row/Cell/Caption）渲染 + 类名合并。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 八个子组件渲染与类 | 通过 | Table 外层包 overflow 容器，断言 table 元素角色 |
import { test, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import {
  Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption,
} from './table';

afterEach(cleanup);

test('全子组件组合渲染 table 结构', () => {
  render(
    <Table>
      <TableCaption>表说明</TableCaption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-40">列A</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell className="font-medium">格1</TableCell>
        </TableRow>
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableCell>合计</TableCell>
        </TableRow>
      </TableFooter>
    </Table>,
  );
  const table = screen.getByRole('table');
  expect(table.className).toContain('text-sm');
  expect(screen.getByText('表说明').tagName).toBe('CAPTION');
  expect(screen.getByText('列A').tagName).toBe('TH');
  expect(screen.getByText('列A').className).toContain('text-muted-foreground');
  expect(screen.getByText('格1').tagName).toBe('TD');
  expect(screen.getByText('格1').className).toContain('font-medium');
  const footer = within(table).getAllByRole('rowgroup').find((s) => s.tagName === 'TFOOT');
  expect(footer).toBeTruthy();
  expect(footer!.className).toContain('bg-muted/50');
  const headRow = screen.getByText('列A').closest('tr')!;
  expect(headRow.className).toContain('hover:bg-transparent');
});

test('Table：className 落到 table 元素（非外层滚动容器）', () => {
  render(
    <Table className="w-1/2">
      <TableBody><TableRow><TableCell>x</TableCell></TableRow></TableBody>
    </Table>,
  );
  const table = screen.getByRole('table');
  expect(table.className).toContain('w-1/2');
  expect(table.parentElement!.className).toContain('overflow-auto');
});
