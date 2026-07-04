// versions.ts 纯处理函数单测：临时文件 DB + ingestVideo 样本，断言 payload 结构。
// 跑法（不在 pnpm test glob 内）：cd apps/collector-server && node --test --import tsx src/cli/commands/versions.test.ts
//
// 测试轮次记录表（对齐全局 8.2）：
// | 轮次 | 范围 | 结果 | 备注 |
// |---|---|---|---|
// | R1 | versionsGet 纯函数（payload 解析 + 未找到） | 通过 | 临时 DB，无副作用 |

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, migrate } from '../../db/migrate.js';
import { ingestVideo } from '../../db/ingest.js';
import { versionsGet } from './versions.js';

const T = 1_700_000_000_000;

// 构造样本库：1 视频，2 字幕轨（zh-Hans external / en asr），共 2 条字幕版本。
function setup(): { db: Database.Database; dir: string; versionIds: number[] } {
  const dir = mkdtempSync(join(tmpdir(), 'cli-versions-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  ingestVideo(db, {
    source: 'bilibili',
    video: {
      source_vid: 'BV1', title: '标题A',
      creator: { source_uid: '1', name: 'Alpha UP' },
      extra: {}, duration: 600, published_at: T + 1000,
    },
    tracks: [
      { lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [
        { origin: 'external', payload: { body: [{ from: 0, to: 1.5, content: '你好世界' }] }, source_url: 'https://cc' },
      ] },
      { lan: 'en', lan_doc: 'English', track_type: 1, versions: [
        { origin: 'asr', payload: { body: [{ from: 0, to: 1.5, content: 'hello world' }] }, asr_engine: 'whisper' },
      ] },
    ],
  });
  const versionIds = (db.prepare('SELECT id FROM subtitle_versions ORDER BY id').all() as Array<{ id: number }>).map((r) => r.id);
  return { db, dir, versionIds };
}

test('versionsGet: 返回 payload 解析后的对象（非字符串）', () => {
  const { db, dir, versionIds } = setup();
  try {
    assert.ok(versionIds.length >= 2, '应有至少 2 条字幕版本');
    const v = versionsGet(db, versionIds[0]);
    if (!v) throw new Error('expected version');
    assert.equal(v.id, versionIds[0]);
    assert.ok(v.origin === 'external' || v.origin === 'asr');
    assert.equal(typeof v.payload, 'object');
    assert.ok(Array.isArray((v.payload as { body: unknown[] }).body));
    assert.equal(typeof v.captured_at, 'number');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versionsGet: 不同 origin 的版本可分别取到', () => {
  const { db, dir, versionIds } = setup();
  try {
    const origins = versionIds.map((id) => versionsGet(db, id)?.origin).sort();
    assert.deepEqual(origins, ['asr', 'external']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('versionsGet: 不存在返回 null', () => {
  const { db, dir } = setup();
  try {
    assert.equal(versionsGet(db, 99999), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
