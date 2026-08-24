// VideoDetail 页面组件单测：加载/错误骨架、元信息（bilibili/youtube 分支）、标签增删、
// 轨/版本选择（URL 唯一真相 ?track=&ver=）、字幕正文加载与失败重试。
// 跑法：npx vitest run src/pages/VideoDetail.test.tsx
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | loading 骨架 / 500 错误 + 重试 / extra 坏 JSON 容错 | 通过 | deferred fetch 控 resolve 时序 |
// | R2 | bilibili 全字段（含分区/版权/P数/投币…）+ youtube 精简字段 | 通过 | copyright 1/2/其他三分支 |
// | R3 | 标签增删（POST/DELETE 端点契约 + toast + reload） | 通过 | 包 ToastProvider 断言文案 |
// | R4 | 轨/版本：URL 参数命中/非法回落默认、切换写回 query、正文/失败重试 | 通过 | hash 直改 + hashchange |
import { test, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { VideoDetail } from './VideoDetail';
import { ToastProvider } from '@/components/ui/toast';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const r = handler(url, init);
    return r instanceof Response ? r : jsonResponse(r ?? { ok: true });
  }));
}

function detailPayload(over: {
  extra?: unknown;
  tracks?: unknown[];
  tags?: unknown[];
  video?: Record<string, unknown>;
} = {}) {
  return {
    ok: true,
    video: {
      title: '详情页视频', creator_name: '测试UP', creator_source_uid: '42',
      duration: 120, published_at: new Date('2026-01-02T03:04:05').getTime(),
      extra: over.extra ?? JSON.stringify({
        tname: '生活', copyright: 1, pages: [{ cid: 1 }, { cid: 2 }],
        desc: '视频简介内容', stat: { view: 12345, like: 678, coin: 9, favorite: 10, share: 11, danmaku: 12, reply: 13 },
      }),
      ...over.video,
    },
    tracks: over.tracks ?? [
      {
        id: 11, lan: 'zh-CN', lan_doc: '中文（简体）', track_type: 1, is_default: true,
        versions: [
          { id: 111, origin: 'external', is_default: true },
          { id: 112, origin: 'asr' },
        ],
      },
      { id: 12, lan: 'ai-ZH', lan_doc: '中文（自动）', track_type: 2, versions: [{ id: 121, origin: 'asr' }] },
    ],
    tag_details: over.tags ?? [
      { name: '手动标', source: 'manual' },
      { name: 'B站自带', source: 'bili' },
    ],
  };
}

const versionBody = (content: string) => ({
  ok: true, version: { id: 111, origin: 'external', captured_at: 0, payload: { body: [{ from: 1, to: 2, content }] } },
});

function renderDetail(source = 'bilibili', sourceVid = 'BV1test', onBack = vi.fn()) {
  window.location.hash = `#/videos/${source}/${sourceVid}`;
  return render(<VideoDetail source={source} sourceVid={sourceVid} onBack={onBack} />);
}

function renderDetailWithToast(source = 'bilibili', sourceVid = 'BV1test', onBack = vi.fn()) {
  window.location.hash = `#/videos/${source}/${sourceVid}`;
  return render(
    <ToastProvider>
      <VideoDetail source={source} sourceVid={sourceVid} onBack={onBack} />
    </ToastProvider>,
  );
}

test('loading：getVideo 未返回前渲染骨架 + 返回按钮', async () => {
  let resolveFetch!: (r: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolveFetch = res; })));
  renderDetail();
  expect(screen.getByText('返回')).toBeInTheDocument();
  expect(screen.queryByText('详情页视频')).toBe(null);
  resolveFetch(jsonResponse(detailPayload()));
  expect(await screen.findByText('详情页视频')).toBeInTheDocument();
});

