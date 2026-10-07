// DanmakuCard 形态锁定测试（2026-10-07 引入，用户需求「popup 长什么样，测试用例能固定下来吗。
// 方便排查漂移」）——snapshot 进 git 锁 UI 形态，形态漂移（类名/结构/文案）在 qa 门直接红。
//
// 覆盖六形态 snapshot（__snapshots__/DanmakuCard.test.tsx.snap）：
//   S1 折叠态默认整卡（一行头：chevron + 弹幕 + N 条 + 复制；展开内容不存在）
//   S2 展开态（定高滚动容器 max-h-80 overflow-y-auto + 逐条 [MM:SS] 内容）
//   S3 收起后（与 S1 同构：属性序/Radix 动态 id 归一的全树比对断言 + snapshot 双保险）
//   S4 复制成功反馈态（按钮「已复制 N 条」+ secondary 配色，瞬态 2s）
//   S5 未采集 rows=0（灰字「弹幕未采集」，无复制按钮）
//   S6 server 不可达（静默不渲染，空容器）
// 另锁非视觉契约：fetch URL/缓存语义、复制文本与 formatDanmakuCopy 逐字节一致、
// 展开态 aria-expanded、收起再展开零重复 fetch（数据在 hook，开合只控显隐）。
//
// 栈：vitest + jsdom + @testing-library/react（对齐 apps/collector-web 先例）；useDanmaku 走真
// hook（组件+hook 集成，不 mock hook 本身），仅 stub global fetch 与 navigator.clipboard；
// chrome.* 基座与 Radix jsdom 缺口兜底在 test/setup.ui.ts。
// 跑法：cd apps/subtitle-collector && npx vitest run（或 pnpm test:ui）。
//
// 测试轮次记录表（对齐 CLAUDE.md §3 / RULES §5）：
// | 轮次 | 日期       | 范围                                                            | 结果 | 备注                                                          |
// |------|------------|-----------------------------------------------------------------|------|---------------------------------------------------------------|
// | T1   | 2026-10-07 | 六形态 snapshot + fixture 守门 + 展开/收起/复制三态/零重复 fetch/fetch 契约 | 通过 | vitest + jsdom 首次接入本 app；`npx vitest run` 9 用例全绿 + `pnpm qa` 全门绿 |
import { test, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DanmakuCard } from './DanmakuCard';
import { formatDanmakuCopy } from '../../popup-danmaku.mjs';

// ── fixtures：契约形状对齐 server GET /api/danmaku/list（ok/rows/pages/danmakus）──

const BV = 'BV1xx411c7mD';
const HTTP_BASE = 'https://popup.test';

// 5 条覆盖四类形态：正常 00:00 / 边界 59.9s→00:59（floor）/ 整小时 1:00:00（小时不补零）/
// progress 缺失 --:--；外加一条 content null（列表与复制同口径跳过，但 rows 契约计数仍含）。
const FIXTURE_DANMAKUS = [
  { progress_ms: 0, mode: 1, content: '前排', ctime_s: 1760000000 },
  { progress_ms: 59900, mode: 4, content: '名场面打卡', ctime_s: 1760000060 },
  { progress_ms: null, mode: 1, content: null, ctime_s: 1760000120 },
  { progress_ms: 3600000, mode: 5, content: '一小时整的彩蛋', ctime_s: 1760000180 },
  { progress_ms: null, mode: 1, content: '未定位弹幕', ctime_s: 1760000240 },
];

const OK_BODY = {
  ok: true,
  bvid: BV,
  rows: 5,
  pages: [{ cid: 1101, page: 1, rows: 5 }],
  danmakus: FIXTURE_DANMAKUS,
};

// 期望列表条目（formatDanmakuLines 口径：clock + content，null content 跳过）——硬编码锁口径，
// 不直接引用实现函数，实现漂移时 snapshot/断言双红。
const EXPECT_LINES: Array<[string, string]> = [
  ['00:00', '前排'],
  ['00:59', '名场面打卡'],
  ['1:00:00', '一小时整的彩蛋'],
  ['--:--', '未定位弹幕'],
];

// 期望复制文本（formatDanmakuCopy 口径：每条一行 "[MM:SS] 内容"，无尾随换行）
const EXPECT_COPY = '[00:00] 前排\n[00:59] 名场面打卡\n[1:00:00] 一小时整的彩蛋\n[--:--] 未定位弹幕';

