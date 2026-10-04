import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CommentTree, CommentsSection } from './CommentTree';
import type { CommentNode } from '@/api';

// CommentTree 组件单测：置顶徽标、昵称空回落匿名、正文保留换行、点赞与时间渲染、
// 楼中楼缩进（多级）；CommentsSection 编排：未加载前无数字、点击懒加载、再点收起不重拉、
// 空态（totalRows=0）、失败态 + 重试、失败 console.error 带 bvid。
// 跑法：npx vitest run src/components/CommentTree.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | CommentTree 纯渲染：置顶/匿名/换行/点赞/时间/楼中楼缩进 | 通过 | border-l 缩进容器断言 |
// | R2 | CommentsSection 懒加载编排：懒加载/缓存/收起/空态/失败重试/日志 | 通过 | stubGlobal fetch 路由 /api/comments/tree |
// | R3 | 可空字段回归：ctime_s=null 显「—」（防 1970）、message=null 不渲染正文 | 通过 | server/DB 列可空契约对齐 |

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function node(over: Partial<CommentNode> = {}): CommentNode {
  return {
    rpid_str: 'r1', uname: '用户A', mid_str: '1', message: '正文',
    like_count: 0, ctime_s: 1700000000, pin_kind: null, replies: [],
    ...over,
  };
}

// ── R1：CommentTree 纯渲染 ──

test('CommentTree：置顶评论显示「置顶」徽标，非置顶不显示', () => {
  render(<CommentTree tree={[node({ pin_kind: 'top' }), node({ rpid_str: 'r2' })]} />);
  expect(screen.getByText('置顶')).toBeInTheDocument();
  // 仅一条置顶 → 徽标唯一
  expect(screen.getAllByText('置顶')).toHaveLength(1);
});

test('CommentTree：uname 空/null → 回落「匿名」；有昵称原样渲染', () => {
  render(<CommentTree tree={[node({ uname: null, rpid_str: 'r1' }), node({ uname: '', rpid_str: 'r2' }), node({ uname: '真名', rpid_str: 'r3' })]} />);
  expect(screen.getAllByText('匿名')).toHaveLength(2);
  expect(screen.getByText('真名')).toBeInTheDocument();
});

test('CommentTree：正文保留换行（whitespace-pre-wrap）', () => {
  render(<CommentTree tree={[node({ message: '第一行\n第二行' })]} />);
  const msg = screen.getByText((_, el) => el?.textContent === '第一行\n第二行');
  expect(msg).not.toBe(null);
  expect(msg.className).toContain('whitespace-pre-wrap');
});

test('CommentTree：like_count>0 显示 👍 N；=0 不显示点赞', () => {
  render(<CommentTree tree={[node({ like_count: 42, rpid_str: 'r1' }), node({ like_count: 0, rpid_str: 'r2' })]} />);
  expect(screen.getByText('👍 42')).toBeInTheDocument();
  expect(screen.getAllByText(/👍/)).toHaveLength(1); // like_count=0 的那条无点赞角标
});

test('CommentTree：时间 ctime_s 秒 → toLocaleString("zh-CN")', () => {
  render(<CommentTree tree={[node({ ctime_s: 1700000000 })]} />);
  // 秒 ×1000 转毫秒；本地时区格式化后断言含「年」分隔形态即可锁住不是裸秒数
  const expected = new Date(1700000000 * 1000).toLocaleString('zh-CN');
  expect(screen.getByText(expected)).toBeInTheDocument();
});

test('CommentTree：ctime_s=null 显「—」占位（防 new Date(null) 渲染 1970-01-01）', () => {
  render(<CommentTree tree={[node({ ctime_s: null })]} />);
  expect(screen.getByText('—')).toBeInTheDocument();
  // 1970 形态绝不允许出现（null 曾被乘 1000 当 0 处理）
  expect(screen.queryByText(new Date(0).toLocaleString('zh-CN'))).toBe(null);
});

test('CommentTree：message=null 不渲染正文容器；message 非空照常渲染', () => {
  render(<CommentTree tree={[node({ message: null, rpid_str: 'r1' }), node({ message: '有正文', rpid_str: 'r2' })]} />);
  expect(screen.getByText('有正文')).toBeInTheDocument();
  // null 正文：无残留空 div（正文容器整体摘掉）
  const bodies = document.querySelectorAll('.whitespace-pre-wrap');
  expect(bodies).toHaveLength(1);
});

test('CommentTree：楼中楼 replies 缩进渲染（border-l 容器 + 递归内容）；叶子空数组不渲染缩进容器', () => {
  const tree = [
    node({
      rpid_str: 'root1', message: '主楼',
      replies: [node({ rpid_str: 'sub1', message: '楼中楼A' }), node({ rpid_str: 'sub2', message: '楼中楼B' })],
    }),
  ];
  const { container } = render(<CommentTree tree={tree} />);
  expect(screen.getByText('主楼')).toBeInTheDocument();
  expect(screen.getByText('楼中楼A')).toBeInTheDocument();
  expect(screen.getByText('楼中楼B')).toBeInTheDocument();
  // 缩进实现：border-l-2 容器包裹楼中楼
  expect(container.querySelector('.border-l-2')).not.toBe(null);
  // 二级楼中楼（replies 里的 replies）也递归渲染
  cleanup();
  const deep = [node({ rpid_str: 'd1', replies: [node({ rpid_str: 'd2', replies: [node({ rpid_str: 'd3', message: '二级楼中楼' })] })] })];
  render(<CommentTree tree={deep} />);
  expect(screen.getByText('二级楼中楼')).toBeInTheDocument();
  // 叶子空数组：不残留空缩进容器
  cleanup();
  const leaf = render(<CommentTree tree={[node({ replies: [] })]} />);
  expect(leaf.container.querySelector('.border-l-2')).toBe(null);
});

