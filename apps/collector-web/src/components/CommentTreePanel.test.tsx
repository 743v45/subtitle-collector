// CommentTreePanel 组件单测（P2-5 web 评论展示）：懒展开（收起不发请求）/加载骨架/
// 错误重试/空态/树形结构渲染（根头部/楼层缩进/回复指向/对象已删/状态徽章/孤儿组/
// 截根「加载全部」）。数据形态对齐 server GET /api/videos/:source/:vid/comments。
// 跑法：npx vitest run src/components/CommentTreePanel.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 懒展开 / 骨架 / 错误重试 / 空态 / 全要素树渲染 / 孤儿 / 截根加载全部 | 通过 | 一次性夹具布点全部分支 |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CommentTreePanel, commentDate } from './CommentTreePanel';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** server 端点原样返回（展示子集字段 + 其余列在 JSON 里存在但组件不读） */
function commentsPayload(over: {
  roots?: unknown[];
  orphans?: unknown[];
  counts?: { rows: number; roots: number; floors: number };
  truncated?: boolean;
  limit?: number;
} = {}) {
  return {
    ok: true,
    source: 'bilibili',
    source_vid: 'BV1test',
    counts: over.counts ?? { rows: 6, roots: 2, floors: 4 },
    roots: over.roots ?? [],
    orphans: over.orphans ?? [],
    truncated: over.truncated ?? false,
    limit: over.limit ?? 0,
  };
}

/** 根评论行（缺省=普通无标记根；over 覆盖任意列；floors 走 roots 装配） */
function rootRec(over: Record<string, unknown> = {}) {
  return {
    id: 1, rpid_str: '101', video_id: 1, root_rpid: '0', parent_rpid: '0', dialog_rpid: '0',
    is_root: 1, mid_str: '9', uname: 'UP酱', member: null, message: '根评论正文',
    content: null, like_count: 20, rcount: 5, reply_total: 5, ctime_s: 1797411600,
    ip_location: '广东', state: 0, invisible: 0, folded: 0, up_like: 0, up_reply: 0,
    is_up: 1, pin_kind: null, first_seen_at: 0, last_seen_at: 0,
    first_page: null, first_sort: null, batch_id: null, missing_since: null,
    ...over,
    floors: (over.floors as unknown[] | undefined) ?? [],
  };
}

/** 楼中楼行（缺省=直回根 depth1 无指向；depth/reply_to/parent_missing 为 server 派生列） */
function floorRec(over: Record<string, unknown> = {}) {
  return {
    id: 2, rpid_str: '201', video_id: 1, root_rpid: '101', parent_rpid: '101', dialog_rpid: '101',
    is_root: 0, mid_str: '8', uname: '张三', member: null, message: '楼层正文',
    content: null, like_count: 8, rcount: 0, reply_total: 0, ctime_s: 1797411700,
    ip_location: null, state: 0, invisible: 0, folded: 0, up_like: 0, up_reply: 0,
    is_up: 0, pin_kind: null, first_seen_at: 0, last_seen_at: 0,
    first_page: null, first_sort: null, batch_id: null, missing_since: null,
    depth: 1, reply_to: null, parent_missing: false,
    ...over,
  };
}

function renderPanel() {
  return render(<CommentTreePanel source="bilibili" sourceVid="BV1test" />);
}

/** 收集发往 /comments 的请求 URL（断言懒加载/limit 参数用）；handler 返回 Response 时原样透传（错误态用） */
function stubCommentsFetch(handler: (url: string) => unknown) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    urls.push(url);
    if (url.includes('/comments')) {
      const r = handler(url);
      return r instanceof Response ? r : jsonResponse(r);
    }
    return jsonResponse({ ok: true });
  }));
  return urls;
}

