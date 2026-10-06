// VideoList 页面组件单测：筛选（URL 唯一真相 + 300ms 防抖）、聚合下拉（分区/标签）、
// 多标签多选面板、排序/升降序、次要筛选（时长/播放/日期/档位/仅含字幕）、分页、
// 行渲染分支（格式化函数全分支）、加载/错误/双空态、工具栏导出（列表导出 + 原料包入口）。
// 跑法：npx vitest run src/pages/VideoList.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | 默认加载 + 行渲染（formatView 万/亿/千以下、时长 h 分支、pic http→https、标签+1、旧 tags 回落） | 通过 | |
// | R2 | 错误重试 / 空库（引导采集）/ 筛选空态（重置）/ 行点击带 query 进详情 | 通过 | |
// | R3 | 分页（页码写 URL、边界禁用）；q/sq 防抖 300ms 写 URL | 通过 | 真实 timer + waitFor |
// | R4 | Radix Select 三下拉 + 排序/升降序切换 | 通过 | combobox 无可访问名（Radix 未设 aria-label），按显示文本定位 trigger；jsdom 需 scrollIntoView stub |
// | R5 | 更多筛选：TagMultiSelect 开合/外点关闭/勾选与徽章移除/暂无标签；次要输入（lang/时长/播放/日期/仅含字幕） | 通过 | |
// | R6 | URL 复合筛选 → listVideos 请求参数全量断言（分钟→秒、万→绝对值、日期→ms、非法数字容错）；外部 hash 变化同步输入框；重置 | 通过 | |
// | R7 | douyin（2026-08-29）：平台第四项/URL 透传、档位文案「平台自带」、行降级渲染（黑系图标/外链/话题标） | 通过 | |
// | R8 | 标签单行收纳（2026-10-05 Q3）：默认前 2 + 「+N」展开/收起（行内瞬态不进 URL）；分区列移除（筛选控件保留） | 通过 | |
// | R7 | douyin（2026-08-29）：平台第四项/URL 透传、档位文案「平台自带」、行降级渲染（黑系图标/外链/分区 —） | 通过 | |
// | R8 | 工具栏导出（CLI 全功能 web 化 Phase 2）：导出下拉 URL 组装（带筛选/无分页）+ 成功/失败 toast；原料包按钮开对话框 | 通过 | 下载链 stub（createObjectURL + anchor click） |
// | R9 | 批量打标/摘标勾选（Phase 3）：行勾选列（点击不进详情）、表头全选当前页、操作条显形/打标请求形状、翻页清空勾选 | 通过 | 操作条行为细节在 VideoListBulkBar.test.tsx |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { VideoList } from './VideoList';
import { ToastProvider } from '@/components/ui/toast';

// jsdom 缺失 API stub：Radix Select 开面板需要
window.HTMLElement.prototype.scrollIntoView = () => {};
(window.HTMLElement.prototype as any).hasPointerCapture = () => false;
(window.HTMLElement.prototype as any).releasePointerCapture = () => {};
(window.HTMLElement.prototype as any).setPointerCapture = () => {};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

// ── fetch stub：按 URL 路由，记录调用 ──

interface Call { url: string; init?: RequestInit }