// 渲染挂载参数（popup 实际接线：isBili 且非 standalone → enabled=true）
function mount() {
  return render(<DanmakuCard bvid={BV} httpBase={HTTP_BASE} enabled />);
}

// 展开 trigger 的可访问名（getByRole 选项对象）：jsdom 无布局信息，span 文本无空格直拼
//（textContent=「弹幕5 条」），正则容忍空白差异，只锁「弹幕 + N 条」语义形态
//（N 变更时同步此处与「N 条」断言）。
const TRIGGER_NAME = { name: /^弹幕\s*5\s*条$/ };

// stub fetch：按 /api/danmaku/list 契约回 JSON，返回 mock 供调用数/入参断言
function stubFetchOk(body: unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// stub navigator.clipboard（jsdom 无此 API；configurable 保证用例间可覆写）
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
}

// fixture 守门：硬编码期望值必须与纯函数实现逐字节一致——若实现口径变了这里先红，
// 提示同步更新 EXPECT_LINES/EXPECT_COPY 与对应 snapshot（人为确认是「预期内的改版」还是漂移）。
test('fixture 守门:formatDanmakuCopy(同数据) 与硬编码期望逐字节一致', () => {
  expect(formatDanmakuCopy(FIXTURE_DANMAKUS)).toBe(EXPECT_COPY);
});

// ── S1 折叠态默认 ──

test('折叠态默认渲染:「弹幕 5 条 + 复制」头行,snapshot 锁整卡结构,展开内容不存在', async () => {
  const fetchMock = stubFetchOk(OK_BODY);
  const { container } = mount();

  // 数据就绪前不渲染（首拉 loading 静默）
  expect(container.firstChild).toBeNull();

  const copyBtn = await screen.findByRole('button', { name: '复制' });
  expect(screen.getByText('弹幕')).toBeInTheDocument();
  expect(screen.getByText('5 条')).toBeInTheDocument(); // rows 取契约总数（含 null content 条）
  expect(copyBtn).toBeInTheDocument();

  // 折叠态：列表不存在（无滚动容器、无条目内容），trigger aria-expanded=false
  expect(document.querySelector('.max-h-80')).toBeNull();
  expect(screen.queryByText('前排')).toBeNull();
  const trigger = screen.getByRole('button', TRIGGER_NAME);
  expect(trigger).toHaveAttribute('aria-expanded', 'false');

  // fetch 契约：URL + bvid + no-cache（Bearer 不带——token 仅 useServerConfig 写入，本链路恒 null）
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe(`${HTTP_BASE}/api/danmaku/list?bvid=${BV}`);
  expect(init).toMatchObject({ cache: 'no-cache' });

  expect(container.firstChild).toMatchSnapshot('S1 折叠态默认整卡结构');
});

// ── S2 展开态 ──

test('点击 chevron 行展开:aria-expanded=true + 定高滚动容器类名显式锁定 + 逐条 [MM:SS] 内容,snapshot 锁展开态', async () => {
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

  // 逐条 [MM:SS] 内容（formatDanmakuLines 口径：null content 跳过、progress 缺失 --:--、顺序不重排）
  for (const [clock, content] of EXPECT_LINES) {
    expect(screen.getByText(clock)).toBeInTheDocument();
    expect(screen.getByText(content)).toBeInTheDocument();
  }
  expect(screen.queryByText('无文本弹幕')).toBeNull(); // 空态行只在 lines.length===0 出现

  expect(container.firstChild).toMatchSnapshot('S2 展开态（定高滚动列表）');
});

// ── S3 收起 ──

// 结构序列化：tag + 排序后属性 + 子树递归，专供「收起后与折叠态同构」断言。不做两件事的归一：
//   1) 属性插入顺序（React 开合重渲染会重排 hidden/style 的属性序，语义无差）；
//   2) Radix 动态 id（radix-:rN:，挂载序号产物，非形态）。
// innerHTML 逐字节比对在这两点上误报，序列化后比对即真同构。
function structural(el: Element): string {
  const attrs = Array.from(el.attributes)
    .filter((a) => !(a.name === 'id' && a.value.startsWith('radix-')))
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(',');
  const children = Array.from(el.childNodes)
    .map((n) =>
      n.nodeType === Node.TEXT_NODE
        ? n.textContent
        : n.nodeType === Node.ELEMENT_NODE
          ? structural(n as Element)
          : ''
    )
    .join('|');
  return `<${el.tagName} ${attrs}[${children}]>`;
}

