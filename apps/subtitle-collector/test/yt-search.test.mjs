// yt-search.mjs 测试：YouTube 关键词搜索的解析纯函数与编排（CLI collect yt-search 的扩展侧）。
// 数据源与 yt-channel.mjs 同族：搜索结果页 SSR HTML（ytInitialData）+ InnerTube search 续页响应。
// 2026-08-24 无 cookie 实测：搜索页主结构为 videoRenderer（20/20 命中），lockupViewModel（频道页
// 结构）兼容收集。全函数无网络，runYtSearch/runYtSearchAction 依赖注入 mock。
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | searchResultsUrl / parseVideoRenderer / parseYtSearchResponse / parseYtSearchHtml / runYtSearch | 通过 | LOCKUP 样本对齐 yt-channel.test.mjs |
// | R2 | runYtSearchAction（tab 惰性/收尾关/复用不关/参数校验） | 通过 | io 注入 mock |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchResultsUrl,
  parseVideoRenderer,
  parseYtSearchResponse,
  parseYtSearchHtml,
  runYtSearch,
  runYtSearchAction,
  YT_SEARCH_ORDER_SP,
} from '../yt-search.mjs';

// lockupViewModel 样本（对齐 yt-channel.test.mjs 的 LOCKUP，同一结构）
const LOCKUP = {
  contentId: 'gaDdrDdczO4',
  contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
  metadata: {
    lockupMetadataViewModel: {
      title: { content: 'New Skills! v1.2' },
      metadata: {
        contentMetadataViewModel: {
          metadataRows: [
            { metadataParts: [{ text: { content: '127K views' } }, { text: { content: '2 weeks ago' } }] },
          ],
        },
      },
    },
  },
  contentImage: {
    thumbnailViewModel: {
      overlays: [
        {
          thumbnailBottomOverlayViewModel: {
            badges: [{ thumbnailBadgeViewModel: { text: '11:38', badgeStyle: 'THUMBNAIL_OVERLAY_BADGE_STYLE_DEFAULT' } }],
          },
        },
      ],
    },
  },
};

// videoRenderer 样本（搜索页旧主结构，字段路径与 lockup 不同：runs/simpleText）
const RENDERER = {
  videoId: 'dQw4w9WgXcQ',
  title: { runs: [{ text: 'Rick Astley - ' }, { text: 'Together Forever' }] },
  viewCountText: { simpleText: '1,234,567 views' },
  publishedTimeText: { simpleText: '3 days ago' },
  lengthText: { simpleText: '3:24' },
};

// —— searchResultsUrl：排序参数 sp ——
test('searchResultsUrl：relevance 不带 sp；newest/views 带 sp（编码）', () => {
  assert.equal(searchResultsUrl('ts tutorial'), 'https://www.youtube.com/results?search_query=ts%20tutorial');
  assert.equal(searchResultsUrl('ts tutorial', 'newest'),
    'https://www.youtube.com/results?search_query=ts%20tutorial&sp=CAI%3D');
  assert.equal(searchResultsUrl('ts', 'views'), 'https://www.youtube.com/results?search_query=ts&sp=CAM%3D');
});

test('searchResultsUrl：关键词特殊字符全编码；未知 order 按无 sp（宽容）', () => {
  // & = 等保留字符必须编码，否则会拼进 query 结构
  assert.equal(searchResultsUrl('a&b=c'), 'https://www.youtube.com/results?search_query=a%26b%3Dc');
  assert.equal(searchResultsUrl('ts', 'whatever'), 'https://www.youtube.com/results?search_query=ts');
  assert.equal(searchResultsUrl('ts', 'whatever'), searchResultsUrl('ts', 'relevance'));
});

test('YT_SEARCH_ORDER_SP：三种排序常量（relevance 为 null）', () => {
  assert.deepEqual(YT_SEARCH_ORDER_SP, { relevance: null, newest: 'CAI=', views: 'CAM=' });
});

