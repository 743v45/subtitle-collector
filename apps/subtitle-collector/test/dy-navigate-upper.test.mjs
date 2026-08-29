// test/dy-navigate-upper.test.mjs
// dy-navigate.mjs 编排层回归（chrome.tabs/env 注入 stub + node:test mock timers 驱动）：
// ① 审查 M2（2026-08-30）：expand 零数据防线——content-dy 完全未注入/页面零消息时不再回
//    「ok+total:0」伪装成功，改回 error「博主页数据未就绪」；三条对照路径保持（需登录错误 /
//    真 0 作品空列表成功 / items>0 保部分结果成功）。
// ② fetch-douyin-subtitle 主链（首次直测：此前本文件未被任何单测加载，覆盖率锁定不计；
//    一经加载须整文件覆盖——has/no_subtitle/not_video/超时/复用 tab/校验分支/字幕体抓取五形态）。
// mock timers 说明：setTimeout+Date 一并 mock，无进展窗口（20s/45s）在测试里 tick 推进不真等。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createDouyinCommands } from '../dy-navigate.mjs';
import { navGate } from '../nav-gate.mjs';
import { cmdError, fmtLength } from '../format.mjs';
import { TASK_DISPATCH_DISABLED_ERROR } from '../task-dispatch.mjs';

// 测试轮次记录（对齐项目 CLAUDE.md §3 / RULES §5）
// | 轮次 | 日期       | 范围                                                        | 结果 | 备注 |
// |------|------------|-------------------------------------------------------------|------|------|
// | T1   | 2026-08-30 | 审查 M2：expand 零数据 error + 三条对照路径                  | PASS | `pnpm --dir apps/subtitle-collector test` 全绿（覆盖率锁定达标） |
// | T2   | 2026-08-30 | fetch-douyin-subtitle 主链全分支（首测加载本模块后的覆盖补齐）| PASS | 同上 |

const SEC = 'MS4wLjABAAAA2y53DZw7-0cG6yOfaZCJesMdyIdXhqLPu2abnCFjkUs';
// content-dy PROFILE_OTHER 抓的是 profile/other 响应的 user（snake_case，douyinCreatorFromProfile 口径）
const PROFILE = { sec_uid: SEC, nickname: '测试博主' };

// ── chrome stub（sendMessage 控制器按消息类型分发；{__lastError:true} 模拟未注入）──
function installChrome({ onMessage, existingTab } = {}) {
  const removed = [];
  const chromeStub = {
    runtime: { lastError: undefined },
    tabs: {
      query: async () => (existingTab ? [existingTab] : []),
      reload: async () => {},
      create: async () => ({ id: 101 }),
      remove: (tabId, cb) => { removed.push(tabId); cb?.(); },
      sendMessage: (tabId, msg, cb) => {
        Promise.resolve().then(() => {
          const r = onMessage ? onMessage(msg) : { ok: true };
          if (r && r.__lastError) {
            chromeStub.runtime.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
            cb(undefined);
            chromeStub.runtime.lastError = undefined;
            return;
          }
          cb(r);
        });
      },
    },
  };
  globalThis.chrome = chromeStub;
  return { removed };
}

function makeEnv() {
  const ingests = [];
  const uppers = [];
  return {
    env: {
      extLog: () => {},
      sendIngest: (p) => ingests.push(p),
      inFlightCollects: new Set(),
      canDispatch: () => true,
      sendUpper: (c) => uppers.push(c),
    },
    ingests, uppers,
  };
}

// mock timers 下驱动异步命令：每秒 tick + 真 setImmediate 冲刷微任务，直到 until() 或到 maxMs。
async function drive(until, maxMs = 70000) {
  for (let t = 0; t < maxMs && !until(); t += 1000) {
    mock.timers.tick(1000);
    await new Promise((r) => setImmediate(r));
  }
}