test('再点收起:列表消失、aria-expanded=false、结构与折叠态同构,snapshot 锁收起后形态', async () => {
  stubFetchOk(OK_BODY);
  const { container } = mount();
  const user = userEvent.setup();

  const trigger = await screen.findByRole('button', TRIGGER_NAME);
  const collapsedStructure = structural(container.firstElementChild as Element); // 折叠基准结构（展开前）
  await user.click(trigger);
  await screen.findByText('前排'); // 等展开渲染完成
  await user.click(trigger);

  await waitFor(() => expect(screen.queryByText('前排')).toBeNull()); // 列表消失（Presence 退出帧兜等）
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  // 与折叠态同构（属性序/Radix 动态 id 归一后的全树比对，比 snapshot 更强的即时断言）
  expect(structural(container.firstElementChild as Element)).toBe(collapsedStructure);

  expect(container.firstChild).toMatchSnapshot('S3 收起后（与折叠态同构）');
});

// ── S4 复制成功（fake timers 控 2s 复原）──

test('复制成功:writeText 收到与 formatDanmakuCopy 逐字节一致文本 →「已复制 4 条」→ 2s 后复原「复制」', async () => {
  stubFetchOk(OK_BODY);
  const { container } = mount();

  const copyBtn = await screen.findByRole('button', { name: '复制' });
  vi.useFakeTimers(); // findBy 已完成，此后禁止 findBy*/waitFor（其等待依赖真计时器）
  try {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    stubClipboard(writeText);

    fireEvent.click(copyBtn); // 复制按钮在 trigger 外：点复制不触发展开
    await act(async () => {
      // 冲刷 onCopy → copyText → writeText 微任务链（await 数拍满整条链）
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // 逐字节一致：批量复制=全部（含 --:-- 未定位条，null content 条不在内）
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(EXPECT_COPY);
    expect(formatDanmakuCopy(FIXTURE_DANMAKUS)).toBe(writeText.mock.calls[0][0]); // 与同数据纯函数输出一致

    // 反馈态：条数=复制文本行数（danmakuCopyStats 口径）=4
    expect(screen.getByRole('button', { name: '已复制 4 条' })).toBeInTheDocument();
    expect(container.firstChild).toMatchSnapshot('S4 复制成功反馈态（secondary 配色瞬态）');

    // 2s 复原
    await act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// ── 复制失败 ──

test('复制失败:writeText reject →「复制失败」→ 2s 后复原「复制」（copyText 回退 execCommand 亦败）', async () => {
  stubFetchOk(OK_BODY);
  const { container } = mount();

  const copyBtn = await screen.findByRole('button', { name: '复制' });
  vi.useFakeTimers();
  try {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockRejectedValue(new Error('NotAllowedError'));
    stubClipboard(writeText);

    fireEvent.click(copyBtn);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '复制失败' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制失败' }).className).toContain('bg-destructive');

    await act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制失败' })).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// ── S5 未采集 ──

test('未采集(rows=0):灰字「弹幕未采集」snapshot,无复制按钮、无展开行', async () => {
  stubFetchOk({ ok: true, bvid: BV, rows: 0, pages: [], danmakus: [] });
  const { container } = mount();

  await screen.findByText('弹幕未采集');
  expect(screen.queryByRole('button', { name: '复制' })).toBeNull();
  expect(screen.queryByRole('button', TRIGGER_NAME)).toBeNull(); // 无头行（无 Collapsible trigger）

  expect(container.firstChild).toMatchSnapshot('S5 未采集（灰字提示）');
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

// ── 开合零重复 fetch ──

test('展开→收起→再展开:零重复 fetch(数据在 useDanmaku 挂载拉取,开合只控显隐)', async () => {
  const fetchMock = stubFetchOk(OK_BODY);
  mount();
  const user = userEvent.setup();

  const trigger = await screen.findByRole('button', TRIGGER_NAME);
  await user.click(trigger); // 展开
  await screen.findByText('前排');
  await user.click(trigger); // 收起
  await waitFor(() => expect(screen.queryByText('前排')).toBeNull());
  await user.click(trigger); // 再展开
  await screen.findByText('前排');

  expect(fetchMock).toHaveBeenCalledTimes(1); // 三次开合共用首拉数据
  expect(screen.getByText('1:00:00')).toBeInTheDocument(); // 再展开后条目完整
});