// —— parseVideoRenderer：旧结构兜底解析 ——
test('parseVideoRenderer：runs 标题/播放数/相对时间/时长全解析', () => {
  const it = parseVideoRenderer(RENDERER);
  assert.equal(it.vid, 'dQw4w9WgXcQ');
  // runs 多段拼接（YouTube 标题高亮分段）
  assert.equal(it.title, 'Rick Astley - Together Forever');
  assert.equal(it.play, 1234567);
  assert.equal(it.agoText, '3 days ago');
  assert.ok(Number.isInteger(it.created) && it.created > 0);
  assert.equal(it.length, '3:24');
  assert.equal(it.pic, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg');
});

test('parseVideoRenderer：字段缺失宽容降级（null 不炸）', () => {
  const it = parseVideoRenderer({ videoId: 'dQw4w9WgXcQ' });
  assert.equal(it.vid, 'dQw4w9WgXcQ');
  assert.equal(it.title, null);
  assert.equal(it.created, null);
  assert.equal(it.agoText, null);
  assert.equal(it.play, null);
  assert.equal(it.length, null);
  // 时长非 M:SS 形态（如直播 "LIVE"）→ null
  assert.equal(parseVideoRenderer({ videoId: 'dQw4w9WgXcQ', lengthText: { simpleText: 'LIVE' } }).length, null);
});

test('parseVideoRenderer：非法 videoId（缺/非 11 位）→ null', () => {
  assert.equal(parseVideoRenderer(null), null);
  assert.equal(parseVideoRenderer({}), null);
  assert.equal(parseVideoRenderer({ videoId: 'short' }), null);
});

// —— parseYtSearchResponse：InnerTube 响应 / ytInitialData 通用递归收集 ——
test('parseYtSearchResponse：lockup 与 videoRenderer 双收集 + 命中计数', () => {
  const json = { contents: { itemSectionRenderer: { contents: [
    { lockupViewModel: LOCKUP }, { videoRenderer: RENDERER }, { channelRenderer: { channelId: 'UCx' } },
  ] } } };
  const out = parseYtSearchResponse(json);
  // channelRenderer（频道结果条目）不是视频，双解析天然过滤
  assert.equal(out.items.length, 2);
  assert.equal(out.hitLockups, 1);
  assert.equal(out.hitRenderers, 1);
  assert.equal(out.items[0].vid, 'gaDdrDdczO4');
  assert.equal(out.items[1].vid, 'dQw4w9WgXcQ');
});

test('parseYtSearchResponse：vid 去重（同 vid 双结构混杂不重复）', () => {
  const json = { a: { lockupViewModel: LOCKUP }, b: { videoRenderer: { videoId: 'gaDdrDdczO4', title: { runs: [{ text: 'dup' }] } } } };
  const out = parseYtSearchResponse(json);
  assert.equal(out.items.length, 1);
});

test('parseYtSearchResponse：continuation token 提取；空响应全空', () => {
  const json = { continuation: { itemSectionRenderer: { continuationItem: { continuationItemRenderer: {
    continuationEndpoint: { continuationCommand: { token: 'tok-1' } } } } } } };
  assert.equal(parseYtSearchResponse(json).continuation, 'tok-1');
  const empty = parseYtSearchResponse({});
  assert.equal(empty.items.length, 0);
  assert.equal(empty.continuation, null);
  assert.equal(empty.hitLockups, 0);
  assert.equal(empty.hitRenderers, 0);
});

// —— parseYtSearchHtml：搜索结果页 SSR HTML 全量解析 ——
test('parseYtSearchHtml：estimatedResults/InnerTube 凭据/条目/续页 token', () => {
  const inner = JSON.stringify({
    estimatedResults: '12345',
    contents: { itemSectionRenderer: { contents: [{ lockupViewModel: LOCKUP }] } },
    continuation: { continuationCommand: { token: 'next-tok' } },
  });
  const html = `<html><script>var ytInitialData = ${inner};</script>` +
    `<script>yt.setConfig({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260824.01.00"});</script></html>`;
  const out = parseYtSearchHtml(html);
  assert.equal(out.found, true);
  assert.equal(out.estimatedResults, 12345);
  assert.equal(out.inntertubeKey, 'AIzaSyTEST');
  assert.equal(out.clientVersion, '2.20260824.01.00');
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].vid, 'gaDdrDdczO4');
  assert.equal(out.continuation, 'next-tok');
  assert.equal(out.hitLockups, 1);
});

test('parseYtSearchHtml：无 ytInitialData（反爬/consent 页）→ found:false；坏 JSON 同', () => {
  assert.equal(parseYtSearchHtml('<html>consent page</html>').found, false);
  assert.equal(parseYtSearchHtml('<script>var ytInitialData = {bad json};</script>').found, false);
  assert.equal(parseYtSearchHtml(null).found, false);
  assert.equal(parseYtSearchHtml('').found, false);
});