async function runCommand(msg, { onMessage, existingTab } = {}) {
  const { removed } = installChrome({ onMessage, existingTab });
  const { env, ingests, uppers } = makeEnv();
  const cmds = createDouyinCommands(env);
  const receipts = [];
  mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  try {
    const p = cmds.handleCommand(msg, (r) => receipts.push(r));
    await drive(() => receipts.length > 0);
    await Promise.race([p, new Promise((r) => setImmediate(r))]);
    return { receipts, removed, ingests, uppers, env };
  } finally {
    mock.timers.reset();
    delete globalThis.chrome;
  }
}

// ── fetch-douyin-subtitle 主链 ──

// snake_case aweme_detail fixture（键取自 spike 实测样例形态，douyin-payload.test.mjs 同源精简）
const DETAIL = {
  aweme_id: '7663873788873821476',
  desc: '测试视频', aweme_type: 0, is_subtitled: 1,
  cla_info: { cla_infos: [
    { language: 'zh', language_desc: '中文', url: 'https://cap/zh.json' },
    { language: 'en', language_desc: '英文', url: 'https://cap/en.json' },
    { language: 'bad', language_desc: 'HTTP 坏', url: 'https://cap/bad.json' },
    { language: 'empty', language_desc: '空 cues', url: 'https://cap/empty.json' },
    { language: 'badjson', language_desc: 'JSON 解析失败', url: 'https://cap/badjson.json' },
    { language: 'throw', language_desc: '网络异常', url: 'https://cap/throw.json' },
  ] },
  create_time: 1787896381, duration: 47948,
  author: { sec_uid: SEC, nickname: '测试博主' },
  statistics: { play_count: 0, digg_count: 1, comment_count: 2, share_count: 3, collect_count: 4 },
  video: { duration: 47948, play_addr: { uri: 'u', url_list: ['https://v/x.mp4'] }, cover: { url_list: ['https://c.jpg'] } },
};

// 字幕体五形态路由：正常 body / utterances 归一 / HTTP 非 2xx / 空 cues / JSON 坏 / 抛异常
const FETCH_ROUTES = {
  'https://cap/zh.json': async () => ({ ok: true, json: async () => ({ body: [{ from: 0, to: 1, content: '你好' }] }) }),
  'https://cap/en.json': async () => ({ ok: true, json: async () => ({ utterances: [{ text: 'hi', start_time: 0, end_time: 900 }] }) }),
  'https://cap/bad.json': async () => ({ ok: false, status: 503 }),
  'https://cap/empty.json': async () => ({ ok: true, json: async () => ({}) }),
  'https://cap/badjson.json': async () => ({ ok: true, json: async () => { throw new Error('parse error'); } }),
  'https://cap/throw.json': async () => { throw new Error('network down'); },
};

test('fetch：有字幕轨——双轨入库（body/utterances 归一），坏轨（HTTP/空cues/坏JSON/异常）跳过不上报', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => FETCH_ROUTES[url]();
  const warnOrig = console.warn; console.warn = () => {};
  try {
    let n = 0;
    const { receipts, ingests } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't1' }, {
      onMessage: (msg) => {
        if (msg?.type !== 'GET_DETAIL') return { ok: true };
        n += 1;
        if (n === 1) return { ok: true, state: 'not-loaded' }; // 首轮未就绪（重置无进展窗口）
        return { ok: true, state: 'has-detail', detail: DETAIL, origin: 'xhr' };
      },
    });
    assert.equal(receipts[0].ok, true);
    assert.equal(receipts[0].data.reason, undefined, '有轨不带 no_subtitle');
    assert.equal(receipts[0].data.captured, 2, 'zh+en 两轨有效');
    assert.equal(receipts[0].data.tracks, 2);
    assert.equal(receipts[0].data.ingested, true);
    assert.equal(ingests.length, 1, 'payload 一次上报');
    assert.equal(ingests[0].tracks.length, 2);
    assert.deepEqual(ingests[0].tracks[0].versions[0].payload.body, [{ from: 0, to: 1, content: '你好' }]);
  } finally {
    globalThis.fetch = origFetch;
    console.warn = warnOrig;
  }
});

