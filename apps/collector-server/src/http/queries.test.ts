// /api/videos 列表项富化字段测试（pot_limited 受限标记：web UI 本次未消费，字段先备好）。
// 模式对齐 tags.test.ts：handler 直挂测试 server + fetch。
// 跑法：cd apps/collector-server && node --test --import tsx src/http/queries.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | pot_limited 派生 / changes 全维 / 富化降级 / 详情 / 打标 400 | 通过 | 建表时既有 |
// | R2 | tag_source 单独筛选存在性过滤（2026-08-29 修复静默忽略） | 通过 | 各档独立 + 多档 OR + 组合不回归 |
// | R3 | +4 组：GET /api/videos/:s/:v/comments 评论树子路由（404/空树/树形组装/limit 校验） | 通过 | 树形组装走 db/comments-tree.ts shapeTree（P2-5 web 评论展示，2026-10-05） |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { upsertComments, clearAndSetPins, type CommentUpsertRow } from '../db/comments.js';
import { handleQueryHttp } from './queries.js';

async function setup(): Promise<{ db: Database.Database; port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-queries-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1 有字幕；BV2 无字幕（测试体内按需补 collect_tasks 行制造 limited 形态）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '有字幕', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: 'x' }] }, source_url: 'https://a' }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '无字幕', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleQueryHttp(req, res, db);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { db, port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function call(port: number, path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function itemsByVid(port: number): Promise<Record<string, any>> {
  const r = await call(port, '/api/videos?size=100');
  assert.equal(r.status, 200);
  return Object.fromEntries(r.json.items.map((i: any) => [i.source_vid, i]));
}

test('/api/videos: 列表项含 pot_limited（最近任务 limited → true；重采成功 → false）', async () => {
  const s = await setup();
  try {
    // 初始：无任务记录 → 全 false（真无字幕与有字幕 alike）
    let byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV1.pot_limited, false, '无任务记录 → false');
    assert.equal(byVid.BV2.pot_limited, false, '真无字幕（无任务）→ false');

    // BV2 最近任务 limited → true（半入库：元信息在、0 轨）
    s.db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'limited', 100, 200)").run();
    byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV2.pot_limited, true, '最近任务 limited → true');
    assert.equal(byVid.BV1.pot_limited, false, '其它视频不受影响');

    // 重采成功（id 更大的 succeeded 成为最近一条）→ 标记自然消失
    s.db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'succeeded', 300, 400)").run();
    byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV2.pot_limited, false, '重采成功后标记消失（任务表派生，无回清维护）');
  } finally { s.cleanup(); }
});