function stubFetch(handler: (url: string, init?: RequestInit) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = await handler(url, init);
    if (r instanceof Response) return r;
    return new Response(JSON.stringify(r ?? { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

const emptyVideos = { total: 0, items: [] };

// 默认路由：tname/tag 聚合 + 视频列表（videos 收到请求 url）
function defaultHandler(videos: (url: string) => unknown = () => emptyVideos) {
  return (url: string) => {
    if (url.includes('groupBy=tname')) return { items: [{ key: '生活', count: 3 }, { key: '', count: 1 }, { key: '(unknown)', count: 2 }] };
    if (url.includes('groupBy=tag')) return { items: [{ key: '游戏', count: 5 }, { key: '', count: 9 }] };
    if (url.includes('/api/videos?')) return videos(url);
    return { items: [] };
  };
}

const twoRows = {
  total: 2,
  items: [
    {
      id: 1, source: 'bilibili', source_vid: 'BV1full', title: 'B站完整字段视频',
      creator_name: 'B站UP', creator_source_uid: '42', duration: 3661,
      published_at: new Date('2026-01-02T03:04:05').getTime(), track_count: 3,
      tid: 1, tname: '生活', tag_details: [
        { name: '标a', source: 'manual' }, { name: '标b', source: 'batch' },
        { name: '标c', source: 'ai' }, { name: '标d', source: 'bili' },
      ],
      view: 12345, pic: 'http://i0.hdslb.com/bfs/a.jpg',
    },
    {
      id: 2, source: 'youtube', source_vid: 'yt999', title: '油管缺字段视频',
      creator_name: null, duration: null, published_at: null, track_count: 0,
      tname: null, tags: ['旧标'], view: 999999999, pic: null,
    },
  ],
};

function qp(calls: Call[]): URLSearchParams {
  const v = calls.filter((c) => c.url.includes('/api/videos?')).at(-1)!.url;
  return new URL(v, 'http://x').searchParams;
}

// Radix SelectTrigger 无 aria-label（name-from-content 对 combobox 角色不生效），
// 按触发器显示文本定位（如 '全部平台' → 对应 combobox button）
function combo(label: string): HTMLElement {
  const el = screen.getByText(label).closest('button');
  if (!el) throw new Error(`combobox not found: ${label}`);
  return el as HTMLElement;
}

// TagMultiSelect 触发按钮：标签 / 标签（N）两种形态
function tagBtn(): HTMLElement {
  const b = screen.getAllByRole('button').find((el) => /^标签(（\d+）)?$/.test((el.textContent ?? '').trim()));
  if (!b) throw new Error('tag panel button not found');
  return b;
}

function setup(handler = defaultHandler(() => twoRows), hash = '#/videos') {
  window.location.hash = hash;
  const calls = stubFetch(handler);
  render(<VideoList />);
  return calls;
}

// ── R1：默认加载与行渲染 ──

test('默认加载：计数、两行渲染、各格式化分支、外链、http 封面归一 https', async () => {
  setup();
  expect(await screen.findByText('B站完整字段视频')).toBeInTheDocument();
  expect(screen.getByText('油管缺字段视频')).toBeInTheDocument();
  expect(
    screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === '共 2 条'),
  ).toBeInTheDocument();

  // view：1.2万 / 10.0亿
  expect(screen.getByText('1.2万')).toBeInTheDocument();
  expect(screen.getByText('10.0亿')).toBeInTheDocument();
  // duration：h 分支 1:01:01；null → —（2026-10-05 分区列移除后 youtube 行空占位剩 3 处）
  expect(screen.getByText('1:01:01')).toBeInTheDocument();
  expect(screen.getAllByText('—')).toHaveLength(3); // creator/duration/published 空占位
  // 封面：http → https；无 pic → 无 img（回落 Film 图标）
  expect(document.querySelector('img[src="https://i0.hdslb.com/bfs/a.jpg"]')).not.toBe(null);
  expect(document.querySelectorAll('img').length).toBe(1);
  // 标签单行收纳（Q3）：4 个标签默认只显前 2 + 「+2」展开钮；旧 tags 回落无色徽章
  expect(screen.getByText('标a')).toBeInTheDocument();
  expect(screen.getByText('标b')).toBeInTheDocument();
  expect(screen.queryByText('标c')).toBe(null);
  expect(screen.getByRole('button', { name: '+2' })).toBeInTheDocument();
  expect(screen.getByText('旧标')).toBeInTheDocument();
  // 外链
  expect(screen.getAllByLabelText('在原站打开视频').length).toBe(2);
  expect(screen.getByLabelText('在原站打开 B站UP 的空间').getAttribute('href')).toBe('https://space.bilibili.com/42');
});

test('formatView/formatDuration 边界：<1万 原样、无 h 时长', async () => {
  setup(defaultHandler(() => ({
    total: 1,
    items: [{ ...twoRows.items[0]!, id: 9, title: '边界行', view: 999, duration: 61, tag_details: [], pic: null, tname: '生活', track_count: 1 }],
  })));
  expect(await screen.findByText('边界行')).toBeInTheDocument();
  expect(screen.getByText('999')).toBeInTheDocument();
  expect(screen.getByText('1:01')).toBeInTheDocument();
});

test('行点击 → 带 query 进详情；分区下拉选项来自 tname 聚合（空/unknown 过滤）', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByText('B站完整字段视频'));
  expect(window.location.hash).toBe('#/videos/bilibili/BV1full');

  // 分区下拉：唯一合法选项 生活 (3)
  fireEvent.click(combo('全部分区'));
  expect(await screen.findByRole('option', { name: /生活/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /unknown/ })).toBe(null);
  expect(qp(calls).get('page')).toBe('1');
});

// ── R8：标签单行收纳 + 分区列移除（2026-10-05 Q3）──

test('标签展开收起：默认前 2 个 + 「+2」钮；点击就地展开全量（不触发行点击进详情），再点收起', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  // 默认收纳：只显 标a/标b，标c/标d 折叠；+2 钮 aria-expanded=false
  expect(screen.getByText('标a')).toBeInTheDocument();
  expect(screen.getByText('标b')).toBeInTheDocument();
  expect(screen.queryByText('标c')).toBe(null);
  expect(screen.queryByText('标d')).toBe(null);
  const expandBtn = screen.getByRole('button', { name: '+2' });
  expect(expandBtn.getAttribute('aria-expanded')).toBe('false');

  // 展开：全量标签就地显示；stopPropagation → hash 不变（行点击进详情未被触发）
  fireEvent.click(expandBtn);
  expect(screen.getByText('标c')).toBeInTheDocument();
  expect(screen.getByText('标d')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
  expect(window.location.hash).toBe('#/videos');

  // 收起：回到前 2 个 + 「+2」
  fireEvent.click(screen.getByRole('button', { name: '收起' }));
  expect(screen.queryByText('标c')).toBe(null);
  expect(screen.getByRole('button', { name: '+2' }).getAttribute('aria-expanded')).toBe('false');
});

test('分区列移除：表体不再渲染 tname；「更多筛选」里的分区下拉保留', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  // 分区列已删：B 站行的 tname「生活」不再出现在表体
  expect(screen.queryByText('生活')).toBe(null);
  // 分区筛选控件仍在「更多筛选」折叠区（功能不受列移除影响）
  fireEvent.click(screen.getByRole('button', { name: /更多筛选/ }));
  expect(screen.getByText('全部分区')).toBeInTheDocument();
});

