// /api/videos 列表项富化字段测试（pot_limited 受限标记：web UI 本次未消费，字段先备好）。
// 模式对齐 tags.test.ts：handler 直挂测试 server + fetch。
// 跑法：cd apps/collector-server && node --test --import tsx src/http/queries.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { handleQueryHttp } from './queries.js';

async function setup(): Promise<{ db: Database.Database; port: number; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'collector-queries-http-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  // BV1 有字幕；BV2 无字幕（测试体内按需补 collect_tasks 行制造 limited 形态）
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV1', title: '有字幕', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [{ lan: 'zh-Hans', lan_doc: 'CC中文', track_type: 2, versions: [{ origin: 'external', payload: { body: [{ from: 0, to: 1, content: 'x' }] }, source_url: 'https://a' }] }],
  });
  ingestVideo(db, {
    source: 'bilibili',
    video: { source_vid: 'BV2', title: '无字幕', creator: { source_uid: '1', name: 'up' }, extra: {}, duration: 60, published_at: 1 },
    tracks: [],
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleQueryHttp(req, res, db);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  return { db, port, cleanup: () => { server.close(); db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

async function call(port: number, path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function itemsByVid(port: number): Promise<Record<string, any>> {
  const r = await call(port, '/api/videos?size=100');
  assert.equal(r.status, 200);
  return Object.fromEntries(r.json.items.map((i: any) => [i.source_vid, i]));
}

test('/api/videos: 列表项含 pot_limited（最近任务 limited → true；重采成功 → false）', async () => {
  const s = await setup();
  try {
    // 初始：无任务记录 → 全 false（真无字幕与有字幕 alike）
    let byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV1.pot_limited, false, '无任务记录 → false');
    assert.equal(byVid.BV2.pot_limited, false, '真无字幕（无任务）→ false');

    // BV2 最近任务 limited → true（半入库：元信息在、0 轨）
    s.db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'limited', 100, 200)").run();
    byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV2.pot_limited, true, '最近任务 limited → true');
    assert.equal(byVid.BV1.pot_limited, false, '其它视频不受影响');

    // 重采成功（id 更大的 succeeded 成为最近一条）→ 标记自然消失
    s.db.prepare("INSERT INTO collect_tasks (source, source_vid, url, status, created_at, finished_at) VALUES ('bilibili', 'BV2', 'https://b23.tv/BV2', 'succeeded', 300, 400)").run();
    byVid = await itemsByVid(s.port);
    assert.equal(byVid.BV2.pot_limited, false, '重采成功后标记消失（任务表派生，无回清维护）');
  } finally { s.cleanup(); }
});