// —— runYtSearch：编排（依赖注入，无网络） ——
const okHtml = (items, est = '10', token = null) => `<html><script>var ytInitialData = ${JSON.stringify({
  estimatedResults: est,
  contents: { itemSectionRenderer: { contents: items } },
  ...(token ? { continuation: { continuationCommand: { token } } } : {}),
})};</script><script>yt.setConfig({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260824.01.00"});</script></html>`;

test('runYtSearch：单页（pages=1）不触发续页与 tab 依赖', async () => {
  let contCalled = 0;
  const out = await runYtSearch(
    { fetchHtml: async () => ({ status: 200, text: okHtml([{ lockupViewModel: LOCKUP }]) }),
      searchContinuation: async () => { contCalled++; return { status: 200, json: {} }; },
      sleep: async () => {} },
    { keyword: 'ts tutorial', order: 'newest', pages: 1, gapMs: 0 },
  );
  assert.equal(out.items.length, 1);
  assert.equal(out.raw_total, 10);
  assert.equal(out.pages_fetched, 1);
  assert.equal(out.order, 'newest');
  assert.equal(contCalled, 0); // 单页无需 InnerTube 续页（也就无需 youtube tab）
  // 诊断计数透传（§9 可观察性：解析命中可见）
  assert.equal(out.diag.hit_lockups, 1);
});

test('runYtSearch：多页续页合并去重 + 页间节流 + estimatedResults 缺省 null', async () => {
  const sleeps = [];
  let call = 0;
  const contItems = [
    { videoRenderer: RENDERER },
    { lockupViewModel: LOCKUP }, // 与首页同 vid → 去重
  ];
  const out = await runYtSearch(
    { fetchHtml: async () => ({ status: 200, text: okHtml([{ lockupViewModel: LOCKUP }], 'not-a-number', 'cont-1') }),
      // 续页只回一次 continuation（真实嵌套形状：continuationCommand），第二次无 token → 自然终止
      searchContinuation: async () => {
        call++;
        return { status: 200, json: call === 1
          ? { onResponseReceivedCommands: [{ appendContinuationItemsAction: {
              continuationItems: contItems,
              continuation: { continuationCommand: { token: 'tok-2' } } } }] }
          : { onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [] } }] } };
      },
      sleep: async (ms) => { sleeps.push(ms); } },
    { keyword: 'ts', pages: 5, gapMs: 7 },
  );
  assert.equal(call, 2);
  assert.equal(out.pages_fetched, 3);
  assert.equal(out.items.length, 2); // LOCKUP + RENDERER（dup 去重）
  assert.deepEqual(sleeps, [7]); // 续页间节流（最后一页无后续不 sleep）
  assert.equal(out.raw_total, null); // estimatedResults 非数字 → null（宽容）
});

test('runYtSearch：结果页 HTTP 非 200 → 抛错带状态与 html_len 诊断', async () => {
  await assert.rejects(
    runYtSearch(
      { fetchHtml: async () => ({ status: 302, text: '' }),
        searchContinuation: async () => ({ status: 0, json: null }),
        sleep: async () => {} },
      { keyword: 'ts', pages: 1 },
    ),
    /results page HTTP 302/,
  );
});

test('runYtSearch：fetchHtml 无响应（undefined）→ 抛错带 none/0 诊断', async () => {
  // 网络层异常时 background 的 fetchHtml 可能直接抛（上抛）或返回 undefined（防御分支）
  await assert.rejects(
    runYtSearch(
      { fetchHtml: async () => undefined,
        searchContinuation: async () => ({ status: 0, json: null }),
        sleep: async () => {} },
      { keyword: 'ts', pages: 1 },
    ),
    /results page HTTP none.*html_len=0/,
  );
});

test('runYtSearch：ytInitialData 缺失（反爬特征）→ 抛错带 html_len', async () => {
  const longBody = '<html>' + 'x'.repeat(5000) + '</html>';
  await assert.rejects(
    runYtSearch(
      { fetchHtml: async () => ({ status: 200, text: longBody }),
        searchContinuation: async () => ({ status: 0, json: null }),
        sleep: async () => {} },
      { keyword: 'ts', pages: 1 },
    ),
    new RegExp(`无 ytInitialData.*html_len=${longBody.length}`),
  );
});