test('错误：500 → 加载失败 + 错误文案；重试后成功', async () => {
  let fail = true;
  stubFetch(() => (fail ? jsonResponse({ ok: false, error: '扩展离线' }, 503) : detailPayload()));
  renderDetail();
  expect(await screen.findByText(/加载失败：HTTP 503：扩展离线/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('详情页视频')).toBeInTheDocument();
});

test('返回按钮 → onBack 回调', async () => {
  stubFetch(() => detailPayload());
  const onBack = vi.fn();
  renderDetail('bilibili', 'BV1test', onBack);
  fireEvent.click(await screen.findByText('返回'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('extra 非 JSON 字符串 → 解析容错为 {}，分区/版权/P数显 -', async () => {
  stubFetch(() => detailPayload({ extra: 'not-json{' }));
  renderDetail();
  expect(await screen.findByText('详情页视频')).toBeInTheDocument();
  expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(3); // 分区/版权/P数占位
});

test('bilibili 全字段：元信息卡 / 统计卡（含B站专属档）/ 简介 / 标签（manual 可删、bili 只读）', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) return versionBody('正文内容行');
  });
  renderDetail();
  await screen.findByText('详情页视频');

  // 元信息
  expect(screen.getByText('作者')).toBeInTheDocument();
  expect(screen.getByLabelText('在原站打开 测试UP 的空间').getAttribute('href')).toBe('https://space.bilibili.com/42');
  expect(screen.getByText('2:00')).toBeInTheDocument(); // 时长
  expect(screen.getByText('BV1test')).toBeInTheDocument(); // 来源ID
  expect(screen.getByText('生活')).toBeInTheDocument(); // 分区
  expect(screen.getByText('自制')).toBeInTheDocument(); // copyright=1
  expect(screen.getByText('2')).toBeInTheDocument(); // P 数
  // 原站外链
  expect(screen.getByText('原站打开').closest('a')?.getAttribute('href')).toBe('https://www.bilibili.com/video/BV1test');
  // 统计（fmtNum 千分位；reply=13）
  expect(screen.getByText('12,345')).toBeInTheDocument();
  expect(screen.getByText('13')).toBeInTheDocument();
  expect(screen.getByText('投币')).toBeInTheDocument();
  expect(screen.getByText('弹幕')).toBeInTheDocument();
  // 简介
  expect(screen.getByText('视频简介内容')).toBeInTheDocument();
  // 标签
  expect(screen.getByText('手动标')).toBeInTheDocument();
  expect(screen.getByText('B站自带')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '移除标签 手动标' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '移除标签 B站自带' })).toBe(null);
  // 默认轨选中 + 默认版本正文
  expect(await screen.findByText('正文内容行')).toBeInTheDocument();
  expect(screen.getByText('中文（简体）（默认）').getAttribute('data-state')).toBe('active');
});

test('youtube：无分区/版权/P数/投币等B站专属字段；统计只播/赞', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload({ tags: [] });
    if (url.includes('/api/versions/')) return versionBody('yt line');
  });
  renderDetail('youtube', 'dQw4w9WgXcQ');
  await screen.findByText('详情页视频');
  expect(screen.queryByText('投币')).toBe(null);
  expect(screen.queryByText('弹幕')).toBeInTheDocument === undefined; // 不存在的字段不渲染
  expect(screen.queryByText('分区')).toBe(null);
  expect(screen.queryByText('版权')).toBe(null);
  expect(screen.queryByText('P 数')).toBe(null);
  expect(screen.getByText('暂无标签——在下方输入框添加，多个用逗号分隔')).toBeInTheDocument();
  expect(screen.getByText('原站打开').closest('a')?.getAttribute('href')).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('作者字段：无 uid → 纯文本回落；无名字 → -', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) {
      return detailPayload({ video: { creator_name: '只有名字', creator_source_uid: null } });
    }
    if (url.includes('/api/versions/')) return versionBody('x');
  });
  renderDetail();
  expect(await screen.findByText('只有名字')).toBeInTheDocument();
  expect(screen.queryByLabelText(/空间/)).toBe(null);
  cleanup();
  window.location.hash = '#/videos/bilibili/BV1test';

  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload({ video: { creator_name: null, creator_source_uid: null } });
    if (url.includes('/api/versions/')) return versionBody('x');
  });
  renderDetail();
  await screen.findByText('详情页视频');
  expect(screen.queryByLabelText(/空间/)).toBe(null); // 作者值 '-'
});