// ── R2：错误/空态 ──

test('列表 500 → 错误行 + 重试按钮恢复', async () => {
  let fail = true;
  setup(defaultHandler(() => (fail ? new Response(JSON.stringify({ ok: false, error: 'db locked' }), { status: 500 }) : twoRows)));
  expect(await screen.findByText(/加载失败：HTTP 500：db locked/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('B站完整字段视频')).toBeInTheDocument();
});

test('空库（无筛选）→ 引导去采集页', async () => {
  setup(defaultHandler());
  expect(await screen.findByText('视频库还是空的')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /去采集页提交第一个任务/ }));
  expect(window.location.hash).toBe('#/collect');
});

test('筛选下空结果 → 放宽筛选引导 + 重置回干净 URL', async () => {
  setup(defaultHandler(), '#/videos?q=不存在');
  expect(await screen.findByText('没有匹配的视频——试试放宽筛选条件')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /重置筛选/ }));
  expect(window.location.hash).toBe('#/videos');
});

// ── R3：分页 + 防抖 ──

test('分页：40 条 → 2 页；下一页写 page=2 重拉；第 2 页回第 1 页删除 page', async () => {
  const calls = setup(defaultHandler(() => ({ total: 40, items: twoRows.items })));
  await screen.findByText('B站完整字段视频');
  expect(screen.getByText('第 1/2 页')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos?page=2'));
  await waitFor(() => expect(qp(calls).get('page')).toBe('2'));
  // 第 2 页：上一页 → page 删除（回 1，写默认值省略）
  fireEvent.click(screen.getByRole('button', { name: '上一页' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos'));
  await waitFor(() => expect(qp(calls).get('page')).toBe('1'));
});

test('空库下一页禁用', async () => {
  setup(defaultHandler());
  await screen.findByText('视频库还是空的');
  expect(screen.getByRole('button', { name: '下一页' })).toBeDisabled();
});

test('搜索防抖：输入 300ms 后写 q 并重拉；清空删除 q', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  const input = screen.getByPlaceholderText('搜索标题 / 创作者');
  fireEvent.change(input, { target: { value: '关键词' } });
  await waitFor(() => expect(window.location.hash).toContain('q='), { timeout: 1500 });
  await waitFor(() => expect(qp(calls).get('q')).toBe('关键词'));
  expect((input as HTMLInputElement).value).toBe('关键词');

  fireEvent.change(input, { target: { value: '' } });
  await waitFor(() => expect(window.location.hash).toBe('#/videos'), { timeout: 1500 });
});

test('字幕搜索防抖：sq 写入请求参数', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.change(screen.getByPlaceholderText('搜字幕内容'), { target: { value: '字幕词' } });
  await waitFor(() => expect(qp(calls).get('subtitle_q')).toBe('字幕词'), { timeout: 1500 });
});

// ── R4：Select 下拉 + 排序 ──

test('平台下拉：选哔哩哔哩 → source=bilibili 重拉；选全部平台 → 删除', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(combo('全部平台'));
  fireEvent.click(await screen.findByRole('option', { name: '哔哩哔哩' }));
  await waitFor(() => expect(window.location.hash).toContain('source=bilibili'));
  await waitFor(() => expect(qp(calls).get('source')).toBe('bilibili'));

  fireEvent.click(combo('哔哩哔哩'));
  fireEvent.click(await screen.findByRole('option', { name: '全部平台' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos'));
});

// ── douyin（2026-08-29 接入）：平台第四项、URL 白名单透传、档位文案、行降级渲染 ──

test('douyin：平台下拉第四项 + 选中写 source=douyin；URL source=douyin 直入透传请求', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(combo('全部平台'));
  fireEvent.click(await screen.findByRole('option', { name: '抖音' }));
  await waitFor(() => expect(window.location.hash).toContain('source=douyin'));
  await waitFor(() => expect(qp(calls).get('source')).toBe('douyin'));
});

test('douyin：URL source=douyin 直入 → 请求透传（白名单收录）', async () => {
  const calls = setup(defaultHandler(() => emptyVideos), '#/videos?source=douyin');
  await waitFor(() => expect(qp(calls).get('source')).toBe('douyin'));
});

test('档位文案：bili 档显示「平台自带」（抖音话题标签同入此档，不再叫「B站」）', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByRole('button', { name: /更多筛选/ }));
  fireEvent.click(combo('全部档位'));
  expect(await screen.findByRole('option', { name: '平台自带' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'B站' })).toBe(null);
});

test('douyin 行渲染：黑系图标 + 原站/主页外链 + 话题标签', async () => {
  // douyin 无 tid/tname（B 站专属；2026-10-05 起表体不再渲染分区列）；外链走 douyin 域名形态
  const rows = {
    total: 1,
    items: [{
      id: 9, source: 'douyin', source_vid: '7300000000000000001', title: '抖音视频标题',
      creator_name: '抖音博主', creator_source_uid: 'MS4wLjABAAAAsec_uid_x', duration: 61,
      published_at: new Date('2026-02-03T04:05:06').getTime(), track_count: 1,
      tname: null, tag_details: [{ name: '话题标', source: 'bili' }], view: 21000, pic: null,
    }],
  };
  setup(defaultHandler(() => rows));
  expect(await screen.findByText('抖音视频标题')).toBeInTheDocument();
  expect(screen.getByLabelText('在原站打开视频').getAttribute('href')).toBe('https://www.douyin.com/video/7300000000000000001');
  expect(screen.getByLabelText('在原站打开 抖音博主 的空间').getAttribute('href')).toBe('https://www.douyin.com/user/MS4wLjABAAAAsec_uid_x');
  expect(screen.getByText('2.1万')).toBeInTheDocument(); // view 格式化同构（21000）
  expect(screen.getByText('1:01')).toBeInTheDocument(); // 时长同构
  expect(screen.getByText('话题标')).toBeInTheDocument(); // douyin 话题标签入 bili 档渲染
  // 图标类：douyin 黑系（行内 iconColor 与共享 platformIconClass 同源）
  const titleCell = screen.getByText('抖音视频标题').closest('td')!;
  const icon = titleCell.querySelector('svg');
  expect(icon?.getAttribute('class')).toContain('text-black');
  expect(icon?.getAttribute('class')).toContain('dark:text-white');
});

test('分区下拉选择 → tname 参数', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(combo('全部分区'));
  fireEvent.click(await screen.findByRole('option', { name: /生活/ }));
  await waitFor(() => expect(qp(calls).get('tname')).toBe('生活'));
});