test('fetch：旧 ID 302 迁移——detail.aweme_id ≠ 提交 ID 时回执/上报按实际 ID', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const { receipts, ingests } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: '7123456789012345678', id: 't2' }, {
      onMessage: (msg) => msg?.type === 'GET_DETAIL' ? { ok: true, state: 'has-detail', detail: DETAIL, origin: 'ssr' } : { ok: true },
    });
    assert.equal(receipts[0].ok, true);
    assert.equal(receipts[0].data.awemeId, '7663873788873821476', '回执 awemeId 取页面实际 ID');
    assert.equal(ingests[0].video.source_vid, '7663873788873821476', 'payload 按实际 ID 入库');
  } finally { globalThis.fetch = origFetch; }
});

test('fetch：图集（aweme_type≠0）→ reason=not_video 不入库', async () => {
  let polls = 0;
  const { receipts, ingests } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't3' }, {
    onMessage: (msg) => {
      if (msg?.type !== 'GET_DETAIL') return { ok: true };
      polls += 1;
      if (polls === 1) return { ok: true }; // 无 state 键 → observed 'ok' 兜底分支
      if (polls === 2) return { ok: true, state: 'has-detail' }; // 缺 detail 体 → hasDetail false 继续轮询
      return { ok: true, state: 'has-detail', detail: { ...DETAIL, aweme_type: 68, cla_info: null }, origin: 'xhr' };
    },
  });
  assert.equal(receipts[0].ok, true);
  assert.equal(receipts[0].data.reason, 'not_video');
  assert.equal(receipts[0].data.ingested, false);
  assert.equal(ingests.length, 0);
});

test('fetch：无字幕（cla_info null）→ reason=no_subtitle 元信息仍上报；duration/published 缺失告警不阻塞', async () => {
  const warnOrig = console.warn; console.warn = () => {};
  try {
    const { receipts, ingests } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't4' }, {
      onMessage: (msg) => msg?.type === 'GET_DETAIL' ? {
        ok: true, state: 'has-detail', // 无 origin 键 → 日志 '?' 兜底分支
        // 裸 detail：无 duration/create_time（missing 告警路径）+ 无 cla_info（0 轨 no_subtitle）
        detail: { aweme_id: DETAIL.aweme_id, desc: '裸视频', aweme_type: 0, author: { sec_uid: SEC, nickname: 'n' }, statistics: {}, video: {} },
      } : { ok: true },
    });
    assert.equal(receipts[0].ok, true);
    assert.equal(receipts[0].data.reason, 'no_subtitle');
    assert.equal(receipts[0].data.captured, 0);
    assert.equal(ingests.length, 1, '0 轨也入库（no_subtitle 打标 → ASR 兜底锚点）');
    assert.equal(ingests[0].video.duration, null);
  } finally { console.warn = warnOrig; }
});

test('fetch：无进展窗口到点 → 超时 error（文案前缀与 server amend LIKE 匹配耦合）；tab 关闭+锁释放', async () => {
  let polls = 0;
  const { receipts, removed } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, timeout_ms: 15000, id: 't5' }, {
    onMessage: (msg) => {
      if (msg?.type !== 'GET_DETAIL') return { ok: true };
      polls += 1;
      if (polls === 1) return { ok: false }; // 无 state 键 + ok:false → observed '!ok' 兜底分支
      return { ok: true, state: 'not-loaded' }; // 恒未就绪
    },
  });
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /抖音 采集超时（15s/);
  assert.deepEqual(removed, [101], '自开 tab 收尾关闭');
});

test('fetch：timeout_ms 非法（<15s）→ 回落 45s 默认窗口', async () => {
  const { receipts } = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, timeout_ms: 3000, id: 't6' }, {
    onMessage: (msg) => (msg?.type === 'GET_DETAIL' ? { ok: true, state: 'not-loaded' } : { ok: true }),
  });
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /抖音 采集超时（45s/, '非法 timeout_ms 回落 45s');
});