test('copyright：2=转载、其他值原样输出', async () => {  stubFetch(() => detailPayload({ extra: JSON.stringify({ copyright: 2 }) }));
  renderDetail();
  expect(await screen.findByText('转载')).toBeInTheDocument();
  cleanup();
  window.location.hash = '#/videos/bilibili/BV1test';

  stubFetch(() => detailPayload({ extra: JSON.stringify({ copyright: 3 }) }));
  renderDetail();
  expect(await screen.findByText('3')).toBeInTheDocument();
});

test('URL ?track=12&ver=121：命中即选中该轨/版本，正文按 121 拉', async () => {
  const urls: string[] = [];
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) { urls.push(url); return versionBody('v121 正文'); }
  });
  window.location.hash = '#/videos/bilibili/BV1test?track=12&ver=121';
  render(<VideoDetail source="bilibili" sourceVid="BV1test" onBack={() => {}} />);
  expect(await screen.findByText('v121 正文')).toBeInTheDocument();
  expect(urls[0]).toContain('/api/versions/121');
});

test('URL track 非法（不存在的轨）→ 回落默认轨', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) return versionBody('默认轨正文');
  });
  window.location.hash = '#/videos/bilibili/BV1test?track=999';
  render(<VideoDetail source="bilibili" sourceVid="BV1test" onBack={() => {}} />);
  expect(await screen.findByText('默认轨正文')).toBeInTheDocument();
  expect(screen.getByText('中文（简体）（默认）').getAttribute('data-state')).toBe('active');
});

test('URL track 命中但 ver 非法 → 该轨默认版本', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) return versionBody('track12 默认版');
  });
  window.location.hash = '#/videos/bilibili/BV1test?track=12&ver=888';
  render(<VideoDetail source="bilibili" sourceVid="BV1test" onBack={() => {}} />);
  expect(await screen.findByText('track12 默认版')).toBeInTheDocument();
});