test('排序：默认禁用；选播放量后可切升降序（desc=0 ↔ 删除）', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  expect(screen.getByTitle('当前降序，点击切换升序')).toBeDisabled();

  fireEvent.click(combo('默认排序'));
  fireEvent.click(await screen.findByRole('option', { name: '播放量' }));
  await waitFor(() => expect(qp(calls).get('sort')).toBe('view'));
  expect(qp(calls).get('desc')).toBe('true'); // 默认降序

  expect(screen.getByTitle('当前降序，点击切换升序')).toBeEnabled();
  fireEvent.click(screen.getByTitle('当前降序，点击切换升序'));
  await waitFor(() => expect(window.location.hash).toContain('desc=0'));
  // 升序必须显式发送 desc=false（2026-08-29 修复）：省略会被 server 缺省降序吃掉
  await waitFor(() => expect(qp(calls).get('desc')).toBe('false'));

  fireEvent.click(screen.getByTitle('当前升序，点击切换降序'));
  await waitFor(() => expect(window.location.hash).not.toContain('desc=0'));
  await waitFor(() => expect(qp(calls).get('desc')).toBe('true'));
});

// ── R5：更多筛选 ──

test('更多筛选：面板开合（aria-expanded）；TagMultiSelect 勾选 → tags 写 URL + 徽章移除', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  const moreBtn = screen.getByRole('button', { name: /更多筛选/ });
  expect(moreBtn.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(moreBtn);
  expect(moreBtn.getAttribute('aria-expanded')).toBe('true');

  fireEvent.click(tagBtn());
  const opt = await screen.findByRole('option', { name: /游戏/ });
  expect(opt.getAttribute('aria-selected')).toBe('false');
  fireEvent.click(opt);
  await waitFor(() => expect(qp(calls).get('tags')).toBe('游戏'));
  expect(screen.getByText('标签（1）')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '移除标签筛选 游戏' })).toBeInTheDocument();

  // 面板不因勾选关闭：面板内再点同一项 = 取消勾选
  fireEvent.click(screen.getByRole('option', { name: /游戏/ }));
  await waitFor(() => expect(qp(calls).has('tags')).toBe(false));

  // 再勾选 → 用行内徽章 × 移除
  fireEvent.click(screen.getByRole('option', { name: /游戏/ }));
  await waitFor(() => expect(qp(calls).get('tags')).toBe('游戏'));
  fireEvent.click(screen.getByRole('button', { name: '移除标签筛选 游戏' }));
  await waitFor(() => expect(qp(calls).has('tags')).toBe(false));
});

