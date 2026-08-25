import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate, runMigrations } from './migrate.js';
import { ingestVideo, ingestUpper } from './ingest.js';
import { markNoSubtitle } from './tags.js';
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
    const changes = db.prepare('SELECT field FROM change_log WHERE entity=? AND entity_id=? ORDER BY id').all('creator', 1) as Array<{ field: string }>;
    // 首次建行记 created（对齐 ingestVideo 的创建审计），第二次记 sign 变更
    assert.deepEqual(changes.map((c) => c.field), ['created', 'sign']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingestUpper 首次建行记 change_log created（old=null / new=name，对齐 ingestVideo）', () => {
  const { db, dir } = freshDb();
  try {
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', avatar: 'f' } });
    const creator = db.prepare("SELECT id, name FROM creators WHERE source_uid='123'").get() as { id: number; name: string };
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='creator' AND field='created'").all() as any[];
    assert.equal(logs.length, 1, '首次建行应记一条 created');
    assert.equal(logs[0].entity_id, creator.id, 'entity_id 应指向新建 creator 行');
    assert.equal(logs[0].old_value, null);
    assert.equal(logs[0].new_value, 'up1');
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

// ── 版本去重键（P0-5）：source_url 是带签名的临时 URL（YouTube timedtext 的
// signature/expire/pot、B 站 aisubtitle 签名每会话不同），参与去重会导致重采必插重复行。
// 去重键改为字幕体 body_hash：同内容跨会话/跨签名 URL 只留一行；内容真变化才新增版本行。

test('版本去重：同 body 不同签名 URL → 跳过；body 变化 → 新版本行', () => {
  const { db, dir } = freshDb();
  try {
    const mk = (url: string, body: Array<Record<string, unknown>>) => ({
      source: 'youtube' as const,
      video: {
        source_vid: 'gaDdrDdczO4', title: 'T',
        creator: { source_uid: 'UC1', name: 'ch' },
        extra: {}, duration: 60, published_at: 1700000000000,
      },
      tracks: [{
        lan: 'en', track_type: 1,
        versions: [{ origin: 'external' as const, payload: { body }, source_url: url }],
      }],
    });
    const body = [{ from: 0, to: 2, content: 'hello' }];
    // 第一次：会话 A 的签名 URL
    const r1 = ingestVideo(db, mk('https://tt.example/api?signature=AAA&expire=111', body));
    assert.equal(r1.inserted_tracks, 1);
    // 第二次：会话 B 的签名 URL（同 body）→ 必须跳过，不新增重复行
    const r2 = ingestVideo(db, mk('https://tt.example/api?signature=BBB&expire=222', body));
    assert.equal(r2.inserted_tracks, 0);
    assert.equal(r2.skipped_tracks, 1);
    // 第三次：字幕内容更新（B 站 AI 字幕重跑等）→ 新版本行（版本语义）
    const r3 = ingestVideo(db, mk('https://tt.example/api?signature=CCC&expire=333', [...body, { from: 2, to: 4, content: 'world' }]));
    assert.equal(r3.inserted_tracks, 1);
    const c = db.prepare('SELECT COUNT(*) AS c FROM subtitle_versions').get() as { c: number };
    assert.equal(c.c, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── creator 缺失契约（与扩展侧共同约定：缺失不发字段；'unknown' 为旧扩展窗口期防御）──

test('creator 缺失（不发 creator 字段）：不建 creators 行，video.creator_id=null', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'yt1', title: '受限元信息', extra: {}, duration: 60, published_at: 1 },
      tracks: [],
    });
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM creators').get() as { c: number }).c, 0,
      '不得 upsert 任何 creator 行');
    const v = db.prepare('SELECT creator_id FROM videos WHERE source_vid = ?').get('yt1') as { creator_id: number | null };
    assert.equal(v.creator_id, null, 'video.creator_id 应写 null（schema 允许）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("creator.source_uid 字面 'unknown' 视同缺失：不同频道的视频不吸进同一虚构 UP 行", () => {
  const { db, dir } = freshDb();
  try {
    const mk = (vid: string) => ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: vid, title: 't', creator: { source_uid: 'unknown' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    mk('ytA');
    mk('ytB'); // 旧逻辑：UNIQUE(source,'unknown') 使两条视频吸进同一行（1 个 creator、2 条挂靠）
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM creators').get() as { c: number }).c, 0,
      "不得落 'unknown' 虚构 creator 行");
    const rows = db.prepare('SELECT source_vid, creator_id FROM videos ORDER BY source_vid').all() as Array<{ source_vid: string; creator_id: number | null }>;
    assert.deepEqual(rows.map((r) => r.creator_id), [null, null], '两条视频 creator_id 均应为 null');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('creator.source_uid null / 空串 同样视同缺失', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytN', title: 't', creator: { source_uid: null }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytE', title: 't', creator: { source_uid: '' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM creators').get() as { c: number }).c, 0);
    const rows = db.prepare('SELECT creator_id FROM videos').all() as Array<{ creator_id: number | null }>;
    assert.deepEqual(rows.map((r) => r.creator_id), [null, null]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('重采缺 creator：已有 creator_id 保留旧归属（COALESCE 语义，与 duration/published_at 一致）', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytR', title: 't', creator: { source_uid: 'UC1', name: 'ch' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    const before = db.prepare('SELECT creator_id FROM videos WHERE source_vid = ?').get('ytR') as { creator_id: number | null };
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytR', title: 't2', extra: {}, duration: 1, published_at: 1 }, // 本次不带 creator
      tracks: [],
    });
    const v = db.prepare('SELECT creator_id FROM videos WHERE source_vid = ?').get('ytR') as { creator_id: number | null };
    assert.equal(v.creator_id, before.creator_id, 'UPDATE 路径缺 creator_uid 保留旧归属（防合法视频被不带 creator 的路径误清）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 重采 UPDATE 合并语义（「非空才覆盖」+ paid 只升不降 + tags 保底）──

test('重采 duration/published_at 缺失：保留旧值（COALESCE(new, old)）；带新值则覆盖', () => {
  const { db, dir } = freshDb();
  try {
    const full = (duration?: number, published_at?: number) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVM', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration, published_at },
      tracks: [],
    });
    full(600, 1700000000000);
    full(undefined, undefined); // 浏览路径重采：payload 不带 → 旧逻辑 ?? null 会清掉
    let v = db.prepare('SELECT duration, published_at FROM videos WHERE source_vid = ?').get('BVM') as { duration: number; published_at: number };
    assert.equal(v.duration, 600, 'duration 新值缺失应保留旧值');
    assert.equal(v.published_at, 1700000000000, 'published_at 新值缺失应保留旧值');
    full(700, 1700000001000); // 带新值 → 正常覆盖
    v = db.prepare('SELECT duration, published_at FROM videos WHERE source_vid = ?').get('BVM') as { duration: number; published_at: number };
    assert.equal(v.duration, 700);
    assert.equal(v.published_at, 1700000001000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 必要字段缺失留证（2026-08-25：上报不完整必须可观察）：INSERT 落值 / UPDATE COALESCE
// 合并终值仍 NULL 时，返回值带 missing_required 清单供 ws 层记告警日志；字段齐时不带该键。
test('missing_required：INSERT 缺→返回清单；重采补齐→清单消失；重采仍缺→清单保留', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (duration?: number, published_at?: number) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVMR', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration, published_at },
      tracks: [],
    });
    // 首次 INSERT 全缺（player API 无 pubdate/video_info 的被动路径形态）→ 两个字段都进清单
    const r1 = rec(undefined, undefined);
    assert.deepEqual(r1.missing_required, ['duration', 'published_at'], 'INSERT 缺失应返回完整清单');
    // 重采带值补齐（修复后扩展 force 重采）→ 终值非空，清单消失（键不出现）
    const r2 = rec(269, 1787556638000);
    assert.equal(r2.missing_required, undefined, '补齐后不应带 missing_required 键');
    // 补齐后重采再缺（浏览路径 payload 不带）→ COALESCE 保留旧值，终值仍非空 → 不告警
    const r3 = rec(undefined, undefined);
    assert.equal(r3.missing_required, undefined, '终值已补齐时 COALESCE 保留,不应再告警');
    // 真正的终值仍 NULL：INSERT 缺 + 重采仍缺（旧版扩展/videoData 未就绪持续空转）→ 清单恒保留
    const rec2 = (duration?: number, published_at?: number) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV_MISS', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration, published_at },
      tracks: [],
    });
    rec2(undefined, undefined);
    const r5 = rec2(undefined, undefined);
    assert.deepEqual(r5.missing_required, ['duration', 'published_at'], '终值仍 NULL 时清单应保留');
    // 半缺形态：只缺 duration
    const r4 = ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BV_HALF', title: 't', extra: {}, duration: 100 },
      tracks: [],
    });
    assert.deepEqual(r4.missing_required, ['published_at'], '只缺 published_at 时清单应单列');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('paid 只升不降：旧 1 时新 payload 无 paid 键 / paid=false 均保持 1；旧 0 新 1 正常升级', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (extra: Record<string, unknown>, vid = 'BVP') => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: vid, title: 't', creator: { source_uid: '1', name: 'up' }, extra },
      tracks: [],
    });
    rec({ paid: true });                 // 首次：paid=1
    rec({ aid: 1 });                     // 重采无 paid 键（浏览路径）→ 旧逻辑 Number(undefined)→NaN→0 清掉
    let v = db.prepare('SELECT paid FROM videos WHERE source_vid = ?').get('BVP') as { paid: number };
    assert.equal(v.paid, 1, '新值缺失应保留旧值 1');
    rec({ paid: false });                // 显式 false → 只升不降
    v = db.prepare('SELECT paid FROM videos WHERE source_vid = ?').get('BVP') as { paid: number };
    assert.equal(v.paid, 1, 'paid 只升不降：1 不得回落为 0');
    rec({ paid: false }, 'BV0');         // 新视频首次 paid=false → 0
    rec({ paid: true }, 'BV0');          // 重采升级 0→1
    const up = db.prepare('SELECT paid FROM videos WHERE source_vid = ?').get('BV0') as { paid: number };
    assert.equal(up.paid, 1, '旧 0 新 1 应覆盖（正常升级）');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('title 新值 null 不覆盖（新值非 null 时正常更新）', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (title: string | null) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVT', title: title as unknown as string, creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [],
    });
    rec('旧标题');
    rec(null); // 新值 null → 不覆盖
    let v = db.prepare('SELECT title FROM videos WHERE source_vid = ?').get('BVT') as { title: string };
    assert.equal(v.title, '旧标题', 'title 新值 null 应保留旧值');
    rec('新标题'); // 正常改版更新
    v = db.prepare('SELECT title FROM videos WHERE source_vid = ?').get('BVT') as { title: string };
    assert.equal(v.title, '新标题');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('extra.tags 保底：重采 extra 无 tags / 空 tags 保留旧 tags；带非空 tags 时正常替换', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (extra: Record<string, unknown>) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVG', title: 't', creator: { source_uid: '1', name: 'up' }, extra, duration: 1, published_at: 1 },
      tracks: [],
    });
    rec({ tags: [{ tag_id: 1, tag_name: '游戏' }], stat: { view: 100 } });
    rec({ stat: { view: 200 } }); // tag 接口失败的重采：extra 无 tags → 旧逻辑整体替换冲掉
    let tags = db.prepare("SELECT json_extract(extra, '$.tags') AS t FROM videos WHERE source_vid = ?").get('BVG') as { t: string };
    assert.equal(JSON.parse(tags.t)[0].tag_name, '游戏', '新 extra 无 tags 字段应保留旧 extra.tags');
    rec({ tags: [], stat: { view: 300 } }); // 空 tags 数组同样保底
    tags = db.prepare("SELECT json_extract(extra, '$.tags') AS t FROM videos WHERE source_vid = ?").get('BVG') as { t: string };
    assert.equal(JSON.parse(tags.t)[0].tag_name, '游戏', '新 extra tags 为空数组应保留旧 extra.tags');
    assert.equal((db.prepare("SELECT json_extract(extra, '$.stat.view') AS v FROM videos WHERE source_vid = ?").get('BVG') as { v: number }).v, 300, 'extra 其余字段仍整体替换为最新');
    rec({ tags: [{ tag_id: 2, tag_name: '新标签' }] }); // 非空新 tags → 正常替换
    tags = db.prepare("SELECT json_extract(extra, '$.tags') AS t FROM videos WHERE source_vid = ?").get('BVG') as { t: string };
    assert.equal(JSON.parse(tags.t)[0].tag_name, '新标签', '新 extra 带非空 tags 应整体替换');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── 分支洼地补齐：最小 payload、库内脏 extra、无 lan/lan_doc 轨、upper 最小请求 ──

test('最小 payload：无 extra/duration/published_at + creator 只带 uid → 全部落 NULL 不炸', () => {
  const { db, dir } = freshDb();
  try {
    const r = ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytMin', title: '最小', creator: { source_uid: 'UC1' } },
      tracks: [],
    });
    assert.equal(r.inserted_tracks, 0);
    const v = db.prepare('SELECT * FROM videos WHERE source_vid = ?').get('ytMin') as any;
    assert.equal(v.extra, '{}', 'extra 缺省 → {}');
    assert.equal(v.duration, null);
    assert.equal(v.published_at, null);
    assert.equal(v.paid, 0);
    // creator 只带 uid → name/avatar 落 NULL（change_log created 的 new_value 也是 null）
    const c = db.prepare("SELECT * FROM creators WHERE source_uid = 'UC1'").get() as any;
    assert.equal(c.name, null);
    assert.equal(c.avatar, null);
    const created = db.prepare("SELECT new_value FROM change_log WHERE entity='creator' AND field='created'").get() as any;
    assert.equal(created.new_value, null);
    // 重采：creator 仍不带 name → 不记 name 变更
    ingestVideo(db, {
      source: 'youtube',
      video: { source_vid: 'ytMin', title: '最小', creator: { source_uid: 'UC1' } },
      tracks: [],
    });
    assert.equal((db.prepare("SELECT COUNT(*) AS c FROM change_log WHERE field='name'").get() as any).c, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('库内 extra 为 NULL：重采不炸，extra 按新值整体替换', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVD', title: 't', creator: { source_uid: '1', name: 'up' }, extra: { tags: [{ tag_name: '旧' }] }, duration: 1, published_at: 1 },
      tracks: [],
    });
    // extra 置 NULL（typeof 非 string → String(null ?? '') 参与比较；mergeExtraTags 无 tags 可保底）
    db.prepare("UPDATE videos SET extra = NULL WHERE source_vid = 'BVD'").run();
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVD', title: 't', creator: { source_uid: '1', name: 'up' }, extra: { aid: 1 }, duration: 1, published_at: 1 },
      tracks: [],
    });
    const v = db.prepare('SELECT extra FROM videos WHERE source_vid = ?').get('BVD') as any;
    assert.equal(JSON.parse(v.extra).aid, 1, 'NULL extra 被新值替换');
    // 注：非法 JSON 的 extra 写不进库——idx_videos_extra_tid/view 表达式索引在写时即抛
    // malformed JSON（实测 SQLITE_ERROR），structuralExtra/mergeExtraTags 的 catch 属 schema 不可达防御分支。
    assert.throws(() => db.prepare("UPDATE videos SET extra = '{broken' WHERE source_vid = 'BVD'").run(), /malformed JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('重采补 duration：旧值为 NULL 时 change_log 的 old_value 记 NULL', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVQ', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, published_at: 1 }, // 无 duration
      tracks: [],
    });
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVQ', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 480, published_at: 1 },
      tracks: [],
    });
    const logs = db.prepare("SELECT * FROM change_log WHERE field='duration'").all() as any[];
    assert.equal(logs.length, 1);
    assert.equal(logs[0].old_value, null, '旧 duration NULL → old_value 记 null（?? 分支）');
    assert.equal(logs[0].new_value, '480');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('轨缺 lan/lan_doc/track_type：各落 NULL，lan_doc 缺省不触发 UPDATE', () => {
  const { db, dir } = freshDb();
  try {
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVL', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [{ versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://nolan' }] }],
    });
    const t = db.prepare('SELECT * FROM subtitle_tracks').get() as any;
    assert.equal(t.lan, null);
    assert.equal(t.lan_doc, null);
    assert.equal(t.track_type, null);
    // 重采同形态：命中已有轨、lan_doc 仍缺 → 不 UPDATE 不炸
    const r = ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVL', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [{ versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://nolan2' }] }], // 同 body → 去重跳过
    });
    assert.equal(r.skipped_tracks, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM subtitle_tracks').get() as any).c, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('重采已有轨带新 lan_doc → trackUpd 更新轨显示名', () => {
  const { db, dir } = freshDb();
  try {
    const rec = (lanDoc: string) => ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVU', title: 't', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 1, published_at: 1 },
      tracks: [{ lan: 'zh-Hans', lan_doc: lanDoc, track_type: 2, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://u' }] }],
    });
    rec('旧轨名');
    rec('新轨名'); // 轨已存在（同 lan/type）→ lan_doc 更新
    const t = db.prepare('SELECT lan_doc FROM subtitle_tracks').get() as any;
    assert.equal(t.lan_doc, '新轨名', '重采带新 lan_doc 应 UPDATE 轨显示名');
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM subtitle_tracks').get() as any).c, 1, '轨不重复建');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ingestUpper 最小请求（只带 uid）→ 全字段 NULL 建行；补 name 时 change_log old=null', () => {
  const { db, dir } = freshDb();
  try {
    const out = ingestUpper(db, { source: 'bilibili', creator: { source_uid: '42' } });
    assert.ok(out.updated_fields.length > 0, '首次建行视为全字段更新');
    const row = db.prepare("SELECT * FROM creators WHERE source_uid='42'").get() as any;
    for (const f of ['name', 'avatar', 'sign', 'level', 'sex', 'official_type', 'official_title', 'fans', 'following']) {
      assert.equal(row[f], null, `${f} 应为 NULL`);
    }
    // 第二次带 name：旧 name NULL → change_log old_value 记 null
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '42', name: '新名字' } });
    const log = db.prepare("SELECT * FROM change_log WHERE entity='creator' AND field='name'").get() as any;
    assert.equal(log.old_value, null);
    assert.equal(log.new_value, '新名字');
    // 第三次不发 name（字段移除）→ newV null → change_log new_value 记 null
    ingestUpper(db, { source: 'bilibili', creator: { source_uid: '42' } });
    const logs = db.prepare("SELECT * FROM change_log WHERE entity='creator' AND field='name' ORDER BY id").all() as any[];
    assert.equal(logs.length, 2);
    assert.equal(logs[1].old_value, '新名字');
    assert.equal(logs[1].new_value, null, '字段移除 → new_value null');
    const row2 = db.prepare("SELECT name FROM creators WHERE source_uid='42'").get() as any;
    assert.equal(row2.name, null, '列被置回 NULL');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── no-subtitle 摘标（2026-08-23）：ingest 新增轨 > 0 时自动摘 system 档状态标 ──
// 前提：视频带 no-subtitle 系统标（此前确认无字幕）；操作：重采 ingest 带新轨；
// 断言：标被自动摘除（--tag no-subtitle 圈出的恒为真无轨）；skipped-only 不摘（内容未变不算新增）。
test('ingest 新增字幕轨：自动摘 no-subtitle 系统标；无新增轨不动标', () => {
  const { db, dir } = freshDb();
  try {
    // 步骤1：首次 ingest 仅元信息（模拟确认无字幕后的入库）
    ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVns', title: 't', extra: {}, duration: 10, published_at: 1700000000000 },
      tracks: [],
    });
    markNoSubtitle(db, { source: 'bilibili', source_vid: 'BVns' });
    assert.equal(hasNoSubtitleTag(db), true, '前提：标已打上');

    // 步骤2：重采 ingest 带一轨新版本 → inserted=1 → 标应被摘
    const r = ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVns', title: 't', extra: {}, duration: 10, published_at: 1700000000000 },
      tracks: [
        { lan: 'zh', lan_doc: '中文', track_type: 1,
          versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://x' }] },
      ],
    });
    assert.equal(r.inserted_tracks, 1);
    assert.equal(hasNoSubtitleTag(db), false, '新增轨后标被自动摘除');

    // 步骤3：第三次 ingest 同内容（skipped-only，inserted=0）→ 不动标（此时无标，验证点为不报错不误写）
    const r3 = ingestVideo(db, {
      source: 'bilibili',
      video: { source_vid: 'BVns', title: 't', extra: {}, duration: 10, published_at: 1700000000000 },
      tracks: [
        { lan: 'zh', lan_doc: '中文', track_type: 1,
          versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://x' }] },
      ],
    });
    assert.equal(r3.inserted_tracks, 0);
    assert.equal(hasNoSubtitleTag(db), false, 'skipped-only 不重新打标');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// 辅助：查视频当前是否带 no-subtitle 标（任意档）
function hasNoSubtitleTag(db: ReturnType<typeof openDb>): boolean {
  const row = db.prepare(
    `SELECT 1 FROM video_tags vt JOIN tags t ON t.id = vt.tag_id JOIN videos v ON v.id = vt.video_id
     WHERE v.source_vid = 'BVns' AND t.name = 'no-subtitle'`,
  ).get();
  return row != null;
}