// ── /api/videos：tag_source 单独筛选（2026-08-29 修复）──
// 此前 tag_source 只作 tag/tags 匹配的档位收窄，单独传被静默忽略（全量返回）——
// web 视频页「标签档位」独立下拉筛选失效。现在语义 = 所选档位至少有一个标签的视频。
test('/api/videos: tag_source 单独筛选——各档存在性过滤；与 tags 组合仍精确 AND', async () => {
  const s = await setup();
  try {
    // 四形态：关系档 manual / bili 档 extra.tags / season 档 ugc_season / 无标签；
    // 另备一个 bili 空数组视频（数组存在但无有效 tag_name，不算有 bili 标签）
    const base = { source: 'bilibili', creator: { source_uid: '1', name: 'up' }, duration: 60, published_at: 1 };
    ingestVideo(s.db, { source: 'bilibili', video: { source_vid: 'BV-rel', title: '关系档', creator: base.creator, extra: {} }, tracks: [] });
    ingestVideo(s.db, { source: 'bilibili', video: { source_vid: 'BV-bili', title: 'B站档', creator: base.creator, extra: { tags: [{ tag_name: '官方' }] } }, tracks: [] });
    ingestVideo(s.db, { source: 'bilibili', video: { source_vid: 'BV-empty', title: '空数组', creator: base.creator, extra: { tags: [] } }, tracks: [] });
    ingestVideo(s.db, { source: 'bilibili', video: { source_vid: 'BV-season', title: '合集档', creator: base.creator, extra: { ugc_season: { title: '合集X' } } }, tracks: [] });
    ingestVideo(s.db, { source: 'bilibili', video: { source_vid: 'BV-none', title: '无标签', creator: base.creator, extra: {} }, tracks: [] });
    // BV-rel 打一个 manual 档标签（镜像 applyVideoTags 的落库形态）
    const relVid = s.db.prepare("SELECT id FROM videos WHERE source_vid = 'BV-rel'").get() as { id: number };
    const tagId = (s.db.prepare("INSERT INTO tags (name, created_at) VALUES ('主题A', 1) RETURNING id").get() as { id: number }).id;
    s.db.prepare("INSERT INTO video_tags (video_id, tag_id, source, created_at) VALUES (?, ?, 'manual', 1)").run(relVid.id, tagId);

    const vids = async (query: string): Promise<string[]> => {
      const r = await call(s.port, `/api/videos?size=100&${query}`);
      assert.equal(r.status, 200);
      return r.json.items.map((i: any) => i.source_vid).sort();
    };
    // 各档单独筛：只含有该档标签的视频
    assert.deepEqual(await vids('tag_source=manual'), ['BV-rel'], 'manual 档 → 仅关系档视频');
    assert.deepEqual(await vids('tag_source=bili'), ['BV-bili'], 'bili 档 → 仅带有效 B 站标签的视频（空数组不算）');
    assert.deepEqual(await vids('tag_source=season'), ['BV-season'], 'season 档 → 仅有合集标题的视频');
    assert.deepEqual(await vids('tag_source=manual,bili'), ['BV-bili', 'BV-rel'], '多档 OR');
    // 组合行为不回归：tag_source 与 tags 同传仍走精确 AND（档位只收窄匹配路）
    assert.deepEqual(await vids('tags=主题A&tag_source=manual'), ['BV-rel'], '组合：精确 AND 不变');
    assert.deepEqual(await vids('tags=官方&tag_source=manual'), [], '组合：bili 标签在 manual 档不可命中');
  } finally { s.cleanup(); }
});

// ── /api/changes：变更日志查询（entity/entity_id/field/since/until + 分页 + 非法参数忽略）──
test('/api/changes: 全维过滤 + 分页 + 非法 since/until/entity_id 忽略', async () => {
  const s = await setup();
  try {
    // 清掉 setup ingest 留下的 created 日志（时间戳是真实 Date.now()，会污染确定性断言）
    s.db.prepare('DELETE FROM change_log').run();
    const logIns = s.db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');
    logIns.run('video', 1, 'title', '旧A', '新A', 100);
    logIns.run('video', 1, 'duration', '60', '120', 200);
    logIns.run('creator', 9, 'name', null, 'up', 300);

    // 无过滤：3 条，changed_at 倒序
    let r = await call(s.port, '/api/changes');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 3);
    assert.equal(r.json.items[0].field, 'name'); // changed_at 最大在前
    assert.equal(r.json.page, 1);
    assert.equal(r.json.size, 20);

    // entity / entity_id / field 组合
    r = await call(s.port, '/api/changes?entity=video');
    assert.equal(r.json.total, 2);
    r = await call(s.port, '/api/changes?entity=video&entity_id=1');
    assert.equal(r.json.total, 2);
    r = await call(s.port, '/api/changes?entity=creator&entity_id=9&field=name');
    assert.equal(r.json.total, 1);
    // entity_id 非数字（非 ^\d+$）→ 忽略该过滤项（entity=creator 仍生效，只 1 条 creator 日志）
    r = await call(s.port, '/api/changes?entity=creator&entity_id=abc');
    assert.equal(r.json.total, 1);

    // since/until（毫秒比对 changed_at）
    r = await call(s.port, '/api/changes?since=150');
    assert.equal(r.json.total, 2); // 200 与 300
    r = await call(s.port, '/api/changes?until=150');
    assert.equal(r.json.total, 1); // 100
    r = await call(s.port, '/api/changes?since=150&until=250');
    assert.equal(r.json.total, 1); // 200
    // 非法 since/until（NaN）→ 忽略，等同未传
    r = await call(s.port, '/api/changes?since=abc&until=NaN');
    assert.equal(r.json.total, 3);

    // 分页：page=2&size=1 → 第 2 条（changed_at 倒序第 2 = duration）
    r = await call(s.port, '/api/changes?page=2&size=1');
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].field, 'duration');
    assert.equal(r.json.page, 2);
    assert.equal(r.json.size, 1);
    // ── 2026-08-25 全端点排序：sort=changed_at + desc；非法 sort → 400 ──
    // 缺省 changed_at DESC：field 序 [name(300), duration(200), title(100)]
    r = await call(s.port, '/api/changes');
    assert.deepEqual(r.json.items.map((i: any) => i.field), ['name', 'duration', 'title']);
    // 显式升序
    r = await call(s.port, '/api/changes?sort=changed_at&desc=0');
    assert.deepEqual(r.json.items.map((i: any) => i.field), ['title', 'duration', 'name']);
    // 非法 sort → 400 + 错误列全合法键（单键端点）
    r = await call(s.port, '/api/changes?sort=bogus');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    assert.match(r.json.error, /sort must be one of changed_at/);

    // 非法 page/size 回落默认（page≥1，size 夹 1..100）
    r = await call(s.port, '/api/changes?page=oops&size=huge');
    assert.equal(r.json.page, 1);
    assert.equal(r.json.size, 20);
  } finally { s.cleanup(); }
});