test('TagMultiSelect：面板外 mousedown 关闭；无标签选项 → 暂无标签', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByRole('button', { name: /更多筛选/ }));
  fireEvent.click(tagBtn());
  expect(await screen.findByRole('option', { name: /游戏/ })).toBeInTheDocument();
  fireEvent.mouseDown(document.body);
  await waitFor(() => expect(screen.queryByRole('option', { name: /游戏/ })).toBe(null));

  cleanup();
  vi.unstubAllGlobals();
  setup((url) => {
    if (url.includes('groupBy=tname')) return { items: [] };
    if (url.includes('groupBy=tag')) return { items: [] };
    return twoRows;
  });
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByRole('button', { name: /更多筛选/ }));
  fireEvent.click(tagBtn());
  expect(await screen.findByText('暂无标签')).toBeInTheDocument();
});

test('次要筛选：标签档位/语言/时长/播放/日期列/日期区间/仅含字幕', async () => {
  const calls = setup();
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByRole('button', { name: /更多筛选/ }));

  fireEvent.click(combo('全部档位'));
  fireEvent.click(await screen.findByRole('option', { name: 'AI' }));
  await waitFor(() => expect(qp(calls).get('tag_source')).toBe('ai'));

  fireEvent.change(screen.getByPlaceholderText('语言，如 zh/en'), { target: { value: 'zh' } });
  await waitFor(() => expect(qp(calls).get('lang')).toBe('zh'));

  // 时长（分钟）→ 秒；播放（万）→ 绝对值：第一组 最小/最大 是时长，第二组是播放
  fireEvent.change(screen.getAllByPlaceholderText('最小')[0]!, { target: { value: '5' } });
  await waitFor(() => expect(qp(calls).get('min_duration')).toBe('300'));
  fireEvent.change(screen.getAllByPlaceholderText('最大')[0]!, { target: { value: '10' } });
  await waitFor(() => expect(qp(calls).get('max_duration')).toBe('600'));
  fireEvent.change(screen.getAllByPlaceholderText('最小')[1]!, { target: { value: '2' } });
  await waitFor(() => expect(qp(calls).get('min_view')).toBe('20000'));
  fireEvent.change(screen.getAllByPlaceholderText('最大')[1]!, { target: { value: '3' } });
  await waitFor(() => expect(qp(calls).get('max_view')).toBe('30000'));

  fireEvent.click(combo('首见'));
  fireEvent.click(await screen.findByRole('option', { name: '发布' }));
  await waitFor(() => expect(qp(calls).get('date_field')).toBe('published_at'));

  const dateInputs = document.querySelectorAll('input[type="date"]');
  fireEvent.change(dateInputs[0]!, { target: { value: '2026-01-01' } });
  await waitFor(() => expect(qp(calls).get('since')).toBe(String(new Date('2026-01-01T00:00:00').getTime())));
  fireEvent.change(dateInputs[1]!, { target: { value: '2026-01-31' } });
  await waitFor(() => expect(qp(calls).get('until')).toBe(String(new Date('2026-01-31T23:59:59.999').getTime())));

  expect(screen.getByRole('button', { name: /仅含字幕：关/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /仅含字幕：关/ }));
  await waitFor(() => expect(qp(calls).get('has_subtitle')).toBe('true'));
  expect(screen.getByRole('button', { name: /仅含字幕：开/ })).toBeInTheDocument();
});

