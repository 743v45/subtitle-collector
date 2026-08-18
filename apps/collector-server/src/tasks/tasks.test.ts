import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { extractVideoUrl, expandShortLink, parseVideoUrl, createTask, getTask, listTasks, resetDispatched, type FetchLike } from './tasks.js';

function setupDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'collector-tasks-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db); // schema.sql 含 collect_tasks 建表
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

// ── extractVideoUrl：从粘贴文本提取视频 URL ──

test('extractVideoUrl：从 B 站分享文案提取 b23.tv 短链', () => {
  const text = '【我又整了个新活!】 https://b23.tv/AbCdEfG 快来看!';
  assert.equal(extractVideoUrl(text), 'https://b23.tv/AbCdEfG');
});

test('extractVideoUrl：裸 URL 直接命中', () => {
  assert.equal(extractVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(extractVideoUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(extractVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('extractVideoUrl：非视频站 URL / 无 URL → null', () => {
  assert.equal(extractVideoUrl('https://example.com/foo'), null);
  assert.equal(extractVideoUrl('没有链接的纯文本'), null);
  assert.equal(extractVideoUrl(''), null);
});

// ── expandShortLink：短链跟随重定向 ──

test('expandShortLink：b23.tv 重定向到视频页（取 Response.url）', async () => {
  // Response 构造器不支持设置 url（只读,反映真实网络请求）,mock 返回带 url 字段的类 Response 对象
  const fetcher: FetchLike = async () => ({ url: 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999' } as unknown as Response);
  const out = await expandShortLink('https://b23.tv/AbCdEfG', fetcher);
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999');
});

test('expandShortLink：非短链域名原样返回（不发请求）', async () => {
  let called = false;
  const fetcher: FetchLike = async () => { called = true; return new Response(''); };
  const out = await expandShortLink('https://www.bilibili.com/video/BV1xx411c7mD', fetcher);
  assert.equal(out, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(called, false);
});

test('expandShortLink：fetch 失败回退原 URL', async () => {
  const fetcher: FetchLike = async () => { throw new Error('network down'); };
  const out = await expandShortLink('https://b23.tv/AbCdEfG', fetcher);
  assert.equal(out, 'https://b23.tv/AbCdEfG');
});

// ── parseVideoUrl：标准 URL → 平台 + 视频 ID ──

test('parseVideoUrl：B 站 /video/BV 路径', () => {
  const t = parseVideoUrl('https://www.bilibili.com/video/BV1xx411c7mD?spm_id_from=333.999');
  assert.deepEqual(t, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
});

test('parseVideoUrl：B 站 ?bvid= 查询参数', () => {
  const t = parseVideoUrl('https://www.bilibili.com/?bvid=BV1xx411c7mD');
  assert.equal(t?.source, 'bilibili');
  assert.equal(t?.source_vid, 'BV1xx411c7mD');
});

test('parseVideoUrl：YouTube watch / shorts / youtu.be / music', () => {
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.deepEqual(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?si=abc'), { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(parseVideoUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ')?.source_vid, 'dQw4w9WgXcQ');
});

test('parseVideoUrl：不可识别 → null', () => {
  assert.equal(parseVideoUrl('https://b23.tv/AbCdEfG'), null); // 未展开的短链解析不出
  assert.equal(parseVideoUrl('https://www.bilibili.com/video/av170001'), null); // av 号不支持（第一阶段只支持 BV）
  assert.equal(parseVideoUrl('https://www.youtube.com/channel/UCxxx'), null);
  assert.equal(parseVideoUrl('https://example.com'), null);
  assert.equal(parseVideoUrl('不是URL'), null);
});

// ── 任务 CRUD ──

test('createTask/getTask/listTasks：建 pending 任务、按 id 倒序列出', () => {
  const { db, cleanup } = setupDb();
  try {
    const t1 = createTask(db, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://www.bilibili.com/video/BV1xx411c7mD' });
    const t2 = createTask(db, { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    assert.equal(t1.status, 'pending');
    assert.equal(t1.source, 'bilibili');
    assert.equal(getTask(db, t1.id)?.source_vid, 'BV1xx411c7mD');
    assert.equal(getTask(db, 99999), null);

    const { total, items } = listTasks(db, 20);
    assert.equal(total, 2);
    assert.equal(items[0].id, t2.id); // 倒序：最新在前
    assert.equal(items[1].id, t1.id);
  } finally { cleanup(); }
});

test('resetDispatched：dispatched → pending，终态不动', () => {
  const { db, cleanup } = setupDb();
  try {
    const t = createTask(db, { source: 'bilibili', source_vid: 'BV1xx411c7mD', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='dispatched', client_id='ext-A' WHERE id=?").run(t.id);
    const t2 = createTask(db, { source: 'youtube', source_vid: 'dQw4w9WgXcQ', url: 'https://x' });
    db.prepare("UPDATE collect_tasks SET status='succeeded', finished_at=? WHERE id=?").run(Date.now(), t2.id);

    resetDispatched(db);
    assert.equal(getTask(db, t.id)?.status, 'pending');
    assert.equal(getTask(db, t.id)?.client_id, null);
    assert.equal(getTask(db, t2.id)?.status, 'succeeded'); // 终态不受影响
  } finally { cleanup(); }
});
