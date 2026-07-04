import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { listVideos, getVideo, getVersionPayload, getCreator } from './queries.js';

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