test('runYtSearch：续页 HTTP 失败 → 抛错带页号；0 命中正常返回不抛', async () => {
  // 首页带 continuation token → 触发续页；续页 403（InnerTube 拒绝）→ 抛错带页号
  const homeWithToken = `<html><script>var ytInitialData = ${JSON.stringify({
    estimatedResults: '5',
    contents: { itemSectionRenderer: { contents: [{ lockupViewModel: LOCKUP }] } },
    continuation: { continuationCommand: { token: 't1' } },
  })};</script><script>yt.setConfig({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260824.01.00"});</script></html>`;
  await assert.rejects(
    runYtSearch(
      { fetchHtml: async () => ({ status: 200, text: homeWithToken }),
        searchContinuation: async () => ({ status: 403, json: null }),
        sleep: async () => {} },
      { keyword: 'ts', pages: 2 },
    ),
    /search continuation HTTP 403.*page=2/,
  );
  // 搜索词无结果（0 命中）是正常态：返回空 items + 诊断计数，不抛错
  const empty = await runYtSearch(
    { fetchHtml: async () => ({ status: 200, text: okHtml([]) }),
      searchContinuation: async () => ({ status: 0, json: null }),
      sleep: async () => {} },
    { keyword: 'zxqwv nowhere', pages: 1 },
  );
  assert.equal(empty.items.length, 0);
  assert.equal(empty.raw_total, 10);
});

test('runYtSearch：宽容分支——pages 非法按 1 / 续页无响应抛 parse / sleep 缺省用真 setTimeout', async () => {
  const deps = {
    fetchHtml: async () => ({ status: 200, text: okHtml([{ videoRenderer: RENDERER }], '7', 't1') }),
    // 返回 undefined（无 status）→ "HTTP parse" 分支
    searchContinuation: async () => undefined,
  };
  // pages 传 NaN：Number.isFinite 守卫按 1 → 单页，不触发续页
  const single = await runYtSearch(deps, { keyword: 'ts', pages: Number.NaN, gapMs: 0 });
  assert.equal(single.pages_fetched, 1);
  // pages=2 触发续页 → 续页无响应抛错；deps 不注入 sleep（默认 setTimeout 路径，gapMs=0 实际零等待）
  await assert.rejects(
    runYtSearch(deps, { keyword: 'ts', pages: 2, gapMs: 0 }),
    /search continuation HTTP parse.*page=2/,
  );
});

test('parseVideoRenderer：runs 段内 text 缺失宽容（空串占位）', () => {
  // 某段 run 无 text（删除线等富文本形态）→ 空串参与拼接，不炸不丢段
  const it = parseVideoRenderer({ videoId: 'dQw4w9WgXcQ', title: { runs: [{ text: 'A ' }, {}, { text: 'B' }] } });
  assert.equal(it.title, 'A B');
  // title.runs 非数组（直接 content 形态等）→ null
  assert.equal(parseVideoRenderer({ videoId: 'dQw4w9WgXcQ', title: { content: 'x' } }).title, null);
});

