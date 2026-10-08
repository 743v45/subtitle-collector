// CommentsCard 形态锁定测试（2026-10-08，照抄 DanmakuCard.test.tsx 先例——用户需求「popup 长什么样，
// 测试用例能固定下来吗」）——snapshot 进 git 锁 UI 形态，形态漂移（类名/结构/文案）在测试直接红。
//
// 覆盖五形态 snapshot（__snapshots__/CommentsCard.test.tsx.snap）：
//   S1 折叠态默认整卡（一行头：chevron + 评论 + N 条；展开内容不存在；无复制按钮——评论卡未授意复制）
//   S2 展开态（定高滚动容器 max-h-80 overflow-y-auto + 标注全集：[置顶]/(UP主)/[图]/[已折叠]/
//      回复 @X/[仅自己可见] + 楼中楼缩进 pl-4）
//   S5 未采集 total_rows=0（灰字两段式：主行「评论未采集」+ 副行采集命令指引，无头行）
//   S6 server 不可达（静默不渲染，空容器）
//   S7 截断提示（truncated=true：列表尾灰字「仅显示前 200 根评论（共 N 根）」）
// 另锁非视觉契约：fetch URL（bvid + limit=200）/缓存语义、formatCommentContent 标注口径、
// 展开/收起零重复 fetch（数据在 hook，开合只控显隐）。
//
// 栈：vitest + jsdom + @testing-library/react（对齐 DanmakuCard.test.tsx）；useComments 走真
// hook（组件+hook 集成，不 mock hook 本身），仅 stub global fetch；chrome.* 基座与 Radix jsdom
// 缺口兜底在 test/setup.ui.ts。
// 跑法：cd apps/subtitle-collector && npx vitest run（或 pnpm test:ui）。
//
// 测试轮次记录表（对齐 CLAUDE.md §3 / RULES §5）：
// | 轮次 | 日期       | 范围                                                                 | 结果 | 备注                            |
// |------|------------|----------------------------------------------------------------------|------|---------------------------------|
// | T1   | 2026-10-08 | 五形态 snapshot + fixture 守门 + fetch 契约 + 零重复 fetch + server down | 通过 | vitest + jsdom，照抄 DanmakuCard 形态 |
import { test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommentsCard, formatCommentContent } from './CommentsCard';
import { COMMENTS_LIST_LIMIT, type CommentItem } from './hooks-comments';

// ── fixtures：契约形状对齐 server GET /api/comments/list（ok/total_rows/total_roots/truncated/comments）──

const BV = 'BV1xx411c7mD';
const HTTP_BASE = 'https://popup.test';

// 4 条覆盖标注全集（渲染序=server 拍平序：置顶前置 → 根赞降序 → 楼随其根）：
// 置顶根 r9 / UP主根 r1 / 带图+折叠根 r2 / 楼 r2f1（回复 @用户B + 仅自己可见）。
function item(over: Partial<CommentItem>): CommentItem {
  return {
    rpid_str: 'r',
    is_root: 1,
    uname: '用户A',
    like_count: 1,
    ctime_s: 1760000000,
    message: '正文',
    parent_reply_name: null,
    ip_location: null,
    pin_kind: null,
    state: 0,
    folded: 0,
    up_like: 0,
    up_reply: 0,
    is_up: 0,
    has_picture: 0,
    root_rpid: '0',
    parent_rpid: '0',
    dialog_rpid: '0',
    ...over,
  };
}

const FIXTURE_COMMENTS: CommentItem[] = [
  item({ rpid_str: 'r9', uname: '置顶用户', like_count: 1, message: '置顶说明', pin_kind: 'admin' }),
  item({ rpid_str: 'r1', uname: 'UP主本人', like_count: 10, message: '感谢支持', is_up: 1 }),
  item({ rpid_str: 'r2', uname: '用户B', like_count: 5, message: '看图', has_picture: 1, folded: 1 }),
  item({
    rpid_str: 'r2f1', is_root: 0, uname: '用户C', like_count: 2, message: '回复内容',
    parent_reply_name: '用户B', state: 17, root_rpid: 'r2', parent_rpid: 'r2', dialog_rpid: 'r2f1',
  }),
];

const OK_BODY = {
  ok: true,
  bvid: BV,
  total_rows: 4,
  total_roots: 3,
  truncated: false,
  comments: FIXTURE_COMMENTS,
};