// ── R6：URL 复合筛选 → 请求参数全量断言；外部 hash 同步；重置 ──

test('URL 复合筛选 → listVideos 参数映射（分钟→秒、万→绝对值、日期→毫秒、tags 逗号 join）', async () => {
  const calls = stubFetch(defaultHandler(() => twoRows));
  window.location.hash = '#/videos?q=标题词&sq=字幕词&source=youtube&tname=生活&tags=a,b&tag_source=manual&lang=zh&has_subtitle=1&date_field=published_at&since_date=2026-01-01&until_date=2026-01-31&min_dur=5&max_dur=10&min_view=2&max_view=3&sort=duration&desc=0&page=3';
  render(<VideoList />);
  await screen.findByText('B站完整字段视频');
  const p = qp(calls);
  expect(p.get('q')).toBe('标题词');
  expect(p.get('subtitle_q')).toBe('字幕词');
  expect(p.get('source')).toBe('youtube');
  expect(p.get('tname')).toBe('生活');
  expect(p.get('tags')).toBe('a,b');
  expect(p.get('tag_source')).toBe('manual');
  expect(p.get('lang')).toBe('zh');
  expect(p.get('has_subtitle')).toBe('true');
  expect(p.get('date_field')).toBe('published_at');
  expect(p.get('since')).toBe(String(new Date('2026-01-01T00:00:00').getTime()));
  expect(p.get('until')).toBe(String(new Date('2026-01-31T23:59:59.999').getTime()));
  expect(p.get('min_duration')).toBe('300');
  expect(p.get('max_duration')).toBe('600');
  expect(p.get('min_view')).toBe('20000');
  expect(p.get('max_view')).toBe('30000');
  expect(p.get('sort')).toBe('duration');
  expect(p.get('desc')).toBe('false'); // desc=0 → 升序显式发送（省略会被 server 缺省降序吃掉）
  expect(p.get('page')).toBe('3');
  expect(p.get('size')).toBe('20');
});

test('非法数字筛选（min_dur=abc）→ 对应参数省略不炸', async () => {
  const calls = stubFetch(defaultHandler(() => twoRows));
  window.location.hash = '#/videos?min_dur=abc&min_view=xyz';
  render(<VideoList />);
  await screen.findByText('B站完整字段视频');
  const p = qp(calls);
  expect(p.has('min_duration')).toBe(false);
  expect(p.has('min_view')).toBe(false);
});

test('外部 hash 变化（后退/分享跳入）→ 搜索框同步回显', async () => {
  // 带 q 的请求返回空（模拟该词无结果），不带 q 返回两行
  setup(defaultHandler((url) => (url.includes('q=') ? emptyVideos : twoRows)));
  await screen.findByText('B站完整字段视频');
  const input = screen.getByPlaceholderText('搜索标题 / 创作者');
  window.location.hash = '#/videos?q=外部词';
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('外部词'));
  expect(await screen.findByText('没有匹配的视频——试试放宽筛选条件')).toBeInTheDocument();
});