test('fetch：复用已开的非活跃 tab（reload 刷新，不关）；活跃 tab 不动改开新页', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    // 非活跃既有 tab → reload 复用，收尾不 remove
    const reused = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't7' }, {
      existingTab: { id: 55, active: false },
      onMessage: (msg) => (msg?.type === 'GET_DETAIL' ? { ok: true, state: 'has-detail', detail: { ...DETAIL, cla_info: null }, origin: 'xhr' } : { ok: true }),
    });
    assert.equal(reused.receipts[0].data.reused, true);
    assert.deepEqual(reused.removed, [], '复用的 tab 不关');

    // 用户正看着的活跃 tab → 不动，开新后台 tab（收尾关新 tab）
    const fresh = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't8' }, {
      existingTab: { id: 66, active: true },
      onMessage: (msg) => (msg?.type === 'GET_DETAIL' ? { ok: true, state: 'has-detail', detail: { ...DETAIL, cla_info: null }, origin: 'xhr' } : { ok: true }),
    });
    assert.equal(fresh.receipts[0].data.reused, false);
    assert.deepEqual(fresh.removed, [101], '新开 tab 收尾关闭');

    // 既有 tab 无 id（?. 短路）→ 视同无可复用，开新页
    const idless = await runCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 't9' }, {
      existingTab: { active: false },
      onMessage: (msg) => (msg?.type === 'GET_DETAIL' ? { ok: true, state: 'has-detail', detail: { ...DETAIL, cla_info: null }, origin: 'xhr' } : { ok: true }),
    });
    assert.equal(idless.receipts[0].data.reused, false, '无 id 的 query 结果不复用');
    assert.deepEqual(idless.removed, [101]);
  } finally { globalThis.fetch = origFetch; }
});

test('fetch：防御分支——派发关闭拒任务 / awemeId 非法 / 同视频 in-flight 防重', async () => {
  const cases = [
    [{ action: 'fetch-douyin-subtitle', awemeId: '7123456789012345678', id: 'd1' }, 'dispatch-off'],
    [{ action: 'fetch-douyin-subtitle', awemeId: 'abc', id: 'd2' }, 'bad-aweme'],
    [{ action: 'fetch-douyin-subtitle', awemeId: 7123456789012345678, id: 'd3' }, 'bad-aweme'],
  ];
  for (const [msg, kind] of cases) {
    const { env, receipts } = await (() => {
      // 校验分支是同步回执，不走定时器——直接裸驱动一次
      installChrome({});
      if (kind === 'dispatch-off') {
        const bag = makeEnv();
        const cmds = createDouyinCommands({ ...bag.env, canDispatch: () => false });
        const rs = [];
        cmds.handleCommand(msg, (r) => rs.push(r));
        return { env: bag.env, receipts: rs };
      }
      const bag = makeEnv();
      const cmds = createDouyinCommands(bag.env);
      const rs = [];
      cmds.handleCommand(msg, (r) => rs.push(r));
      return { env: bag.env, receipts: rs };
    })();
    await new Promise((r) => setImmediate(r));
    delete globalThis.chrome;
    assert.equal(receipts.length, 1);
    if (kind === 'dispatch-off') assert.equal(receipts[0].error, TASK_DISPATCH_DISABLED_ERROR);
    else assert.match(receipts[0].error, /awemeId（数字 ID）required/);
  }

  // 同视频 in-flight：预置占位 → 拒绝新命令
  installChrome({});
  const bag = makeEnv();
  bag.env.inFlightCollects.add(`douyin:${DETAIL.aweme_id}`);
  const cmds = createDouyinCommands(bag.env);
  const rs = [];
  cmds.handleCommand({ action: 'fetch-douyin-subtitle', awemeId: DETAIL.aweme_id, id: 'd4' }, (r) => rs.push(r));
  await new Promise((r) => setImmediate(r));
  delete globalThis.chrome;
  assert.match(rs[0].error, /duplicate in-flight/);
});

// ── expand-douyin-upper（审查 M2 零数据防线 + 对照路径）──

