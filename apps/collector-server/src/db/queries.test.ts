import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, runMigrations } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { getVideo, getVersionPayload, getCreator, listCategories, createCategory, updateCategory, deleteCategory, listCreators, setCreatorCategory, setCreatorBlocked, getCreatorBySourceUid } from './queries.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-q-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

const sampleReq = (title: string, tracks: any[] = [], sourceVid = 'BV1') => ({
  source: 'bilibili',
  video: { source_vid: sourceVid, title, creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
  tracks,
});

// listVideos（旧版仅 q 过滤）已删（2026-08-25 死代码清理），其 q/分页/倒序语义
// 由 advanced.test.ts 的 listVideosFiltered 用例覆盖。

test('getVideo: 默认轨优先级 CC中文 > AI中文 > 英文', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('多语言', [
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://e' }] },
      { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.equal(d.tracks.length, 3);
    assert.equal(d.tracks[0].lan_doc, 'CC中文');
    assert.equal((d.tracks[0] as any).is_default, true);
    assert.equal((d.tracks[1] as any).is_default, false);
    assert.equal((d.tracks[2] as any).is_default, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: 翻译轨(type=3) 排在原文 CC/ASR 之后——YouTube 默认轨不再落机翻中文', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('英文视频', [
      // 旧数据形态：翻译轨落 type=2 时 zh-Hans 会顶成默认（优先级 0）——v10 迁移与扩展侧改发 type=3 后：
      { lan: 'zh-Hans', lan_doc: '中文(机翻)', track_type: 3, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?tlang=zh-Hans' }] },
      { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?lang=en' }] },
      { lan: 'en', lan_doc: 'English ASR', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?lang=en&asr' }] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.equal(d.tracks.length, 3);
    assert.equal(d.tracks[0].lan_doc, 'English CC', '原文人工 CC 应为默认轨');
    assert.equal(d.tracks[1].lan_doc, 'English ASR', '原文 ASR 次之');
    assert.equal(d.tracks[2].lan_doc, '中文(机翻)', '翻译轨(type=3) 应排在所有原文轨之后');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: video 带 creator_source_uid（详情页作者外链跳转）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('外链视频', []));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.equal(d.video.creator_name, 'up');
    assert.equal(d.video.creator_source_uid, '1'); // LEFT JOIN creators 补 uid，前端据此跳空间页
    // 无 creator 归属的旧数据：null 不炸（前端回落纯文本）
    ingestVideo(db, { source: 'bilibili', video: { source_vid: 'BV2', title: '无归属', creator: null, extra: {}, duration: 1, published_at: 1 }, tracks: [] });
    const d2 = getVideo(db, 'bilibili', 'BV2');
    if (!d2) throw new Error('no detail2');
    assert.equal(d2.video.creator_source_uid, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: 仅有 ASR + 翻译轨时默认 = 原文 ASR；翻译轨排在其他语言轨之前', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('无CC英文视频', [
      { lan: 'ja', lan_doc: 'Japanese', track_type: null, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ja' }] },
      { lan: 'zh-Hans', lan_doc: '中文(机翻)', track_type: 3, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?tlang=zh-Hans' }] },
      { lan: 'en', lan_doc: 'English ASR', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://tt?lang=en' }] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.equal(d.tracks[0].lan_doc, 'English ASR', '原文 ASR 优先于翻译轨');
    assert.equal(d.tracks[1].lan_doc, '中文(机翻)', '翻译轨优先于无 type 的其他语言轨');
    assert.equal(d.tracks[2].lan_doc, 'Japanese');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: B 站默认行为不变——zh CC > zh AI > en', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('B站多轨', [
      { lan: 'en', lan_doc: 'English', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://e' }] },
      { lan: 'zh-Hans', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['CC中文', 'AI中文', 'English'], 'zh CC > zh AI > en 的 B 站默认序保持不变');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: zh-manual 补翻轨——AI中文之后、原文轨之前（advanced.ts 镜像同步）', () => {
  const { db, dir } = freshDb();
  try {
    // 场景一（典型补翻目标）：英文视频无中文轨，fill 后 zh-manual 接管默认轨
    ingestVideo(db, sampleReq('英文视频补翻', [
      { lan: 'en', lan_doc: 'English CC', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://cc' }] },
      { lan: 'zh-manual', lan_doc: '中文（补翻）', track_type: undefined, versions: [{ origin: 'manual', payload: { body: [] }, source_url: 'translate://en' }] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['中文（补翻）', 'English CC'], '补翻后默认轨变中文——补翻的目的');

    // 场景二：有 AI 中文（track_type=1）时 AI 中文仍优先——zh-manual 档位在 AI中文(1) 之后
    ingestVideo(db, sampleReq('重翻场景', [
      { lan: 'zh', lan_doc: 'AI中文', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://ai' }] },
      { lan: 'zh-manual', lan_doc: '中文（补翻）', track_type: undefined, versions: [{ origin: 'manual', payload: { body: [] }, source_url: 'translate://ai-en' }] },
      { lan: 'en', lan_doc: 'English ASR', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://en' }] },
    ], 'BV2'));
    const d2 = getVideo(db, 'bilibili', 'BV2');
    if (!d2) throw new Error('no detail');
    assert.deepEqual(d2.tracks.map((t) => t.lan_doc), ['AI中文', '中文（补翻）', 'English ASR']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: 每个 track 内各自有 default version（不跨轨串台）— Critical C1', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('多轨多版本', [
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [
        { origin: 'asr', payload: { body: [{ content: 'asr' }] }, source_url: null, asr_engine: 'whisper' },
        { origin: 'external', payload: { body: [{ content: 'ext' }] }, source_url: 'https://cc' },
      ] },
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [
        { origin: 'asr', payload: { body: [{ content: 'asr-en' }] }, source_url: null, asr_engine: 'whisper' },
        { origin: 'external', payload: { body: [{ content: 'ext-en' }] }, source_url: 'https://en' },
      ] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    // version priority: external(0) < manual(1) < asr(2)，排序后首个 = external
    for (const t of d.tracks) {
      const defaults = t.versions.filter(v => (v as any).is_default);
      assert.equal(defaults.length, 1, `track ${t.lan_doc} 应有且仅有一个 default version`);
      assert.equal(defaults[0].origin, 'external');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo: 不存在返回 null', () => {
  const { db, dir } = freshDb();
  try {
    assert.equal(getVideo(db, 'bilibili', 'BVx'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVersionPayload: payload JSON 还原', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('t', [{ lan: 'zh', track_type: 1, versions: [{ origin: 'external', payload: { body: [{ content: 'hi' }] }, source_url: 'https://x' }] }]));
    const v = db.prepare('SELECT id FROM subtitle_versions').get() as { id: number };
    const p = getVersionPayload(db, v.id);
    if (!p) throw new Error('no payload');
    assert.deepEqual(p.payload, { body: [{ content: 'hi' }] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVersionPayload: 不存在返回 null', () => {
  const { db, dir } = freshDb();
  try {
    assert.equal(getVersionPayload(db, 999), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getCreator: 命中返回完整 creator 详情（含 P2 字段）', () => {
  const { db, dir } = freshDb();
  try {
    db.prepare(
      "INSERT INTO creators (source, source_uid, name, sign, level, sex, official_type, official_title, fans, following, first_seen_at, updated_at) " +
      "VALUES ('bilibili','123','up1','签名',6,'男',1,'官方',1000,50,1,2)"
    ).run();
    const c = getCreator(db, 1);
    assert.equal(c?.name, 'up1');
    assert.equal(c?.sign, '签名');
    assert.equal(c?.level, 6);
    assert.equal(c?.sex, '男');
    assert.equal(c?.official_type, 1);
    assert.equal(c?.official_title, '官方');
    assert.equal(c?.fans, 1000);
    assert.equal(c?.following, 50);
    assert.equal(c?.source_uid, '123');
    assert.equal(c?.source, 'bilibili');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getCreator: 未命中返回 null', () => {
  const { db, dir } = freshDb();
  try {
    assert.equal(getCreator(db, 999), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getCreator: 详情带分类名（join categories，agent/human 两套）', () => {
  const { db, dir } = freshDb();
  try {
    // 建两个分类 + 一个 creator 关联到两个分类
    const now = Date.now();
    const ca = db.prepare("INSERT INTO categories (name, scope, sort_order, created_at) VALUES ('股票','agent',0,?)").run(now);
    const ch = db.prepare("INSERT INTO categories (name, scope, sort_order, created_at) VALUES ('关注','human',0,?)").run(now);
    db.prepare(
      "INSERT INTO creators (source, source_uid, name, first_seen_at, updated_at, category_agent_id, category_human_id) " +
      "VALUES ('bilibili','123','up1',1,2,?,?)",
    ).run(Number(ca.lastInsertRowid), Number(ch.lastInsertRowid));
    const c = getCreator(db, 1);
    assert.equal(c?.category_agent_name, '股票');
    assert.equal(c?.category_human_name, '关注');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── categories CRUD + creators 列表/打分类（Task B2）──
// 用 :memory: 库跑 migrate + runMigrations（验证双轨），不需要 FS 目录。
function memDb() {
  const db = new Database(':memory:');
  migrate(db); runMigrations(db);
  return db;
}

test('categories CRUD', () => {
  const db = memDb();
  const a = createCategory(db, '股票', 'agent');
  assert.equal(a.name, '股票');
  assert.equal(a.scope, 'agent');
  // UNIQUE(name, scope) 冲突
  assert.throws(() => createCategory(db, '股票', 'agent'));
  // 同名不同 scope 允许
  const h = createCategory(db, '股票', 'human');
  assert.notEqual(a.id, h.id);
  // list by scope
  const agentCats = listCategories(db, 'agent');
  assert.equal(agentCats.length, 1);
  assert.equal(agentCats[0].name, '股票');
  // update
  updateCategory(db, a.id, { name: 'A股' });
  assert.equal(listCategories(db, 'agent')[0].name, 'A股');
  // delete
  deleteCategory(db, a.id);
  assert.equal(listCategories(db, 'agent').length, 0);
});

test('setCreatorCategory upsert creator 并设分类', () => {
  const db = memDb();
  const c = setCreatorCategory(db, 'bilibili', '123', 'agent', '股票');
  assert.equal(c.category_agent_name, '股票');
  // 再设 human 分类，agent 分类不被覆盖
  setCreatorCategory(db, 'bilibili', '123', 'human', '关注');
  const c2 = setCreatorCategory(db, 'bilibili', '123', 'agent', '股票');
  assert.equal(c2.category_agent_name, '股票');
  assert.equal(c2.category_human_name, '关注');
});

test('listCreators 按分类筛选', () => {
  const db = memDb();
  setCreatorCategory(db, 'bilibili', '1', 'agent', '股票');
  setCreatorCategory(db, 'bilibili', '2', 'agent', '股票');
  setCreatorCategory(db, 'bilibili', '3', 'agent', '基金');
  const r = listCreators(db, { category: '股票', scope: 'agent' }, 1, 20);
  assert.equal(r.total, 2);
});

// ── 分支洼地补齐：track/version 优先级镜像、categories 空补丁、listCreators 排序与 q ──

test('getVideo: en 无 type 轨（优先级 2）排在其他语言轨（5）之前；同轨 manual 版本排 asr 前', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('优先级分支', [
      { lan: 'fr', lan_doc: '法语', track_type: null, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://fr' }] },
      { lan: 'en', lan_doc: '英文无type', track_type: null, versions: [
        { origin: 'asr', payload: { body: [] }, source_url: null, asr_engine: 'whisper' },
        { origin: 'manual', payload: { body: [] }, source_url: null },
      ] },
    ]));
    const d = getVideo(db, 'bilibili', 'BV1');
    if (!d) throw new Error('no detail');
    assert.deepEqual(d.tracks.map((t) => t.lan_doc), ['英文无type', '法语'], 'en 无 type 轨优先级 2，fr 其他 5');
    assert.deepEqual(d.tracks[0].versions.map((v) => v.origin), ['manual', 'asr'], 'external(0) < manual(1) < asr(2)');
    assert.equal((d.tracks[0].versions[0] as any).is_default, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listCategories: 省略 scope → 全量（scope 排序）', () => {
  const db = memDb();
  createCategory(db, '股票', 'agent');
  createCategory(db, '关注', 'human');
  const all = listCategories(db);
  assert.equal(all.length, 2);
  // ORDER BY scope：agent < human
  assert.deepEqual(all.map((c) => c.scope), ['agent', 'human']);
});

test('updateCategory: 仅 sort_order / 空 patch（原样返回不改名）', () => {
  const db = memDb();
  const a = createCategory(db, '股票', 'agent');
  // 只改 sort_order（不带 name）
  const u1 = updateCategory(db, a.id, { sort_order: 7 });
  assert.equal(u1?.name, '股票');
  assert.equal(u1?.sort_order, 7);
  // 空 patch → 不 UPDATE，原样返回当前行
  const u2 = updateCategory(db, a.id, {});
  assert.equal(u2?.name, '股票');
  assert.equal(u2?.sort_order, 7);
  // 不存在的 id + 空 patch → 查无行（返回 falsy；注：.get() 实际给 undefined，函数签名标的 | null 略有出入）
  assert.ok(!updateCategory(db, 999, {}));
});

test('listCreators: q 模糊 / human scope 分类 / 无过滤全量 + fans / video_count 排序', () => {
  const db = memDb();
  setCreatorCategory(db, 'bilibili', '1', 'human', '关注');
  setCreatorCategory(db, 'bilibili', '2', 'agent', '股票');
  // 视频数：uid1 两条、uid2 一条
  for (const [vid, uid] of [['BV1', '1'], ['BV2', '1'], ['BV3', '2']] as const) {
    ingestVideo(db, { source: 'bilibili', video: { source_vid: vid, title: 't', creator: { source_uid: uid }, extra: {}, duration: 1, published_at: 1 }, tracks: [] });
  }
  // fans 时点值（uid2 高）
  db.prepare("UPDATE creators SET fans = 9000 WHERE source_uid = '2'").run();
  db.prepare("UPDATE creators SET fans = 100 WHERE source_uid = '1'").run();

  // human scope 分类筛选
  const human = listCreators(db, { category: '关注', scope: 'human' }, 1, 20);
  assert.equal(human.total, 1);
  assert.equal(human.items[0].source_uid, '1');
  assert.equal(human.items[0].category_human_name, '关注');
  // q 模糊（name / source_uid）
  assert.equal(listCreators(db, { q: '1' }, 1, 20).items.length, 1, 'q 命中 source_uid=1');
  // 无过滤 → 空where + 默认 first_seen 排序，全量
  const all = listCreators(db, {}, 1, 20);
  assert.equal(all.total, 2);
  // fans 排序：uid2(9000) 在前
  assert.deepEqual(listCreators(db, {}, 1, 20, 'fans').items.map((c) => c.source_uid), ['2', '1']);
  // video_count 排序：uid1(2) 在前
  assert.deepEqual(listCreators(db, {}, 1, 20, 'video_count').items.map((c) => c.source_uid), ['1', '2']);
  // items 带 video_count 与分类名
  const c1 = all.items.find((c) => c.source_uid === '1')!;
  assert.equal(c1.video_count, 2);
  assert.equal(c1.category_human_name, '关注');
});

// 2026-08-25 全端点排序：listCreators 新增 following/level/updated_at/name 键 + desc 方向参数。
// 可空数值键 COALESCE 归零（NULL UP 不抢头尾）；name 可空走 NULLS LAST（不论升降）。
test('listCreators: sort=following/level/updated_at/name + desc 方向 + name NULLS LAST', () => {
  const db = memDb();
  // 三个 UP：uid1（数值齐全）、uid2（following/level NULL）、uid3（name NULL）
  for (const uid of ['1', '2', '3']) {
    db.prepare("INSERT INTO creators (source, source_uid, first_seen_at, updated_at) VALUES ('bilibili', ?, 100, 100)").run(uid);
  }
  db.prepare("UPDATE creators SET name='乙', fans=100, following=30, level=5, updated_at=300 WHERE source_uid='1'").run();
  db.prepare("UPDATE creators SET name='甲', fans=200, updated_at=200 WHERE source_uid='2'").run(); // following/level NULL
  db.prepare("UPDATE creators SET name=NULL, fans=50, updated_at=400 WHERE source_uid='3'").run();   // name NULL
  // following DESC：乙(30) > 甲(NULL→0) = 丙(NULL→0)，tie 按 c.id DESC
  assert.deepEqual(listCreators(db, {}, 1, 20, 'following', true).items.map((c) => c.name), ['乙', null, '甲']);
  // following ASC：COALESCE 后同为 0 的 NULL 行 tie 按 c.id ASC
  assert.deepEqual(listCreators(db, {}, 1, 20, 'following', false).items.map((c) => c.name), ['甲', null, '乙']);
  // level DESC：乙(5) > 甲(0) = 丙(0)
  assert.deepEqual(listCreators(db, {}, 1, 20, 'level', true).items.map((c) => c.name), ['乙', null, '甲']);
  // updated_at DESC：丙(400) > 乙(300) > 甲(200)
  assert.deepEqual(listCreators(db, {}, 1, 20, 'updated_at', true).items.map((c) => c.source_uid), ['3', '1', '2']);
  // name ASC：乙(U+4E59) < 甲(U+7532)，name NULL 恒排最后（NULLS LAST）
  assert.deepEqual(listCreators(db, {}, 1, 20, 'name', false).items.map((c) => c.name), ['乙', '甲', null]);
  // name DESC：甲 > 乙，NULL 仍排最后（NULLS LAST 不随方向翻转）
  assert.deepEqual(listCreators(db, {}, 1, 20, 'name', true).items.map((c) => c.name), ['甲', '乙', null]);
  // desc 缺省 true：fans DESC 旧语义不变（fans=200 甲 在前）
  assert.deepEqual(listCreators(db, {}, 1, 20, 'fans').items.map((c) => c.name), ['甲', '乙', null]);
});

// ---- UP 屏蔽（2026-08-24）：setCreatorBlocked 读写 + listCreators 筛选 + getVideo 归属标记 ----

test('setCreatorBlocked：屏蔽/解除往返 + 未入库返回 null', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('甲', [], 'BV1'));
    const blocked = setCreatorBlocked(db, 'bilibili', '1', true);
    assert.equal(blocked!.blocked, true, '屏蔽后回读 blocked=true');
    assert.equal(getCreatorBySourceUid(db, 'bilibili', '1')!.blocked, true);
    const un = setCreatorBlocked(db, 'bilibili', '1', false);
    assert.equal(un!.blocked, false, '解除后回读 blocked=false');
    assert.equal(setCreatorBlocked(db, 'bilibili', '999', true), null, '未入库返回 null（不建最小行）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listCreators：blocked 筛选三态 + items 带布尔化 blocked', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('甲', [], 'BV1'));
    db.prepare("INSERT INTO creators (source, source_uid, first_seen_at, updated_at) VALUES ('bilibili', '2', 1, 1)").run();
    db.prepare("UPDATE creators SET blocked = 1 WHERE source_uid = '2'").run();
    const all = listCreators(db, {}, 1, 20);
    assert.equal(all.total, 2);
    assert.equal(all.items.find((c) => c.source_uid === '2')!.blocked, true, 'SQLite 0/1 出口布尔化');
    assert.equal(all.items.find((c) => c.source_uid === '1')!.blocked, false);
    const onlyBlocked = listCreators(db, { blocked: true }, 1, 20);
    assert.equal(onlyBlocked.total, 1);
    assert.equal(onlyBlocked.items[0].source_uid, '2');
    assert.equal(listCreators(db, { blocked: false }, 1, 20).total, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('getVideo：video 带 creator_blocked 布尔化', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('甲', [], 'BV1'));
    db.prepare('UPDATE creators SET blocked = 1').run();
    const d = getVideo(db, 'bilibili', 'BV1');
    assert.equal(d!.video.creator_blocked, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