test('重置：激活筛选 + 已输入关键词 → 干净 URL + 输入清空', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  const input = screen.getByPlaceholderText('搜索标题 / 创作者');
  fireEvent.change(input, { target: { value: '临时' } });
  await waitFor(() => expect(window.location.hash).toContain('q='), { timeout: 1500 });
  fireEvent.click(screen.getByRole('button', { name: /^重置$/ }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos'));
  expect((input as HTMLInputElement).value).toBe('');
});

test('加载中：骨架行渲染（aria-busy）；完成后落列表', async () => {
  let resolveVideos!: (r: unknown) => void;
  const calls = stubFetch((url) => {
    if (url.includes('groupBy=tname')) return { items: [] };
    if (url.includes('groupBy=tag')) return { items: [] };
    return new Promise((res) => { resolveVideos = res; });
  });
  window.location.hash = '#/videos';
  render(<VideoList />);
  expect(document.querySelector('[aria-busy="true"]')).not.toBe(null);
  resolveVideos(twoRows);
  expect(await screen.findByText('B站完整字段视频')).toBeInTheDocument();
  await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBe(null));
  expect(calls.length).toBeGreaterThanOrEqual(3);
});

// ── R8：工具栏导出（VideoListExportBar 接线；对话框内部行为在 ExportBundleDialog.test.tsx）──

// 下载链 stub（download.test.ts R3 同款）：jsdom 无 createObjectURL，defineProperty 覆盖 + 锚点 click 拦截
function stubAnchorDownload() {
  Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

// 走真实 VideoList 页面：断言「导出」下拉经当前筛选组出 export 端点 URL（列表与导出共用同一映射）
test('导出下拉：CSV → GET /api/export/videos 携带当前筛选（全量无分页）；下载中禁用；成功 toast 带条数与文件名', async () => {
  const clickSpy = stubAnchorDownload();
  let resolveExport!: (r: unknown) => void;
  const exportCalls: string[] = [];
  stubFetch((url) => {
    if (url.includes('groupBy=tname') || url.includes('groupBy=tag')) return { items: [] };
    if (url.startsWith('/api/export/videos')) {
      exportCalls.push(url);
      return new Promise((res) => { resolveExport = res; });
    }
    return twoRows;
  });
  window.location.hash = '#/videos?source=youtube&min_dur=5';
  render(
    <ToastProvider>
      <VideoList />
    </ToastProvider>,
  );
  await screen.findByText('B站完整字段视频');

  fireEvent.click(screen.getByLabelText('导出视频列表'));
  fireEvent.click(await screen.findByRole('option', { name: 'CSV' }));
  await waitFor(() => expect(exportCalls).toHaveLength(1));
  const p = new URL(exportCalls[0]!, 'http://x').searchParams;
  expect(p.get('format')).toBe('csv');
  expect(p.get('source')).toBe('youtube');
  expect(p.get('min_duration')).toBe('300'); // 筛选映射同列表口径（分钟 → 秒）
  expect(p.has('page')).toBe(false); // 导出是全量拉取：不带分页参数
  expect(p.has('size')).toBe(false);

  // 下载中：触发器禁用 + 占位文案切换
  expect(screen.getByLabelText('导出视频列表')).toBeDisabled();
  expect(screen.getByText('导出中…')).toBeInTheDocument();

  resolveExport(new Response('id,title\n1,x', {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="videos-export.csv"',
      'x-export-count': '137',
    },
  }));
  expect(await screen.findByText(/已导出 137 条（videos-export\.csv）/)).toBeInTheDocument();
  expect(screen.getByLabelText('导出视频列表')).not.toBeDisabled();
  expect((clickSpy.mock.instances[0] as unknown as HTMLAnchorElement).download).toBe('videos-export.csv');
});