test('M2：content-dy 完全未注入（START 重试 30 次耗尽 + GET_UPPER_STATE 无响应）→ error 而非 ok+total:0 伪装成功', async () => {
  const { receipts } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e1' }, {
    onMessage: (msg) => (msg?.type === 'DY_UPPER_START' || msg?.type === 'GET_UPPER_STATE' ? { __lastError: true } : { ok: true }),
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, false, '未注入必须回 error');
  assert.match(receipts[0].error, /博主页数据未就绪/);
});

test('M2：已注入但页面零消息（改版/滚动全失灵，state 恒 running 零 profile 零 items）→ 同样回 error', async () => {
  const { receipts } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e2' }, {
    onMessage: (msg) => (msg?.type === 'GET_UPPER_STATE' ? { ok: true, state: 'running', secUid: SEC, profile: null, items: [], error: null } : { ok: true }),
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /博主页数据未就绪/);
});

test('对照：有 profile 但 POST_LIST_EMPTY（未登录 gating）→ 保留「需登录」错误路径', async () => {
  const { receipts } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e3' }, {
    onMessage: (msg) => (msg?.type === 'GET_UPPER_STATE' ? {
      ok: true, state: 'error', secUid: SEC, profile: PROFILE, items: [],
      error: 'post 列表 200 空体：该浏览器未登录抖音（或被风控 gating），需在登录态执行博主批量',
    } : { ok: true }),
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, false);
  assert.match(receipts[0].error, /未登录抖音|登录态/, 'content-dy 的「需登录」错误原文透传');
});

test('对照：真 0 作品（有 profile + done 翻页尽头 + items 空）→ ok 空列表成功（不误伤）+ creator 顺带入库', async () => {
  let round = 0;
  let startNacks = 0;
  const { receipts, uppers } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e4' }, {
    onMessage: (msg) => {
      if (msg?.type === 'DY_UPPER_START') {
        // 前 2 次 START 无响应/被拒（就绪竞态重试路径，lastError 与 ok:false 两种形态），第 3 次成功
        startNacks += 1;
        return startNacks === 1 ? { __lastError: true } : startNacks === 2 ? { ok: false } : { ok: true };
      }
      if (msg?.type !== 'GET_UPPER_STATE') return { ok: true };
      round += 1;
      // 末轮 done 态省略 items 键（GET_UPPER_STATE 字段漂移容错：items?.length 兜底 0）
      return round <= 2
        ? { ok: true, state: 'running', secUid: SEC, profile: PROFILE, items: [], error: null }
        : { ok: true, state: 'done', secUid: SEC, profile: PROFILE };
    },
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, true, '真 0 作品是成功不是错误');
  assert.equal(receipts[0].data.total, 0);
  assert.deepEqual(receipts[0].data.items, []);
  assert.equal(receipts[0].data.channel_id, SEC);
  assert.equal(receipts[0].data.channel_name, '测试博主');
  assert.equal(uppers.length, 1, 'profile 到手顺带 ingest-upper');
  assert.equal(uppers[0].source_uid, SEC);
});

test('对照：items>0 但 profile 未到手 → 保部分结果仍回 ok（图集过滤 + length 双分支）', async () => {
  const ITEM_OK = { aweme_id: '7123456789012345678', desc: '部分结果', aweme_type: 0, create_time: 1787896381, duration_ms: 3661000, play_count: 0, cover_url: 'https://c.jpg' };
  const ITEM_NEG = { aweme_id: '7223456789012345678', desc: null, aweme_type: 0, create_time: null, duration_ms: -1, play_count: null, cover_url: null };
  const ITEM_NODUR = { aweme_id: '7423456789012345678', desc: '非数值时长', aweme_type: 0, create_time: null, duration_ms: null, play_count: null, cover_url: null };
  const ITEM_ALBUM = { aweme_id: '7323456789012345678', desc: '图集', aweme_type: 150, create_time: null, duration_ms: 1000, play_count: null, cover_url: null };
  let round = 0;
  const { receipts, uppers } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e5' }, {
    onMessage: (msg) => {
      if (msg?.type !== 'GET_UPPER_STATE') return { ok: true };
      round += 1;
      const items = round === 1 ? [] : [ITEM_OK, ITEM_NEG, ITEM_NODUR, ITEM_ALBUM];
      return { ok: true, state: round <= 2 ? 'running' : 'done', secUid: SEC, profile: null, items, error: null };
    },
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, true, '拉到真实 items 时即便 profile 缺失也回执成功');
  assert.equal(receipts[0].data.total, 3, '图集（aweme_type=150）过滤');
  assert.deepEqual(receipts[0].data.items.map((x) => x.bvid), ['7123456789012345678', '7223456789012345678', '7423456789012345678']);
  assert.deepEqual(receipts[0].data.items.map((x) => x.length), ['1:01:01', null, null], '3661s → H:MM:SS；负 duration / 非数值 → null');
  assert.deepEqual(receipts[0].data.items.map((x) => x.title), ['部分结果', '', '非数值时长'], 'desc null → 空串');
  assert.equal(uppers.length, 0, 'profile 未到手不 ingest-upper');
});