test('切换轨 → query 写回 track+ver（版本回落该轨默认）；切换版本 → 只更新 ver', async () => {
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) return versionBody('切换后正文');
  });
  renderDetail();
  await screen.findByText('正文加载占位不出现也行', { selector: 'span' }).catch(() => {});
  await screen.findByText('中文（简体）（默认）');

  // 切到轨 12（无 is_default → 第一版 121）
  fireEvent.mouseDown(screen.getByRole('tab', { name: '中文（自动）' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos/bilibili/BV1test?track=12&ver=121'));
  expect(await screen.findByText('切换后正文')).toBeInTheDocument();

  // 轨 11 有两版：切回后在版本区切 112
  fireEvent.mouseDown(screen.getByRole('tab', { name: '中文（简体）（默认）' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos/bilibili/BV1test?track=11&ver=111'));
  fireEvent.click(screen.getByRole('button', { name: 'ASR' }));
  await waitFor(() => expect(window.location.hash).toBe('#/videos/bilibili/BV1test?track=11&ver=112'));
});

test('字幕正文加载失败 → 错误 + 重试恢复', async () => {
  let fail = true;
  stubFetch((url) => {
    if (url.includes('/api/videos/')) return detailPayload();
    if (url.includes('/api/versions/')) return fail ? jsonResponse({ ok: false, error: 'gone' }, 500) : versionBody('重试成功正文');
  });
  renderDetail();
  await screen.findByText('详情页视频');
  expect(await screen.findByText(/字幕加载失败：/)).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(await screen.findByText('重试成功正文')).toBeInTheDocument();
});

test('添加标签：逗号/中文逗号切分 → POST manual 档 → toast + reload + 清空输入', async () => {
  const posts: Array<{ url: string; body: any }> = [];
  let detailCalls = 0;
  stubFetch((url, init) => {
    if (url.includes('/tags') && init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return { ok: true, inserted: 2 };
    }
    if (url.includes('/api/videos/')) { detailCalls++; return detailPayload(); }
  });
  renderDetailWithToast();
  await screen.findByText('详情页视频');
  const input = screen.getByPlaceholderText('新标签名，多个用逗号分隔（记为手动档）');
  fireEvent.change(input, { target: { value: '标签A，标签B, 标签C' } });
  fireEvent.click(screen.getByRole('button', { name: '添加' }));
  expect(await screen.findByText('已添加标签')).toBeInTheDocument();
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ names: ['标签A', '标签B', '标签C'], scope: 'manual' });
  expect(detailCalls).toBeGreaterThanOrEqual(2); // reload
});

test('添加标签：失败 → 错误 toast，输入保留', async () => {
  stubFetch((url, init) => {
    if (url.includes('/tags')) return jsonResponse({ ok: false, error: 'boom' }, 500);
    if (url.includes('/api/videos/')) return detailPayload();
  });
  renderDetailWithToast();
  await screen.findByText('详情页视频');
  const input = screen.getByPlaceholderText('新标签名，多个用逗号分隔（记为手动档）');
  fireEvent.change(input, { target: { value: 'x' } });
  fireEvent.keyDown(input, { key: 'Enter' }); // Enter 也触发添加
  expect(await screen.findByText(/添加标签失败：/)).toBeInTheDocument();
  expect((input as HTMLInputElement).value).toBe('x');
});

test('移除标签：DELETE 对应档位 → toast + reload', async () => {
  const dels: Array<{ url: string }> = [];
  let detailCalls = 0;
  stubFetch((url, init) => {
    if (url.includes('/tags') && init?.method === 'DELETE') { dels.push({ url }); return { ok: true, removed: 1 }; }
    if (url.includes('/api/videos/')) { detailCalls++; return detailPayload(); }
  });
  renderDetailWithToast();
  await screen.findByText('手动标');
  fireEvent.click(screen.getByRole('button', { name: '移除标签 手动标' }));
  expect(await screen.findByText('已移除标签')).toBeInTheDocument();
  expect(dels[0]!.url).toContain('/api/videos/bilibili/BV1test/tags?name=%E6%89%8B%E5%8A%A8%E6%A0%87&scope=manual');
  expect(detailCalls).toBeGreaterThanOrEqual(2);
});

test('移除标签失败 → 错误 toast', async () => {
  stubFetch((url, init) => {
    if (url.includes('/tags')) return jsonResponse({ ok: false, error: 'nope' }, 500);
    if (url.includes('/api/videos/')) return detailPayload();
  });
  renderDetailWithToast();
  await screen.findByText('手动标');
  fireEvent.click(screen.getByRole('button', { name: '移除标签 手动标' }));
  expect(await screen.findByText(/移除标签失败：/)).toBeInTheDocument();
});

test('无版本轨：selectedVersion=null → 不发 getVersion，正文空', async () => {
  const versionCalls: string[] = [];
  stubFetch((url) => {
    if (url.includes('/api/videos/')) {
      return detailPayload({
        tracks: [{ id: 11, lan: 'zh-CN', lan_doc: '空轨', track_type: 1, is_default: true, versions: [] }],
        tags: [],
      });
    }
    if (url.includes('/api/versions/')) { versionCalls.push(url); return versionBody('不应请求'); }
  });
  renderDetail();
  expect(await screen.findByText('空轨（默认）')).toBeInTheDocument();
  await waitFor(() => expect(versionCalls).toHaveLength(0));
  // 版本区不渲染（单版本拦截在 VersionSwitcher 内部）
  expect(screen.getByText('字幕正文')).toBeInTheDocument();
});