test('commentDate：unix 秒 → YYYY-MM-DD（本地时区，断言形态避免时区漂移）；null/0 → 时间未知', () => {
  expect(commentDate(1797411600)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(commentDate(null)).toBe('时间未知');
  expect(commentDate(0)).toBe('时间未知');
});

test('懒展开：默认收起不发 /comments 请求；点击评论展开 → limit=20 → 头部计数+根组', async () => {
  let resolveFetch!: (r: Response) => void;
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    urls.push(url);
    if (!url.includes('/comments')) return jsonResponse({ ok: true });
    return new Promise<Response>((res) => { resolveFetch = res; });
  }));
  renderPanel();
  // 收起：无请求、按钮 aria-expanded=false、无计数
  expect(screen.getByRole('button', { name: '评论' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(/评论区树/)).toBe(null);
  await waitFor(() => expect(urls.filter((u) => u.includes('/comments'))).toHaveLength(0));

  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(screen.getByRole('button', { name: '评论' })).toHaveAttribute('aria-expanded', 'true');
  // 加载中：骨架占位
  expect(document.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  resolveFetch(jsonResponse(commentsPayload({
    roots: [
      rootRec({
        pin_kind: 'top', up_reply: 1,
        floors: [floorRec({ like_count: 8 }), floorRec({ rpid_str: '202', uname: '李四', message: '楼中楼正文A', reply_to: 'UP酱', like_count: 5 })],
      }),
      rootRec({ rpid_str: '102', uname: '张三', message: null, like_count: 10, ip_location: null, is_up: 0, up_reply: 0 }),
    ],
  })));
  // 头部计数（对齐 CLI tree 头行口径）
  expect(await screen.findByText('评论区树：共 6 条（根 2 / 楼中楼 4）')).toBeInTheDocument();
  // 根 101：置顶徽章 + UP主标记 + IP + UP主已回复徽章
  expect(screen.getByText('【赞 20】@UP酱（UP主）')).toBeInTheDocument();
  expect(screen.getByText('· IP属地:广东')).toBeInTheDocument();
  expect(screen.getByText('置顶:top')).toBeInTheDocument();
  expect(screen.getByText('UP主已回复')).toBeInTheDocument();
  // 楼 201：无指向无标记（普通楼层文本原样）
  expect(screen.getByText('【赞 8】@张三：楼层正文')).toBeInTheDocument();
  // 楼 202：reply_to 指向（「回复 @」前缀）
  expect(screen.getByText('【赞 5】@李四 回复 @UP酱：楼中楼正文A')).toBeInTheDocument();
  // 根 102：无 IP 段、无徽章（普通根）
  expect(screen.getByText('【赞 10】@张三')).toBeInTheDocument();
  expect(screen.queryByText('置顶:top')?.textContent).toBe('置顶:top');
  // 加载完后骨架消失；按钮带计数
  expect(document.querySelectorAll('.animate-pulse')).toHaveLength(0);
  expect(screen.getByRole('button', { name: /共 6 条/ })).toBeInTheDocument();
  // 请求只发一次（limit=20 缺省页大小）
  expect(urls.filter((u) => u.includes('/comments'))).toHaveLength(1);
  expect(urls.find((u) => u.includes('/comments'))).toContain('/api/videos/bilibili/BV1test/comments?limit=20');
});

test('楼层缩进与状态徽章：depth2 → ml-4；state=17/state=5/已折叠/对象已删 逐项呈现', async () => {
  stubCommentsFetch(() => commentsPayload({
    counts: { rows: 5, roots: 1, floors: 4 },
    roots: [rootRec({
      floors: [
        floorRec({ rpid_str: '211', state: 17, ip_location: '上海' }),
        floorRec({ rpid_str: '212', uname: '王五', message: '带状态楼层', state: 5, is_up: 1 }),
        floorRec({ rpid_str: '213', uname: '赵六', message: '深层楼', depth: 2, folded: 1, parent_missing: true }),
        floorRec({ rpid_str: '214', uname: '孙七', message: '三级楼', depth: 3 }),
      ],
    })],
  }));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText('【赞 8】@张三：楼层正文')).toBeInTheDocument();
  // state=17 → 仅自己可见；state=5 → state=5 原样；folded → 已折叠
  expect(screen.getByText('仅自己可见')).toBeInTheDocument();
  expect(screen.getByText('state=5')).toBeInTheDocument();
  expect(screen.getByText('已折叠')).toBeInTheDocument();
  // parent_missing 标注（回复对象已删除）
  expect(screen.getByText(/回复对象已删除/)).toBeInTheDocument();
  // 楼 is_up=1 → UP主标记
  expect(screen.getByText('【赞 8】@王五（UP主）：带状态楼层')).toBeInTheDocument();
  // 缩进：depth1 无缩进类、depth2 ml-4、depth3 ml-8
  expect(screen.getByText('【赞 8】@张三：楼层正文').closest('li')).not.toHaveClass('ml-4');
  expect(screen.getByText('【赞 8】@赵六：深层楼').closest('li')).toHaveClass('ml-4');
  expect(screen.getByText('【赞 8】@孙七：三级楼').closest('li')).toHaveClass('ml-8');
});