test('导出失败：HTTP 400 JSON → 错误 toast 带 server 文案；触发器恢复可用', async () => {
  stubAnchorDownload();
  stubFetch((url) => {
    if (url.includes('groupBy=tname') || url.includes('groupBy=tag')) return { items: [] };
    if (url.startsWith('/api/export/videos')) {
      return new Response(JSON.stringify({ ok: false, error: '非法 format' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return twoRows;
  });
  window.location.hash = '#/videos';
  render(
    <ToastProvider>
      <VideoList />
    </ToastProvider>,
  );
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByLabelText('导出视频列表'));
  fireEvent.click(await screen.findByRole('option', { name: 'NDJSON' }));
  expect(await screen.findByText('导出失败：HTTP 400：非法 format')).toBeInTheDocument();
  expect(screen.getByLabelText('导出视频列表')).not.toBeDisabled();
});

test('原料包按钮：打开 ExportBundleDialog（标题/表单出现），取消关闭', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  expect(screen.queryByText('导出原料包')).toBe(null);
  fireEvent.click(screen.getByRole('button', { name: '原料包' }));
  expect(await screen.findByText('导出原料包')).toBeInTheDocument();
  expect(screen.getByLabelText('打包上限（1–1000）')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(screen.queryByText('导出原料包')).toBe(null));
});

// ── R9：批量打标/摘标勾选（Phase 3，操作条本体在 VideoListBulkBar.test.tsx）──

test('批量勾选：行勾选点击不进详情；表头全选勾满当前页；取消选择清空', async () => {
  setup();
  await screen.findByText('B站完整字段视频');
  expect(window.location.hash).toBe('#/videos');
  // 行勾选：操作条显形，且 hash 不变（点击被单元格截停，不触发整行进详情）
  fireEvent.click(screen.getByLabelText('选择 B站完整字段视频'));
  expect(await screen.findByText(/已选/)).toBeInTheDocument();
  expect(window.location.hash).toBe('#/videos');
  // 表头全选：当前页两条全勾（操作条内已选计数=2；「共 2 条」也是 tabular-nums 数字，须限操作条范围）
  fireEvent.click(screen.getByLabelText('全选当前页'));
  await waitFor(() =>
    expect(within(screen.getByTestId('video-bulk-bar')).getByText('2', { selector: 'span.tabular-nums' })).toBeInTheDocument(),
  );
  expect(screen.getByLabelText('选择 油管缺字段视频')).toBeChecked();
  // 取消选择：操作条隐身，勾选清空
  fireEvent.click(screen.getByRole('button', { name: '取消选择' }));
  await waitFor(() => expect(screen.queryByTestId('video-bulk-bar')).toBe(null));
  expect(screen.getByLabelText('选择 B站完整字段视频')).not.toBeChecked();
});

test('批量打标：列表内勾选 → 操作条打标 → POST /api/tags/apply 形状正确', async () => {
  const calls = setup((url) => {
    if (url.includes('groupBy=')) return { items: [] };
    if (url.includes('/api/videos?')) return twoRows;
    if (url.includes('/api/tags/apply')) return { inserted: 1, missing: 0 };
    return { ok: true };
  });
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByLabelText('选择 油管缺字段视频'));
  fireEvent.change(await screen.findByLabelText('批量打标标签名'), { target: { value: '美联储' } });
  fireEvent.click(screen.getByRole('button', { name: '打标' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已为 1 个视频打标 1 个标签'));
  const c = calls.find((x) => x.url.includes('/api/tags/apply'));
  expect(JSON.parse(String(c!.init?.body))).toEqual({
    items: [{ source: 'youtube', source_vid: 'yt999' }],
    names: ['美联储'],
    scope: 'manual',
  });
  // 成功后清空勾选：行勾选框回未选
  await waitFor(() => expect(screen.getByLabelText('选择 油管缺字段视频')).not.toBeChecked());
});

test('勾选跨页不保留：翻页后勾选清空、操作条隐身', async () => {
  // 21 条 → 2 页（第 1 页也要回 total 21，下一页键才可用）；第 1 页勾选后翻页
  const page2 = { total: 21, items: [{ ...twoRows.items[0], id: 21 }] };
  const page1 = { total: 21, items: twoRows.items };
  setup(defaultHandler((url) => (new URL(url, 'http://x').searchParams.get('page') === '2' ? page2 : page1)));
  await screen.findByText('B站完整字段视频');
  fireEvent.click(screen.getByLabelText('选择 B站完整字段视频'));
  await screen.findByTestId('video-bulk-bar');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  await waitFor(() => expect(window.location.hash).toContain('page=2'));
  // 翻页即清空：操作条隐身；第 2 页行就绪后勾选框为未选
  await waitFor(() => expect(screen.queryByTestId('video-bulk-bar')).toBe(null));
  await screen.findByText('B站完整字段视频');
  expect(screen.getByLabelText('选择 B站完整字段视频')).not.toBeChecked();
});
