import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, runMigrations } from './migrate.js';
import { ingestVideo, ingestUpper } from './ingest.js';
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

test('extra.stat 波动不记 change_log，但库里 extra 更新为最新 stat', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (view: number, like: number) => ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV1', title: 't',
        creator: { source_uid: '1', name: 'up' },
        extra: { aid: 1, cid: 2, tname: '单机游戏', stat: { view, like } },
        duration: 1, published_at: 1,
      },
      tracks: [],
    });
    rec(100, 10);
    rec(999, 88); // 仅 stat 数字变化
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='video' AND field='extra'").all() as any[];
    assert.equal(logs.length, 0, '仅 stat 数字变化不应记 extra change_log');
    const v = db.prepare('SELECT extra FROM videos WHERE source_vid = ?').get('BV1') as any;
    const extra = JSON.parse(v.extra);
    assert.equal(extra.stat.view, 999, '库里 extra.stat 应为最新值');
    assert.equal(extra.stat.like, 88);
    assert.equal(extra.tname, '单机游戏', '非 stat 结构字段应保留');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extra 结构字段（tname/tags 等）变化记 change_log', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (tname: string, tags: unknown[]) => ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV2', title: 't',
        creator: { source_uid: '1', name: 'up' },
        extra: { aid: 1, cid: 2, tname, tags, stat: { view: 1 } },
        duration: 1, published_at: 1,
      },
      tracks: [],
    });
    rec('单机游戏', [{ tag_id: 1, tag_name: 'x' }]);
    rec('手机游戏', [{ tag_id: 2, tag_name: 'y' }]); // 结构字段变化（stat 未变）
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='video' AND field='extra'").all() as any[];
    assert.equal(logs.length, 1, '结构字段变化应记一条 extra change_log');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('enrich tname：extra 有 tid 时按 zones 字典反查填 tname（view API 的 tname 恒空）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BV207', title: 't',
        creator: { source_uid: '1', name: 'up' },
        extra: { aid: 1, cid: 2, tid: 207 }, // view API 只返回 tid，tname 恒为空串
        duration: 1, published_at: 1,
      },
      tracks: [],
    });
    const v = db.prepare('SELECT extra FROM videos WHERE source_vid = ?').get('BV207') as any;
    const extra = JSON.parse(v.extra);
    assert.equal(extra.tid, 207);
    assert.equal(extra.tname, '财经商业', 'tid=207 应被 zones-v1.json 字典 enrich 为「财经商业」');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paid 双写：extra.paid=true → 独立 paid 列=1 且 extra JSON 保留 paid（json_extract=1）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: 'BVpaid', title: '付费片',
        creator: { source_uid: '1', name: 'up' },
        extra: { aid: 1, cid: 2, paid: true },
        duration: 1, published_at: 1,
      },
      tracks: [],
    });
    const v = db.prepare('SELECT paid, extra FROM videos WHERE source_vid = ?').get('BVpaid') as any;
    assert.equal(v.paid, 1, '独立 paid 列应为 1（便于查询）');
    const j = db.prepare("SELECT json_extract(extra, '$.paid') as p FROM videos WHERE source_vid = ?").get('BVpaid') as any;
    assert.equal(j.p, 1, 'extra JSON 内 paid 也应为 1（双写：详情/来源；SQLite json_extract 把 true 规范成 1）');
    // 非付费视频默认 0
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVfree', title: '免费片', creator: { source_uid: '1', name: 'up' }, extra: { aid: 2 }, duration: 1, published_at: 1 },
      tracks: [],
    });
    const free = db.prepare('SELECT paid FROM videos WHERE source_vid = ?').get('BVfree') as any;
    assert.equal(free.paid, 0, '无 paid 标志默认 0');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paid 变更记 change_log（0→1）', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (paid: boolean) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVchg', title: 't', creator: { source_uid: '1', name: 'up' }, extra: { paid }, duration: 1, published_at: 1 },
      tracks: [],
    });
    rec(false); // 首次：paid=0
    rec(true);  // 变更：paid 0→1
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='video' AND field='paid'").all() as any[];
    assert.equal(logs.length, 1, 'paid 0→1 应记一条 change_log');
    assert.equal(logs[0].old_value, '0');
    assert.equal(logs[0].new_value, '1');
    const v = db.prepare('SELECT paid FROM videos WHERE source_vid = ?').get('BVchg') as any;
    assert.equal(v.paid, 1, '列应为最新值 1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingestUpper 首次插入 creator（含新字段）', () => {
  const { db, dir } = freshDb();
  try {
    const out = ingestUpper(db, {
      source: 'bilibili',
      creator: { source_uid: '123', name: 'up1', avatar: 'f', sign: '签名', level: 6, sex: '男',
        official_type: 1, official_title: '官方', fans: 1000, following: 50 },
    });
    const row = db.prepare('SELECT * FROM creators WHERE source_uid=?').get('123') as Record<string, unknown>;
    assert.equal(row.name, 'up1');
    assert.equal(row.sign, '签名');
    assert.equal(row.level, 6);
    assert.equal(row.fans, 1000);
    assert.deepEqual(out.updated_fields.sort(), ['avatar', 'fans', 'following', 'level', 'name', 'official_title', 'official_type', 'sex', 'sign']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingestUpper 字段变化记 change_log', () => {
  const { db, dir } = freshDb();
  try {
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', sign: '旧签名' } });
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', sign: '新签名' } });
    const changes = db.prepare('SELECT field FROM change_log WHERE entity=? AND entity_id=?').all('creator', 1) as Array<{ field: string }>;
    assert.equal(changes.length, 1);
    assert.equal(changes[0].field, 'sign');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingestUpper fans/following 波动不记 change_log（stat 类）', () => {
  const { db, dir } = freshDb();
  try {
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', fans: 1000, following: 50 } });
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', fans: 2000, following: 60 } });
    const changes = db.prepare('SELECT field FROM change_log WHERE entity=?').all('creator') as Array<{ field: string }>;
    assert.equal(changes.filter((c) => c.field === 'fans' || c.field === 'following').length, 0);
    const row = db.prepare('SELECT fans, following FROM creators WHERE source_uid=?').get('123') as Record<string, number>;
    assert.equal(row.fans, 2000);
    assert.equal(row.following, 60);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runMigrations 幂等：列已存在不抛', () => {
  const { db, dir } = freshDb(); // freshDb 已调 migrate（schema.sql 含新列）
  try {
    // 再跑 runMigrations：列已存在，应吞 "duplicate column name" 不抛
    assert.doesNotThrow(() => runMigrations(db));
    // creators 表仍有新字段（7 列在）
    const cols = db.prepare('PRAGMA table_info(creators)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const f of ['sign', 'level', 'sex', 'official_type', 'official_title', 'fans', 'following']) {
      assert.ok(names.includes(f), `creators 应有列 ${f}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
