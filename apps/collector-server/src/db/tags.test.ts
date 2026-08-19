import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import {
  listTags, applyVideoTags, removeVideoTags, renameTag, deleteTag,
  getVideoTagsByVideoIds, getVideoTagsForDetail,
} from './tags.js';
import { ingestVideo } from './ingest.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tags-test-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

// 造两个测试视频（走真实 ingest 路径，保证 videos 行存在）
function seedVideos(db: ReturnType<typeof openDb>) {
  for (const vid of ['BV1a', 'BV1b']) {
    ingestVideo(db, {
      source: 'bilibili',
      video: {
        source_vid: vid,
        creator: { source_uid: '1', name: 'up' },
        title: `t-${vid}`,
        extra: { aid: 1 },
        duration: 10, published_at: 1700000000000,
      },
      tracks: [],
    });
  }
}

test('applyVideoTags：打标即建标 + 多档并存 + 幂等', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    const refs = [{ source: 'bilibili', source_vid: 'BV1a' }, { source: 'bilibili', source_vid: 'BV1b' }];

    const r1 = applyVideoTags(db, refs, ['ai', '面试题'], 'batch');
    assert.equal(r1.inserted, 4); // 2 视频 × 2 标签
    assert.deepEqual(r1.missing, []);

    // 同名标签另一档并存（UNIQUE 含 source，不撞）
    const r2 = applyVideoTags(db, refs, ['ai'], 'ai');
    assert.equal(r2.inserted, 2);

    // 重复 apply 同档同名 → INSERT OR IGNORE 幂等
    const r3 = applyVideoTags(db, refs, ['ai', '面试题'], 'batch');
    assert.equal(r3.inserted, 0);

    // 库里不存在的视频 → missing 带清单，不抛
    const r4 = applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BVnope' }], ['ai'], 'batch');
    assert.deepEqual(r4.missing, [{ source: 'bilibili', source_vid: 'BVnope' }]);

    const tags = listTags(db);
    assert.equal(tags.length, 2);
    const ai = tags.find((t) => t.name === 'ai')!;
    assert.deepEqual(ai.counts, { manual: 0, batch: 2, ai: 2, total: 4 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('listTags：q 过滤 + source 档位过滤 + 排序', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    const refs = [{ source: 'bilibili', source_vid: 'BV1a' }];
    applyVideoTags(db, refs, ['机器学习', '面试题'], 'ai');
    applyVideoTags(db, refs, ['面试题'], 'manual');

    // q 模糊
    assert.deepEqual(listTags(db, { q: '面试' }).map((t) => t.name), ['面试题']);
    // source=ai 只列 ai 档 >0 的标签：机器学习（ai=1）+ 面试题（ai=1）；counts 保持三档全量
    const aiOnly = listTags(db, { source: 'ai' });
    assert.deepEqual(aiOnly.map((t) => t.name).sort(), ['机器学习', '面试题']);
    assert.equal(aiOnly.find((t) => t.name === '面试题')!.counts.ai, 1);
    assert.equal(aiOnly.find((t) => t.name === '面试题')!.counts.manual, 1); // 全量计数含 manual
    // total 排序（默认）：面试题 total=2 > 机器学习 1
    assert.equal(listTags(db)[0].name, '面试题');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('removeVideoTags：指定档删 / 省略 source 删全档 / 关系删净标签保留', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    const refs = [{ source: 'bilibili', source_vid: 'BV1a' }];
    applyVideoTags(db, refs, ['ai'], 'batch');
    applyVideoTags(db, refs, ['ai'], 'ai');

    // 只删 batch 档 → ai 档关系还在
    let r = removeVideoTags(db, refs, ['ai'], 'batch');
    assert.equal(r.removed, 1);
    let detail = getVideoTagsForDetail(db, 1);
    assert.equal(detail.length, 1);
    assert.equal(detail[0].source, 'ai');

    // 省略 source → 删全档
    r = removeVideoTags(db, refs, ['ai']);
    assert.equal(r.removed, 1);
    assert.equal(getVideoTagsForDetail(db, 1).length, 0);

    // 标签库行保留（计数归 0，不因移除关系消失）
    assert.equal(listTags(db).find((t) => t.name === 'ai')!.counts.total, 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('renameTag：关系自动跟随 tag_id；撞名抛 UNIQUE', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    const refs = [{ source: 'bilibili', source_vid: 'BV1a' }];
    applyVideoTags(db, refs, ['旧名'], 'manual');
    applyVideoTags(db, refs, ['新名'], 'manual');

    const renamed = renameTag(db, 1, '改名后');
    assert.equal(renamed!.name, '改名后');
    // 关系自动跟随（tag_id 不变）
    assert.equal(getVideoTagsForDetail(db, 1).some((t) => t.name === '改名后'), true);

    // 撞已有名 → UNIQUE 错误（http 层转 409）
    assert.throws(() => renameTag(db, 1, '新名'), /UNIQUE/);
    // 不存在的 id → null
    assert.equal(renameTag(db, 999, 'x'), null);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deleteTag：事务删关系+标签，无孤儿', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    const refs = [{ source: 'bilibili', source_vid: 'BV1a' }, { source: 'bilibili', source_vid: 'BV1b' }];
    applyVideoTags(db, refs, ['ai'], 'batch');
    const tagId = listTags(db)[0].id;

    assert.equal(deleteTag(db, tagId), true);
    assert.equal(listTags(db).length, 0);
    // 无孤儿关系
    assert.equal(getVideoTagsByVideoIds(db, [1, 2]).size, 0);
    assert.equal(deleteTag(db, tagId), false); // 再删 false
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('getVideoTagsByVideoIds：批查分组正确', () => {
  const { db, dir } = freshDb();
  try {
    seedVideos(db);
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1a' }], ['x'], 'manual');
    applyVideoTags(db, [{ source: 'bilibili', source_vid: 'BV1b' }], ['y'], 'ai');
    const map = getVideoTagsByVideoIds(db, [1, 2]);
    assert.deepEqual(map.get(1), [{ name: 'x', source: 'manual' }]);
    assert.deepEqual(map.get(2), [{ name: 'y', source: 'ai' }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
