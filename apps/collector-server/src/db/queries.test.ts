import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate, runMigrations } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { listVideos, getVideo, getVersionPayload, getCreator, listCategories, createCategory, updateCategory, deleteCategory, listCreators, setCreatorCategory } from './queries.js';

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

test('listVideos: 空库 total=0', () => {
  const { db, dir } = freshDb();
  try {
    const r = listVideos(db, undefined, 1, 20);
    assert.equal(r.total, 0);
    assert.deepEqual(r.items, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('listVideos: 搜索 title/creator LIKE + 分页 + first_seen_at 倒序', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, sampleReq('字幕视频A', [], 'BV1'));
    ingestVideo(db, sampleReq('其他视频', [], 'BV2'));
    const all = listVideos(db, undefined, 1, 20);
    assert.equal(all.total, 2);
    assert.equal(all.items[0].title, '其他视频'); // 后插入 = first_seen_at 更大 = 排前
    assert.equal(all.items[1].title, '字幕视频A');
    const q = listVideos(db, '字幕', 1, 20);
    assert.equal(q.total, 1);
    assert.equal(q.items[0].title, '字幕视频A');
    const page2 = listVideos(db, undefined, 2, 1);
    assert.equal(page2.items.length, 1);
    assert.equal(page2.items[0].title, '字幕视频A');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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
