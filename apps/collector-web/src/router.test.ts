// parseHash 纯函数测试（node:test + node 内建 TS type-stripping，import 源码不依赖 dist）
// 运行：node --test src/router.test.ts（package.json test 已串入）
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseHash, navigate } from './router.ts';

test('parseHash：空 / # / #/ → 默认采集页', () => {
  for (const h of ['', '#', '#/']) {
    const r = parseHash(h);
    assert.equal(r.tab, 'collect');
    assert.equal(r.videoView, null);
    assert.equal(r.creatorView, null);
  }
});

test('parseHash：#/videos + query → tab videos，query 可读', () => {
  const r = parseHash('#/videos?source=youtube&page=2');
  assert.equal(r.tab, 'videos');
  assert.equal(r.videoView, null);
  assert.equal(r.query.get('source'), 'youtube');
  assert.equal(r.query.get('page'), '2');
  assert.equal(r.path, '/videos');
});

test('parseHash：#/videos/:source/:vid → videoView（tab 仍 videos）', () => {
  const r = parseHash('#/videos/bilibili/BV1ab234567');
  assert.equal(r.tab, 'videos');
  assert.deepEqual(r.videoView, { source: 'bilibili', sourceVid: 'BV1ab234567' });
});

test('parseHash：#/videos/youtube/dQw4w9WgXcQ → videoView YouTube id', () => {
  const r = parseHash('#/videos/youtube/dQw4w9WgXcQ');
  assert.deepEqual(r.videoView, { source: 'youtube', sourceVid: 'dQw4w9WgXcQ' });
});

test('parseHash：#/videos/bilibili（缺 vid）→ 列表态', () => {
  const r = parseHash('#/videos/bilibili');
  assert.equal(r.tab, 'videos');
  assert.equal(r.videoView, null);
});

test('parseHash：#/creators/12 → creatorView', () => {
  const r = parseHash('#/creators/12');
  assert.equal(r.tab, 'creators');
  assert.equal(r.creatorView, 12);
});

test('parseHash：#/creators/abc（非数字 id）→ 列表态', () => {
  const r = parseHash('#/creators/abc');
  assert.equal(r.tab, 'creators');
  assert.equal(r.creatorView, null);
});

test('parseHash：未知路径 → collect（容错不崩）', () => {
  const r = parseHash('#/bogus/deep/path');
  assert.equal(r.tab, 'collect');
});

test('parseHash：全部 tab 直达', () => {
  for (const t of ['stats', 'clients', 'categories', 'tags', 'changes', 'creators', 'collect'] as const) {
    assert.equal(parseHash(`#/${t}`).tab, t, `tab ${t}`);
  }
});

test('parseHash：中文 query 参数解码', () => {
  const r = parseHash('#/videos?tag=%E6%B8%B8%E6%88%8F');
  assert.equal(r.query.get('tag'), '游戏');
});

test('parseHash：videoView 携带 query（详情页扩展位）', () => {
  const r = parseHash('#/videos/bilibili/BV1ab234567?from=collect');
  assert.deepEqual(r.videoView, { source: 'bilibili', sourceVid: 'BV1ab234567' });
  assert.equal(r.query.get('from'), 'collect');
});

// ── navigate：push/replace 写历史 + 手动派发 hashchange ──
// Node 下无 window/HashChangeEvent，用最小 stub（history 两方法 + dispatchEvent 记录）。
// useRoute/useQueryUpdater 是 React hook（需组件渲染环境），不在 node:test 直测范围。

function stubWindow(): { pushed: string[]; replaced: string[]; dispatched: string[]; restore: () => void } {
  const pushed: string[] = [];
  const replaced: string[] = [];
  const dispatched: string[] = [];
  const g = globalThis as any;
  g.window = {
    history: {
      pushState: (_a: unknown, _b: unknown, url: string) => { pushed.push(url); },
      replaceState: (_a: unknown, _b: unknown, url: string) => { replaced.push(url); },
    },
    dispatchEvent: (e: Event) => { dispatched.push(e.type); return true; },
  };
  const prevHC = g.HashChangeEvent;
  g.HashChangeEvent = class HashChangeEvent extends Event {};
  return {
    pushed, replaced, dispatched,
    restore: () => {
      delete g.window;
      if (prevHC === undefined) delete g.HashChangeEvent;
      else g.HashChangeEvent = prevHC;
    },
  };
}

test('navigate：默认 push 写历史（补 # 前缀）+ 派发 hashchange', () => {
  const w = stubWindow();
  try {
    navigate('/videos?tags=游戏');
    assert.deepEqual(w.pushed, ['#/videos?tags=游戏']);
    assert.deepEqual(w.replaced, []);
    assert.deepEqual(w.dispatched, ['hashchange']);
  } finally { w.restore(); }
});

test('navigate：无头斜杠补 /；replace 走 replaceState 不进历史栈', () => {
  const w = stubWindow();
  try {
    navigate('videos');
    assert.deepEqual(w.pushed, ['#/videos']);
    navigate('/stats', { replace: true });
    assert.deepEqual(w.replaced, ['#/stats']);
    assert.equal(w.pushed.length, 1, 'replace 不应 push');
  } finally { w.restore(); }
});