test('runYtSearch：首页无 InnerTube 凭据 → fallback 常量兜底续页', async () => {
  // SSR 页缺 INNERTUBE_API_KEY/CLIENT_VERSION（结构变化或精简页）→ 公开默认常量兜底
  const bareHtml = `<html><script>var ytInitialData = ${JSON.stringify({
    estimatedResults: '3',
    contents: { itemSectionRenderer: { contents: [{ lockupViewModel: LOCKUP }] } },
    continuation: { continuationCommand: { token: 't1' } },
  })};</script></html>`;
  let usedKey = null;
  const out = await runYtSearch(
    { fetchHtml: async () => ({ status: 200, text: bareHtml }),
      searchContinuation: async (key, _ver, _tok) => {
        usedKey = key;
        return { status: 200, json: { append: { continuationItems: [] } } };
      },
      sleep: async () => {} },
    { keyword: 'ts', pages: 2, gapMs: 0 },
  );
  assert.equal(usedKey, 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'); // YT_INNERTUBE_KEY_FALLBACK
  assert.equal(out.pages_fetched, 2);
});

test('runYtSearch：pages 超 10 截断；sleep 缺省走真 setTimeout（gapMs 微秒级）', async () => {
  let call = 0;
  const deps = { // 不注入 sleep：默认 setTimeout 路径（gapMs=1 实际零体感等待）
    fetchHtml: async () => ({ status: 200, text: okHtml([{ videoRenderer: RENDERER }], '7', 't1') }),
    searchContinuation: async () => {
      call++;
      // 第一次续页带 token（走完循环尾 → sleep 默认实现），第二次无 token 终止
      return { status: 200, json: call === 1
        ? { append: { continuationItems: [{ lockupViewModel: LOCKUP }], continuation: { continuationCommand: { token: 't2' } } } }
        : { append: { continuationItems: [] } } };
    },
  };
  const out = await runYtSearch(deps, { keyword: 'ts', pages: 99, gapMs: 1 });
  // pages=99 → maxPages 截断 10（此处 2 页后自然终止，截断上限不阻断正常收尾）
  assert.equal(out.pages_fetched, 3);
  assert.equal(out.items.length, 2);
});

// —— runYtSearchAction：background action 执行体（io 注入 chrome 依赖） ——
function mockIo(tab) {
  const tabs = [];
  const calls = [];
  return {
    tabs, calls,
    fetchHtml: async () => ({ status: 200, text: okHtml([{ lockupViewModel: LOCKUP }]) }),
    ensureTab: async () => { tabs.push('ensure'); return tab; },
    innertubeViaTab: async (tabId, endpoint, key, ver, token) => {
      calls.push({ tabId, endpoint, key, ver, token });
      return { status: 200, json: { append: { continuationItems: [] } } };
    },
    closeTab: async (tabId) => { tabs.push(`close:${tabId}`); },
  };
}

test('runYtSearchAction：单页不碰 tab（惰性）；keyword 校验与 pages 归一', async () => {
  const io = mockIo({ tabId: 7, opened: true });
  const out = await runYtSearchAction({ keyword: '  kw  ', pages: 0 }, io); // pages=0 非法 → 归一 1
  assert.equal(out.keyword, 'kw'); // trim
  assert.equal(out.pages_fetched, 1);
  assert.deepEqual(io.tabs, []); // 单页无需 InnerTube 续页，不 ensureTab
  // keyword 缺失/非字符串 → keyword required
  await assert.rejects(() => runYtSearchAction({}, io), /keyword required/);
  await assert.rejects(() => runYtSearchAction({ keyword: '  ' }, io), /keyword required/);
  await assert.rejects(() => runYtSearchAction(null, io), /keyword required/);
});

test('runYtSearchAction：续页经 tab（endpoint=search，凭据透传）；自建 tab 用完关，复用 tab 不关', async () => {
  const homeWithToken = `<html><script>var ytInitialData = ${JSON.stringify({
    estimatedResults: '5',
    contents: { itemSectionRenderer: { contents: [{ lockupViewModel: LOCKUP }] } },
    continuation: { continuationCommand: { token: 't1' } },
  })};</script><script>yt.setConfig({"INNERTUBE_API_KEY":"AIzaSyTEST","INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260824.01.00"});</script></html>`;
  // 自建 tab（opened:true）→ finally 关
  const opened = {
    tabs: [], calls: [],
    fetchHtml: async () => ({ status: 200, text: homeWithToken }),
    ensureTab: async function () { this.tabs.push('ensure'); return { tabId: 9, opened: true }; },
    innertubeViaTab: async function (tabId, endpoint, key, ver, token) {
      this.calls.push({ tabId, endpoint, key, ver, token });
      return { status: 200, json: { append: { continuationItems: [] } } };
    },
    closeTab: async function (tabId) { this.tabs.push(`close:${tabId}`); },
  };
  const out = await runYtSearchAction({ keyword: 'kw', pages: 2 }, opened);
  assert.equal(out.pages_fetched, 2);
  assert.equal(opened.calls[0].endpoint, 'search'); // search endpoint（非 browse）
  assert.equal(opened.calls[0].tabId, 9);
  assert.equal(opened.calls[0].key, 'AIzaSyTEST'); // SSR 页抠出的凭据透传
  assert.deepEqual(opened.tabs, ['ensure', 'close:9']); // 自建 tab 收尾关
  // 复用用户 tab（opened:false）→ 不关
  const reuse = {
    tabs: [],
    fetchHtml: async () => ({ status: 200, text: homeWithToken }),
    ensureTab: async () => { reuse.tabs.push('ensure'); return { tabId: 3, opened: false }; },
    innertubeViaTab: async () => ({ status: 200, json: { append: { continuationItems: [] } } }),
    closeTab: async (tabId) => { reuse.tabs.push(`close:${tabId}`); },
  };
  await runYtSearchAction({ keyword: 'kw', pages: 2 }, reuse);
  assert.deepEqual(reuse.tabs, ['ensure']); // 复用 tab 不关
});