// ── /api/versions/:id：字幕版本 payload 直取 ──
test('/api/versions/:id: 命中返回 parse 后 payload；不存在 404', async () => {
  const s = await setup();
  try {
    const ver = s.db.prepare('SELECT id FROM subtitle_versions LIMIT 1').get() as { id: number };
    let r = await call(s.port, `/api/versions/${ver.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.version.id, ver.id);
    assert.deepEqual(r.json.version.payload.body, [{ from: 0, to: 1, content: 'x' }]);
    // 不存在 → 404
    r = await call(s.port, '/api/versions/99999');
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
  } finally { s.cleanup(); }
});

// ── enrichItems / 详情富化的脏数据分支：extra.tags 非法 JSON、非数组、条目脏值 ──
test('/api/videos 富化：extra.tags 非法 JSON / 非数组 / 条目脏值 → 各自降级不炸', async () => {
  const s = await setup();
  try {
    // setup 只有 BV1/BV2，补一个 BV3（extra 随后覆写）
    ingestVideo(s.db, {
      source: 'bilibili',
      video: { source_vid: 'BV3', title: '三号', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    // BV3：tags 是非法 JSON 字符串（json_extract 取出的字符串 JSON.parse 抛错 → catch → 空标签）
    s.db.prepare("UPDATE videos SET extra = ? WHERE source_vid = 'BV3'").run(JSON.stringify({ tags: 'not[json' }));
    // BV2：tags 是合法 JSON 但非数组 → Array.isArray 不成立 → 空标签
    s.db.prepare("UPDATE videos SET extra = ? WHERE source_vid = 'BV2'").run(JSON.stringify({ tags: '"str"' }));
    // BV1：tags 数组含脏条目（null 项 / tag_name 非字符串）→ 只留合法项
    s.db.prepare("UPDATE videos SET extra = ? WHERE source_vid = 'BV1'").run(
      JSON.stringify({ tags: [{ tag_name: '合法' }, { tag_name: 42 }, null, 'plain'] }),
    );

    let byVid = await itemsByVid(s.port);
    assert.deepEqual(byVid.BV1.tags, ['合法'], '脏条目被滤掉，只留 tag_name 为 string 的');
    assert.deepEqual(byVid.BV2.tags, [], 'tags 非 JSON 数组 → 空标签');
    assert.deepEqual(byVid.BV3.tags, [], 'tags 非法 JSON → catch 降级空标签');

    // 详情路径同样降级（detail 的 bili 解析与列表是两份代码）
    let r = await call(s.port, '/api/videos/bilibili/BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tag_details, [{ name: '合法', source: 'bili' }]);
    r = await call(s.port, '/api/videos/bilibili/BV2');
    assert.deepEqual(r.json.tag_details, []);
    r = await call(s.port, '/api/videos/bilibili/BV3');
    assert.deepEqual(r.json.tag_details, []);

    // 空命中（q 无匹配）→ enrichItems 早退空数组，响应结构完好
    r = await call(s.port, '/api/videos?q=绝对不存在');
    assert.equal(r.status, 200);
    assert.equal(r.json.total, 0);
    assert.deepEqual(r.json.items, []);
  } finally { s.cleanup(); }
});

// ── 详情路径的 extra 边界：NULL extra（typeof 非 string）、空串 season 标题 ──
test('/api/videos/:source/:vid 详情：extra 为 NULL 不炸；ugc_season.title 空串不产生 season 标签；不存在 404', async () => {
  const s = await setup();
  try {
    // extra 置 NULL（老数据/手工库形态）：typeof extra !== 'string' 分支 → 无 bili/season 标签
    s.db.prepare("UPDATE videos SET extra = NULL WHERE source_vid = 'BV2'").run();
    let r = await call(s.port, '/api/videos/bilibili/BV2');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tag_details, []);
    // 列表富化对 NULL extra 同样安全（json_extract(NULL) → NULL）
    const byVid = await itemsByVid(s.port);
    assert.deepEqual(byVid.BV2.tags, []);

    // ugc_season.title = ''（空串）：typeof string 但 falsy → 不进 seasonNames
    s.db.prepare("UPDATE videos SET extra = ? WHERE source_vid = 'BV1'").run(JSON.stringify({ ugc_season: { id: 1, title: '' } }));
    r = await call(s.port, '/api/videos/bilibili/BV1');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tag_details, []);

    // 不存在的视频 → 404
    r = await call(s.port, '/api/videos/bilibili/NOPE');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not found');
  } finally { s.cleanup(); }
});

// ── 单视频打标/移除（/api/videos/:source/:vid/tags）的校验分支 ──
test('POST /api/videos/:s/:v/tags：视频不存在 404；body 各非法形态 400', async () => {
  const s = await setup();
  try {
    // 视频不存在 → 404（打标挂在已入库视频上）
    let r = await call(s.port, '/api/videos/bilibili/NOPE/tags', 'POST', { names: ['x'], scope: 'manual' });
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'video not found');

    // names 非数组 → 过滤后空 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: 'x', scope: 'manual' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'names:string[] required');
    // names 空数组 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: [], scope: 'manual' });
    assert.equal(r.status, 400);
    // names 全空白串 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: ['  '], scope: 'manual' });
    assert.equal(r.status, 400);
    // source 非法档 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: ['x'], scope: 'bogus' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'scope must be manual|batch|ai|system');
    // 混入非 string 条目被滤掉，合法项照常打上
    r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: [42, '混入过滤', null], scope: 'manual' });
    assert.equal(r.status, 200);
    assert.equal(r.json.inserted, 1);
  } finally { s.cleanup(); }
});

test('DELETE /api/videos/:s/:v/tags：缺 name 400；source 非法 400；省略 source 删全档', async () => {
  const s = await setup();
  try {
    await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: ['待删'], scope: 'manual' });
    await call(s.port, '/api/videos/bilibili/BV1/tags', 'POST', { names: ['待删'], scope: 'ai' });

    // 缺 name → 400
    let r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'DELETE');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'name query param required');
    // source 非法 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/tags?name=x&scope=bogus', 'DELETE');
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'scope must be manual|batch|ai|system');
    // 省略 source（?? undefined 分支）→ 删全档：manual + ai 两条关系都被删（库里已无残留）。
    // 注：removed 计数按「命中语句数」而非删掉的行数（removeVideoTags 的 info.changes>0 才 ++，
    // 一条无 source 的 DELETE 删多档同名只计 1）——疑似与 applyVideoTags 的 inserted（按行计）不对称，
    // 此处按现状断言，bug 另行上报。
    r = await call(s.port, '/api/videos/bilibili/BV1/tags?name=' + encodeURIComponent('待删'), 'DELETE');
    assert.equal(r.status, 200);
    assert.equal(r.json.removed, 1, '现状：多档同名一条语句删除只计 1（与 inserted 按行计不对称）');
    const residue = s.db.prepare('SELECT COUNT(*) AS c FROM video_tags').get() as { c: number };
    assert.equal(residue.c, 0, 'manual + ai 两条关系实际都已删除');
  } finally { s.cleanup(); }
});

// ── 路由兜底：不认识的路径与方法 ──
test('未知路径 / 方法不匹配 → 兜底 404（videos/:s/:v/tags 用 GET 不走打标路由）', async () => {
  const s = await setup();
  try {
    // GET 打不了标（只认 POST/DELETE）→ 正则不匹配详情（三段路径）→ 兜底 404
    let r = await call(s.port, '/api/videos/bilibili/BV1/tags', 'GET');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'not found');
    // 完全未知的路径
    r = await call(s.port, '/api/nonsense', 'GET');
    assert.equal(r.status, 404);
  } finally { s.cleanup(); }
});

// ── GET /api/videos/:s/:v/comments：评论树子路由（P2-5 web 评论展示）──
// 树形组装经 db/comments-tree.ts shapeTree（与 CLI comments tree 共享，§6.3 语义一致）。
// BV1 评论区种子（形态对齐 cli comments.test.ts seedDb：UP 根置顶 + 楼中楼 + 悬空对象 + 孤儿组）
function seedComments(db: Database.Database): void {
  const videoId = (db.prepare("SELECT id FROM videos WHERE source_vid = 'BV1'").get() as { id: number }).id;
  const up = (o: Partial<CommentUpsertRow> & { rpid_str: string }): CommentUpsertRow => ({
    root_rpid: '0', parent_rpid: '0', dialog_rpid: '0', mid_str: null, uname: null, member: null,
    message: null, content: null, like_count: 0, rcount: 0, reply_total: 0, ctime_s: null,
    ip_location: null, state: 0, invisible: 0, folded: 0, up_like: 0, up_reply: 0, ...o,
  });
  upsertComments(db, {
    videoId, upperMid: '9001', fetchedAt: 1_700_000_000_000, batchId: 'b1', page: 1, sort: 'time',
    replies: [
      up({ rpid_str: '101', mid_str: '9001', uname: 'UP酱', message: '根UP', like_count: 20, ctime_s: 1_700_000_000, ip_location: '上海', up_reply: 1, rcount: 3 }),
      up({ rpid_str: '102', mid_str: '8002', uname: '张三', message: '根张三', like_count: 10, ctime_s: 1_700_000_100, state: 5 }),
      up({ rpid_str: '201', root_rpid: '101', parent_rpid: '101', dialog_rpid: '101', mid_str: '8003', uname: '李四', message: '楼1', like_count: 3, ctime_s: 1_700_000_200 }),
      up({ rpid_str: '202', root_rpid: '101', parent_rpid: '999', dialog_rpid: '101', mid_str: '8004', uname: '王五', message: '楼2', ctime_s: 1_700_000_300 }),
      up({ rpid_str: '203', root_rpid: '101', parent_rpid: '201', dialog_rpid: '201', mid_str: '8005', uname: '赵六', message: '楼3', state: 17, ctime_s: 1_700_000_400 }),
      up({ rpid_str: '301', root_rpid: '777', parent_rpid: '777', dialog_rpid: '777', mid_str: '8007', uname: '孤儿', message: '孤楼', ctime_s: 1_700_000_600 }),
    ],
  });
  clearAndSetPins(db, videoId, [{ rpid_str: '101', kind: 'upper' }]);
}

test('GET /api/videos/:s/:v/comments: 视频不存在 → 404', async () => {
  const s = await setup();
  try {
    const r = await call(s.port, '/api/videos/bilibili/NOPE/comments');
    assert.equal(r.status, 404);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.error, 'video not found');
  } finally { s.cleanup(); }
});

test('GET /api/videos/:s/:v/comments: 在库无评论 → 200 空树（counts 全 0 + 空数组）', async () => {
  const s = await setup();
  try {
    const r = await call(s.port, '/api/videos/bilibili/BV2/comments');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.source, 'bilibili');
    assert.equal(r.json.source_vid, 'BV2');
    assert.deepEqual(r.json.counts, { rows: 0, roots: 0, floors: 0 });
    assert.deepEqual(r.json.roots, []);
    assert.deepEqual(r.json.orphans, []);
    assert.equal(r.json.truncated, false);
    assert.equal(r.json.limit, 0);
  } finally { s.cleanup(); }
});

test('GET /api/videos/:s/:v/comments: 树形组装全要素（根赞降序/置顶/楼层 depth+回复指向/对象已删/孤儿组）', async () => {
  const s = await setup();
  try {
    seedComments(s.db);
    const r = await call(s.port, '/api/videos/bilibili/BV1/comments');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.counts, { rows: 6, roots: 2, floors: 4 }, 'counts = 根 2 + 楼 4（含孤儿）');
    assert.equal(r.json.truncated, false);
    assert.equal(r.json.limit, 0);
    // 根赞降序：101(20) 在前；置顶/UP主标记随行透传
    const [rootUp, rootZ] = r.json.roots;
    assert.equal(rootUp.rpid_str, '101');
    assert.equal(rootUp.pin_kind, 'upper');
    assert.equal(rootUp.is_up, 1);
    assert.equal(rootUp.uname, 'UP酱');
    assert.equal(rootUp.message, '根UP');
    assert.equal(rootZ.rpid_str, '102');
    // 101 组楼：depth/reply_to/parent_missing 派生列（语义与 CLI tree 一致）
    const fl = rootUp.floors;
    assert.deepEqual(fl.map((f: any) => f.rpid_str), ['201', '202', '203']);
    assert.deepEqual(
      fl.map((f: any) => [f.depth, f.reply_to, f.parent_missing]),
      [[1, 'UP酱', false], [1, 'UP酱', true], [2, '李四', false]],
    );
    // 孤儿组（根 777 不在树）：depth 恒 1、无回复指向
    assert.deepEqual(r.json.orphans.map((f: any) => f.rpid_str), ['301']);
    assert.equal(r.json.orphans[0].depth, 1);
    assert.equal(r.json.orphans[0].reply_to, null);
  } finally { s.cleanup(); }
});

test('GET /api/videos/:s/:v/comments: limit 截根 / 0 不限 / 非法值 400', async () => {
  const s = await setup();
  try {
    seedComments(s.db);
    // limit=1：只 1 根 + truncated 置位 + counts 恒全树
    let r = await call(s.port, '/api/videos/bilibili/BV1/comments?limit=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.roots.length, 1);
    assert.equal(r.json.roots[0].rpid_str, '101');
    assert.equal(r.json.truncated, true);
    assert.deepEqual(r.json.counts, { rows: 6, roots: 2, floors: 4 });
    assert.equal(r.json.limit, 1);
    assert.deepEqual(r.json.orphans.map((f: any) => f.rpid_str), ['301'], '孤儿组不受 limit 影响');
    // limit=0：不限
    r = await call(s.port, '/api/videos/bilibili/BV1/comments?limit=0');
    assert.equal(r.status, 200);
    assert.equal(r.json.roots.length, 2);
    assert.equal(r.json.truncated, false);
    // 非法值 → 400
    r = await call(s.port, '/api/videos/bilibili/BV1/comments?limit=abc');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
    r = await call(s.port, '/api/videos/bilibili/BV1/comments?limit=-1');
    assert.equal(r.status, 400);
    assert.equal(r.json.ok, false);
  } finally { s.cleanup(); }
});