test('expand：state=error 但无 error 文案 → 兜底「博主列表拉取失败」', async () => {
  const { receipts } = await runCommand({ action: 'expand-douyin-upper', secUid: SEC, id: 'e6' }, {
    onMessage: (msg) => (msg?.type === 'GET_UPPER_STATE' ? { ok: true, state: 'error', secUid: SEC, profile: PROFILE, items: [] } : { ok: true }),
  });
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].ok, false);
  assert.equal(receipts[0].error, '博主列表拉取失败');
});

test('expand：secUid 缺失/空串 → 回执 error（校验分支，无 taskId 前缀日志形态）', async () => {
  const missId = await runCommand({ action: 'expand-douyin-upper' }, {});
  assert.equal(missId.receipts.length, 1);
  assert.equal(missId.receipts[0].ok, false);
  assert.match(missId.receipts[0].error, /secUid required/);
  const empty = await runCommand({ action: 'expand-douyin-upper', secUid: '' }, {});
  assert.match(empty.receipts[0].error, /secUid required/, '空串同拒');
});

// ── 依赖模块单元补齐（经 dy-navigate 首次加载进覆盖率口径，连带分支一并锁住）──
test('navGate.loadConfig：storage 有效值覆盖默认 / 非法与缺失忽略；acquire 忙等让锁', async () => {
  // loadConfig：合法数值覆盖，负数/字符串/缺失保默认
  await navGate.loadConfig({ local: { get: async () => ({ nav_gap_base_ms: 2000, nav_gap_random_ms: 4000 }) } });
  assert.equal(navGate.gapBaseMs, 2000);
  assert.equal(navGate.gapRandomMs, 4000);
  await navGate.loadConfig({ local: { get: async () => ({ nav_gap_base_ms: -1, nav_gap_random_ms: 'x' }) } });
  assert.equal(navGate.gapBaseMs, 2000, '负数忽略保旧值');
  assert.equal(navGate.gapRandomMs, 4000, '非数值忽略');
  await navGate.loadConfig({ local: { get: async () => ({}) } });
  assert.equal(navGate.gapBaseMs, 2000, '缺键忽略');
  navGate.gapBaseMs = 1000; navGate.gapRandomMs = 2000; // 还原默认（勿污染后续用例）

  // acquire 互斥：busy 时等待，release 后获得（mock timers 驱动 500ms 轮询）
  navGate.busy = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let acquired = false;
    const p = navGate.acquire().then(() => { acquired = true; });
    assert.equal(acquired, false, '锁被占时 acquire 不返回');
    navGate.release();
    mock.timers.tick(600);
    await p;
    assert.equal(acquired, true, 'release 后 acquire 获得');
  } finally {
    mock.timers.reset();
    navGate.release();
  }
});

test('cmdError / fmtLength：回执文案归一（非 Error/空 message）与时长双档', () => {
  assert.equal(cmdError(new Error('x')), 'x');
  assert.equal(cmdError('boom'), 'boom', '非 Error 抛出值字符串化');
  assert.equal(cmdError(new Error('')), 'Error', '空 message 回落整串');
  assert.equal(fmtLength(47.948), '0:47');
  assert.equal(fmtLength(3661), '1:01:01');
});