test('孤儿组与空字段：根已删楼层独立段；uname/message 缺省回落；无徽章', async () => {
  stubCommentsFetch(() => commentsPayload({
    counts: { rows: 3, roots: 1, floors: 2 },
    roots: [rootRec()],
    orphans: [
      floorRec({ rpid_str: '301', root_rpid: '777', uname: null, message: null, ctime_s: null, ip_location: '北京' }),
    ],
  }));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText('根已删除的楼层（1 条）')).toBeInTheDocument();
  // 空字段回落（uname/message null → 未知用户/无正文；ctime null → 时间未知）
  expect(screen.getByText('【赞 8】@(未知用户)：(无正文)')).toBeInTheDocument();
  expect(screen.getByText('时间未知')).toBeInTheDocument();
  expect(screen.getByText('· IP属地:北京')).toBeInTheDocument();
  // 孤儿段在根组之外（depth 恒 1：li 无缩进类）
  expect(screen.getByText('【赞 8】@(未知用户)：(无正文)').closest('li')).not.toHaveClass('ml-4');
});

test('空评论：counts 全 0 → 该视频暂无评论（无头部树行）', async () => {
  stubCommentsFetch(() => commentsPayload({ counts: { rows: 0, roots: 0, floors: 0 } }));
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText('该视频暂无评论')).toBeInTheDocument();
  expect(screen.queryByText(/评论区树：/)).toBe(null);
});

test('加载失败 → 错误 + 重试恢复', async () => {
  let fail = true;
  stubCommentsFetch(() => {
    if (fail) return jsonResponse({ ok: false, error: 'boom' }, 500);
    return commentsPayload({ roots: [rootRec()] });
  });
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText(/评论加载失败：/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('【赞 20】@UP酱（UP主）')).toBeInTheDocument();
});

test('截根：truncated → 提示 + 加载全部（去掉 limit 参数重取）；不截断无按钮', async () => {
  const urls = stubCommentsFetch((url) => {
    if (url.includes('limit=20')) {
      return commentsPayload({
        counts: { rows: 9, roots: 5, floors: 4 },
        roots: [rootRec()],
        truncated: true,
        limit: 20,
      });
    }
    // 加载全部（无 limit）：返回 5 根全量
    return commentsPayload({
      counts: { rows: 9, roots: 5, floors: 4 },
      roots: [rootRec(), rootRec({ rpid_str: '102', uname: '张三', message: '第二条根', like_count: 10, ip_location: null, is_up: 0 })],
      truncated: false,
      limit: 0,
    });
  });
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: '评论' }));
  expect(await screen.findByText('【赞 20】@UP酱（UP主）')).toBeInTheDocument();
  // 截根提示（对齐 CLI 括注口径）
  expect(screen.getByText('仅显示点赞前 20 根，共 5 根')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '加载全部' }));
  await waitFor(() => expect(urls.filter((u) => u.includes('/comments'))).toHaveLength(2));
  // 第二次请求不带 limit 参数（server 缺省=不限）
  expect(urls.filter((u) => u.includes('/comments'))[1]).not.toContain('limit');
  // 重取完成后按钮消失（truncated=false），全量根可见
  await waitFor(() => expect(screen.queryByRole('button', { name: '加载全部' })).toBe(null));
  expect(await screen.findByText('【赞 10】@张三')).toBeInTheDocument();
});