// ── R2：CommentsSection 懒加载编排 ──

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const treePayload = {
  ok: true, bvid: 'BV1xx', total_rows: 3, total_roots: 2,
  tree: [node({ message: '顶层评论' }), node({ rpid_str: 'r2', replies: [node({ rpid_str: 'r3', message: '回复' })] })],
};

function stubFetch(handler: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    const r = handler(url);
    return r instanceof Response ? r : jsonResponse(r ?? { ok: true });
  });
  vi.stubGlobal('fetch', fetchMock); // 注意 vi.stubGlobal 返回值不是 vi.fn 本体，必须单独持有
  return fetchMock;
}

test('CommentsSection：未加载前徽标只显示「评论」无数字；点击懒加载 GET /api/comments/tree?bvid= 并展开树', async () => {
  const fetchMock = stubFetch((url) => (url.includes('/api/comments/tree') ? treePayload : {}));
  render(<CommentsSection sourceVid="BV1xx" />);
  const btn = screen.getByRole('button', { name: '评论' });
  expect(btn).toBeInTheDocument();
  expect(btn.textContent).not.toContain('3'); // 未加载不显示 totalRows
  expect(screen.queryByText('顶层评论')).toBe(null); // 未展开不请求不渲染

  fireEvent.click(btn);
  await screen.findByText('顶层评论');
  expect(fetchMock.mock.calls[0]![0]).toBe('/api/comments/tree?bvid=BV1xx');
  expect(screen.getByText('回复')).toBeInTheDocument();
  // 加载完成后徽标带数字「评论 3」
  expect(screen.getByRole('button', { name: '评论 3' })).toBeInTheDocument();
});

test('CommentsSection：加载中显示骨架（aria-busy）；收起再展开走缓存不重拉', async () => {
  let resolveFetch!: (r: Response) => void;
  const fetchMock = vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; }));
  vi.stubGlobal('fetch', fetchMock);
  render(<CommentsSection sourceVid="BV1xx" />);
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(document.querySelector('[aria-busy="true"]')).not.toBe(null); // 骨架/加载态
  resolveFetch(jsonResponse(treePayload));
  await screen.findByText('顶层评论');
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // 收起 → 树从 DOM 摘掉但 data 保留
  fireEvent.click(screen.getByRole('button', { name: '评论 3' }));
  expect(screen.queryByText('顶层评论')).toBe(null);
  // 再展开 → 不再发请求，直接渲染缓存
  fireEvent.click(screen.getByRole('button', { name: '评论 3' }));
  expect(screen.getByText('顶层评论')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('CommentsSection：totalRows=0 → 「库内暂无评论（未采集）」空态', async () => {
  stubFetch((url) => (url.includes('/api/comments/tree') ? { ok: true, total_rows: 0, total_roots: 0, tree: [] } : {}));
  render(<CommentsSection sourceVid="BV1empty" />);
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText('库内暂无评论（未采集）')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '评论 0' })).toBeInTheDocument();
});

test('CommentsSection：请求失败 → 错误条 + 重试按钮；重试成功恢复树', async () => {
  let fail = true;
  const fetchMock = stubFetch((url) =>
    url.includes('/api/comments/tree')
      ? (fail ? jsonResponse({ ok: false, error: '扩展离线' }, 503) : treePayload)
      : {},
  );
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<CommentsSection sourceVid="BV1xx" />);
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText(/评论加载失败：HTTP 503：扩展离线/)).toBeInTheDocument();
  // 日志规则：失败 console.error 带 bvid 与错误
  expect(errSpy).toHaveBeenCalledWith('[CommentsSection] 评论树加载失败', { bvid: 'BV1xx', error: 'HTTP 503：扩展离线' });

  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('顶层评论')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('CommentsSection：网络层抛错（fetch reject）→ 错误条 + 日志带 TypeError 文案', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<CommentsSection sourceVid="BV1net" />);
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText(/评论加载失败：Failed to fetch/)).toBeInTheDocument();
  expect(errSpy).toHaveBeenCalledWith('[CommentsSection] 评论树加载失败', { bvid: 'BV1net', error: 'Failed to fetch' });
});

test('CommentsSection：错误态不自动重试（收起再展开不重拉，停在错误等手动重试）', async () => {
  const fetchMock = stubFetch((url) =>
    url.includes('/api/comments/tree') ? jsonResponse({ ok: false, error: 'x' }, 500) : {},
  );
  vi.spyOn(console, 'error').mockImplementation(() => {}); // 静音错误日志（断言在上一用例已覆盖）
  render(<CommentsSection sourceVid="BV1xx" />);
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText(/评论加载失败/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  // 收起再展开：error 非空 → effect 不自动发第二次，仍显示错误
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/评论加载失败/)).toBeInTheDocument();
});
