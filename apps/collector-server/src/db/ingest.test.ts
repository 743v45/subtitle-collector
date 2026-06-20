import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import { ingestVideo } from './ingest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-test-'));
  const dbPath = join(dir, 'test.db');
  const db = openDb(dbPath);
  migrate(db);
  return { db, dir, dbPath };
}

test('首次 ingest：video + creator + track + version 都插入', () => {
  const { db, dir } = freshDb();
  try {
    const result = ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV1xxx',
        creator: { source_uid: '123', name: 'up名', avatar: 'http://...' },
        title: '标题A',
        extra: { aid: 1, cid: 2 },
        duration: 100,
        published_at: 1700000000000,
      },
      tracks: [
        {
          lan: 'zh-Hans', lan_doc: '简体中文', track_type: 2,
          versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }],
        },
      ],
    });
    assert.equal(result.inserted_tracks, 1);
    assert.equal(result.skipped_tracks, 0);
    const video = db.prepare('SELECT * FROM videos WHERE source_vid = ?').get('BV1xxx') as any;
    assert.equal(video.title, '标题A');
    const verCount = db.prepare('SELECT COUNT(*) as c FROM subtitle_versions').get() as any;
    assert.equal(verCount.c, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同 video 再 ingest：元信息不变则不动，version 已存在则跳过', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV1xxx', title: '标题A',
        creator: { source_uid: '123', name: 'up名' },
        extra: {}, duration: 100, published_at: 1700000000000,
      },
      tracks: [{ lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
    });
    const r2 = ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV1xxx', title: '标题A',
        creator: { source_uid: '123', name: 'up名' },
        extra: {}, duration: 100, published_at: 1700000000000,
      },
      tracks: [{ lan: 'zh-Hans', track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
    });
    assert.equal(r2.inserted_tracks, 0);
    assert.equal(r2.skipped_tracks, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('元信息变更：title 变了记 change_log', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1xxx', title: '旧标题', creator: { source_uid: '123', name: 'up' }, extra: {}, duration: 100, published_at: 1 },
      tracks: [{ lan: 'zh', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1xxx', title: '新标题', creator: { source_uid: '123', name: 'up' }, extra: {}, duration: 100, published_at: 1 },
      tracks: [{ lan: 'zh', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
    });
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='video' AND field='title'").all() as any[];
    assert.equal(logs.length, 1);
    assert.equal(logs[0].old_value, '旧标题');
    assert.equal(logs[0].new_value, '新标题');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('作者改名：creator.name 变了记 change_log', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title: 't', creator: { source_uid: '123', name: '旧名' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title: 't', creator: { source_uid: '123', name: '新名' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='creator' AND field='name'").all() as any[];
    assert.equal(logs.length, 1);
    assert.equal(logs[0].new_value, '新名');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('同轨多版本（外挂 vs ASR）：按 origin 分开存', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [{
        lan: 'zh', track_type: 1,
        versions: [
          { origin: 'external', payload: { body: [] }, source_url: 'https://a' },
          { origin: 'asr', payload: { body: [{ from: 0, to: 1, content: 'x' }] }, source_url: null, asr_engine: 'whisper' },
        ],
      }],
    });
    const versions = db.prepare('SELECT origin FROM subtitle_versions ORDER BY id').all() as any[];
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map(v => v.origin).sort(), ['asr', 'external']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('manual 版本不去重：同轨重复导入 manual 始终 INSERT 新行', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (title: string) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV1', title, creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [{
        lan: 'zh', track_type: 1,
        versions: [{ origin: 'manual', payload: { body: [{ content: title }] }, source_url: null }],
      }],
    });
    rec('人工导入 1');
    rec('人工导入 2'); // manual 不去重，应再插一行
    rec('人工导入 3'); // 同理
    const manuals = db.prepare("SELECT * FROM subtitle_versions WHERE origin = 'manual' ORDER BY id").all() as any[];
    assert.equal(manuals.length, 3, 'manual 每次导入都应是新行，不参与去重');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
