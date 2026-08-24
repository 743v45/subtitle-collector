// clients 注册表（2026-08-24 popup 改名）持久层测试：upsert 三态 / touch / listKnownClients 排序。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, migrate } from './migrate.js';
import { upsertClient, touchClientLastSeen, listKnownClients } from './clients.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-clients-db-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  return { db, dir };
}

test('upsertClient：string 设名 → 再 upsert 覆盖；null 显式清除', () => {
  const { db, dir } = freshDb();
  try {
    upsertClient(db, 'ext-A', '书房 iMac');
    let rows = listKnownClients(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, '书房 iMac');

    upsertClient(db, 'ext-A', ' MacBook '); // 覆盖（ws 层已 trim，这里原样存取验证 upsert 路径）
    assert.equal(listKnownClients(db)[0].name, ' MacBook ');

    upsertClient(db, 'ext-A', null); // 显式清除（新版扩展 hello 带 client_name: null）
    assert.equal(listKnownClients(db)[0].name, null);
    assert.equal(listKnownClients(db).length, 1, '清除是 UPDATE 非删行');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('upsertClient：undefined（旧扩展 hello 未上报）→ 只刷 last_seen_at，DB 旧名保留不抹', () => {
  const { db, dir } = freshDb();
  try {
    upsertClient(db, 'ext-A', '旧名字');
    const before = listKnownClients(db)[0];
    upsertClient(db, 'ext-A', undefined); // 重连但 hello 不带 client_name 字段
    const after = listKnownClients(db)[0];
    assert.equal(after.name, '旧名字', '名字不动');
    assert.equal(after.first_seen_at, before.first_seen_at, '首见时间不动');
    assert.ok(after.last_seen_at >= before.last_seen_at, 'last_seen_at 刷新');

    // 全新 client_id 走 undefined 分支：name 落 NULL
    upsertClient(db, 'ext-B', undefined);
    const b = listKnownClients(db).find((r) => r.client_id === 'ext-B')!;
    assert.equal(b.name, null);
    assert.ok(b.first_seen_at > 0 && b.last_seen_at > 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('touchClientLastSeen：断开时刷新 last_seen_at（first_seen/名字不动）', () => {
  const { db, dir } = freshDb();
  try {
    upsertClient(db, 'ext-A', 'x');
    const before = listKnownClients(db)[0];
    touchClientLastSeen(db, 'ext-A');
    const after = listKnownClients(db)[0];
    assert.equal(after.first_seen_at, before.first_seen_at);
    assert.equal(after.name, 'x');
    assert.ok(after.last_seen_at >= before.last_seen_at);
    touchClientLastSeen(db, 'ghost'); // 不存在的 id：UPDATE 0 行，不炸不插
    assert.equal(listKnownClients(db).length, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('listKnownClients：按 last_seen_at 降序（最近活跃在前）', () => {
  const { db, dir } = freshDb();
  try {
    upsertClient(db, 'old', undefined);
    // 同毫秒内连续 upsert 会并列（Date.now 精度 ms，SQLite 并列值顺序不定）：
    // 手动把 old 回拨 1s，制造确定性次序
    db.prepare("UPDATE clients SET last_seen_at = last_seen_at - 1000 WHERE client_id = 'old'").run();
    upsertClient(db, 'new', undefined);
    assert.deepEqual(listKnownClients(db).map((r) => r.client_id), ['new', 'old']);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// ── 登录态/版本落库（2026-08-24 充电视频 no_subtitle 根因可观察化）──

test('upsertClient meta：bili_login/ext_version 覆盖 → undefined 不动 → null 清除（三态同 name）', () => {
  const { db, dir } = freshDb();
  try {
    const login = JSON.stringify({ is_login: true, mid: '42', uname: '测试用户', vip: false });
    upsertClient(db, 'ext-A', '书房', { biliLogin: login, extVersion: '0.1.21' });
    let row = listKnownClients(db)[0];
    assert.equal(row.bili_login, login);
    assert.equal(row.ext_version, '0.1.21');

    // undefined（旧扩展 hello 不带 bili_login 字段）→ 旧值保留（只刷 last_seen_at）
    upsertClient(db, 'ext-A', undefined);
    row = listKnownClients(db)[0];
    assert.equal(row.bili_login, login, '登录态快照不动');
    assert.equal(row.ext_version, '0.1.21', '版本不动');

    // null → 显式清除（探测失败重置场景）
    upsertClient(db, 'ext-A', undefined, { biliLogin: null, extVersion: null });
    row = listKnownClients(db)[0];
    assert.equal(row.bili_login, null);
    assert.equal(row.ext_version, null);

    // 全新 client 只带 meta 不带 name：name 落 NULL，meta 正常入库
    upsertClient(db, 'ext-B', undefined, { biliLogin: JSON.stringify({ is_login: false }), extVersion: '0.1.21' });
    const b = listKnownClients(db).find((r) => r.client_id === 'ext-B')!;
    assert.equal(b.name, null);
    assert.deepEqual(JSON.parse(b.bili_login!), { is_login: false });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