// 期望正文段（formatCommentContent 口径硬编码锁口径——实现漂移时 snapshot/断言双红）
const EXPECT_CONTENT: Array<[string, string]> = [
  ['r9', '[置顶]@置顶用户:置顶说明'],
  ['r1', '@UP主本人(UP主):感谢支持'],
  ['r2', '@用户B:看图 [图] [已折叠]'],
  ['r2f1', '@用户C 回复 @用户B:回复内容 [仅自己可见]'],
];

// 渲染挂载参数（popup 实际接线：isBili 且非 standalone → enabled=true）
function mount() {
  return render(<CommentsCard bvid={BV} httpBase={HTTP_BASE} enabled />);
}

// 展开 trigger 的可访问名：jsdom 无布局信息，span 文本无空格直拼（textContent=「评论4 条」），
// 正则容忍空白差异，只锁「评论 + N 条」语义形态。
const TRIGGER_NAME = { name: /^评论\s*4\s*条$/ };

// stub fetch：按 /api/comments/list 契约回 JSON，返回 mock 供调用数/入参断言
function stubFetchOk(body: unknown) {
  const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// fixture 守门：硬编码期望值必须与纯函数实现逐字一致——若标注口径变了这里先红，
// 提示同步更新 EXPECT_CONTENT 与对应 snapshot（人为确认是「预期内的改版」还是漂移）。
test('fixture 守门:formatCommentContent 标注口径(置顶/UP主/[图]/[已折叠]/回复 @/[仅自己可见])逐字一致', () => {
  for (const [rpid, expected] of EXPECT_CONTENT) {
    const c = FIXTURE_COMMENTS.find((x) => x.rpid_str === rpid);
    expect(c).toBeDefined();
    expect(formatCommentContent(c as CommentItem)).toBe(expected);
  }
});

// 边界：uname/message 缺省形态（CLI 口径 (未知用户)/(无正文)）
test('fixture 守门:uname/message 缺省回退 (未知用户)/(无正文)', () => {
  expect(formatCommentContent(item({ uname: null, message: null }))).toBe('@(未知用户):(无正文)');
});

// ── S1 折叠态默认 ──

test('折叠态默认渲染:「评论 4 条」头行,snapshot 锁整卡结构,展开内容不存在、无复制按钮', async () => {
  const fetchMock = stubFetchOk(OK_BODY);
  const { container } = mount();

  // 数据就绪前不渲染（首拉 loading 静默）
  expect(container.firstChild).toBeNull();

  await screen.findByText('评论');
  expect(screen.getByText('4 条')).toBeInTheDocument(); // N=契约 total_rows（库内总数含楼）
  expect(screen.queryByRole('button', { name: '复制' })).toBeNull(); // 评论卡无复制（未授意，对齐弹幕卡差异点）

  // 折叠态：列表不存在（无滚动容器、无条目内容），trigger aria-expanded=false
  expect(document.querySelector('.max-h-80')).toBeNull();
  expect(screen.queryByText('置顶说明')).toBeNull();
  const trigger = screen.getByRole('button', TRIGGER_NAME);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // fetch 契约：URL + bvid + limit=200 + no-cache（Bearer 不带——token 仅 useServerConfig 写入，本链路恒 null）
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${HTTP_BASE}/api/comments/list?bvid=${BV}&limit=${COMMENTS_LIST_LIMIT}`);
  expect(init).toMatchObject({ cache: 'no-cache' });

  expect(container.firstChild).toMatchSnapshot('S1 折叠态默认整卡结构');
});

// ── S2 展开态 ──

test('点击头行展开:aria-expanded=true + 定高滚动容器类名显式锁定 + 标注全集与楼缩进,snapshot 锁展开态', async () => {
  stubFetchOk(OK_BODY);
  const { container } = mount();
  const user = userEvent.setup();

  const trigger = await screen.findByRole('button', TRIGGER_NAME);
  await user.click(trigger);

  expect(trigger).toHaveAttribute('aria-expanded', 'true'); // Radix CollapsibleTrigger 自带

  // 防漂移锚点：定高滚动容器类名逐个显式锁定（max-h-80 定高 + overflow-y-auto 滚动）
  const scroller = container.querySelector('div.max-h-80');
  expect(scroller).not.toBeNull();
  expect(scroller).toHaveClass('max-h-80', 'overflow-y-auto');

  // 行内容：赞数灰列 + 正文段（标注全集逐条在列）
  expect(screen.getByText('【赞 10】')).toBeInTheDocument();
  for (const [, content] of EXPECT_CONTENT) {
    expect(screen.getByText(content)).toBeInTheDocument();
  }
  // 楼中楼缩进：is_root=0 行带 pl-4，根行不带
  const floorRow = screen.getByText('@用户C 回复 @用户B:回复内容 [仅自己可见]').closest('div.flex');
  expect(floorRow).toHaveClass('pl-4');
  const rootRow = screen.getByText('@UP主本人(UP主):感谢支持').closest('div.flex');
  expect(rootRow).not.toHaveClass('pl-4');

  expect(container.firstChild).toMatchSnapshot('S2 展开态（定高滚动列表 + 标注全集 + 楼缩进）');
});

// ── S5 未采集 ──

test('未采集(total_rows=0):主行「评论未采集」+ 副行采集命令(含真实 bvid),无头行,snapshot 锁两段式', async () => {
  stubFetchOk({ ok: true, bvid: BV, total_rows: 0, total_roots: 0, truncated: false, comments: [] });
  const { container } = mount();

  await screen.findByText('评论未采集');
  expect(screen.queryByRole('button', TRIGGER_NAME)).toBeNull(); // 无头行（无 Collapsible trigger）
  expect(screen.queryByRole('button', { name: '复制' })).toBeNull();

  // 副行指引语义断言（不依赖 snapshot）：含命令名与真实 bvid，用户可直接整行复制。
  // 用 querySelector 取 <code>（getByText 会同时命中外层 div 与其内 code，多匹配报错）
  const guide = container.querySelector('code');
  expect(guide).not.toBeNull();
  expect(guide?.textContent).toBe(`collector-cli comments collect --bvid ${BV}`);

  expect(container.firstChild).toMatchSnapshot('S5 未采集（灰字提示 + 采集命令指引）');
});

// ── S6 server 不可达 ──

test('server 不可达(fetch reject):静默不渲染,snapshot 为空容器', async () => {
  const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
  vi.stubGlobal('fetch', fetchMock);
  const { container } = mount();

  // error 态 UI 静默隐藏（对齐 server-down 处置惯例）：整卡消失，不弹错
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(container).toBeEmptyDOMElement());

  expect(container.firstChild).toMatchSnapshot('S6 server 不可达（空容器）');
});

// ── S7 截断提示 ──

test('截断(truncated=true):展开后列表尾灰字「仅显示前 200 根评论(共 N 根)」+ 头行计数为库内总数,snapshot 锁提示形态', async () => {
  stubFetchOk({ ...OK_BODY, total_rows: 520, total_roots: 173, truncated: true });
  const { container } = mount();
  const user = userEvent.setup();

  // 头行计数=库内总数（520 条），非展示条数（4 条）——已采口径
  const trigger = await screen.findByRole('button', { name: /^评论\s*520\s*条$/ });
  await user.click(trigger);

  const hint = await screen.findByText(`仅显示前 ${COMMENTS_LIST_LIMIT} 根评论（共 173 根）`);
  expect(hint).toHaveClass('text-[10px]', 'text-muted-foreground/70');

  expect(container.firstChild).toMatchSnapshot('S7 截断提示（列表尾灰字）');
  expect(container.textContent).not.toContain('173 条'); // 分母只进截断提示，不进头行计数
});

// ── 开合零重复 fetch ──

test('展开→收起→再展开:零重复 fetch(数据在 useComments 挂载拉取,开合只控显隐)', async () => {
  const fetchMock = stubFetchOk(OK_BODY);
  mount();
  const user = userEvent.setup();

  const trigger = await screen.findByRole('button', TRIGGER_NAME);
  await user.click(trigger); // 展开
  await screen.findByText('[置顶]@置顶用户:置顶说明'); // 行正文是单一 span,断言用整段文本
  await user.click(trigger); // 收起
  await waitFor(() => expect(screen.queryByText('[置顶]@置顶用户:置顶说明')).toBeNull());
  await user.click(trigger); // 再展开
  await screen.findByText('[置顶]@置顶用户:置顶说明');

  expect(fetchMock).toHaveBeenCalledTimes(1); // 三次开合共用首拉数据
  expect(screen.getByText('@用户B:看图 [图] [已折叠]')).toBeInTheDocument(); // 再展开后条目完整
});
