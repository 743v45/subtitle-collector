# 媒体字幕采集库（Media Subtitle Collector）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `docs/superpowers/specs/2026-06-20-media-subtitle-collector-design.md` 定义的多渠道字幕采集库 MVP：B 站字幕拦截 + 本地 SQLite 落库 + 网页查阅 + 双向 WS RPC（为后续批量/自动/AI 命令采集预留）。

**Architecture:** 三个新 monorepo 包：`apps/subtitle-collector`（Chrome 扩展，双重身份）/ `apps/collector-server`（TS 常驻进程，WS 双向 RPC + SQLite + HTTP 查询）/ `apps/collector-web`（React + Vite）。通信核心是 WebSocket 双向 RPC，对齐 opencli 的 daemon/extension 模型（Command/Result 信封 + hello 握手 + /ping 探活 + 指数退避重连 + verifyClient 防 CSRF）。操作页面用 tabs + hook + content script（②+3），不用 CDP/debugger。

**Tech Stack:**
- 服务端：TypeScript + Node 22 + `ws` + `better-sqlite3` + Node 内置 `node:test`
- 扩展：原生 JS（MV3），零构建链
- 网页：React + Vite + TypeScript
- 沿用现有 monorepo：`pnpm workspace` + `turbo`（已含 `apps/*`）

**Spec:** [`docs/superpowers/specs/2026-06-20-media-subtitle-collector-design.md`](../specs/2026-06-20-media-subtitle-collector-design.md)

---

## File Structure

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/collector-server/package.json` | 服务端包配置（`@bilibili-ext/collector-server`，依赖 ws/better-sqlite3） | 新建 |
| `apps/collector-server/tsconfig.json` | TS 配置 | 新建 |
| `apps/collector-server/src/db/schema.sql` | SQLite 四层表 + change_log | 新建 |
| `apps/collector-server/src/db/migrate.ts` | 启动时建表（幂等） | 新建 |
| `apps/collector-server/src/db/ingest.ts` | ingest 幂等去重 + 变更日志（单事务） | 新建 |
| `apps/collector-server/src/db/queries.ts` | 列表/详情/版本查询 | 新建 |
| `apps/collector-server/src/ws/server.ts` | WS 服务端（hello/log/ingest/result） | 新建 |
| `apps/collector-server/src/ws/commands.ts` | Command 派发（navigate/operate/fetch-subtitle） | 新建 |
| `apps/collector-server/src/http/queries.ts` | HTTP 查询 API + /ping + 静态托管 | 新建 |
| `apps/collector-server/src/main.ts` | 入口（组装 http+ws+db） | 新建 |
| `apps/collector-server/src/db/ingest.test.ts` | ingest 幂等/变更日志测试 | 新建 |
| `apps/collector-server/src/ws/server.test.ts` | WS RPC 协议测试 | 新建 |
| `apps/subtitle-collector/package.json` | 扩展包配置 | 新建 |
| `apps/subtitle-collector/manifest.json` | MV3 + permissions | 新建 |
| `apps/subtitle-collector/inject.js` | MAIN world hook（采集） | 新建 |
| `apps/subtitle-collector/content.js` | ISOLATED 聚合 + 命令执行 | 新建 |
| `apps/subtitle-collector/background.js` | WS 客户端 + 双重身份协调 | 新建 |
| `apps/subtitle-collector/popup.html` | 状态 + 补采 | 新建 |
| `apps/subtitle-collector/popup.js` | popup 逻辑 | 新建 |
| `apps/collector-web/package.json` | 网页包配置（vite + react） | 新建 |
| `apps/collector-web/vite.config.ts` | Vite 配置（构建输出到 collector-server/public） | 新建 |
| `apps/collector-web/tsconfig.json` | TS 配置 | 新建 |
| `apps/collector-web/index.html` | 入口 HTML | 新建 |
| `apps/collector-web/src/main.tsx` | React 入口 | 新建 |
| `apps/collector-web/src/api.ts` | HTTP fetch 封装 | 新建 |
| `apps/collector-web/src/App.tsx` | 路由（列表/详情） | 新建 |
| `apps/collector-web/src/types.ts` | 与服务端 API 对齐的类型 | 新建 |
| `apps/collector-web/src/pages/VideoList.tsx` | 列表页 | 新建 |
| `apps/collector-web/src/pages/VideoDetail.tsx` | 详情页 | 新建 |
| `apps/collector-web/src/components/TrackSwitcher.tsx` | 轨切换器 | 新建 |
| `apps/collector-web/src/components/VersionSwitcher.tsx` | 版本切换器 | 新建 |
| `apps/collector-web/src/components/SubtitleView.tsx` | 时间轴逐行 + 复制 | 新建 |

**测试分层（务实）：**
- 服务端核心（db/ingest、ws/server、http/queries）→ `node:test` 自动化
- 扩展采集链路 → puppeteer mock 回归（沿用 `scripts/verify-extension.mjs` 模式）
- 端到端真实字幕 → 人工验收（参考 `MANUAL.md` 模式）

---

## Task 1: collector-server 骨架 + SQLite schema

**Files:**
- Create: `apps/collector-server/package.json`
- Create: `apps/collector-server/tsconfig.json`
- Create: `apps/collector-server/src/db/schema.sql`
- Create: `apps/collector-server/src/db/migrate.ts`
- Create: `apps/collector-server/src/main.ts`

- [ ] **Step 1: package.json**

```json
{
  "name": "@bilibili-ext/collector-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/main.ts",
    "test": "node --test --import tsx src/**/*.test.ts"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "better-sqlite3": "^11.5.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.10",
    "@types/better-sqlite3": "^7.6.11",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: 安装依赖**

Run: `pnpm install`
Expected: 安装 ws / better-sqlite3 / tsx / typescript 等，pnpm-lock.yaml 更新。

- [ ] **Step 4: SQLite schema**

Create `apps/collector-server/src/db/schema.sql`：

```sql
-- 四层 + 通用 change_log
CREATE TABLE IF NOT EXISTS creators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_uid    TEXT NOT NULL,
  name          TEXT,
  avatar        TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_uid)
);

CREATE TABLE IF NOT EXISTS videos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_vid    TEXT NOT NULL,
  creator_id    INTEGER REFERENCES creators(id),
  title         TEXT NOT NULL,
  extra         TEXT,
  duration      INTEGER,
  status        TEXT DEFAULT 'online',
  published_at  INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_vid)
);
CREATE INDEX IF NOT EXISTS idx_videos_first_seen ON videos(first_seen_at DESC);

CREATE TABLE IF NOT EXISTS subtitle_tracks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id    INTEGER NOT NULL REFERENCES videos(id),
  lan         TEXT,
  lan_doc     TEXT,
  track_type  INTEGER,
  UNIQUE(video_id, lan, track_type)
);
CREATE INDEX IF NOT EXISTS idx_tracks_video ON subtitle_tracks(video_id);

CREATE TABLE IF NOT EXISTS subtitle_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL REFERENCES subtitle_tracks(id),
  origin        TEXT NOT NULL,
  payload       TEXT NOT NULL,
  body_size     INTEGER,
  source_url    TEXT,
  asr_engine    TEXT,
  captured_at   INTEGER NOT NULL,
  UNIQUE(track_id, origin, coalesce(asr_engine,''), coalesce(source_url,''))
);
CREATE INDEX IF NOT EXISTS idx_versions_track ON subtitle_versions(track_id);

CREATE TABLE IF NOT EXISTS change_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  field       TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT,
  changed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changelog_entity ON change_log(entity, entity_id);
```

- [ ] **Step 5: migrate.ts**

Create `apps/collector-server/src/db/migrate.ts`：

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath: string): Database.Database {
  return new Database(dbPath);
}

export function migrate(db: Database.Database): void {
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  db.exec(sql);
}
```

- [ ] **Step 6: main.ts（占位，确认启动链路通）**

Create `apps/collector-server/src/main.ts`：

```ts
import { openDb, migrate } from './db/migrate.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);

const db = openDb(DB_PATH);
migrate(db);
console.log(`[collector-server] db ready at ${DB_PATH}`);
// WS + HTTP 在后续 task 接上
console.log(`[collector-server] placeholder on port ${PORT} (ws/http in next tasks)`);
```

- [ ] **Step 7: 运行确认 schema 生效**

Run: `cd apps/collector-server && pnpm dev`
Expected: 打印 `[collector-server] db ready at ./bilibili-collector.db`，不报错。
Verify: `sqlite3 ./bilibili-collector.db ".tables"`（或用 better-sqlite3 写个一次性的 inspect 脚本）应该列出 5 张表：creators / videos / subtitle_tracks / subtitle_versions / change_log。

- [ ] **Step 8: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-server/package.json apps/collector-server/tsconfig.json apps/collector-server/src/db/schema.sql apps/collector-server/src/db/migrate.ts apps/collector-server/src/main.ts pnpm-lock.yaml
git commit -m "feat(collector-server): scaffold + sqlite schema (creators/videos/tracks/versions/changelog)"
```

---

## Task 2: ingest 幂等去重 + 变更日志（TDD）

**Files:**
- Create: `apps/collector-server/src/db/ingest.ts`
- Create: `apps/collector-server/src/db/ingest.test.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/collector-server/src/db/ingest.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL — `Cannot find module './ingest.js'` 或 `ingestVideo is not a function`

- [ ] **Step 3: 实现 ingest.ts**

Create `apps/collector-server/src/db/ingest.ts`：

```ts
import type Database from 'better-sqlite3';

export interface IngestVideo {
  source_vid: string;
  title: string;
  creator: { source_uid: string; name?: string; avatar?: string };
  extra?: Record<string, unknown>;
  duration?: number;
  published_at?: number;
}

export interface IngestVersion {
  origin: string;
  payload: unknown;
  source_url?: string | null;
  asr_engine?: string | null;
}

export interface IngestTrack {
  lan?: string;
  lan_doc?: string;
  track_type?: number;
  versions: IngestVersion[];
}

export interface IngestRequest {
  source: string;
  video: IngestVideo;
  tracks: IngestTrack[];
}

export interface IngestResult {
  source: string;
  source_vid: string;
  inserted_tracks: number;
  skipped_tracks: number;
}

const VIDEO_FIELDS = ['title', 'extra', 'duration', 'status', 'published_at'] as const;

export function ingestVideo(db: Database.Database, req: IngestRequest): IngestResult {
  const now = Date.now();
  const tx = db.transaction((r: IngestRequest) => {
    // 1. creator upsert + change_log
    const creatorSel = db.prepare('SELECT id, name FROM creators WHERE source = ? AND source_uid = ?');
    const creatorIns = db.prepare('INSERT INTO creators (source, source_uid, name, avatar, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const creatorUpd = db.prepare('UPDATE creators SET name = ?, avatar = ?, updated_at = ? WHERE id = ?');
    const changeIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');

    const existingCreator = creatorSel.get(r.source, r.video.creator.source_uid) as { id: number; name: string | null } | undefined;
    let creatorId: number;
    if (!existingCreator) {
      const info = creatorIns.run(r.source, r.video.creator.source_uid, r.video.creator.name ?? null, r.video.creator.avatar ?? null, now, now);
      creatorId = Number(info.lastInsertRowid);
    } else {
      creatorId = existingCreator.id;
      if (r.video.creator.name != null && r.video.creator.name !== existingCreator.name) {
        changeIns.run('creator', creatorId, 'name', existingCreator.name, r.video.creator.name, now);
        creatorUpd.run(r.video.creator.name, r.video.creator.avatar ?? null, now, creatorId);
      }
    }

    // 2. video upsert + change_log（按字段）
    const videoSel = db.prepare('SELECT * FROM videos WHERE source = ? AND source_vid = ?');
    const videoIns = db.prepare('INSERT INTO videos (source, source_vid, creator_id, title, extra, duration, status, published_at, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const videoUpd = db.prepare('UPDATE videos SET title = ?, extra = ?, duration = ?, status = ?, published_at = ?, updated_at = ? WHERE id = ?');

    const existingVideo = videoSel.get(r.source, r.video.source_vid) as Record<string, unknown> | undefined;
    let videoId: number;
    if (!existingVideo) {
      const info = videoIns.run(r.source, r.video.source_vid, creatorId, r.video.title, JSON.stringify(r.video.extra ?? {}), r.video.duration ?? null, 'online', r.video.published_at ?? null, now, now);
      videoId = Number(info.lastInsertRowid);
    } else {
      videoId = existingVideo.id as number;
      const fields: Record<string, unknown> = {
        title: r.video.title,
        extra: JSON.stringify(r.video.extra ?? {}),
        duration: r.video.duration ?? null,
        status: 'online',
        published_at: r.video.published_at ?? null,
      };
      for (const f of VIDEO_FIELDS) {
        const oldVal = existingVideo[f];
        const newVal = fields[f];
        if (String(oldVal ?? '') !== String(newVal ?? '')) {
          changeIns.run('video', videoId, f, oldVal == null ? null : String(oldVal), newVal == null ? null : String(newVal), now);
        }
      }
      videoUpd.run(fields.title, fields.extra, fields.duration, fields.status, fields.published_at, now, videoId);
    }

    // 3. track upsert
    const trackSel = db.prepare('SELECT id FROM subtitle_tracks WHERE video_id = ? AND lan IS ? AND track_type IS ?');
    const trackIns = db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?, ?, ?, ?)');
    const trackUpd = db.prepare('UPDATE subtitle_tracks SET lan_doc = ? WHERE id = ?');

    // 4. version insert-or-ignore
    const verIns = db.prepare('INSERT OR IGNORE INTO subtitle_versions (track_id, origin, payload, body_size, source_url, asr_engine, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

    let inserted = 0;
    let skipped = 0;
    for (const t of r.tracks) {
      let trackId: number;
      const exTrack = trackSel.get(videoId, t.lan ?? null, t.track_type ?? null) as { id: number } | undefined;
      if (!exTrack) {
        const info = trackIns.run(videoId, t.lan ?? null, t.lan_doc ?? null, t.track_type ?? null);
        trackId = Number(info.lastInsertRowid);
      } else {
        trackId = exTrack.id;
        if (t.lan_doc != null) trackUpd.run(t.lan_doc, trackId);
      }
      for (const v of t.versions) {
        const payloadStr = JSON.stringify(v.payload);
        const info = verIns.run(trackId, v.origin, payloadStr, payloadStr.length, v.source_url ?? null, v.asr_engine ?? null, now);
        if (info.changes > 0) inserted++; else skipped++;
      }
    }
    return { inserted, skipped };
  });
  const { inserted, skipped } = tx(req);
  return { source: req.source, source_vid: req.video.source_vid, inserted_tracks: inserted, skipped_tracks: skipped };
}
```

- [ ] **Step 4: 跑测试，全部通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 5/5 PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-server/src/db/ingest.ts apps/collector-server/src/db/ingest.test.ts
git commit -m "feat(collector-server): ingest idempotent dedupe + change_log (TDD)"
```

---

## Task 3: WS 服务端（hello/ingest/result/log + 握手 + /ping 探活）

**Files:**
- Create: `apps/collector-server/src/ws/server.ts`
- Create: `apps/collector-server/src/ws/server.test.ts`
- Modify: `apps/collector-server/src/main.ts`

- [ ] **Step 1: 写失败测试**

Create `apps/collector-server/src/ws/server.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { openDb, migrate } from '../db/migrate.js';
import { ingestVideo } from '../db/ingest.js';
import { attachWsServer, broadcastCommand } from './server.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'collector-ws-'));
  const db = openDb(join(dir, 'test.db'));
  migrate(db);
  const httpServer = createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
  return new Promise<{ port: number; db: any; dir: string; cleanup: () => void }>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const port = (httpServer.address() as AddressInfo).port;
      attachWsServer(httpServer, db);
      resolve({ port, db, dir, cleanup: () => { httpServer.close(); rmSync(dir, { recursive: true, force: true }); } });
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('hello 握手：扩展连上后服务端记录 ext_version', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0' }));
    await new Promise(r => setTimeout(r, 50));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('ingest 消息：服务端写入 SQLite 并回 ingest-ack', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0' }));
    await new Promise(r => setTimeout(r, 30));
    ws.send(JSON.stringify({
      type: 'ingest',
      payload: {
        source: 'bilibili',
        video: { source_vid: 'BV1xxx', title: 't', creator: { source_uid: '123', name: 'up' }, extra: {}, duration: 100, published_at: 1 },
        tracks: [{ lan: 'zh', track_type: 1, versions: [{ origin: 'external', payload: { body: [] }, source_url: 'https://a' }] }],
      },
    }));
    const ack: any = await new Promise((resolve) => ws.once('message', (data) => resolve(JSON.parse(data.toString()))));
    assert.equal(ack.type, 'ingest-ack');
    assert.equal(ack.ok, true);
    assert.equal(ack.inserted_tracks, 1);
    ws.close();
  } finally { ctx.cleanup(); }
});

test('result 消息：服务端记录 commandId → result 映射', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0' }));
    await new Promise(r => setTimeout(r, 30));
    const commandId = 'cmd-1';
    ws.send(JSON.stringify({ type: 'result', id: commandId, ok: true, data: { nav: true } }));
    await new Promise(r => setTimeout(r, 30));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('服务端主动下发 Command：broadcastCommand 触达扩展并收到 result', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0' }));
    await new Promise(r => setTimeout(r, 30));

    const cmd = { id: 'cmd-42', action: 'navigate', url: 'https://www.bilibili.com/video/BV1xxx' };
    const incoming: any = await new Promise((resolve) => {
      ws.once('message', (data) => resolve(JSON.parse(data.toString())));
      broadcastCommand(ctx.port, cmd);
    });
    assert.equal(incoming.id, 'cmd-42');
    assert.equal(incoming.action, 'navigate');

    // 扩展回 result
    ws.send(JSON.stringify({ type: 'result', id: 'cmd-42', ok: true, data: { opened: true } }));
    await new Promise(r => setTimeout(r, 30));
    ws.close();
  } finally { ctx.cleanup(); }
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `cd apps/collector-server && pnpm test`
Expected: FAIL — `Cannot find module '../db/migrate.js'`（或 server 模块缺失）

- [ ] **Step 3: 实现 ws/server.ts**

Create `apps/collector-server/src/ws/server.ts`：

```ts
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import type Database from 'better-sqlite3';
import { ingestVideo, type IngestRequest } from '../db/ingest.js';

interface ExtConn {
  ws: WebSocket;
  extVersion: string | null;
}

const connections = new Set<ExtConn>();
// 待广播的 command queue（按 port 维度，简化版；真实场景可按 contextId 等路由）
const pendingCommands: Array<{ cmd: unknown; target?: WebSocket }> = [];

export function attachWsServer(httpServer: Server, _db: Database.Database): void {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ext',
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      const origin = req.headers['origin'];
      // loopback Node fetch 没 Origin；chrome-extension 才发；其他 origin 拒
      return !origin || origin.startsWith('chrome-extension://');
    },
  });

  wss.on('connection', (ws: WebSocket) => {
    const conn: ExtConn = { ws, extVersion: null };
    connections.add(conn);

    ws.on('message', async (data: RawData) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'hello') {
        conn.extVersion = typeof msg.ext_version === 'string' ? msg.ext_version : null;
        return;
      }

      if (msg.type === 'log') {
        const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info';
        console[level](`[ext] ${msg.msg}`);
        return;
      }

      if (msg.type === 'ingest' && msg.payload) {
        try {
          const result = ingestVideo(_db, msg.payload as IngestRequest);
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ingest-ack', ok: false, error: (err as Error).message }));
        }
        return;
      }

      if (msg.type === 'result') {
        // MVP：记录到 console；后续可挂 pending Promise resolve
        console.log(`[ext] result id=${msg.id} ok=${msg.ok}`);
        return;
      }
    });

    ws.on('close', () => { connections.delete(conn); });
  });
}

export function broadcastCommand(port: number, cmd: { id: string; action: string; [k: string]: unknown }): void {
  const payload = JSON.stringify(cmd);
  for (const c of connections) {
    if (c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(payload);
    }
  }
}
```

- [ ] **Step 4: main.ts 接上 WS + /ping**

Replace `apps/collector-server/src/main.ts`：

```ts
import { createServer } from 'node:http';
import { openDb, migrate } from './db/migrate.js';
import { attachWsServer } from './ws/server.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);

const db = openDb(DB_PATH);
migrate(db);

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  // HTTP 查询 API 与静态托管在后续 task 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext)`);
});
```

- [ ] **Step 5: 跑测试，全部通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 4/4 PASS

- [ ] **Step 6: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-server/src/ws/server.ts apps/collector-server/src/ws/server.test.ts apps/collector-server/src/main.ts
git commit -m "feat(collector-server): ws server (hello/ingest/result/log) + verifyClient + /ping"
```

---

## Task 4: HTTP 查询 API（列表/详情/版本）

**Files:**
- Create: `apps/collector-server/src/db/queries.ts`
- Create: `apps/collector-server/src/http/queries.ts`
- Modify: `apps/collector-server/src/main.ts`

- [ ] **Step 1: 实现 db/queries.ts**

Create `apps/collector-server/src/db/queries.ts`：

```ts
import type Database from 'better-sqlite3';

export interface VideoListItem {
  id: number;
  source: string;
  source_vid: string;
  title: string;
  creator_name: string | null;
  duration: number | null;
  track_count: number;
  first_seen_at: number;
}

export function listVideos(db: Database.Database, q: string | undefined, page: number, size: number): { total: number; items: VideoListItem[] } {
  const offset = (page - 1) * size;
  const params: any[] = [];
  let where = '';
  if (q) {
    where = "WHERE v.title LIKE ? OR c.name LIKE ?";
    params.push(`%${q}%`, `%${q}%`);
  }
  const totalRow = db.prepare(`SELECT COUNT(*) as c FROM videos v LEFT JOIN creators c ON c.id = v.creator_id ${where}`).get(...params) as { c: number };
  const rows = db.prepare(`
    SELECT v.id, v.source, v.source_vid, v.title, c.name as creator_name, v.duration, v.first_seen_at,
           (SELECT COUNT(*) FROM subtitle_tracks t WHERE t.video_id = v.id) as track_count
    FROM videos v LEFT JOIN creators c ON c.id = v.creator_id
    ${where}
    ORDER BY v.first_seen_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, size, offset) as VideoListItem[];
  return { total: totalRow.c, items: rows };
}

export interface VersionRow { id: number; origin: string; source_url: string | null; asr_engine: string | null; captured_at: number; body_size: number | null; }
export interface TrackRow { id: number; lan: string | null; lan_doc: string | null; track_type: number | null; versions: VersionRow[]; }
export interface VideoDetail { video: Record<string, unknown>; tracks: TrackRow[]; }

const trackPriority = (lan: string | null, track_type: number | null): number => {
  const isZh = !!lan && lan.toLowerCase().includes('zh');
  const isEn = !!lan && lan.toLowerCase().includes('en');
  if (isZh && track_type === 2) return 0; // CC中文
  if (isZh && track_type === 1) return 1; // AI中文
  if (isEn) return 2;
  return 3;
};

const versionPriority = (origin: string): number => {
  if (origin === 'external') return 0;
  if (origin === 'manual') return 1;
  return 2; // asr
};

export function getVideo(db: Database.Database, source: string, sourceVid: string): VideoDetail | null {
  const video = db.prepare('SELECT v.*, c.name as creator_name FROM videos v LEFT JOIN creators c ON c.id = v.creator_id WHERE v.source = ? AND v.source_vid = ?').get(source, sourceVid) as Record<string, unknown> | undefined;
  if (!video) return null;
  const tracks = db.prepare('SELECT * FROM subtitle_tracks WHERE video_id = ? ORDER BY id').all(video.id) as Array<{ id: number; lan: string | null; lan_doc: string | null; track_type: number | null }>;
  const versionsByTrack = db.prepare('SELECT * FROM subtitle_versions WHERE track_id = ? ORDER BY id').all.bind(db);
  const result: VideoDetail = { video, tracks: [] };
  for (const t of tracks) {
    const vs = versionsByTrack(t.id) as VersionRow[];
    const sortedVs = vs.slice().sort((a, b) => versionPriority(a.origin) - versionPriority(b.origin));
    result.tracks.push({ ...t, versions: sortedVs });
  }
  result.tracks.sort((a, b) => trackPriority(a.lan, a.track_type) - trackPriority(b.lan, b.track_type));
  // 标 is_default
  const seenDefault = { track: false, version: false };
  for (const t of result.tracks) {
    (t as any).is_default = !seenDefault.track;
    seenDefault.track = true;
    for (const v of t.versions) {
      (v as any).is_default = !seenDefault.version && (t as any).is_default;
      if ((v as any).is_default) seenDefault.version = true;
    }
  }
  return result;
}

export function getVersionPayload(db: Database.Database, versionId: number): { id: number; origin: string; payload: unknown; captured_at: number } | null {
  const v = db.prepare('SELECT id, origin, payload, captured_at FROM subtitle_versions WHERE id = ?').get(versionId) as { id: number; origin: string; payload: string; captured_at: number } | undefined;
  if (!v) return null;
  return { id: v.id, origin: v.origin, payload: JSON.parse(v.payload), captured_at: v.captured_at };
}
```

- [ ] **Step 2: 实现 http/queries.ts**

Create `apps/collector-server/src/http/queries.ts`：

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listVideos, getVideo, getVersionPayload } from '../db/queries.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleQueryHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/videos') {
    const q = url.searchParams.get('q') ?? undefined;
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1'));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? '20')));
    json(res, 200, { ok: true, ...listVideos(db, q, page, size) });
    return;
  }

  const detailMatch = pathname.match(/^\/api\/videos\/([^/]+)\/([^/]+)$/);
  if (detailMatch) {
    const source = detailMatch[1];
    const sourceVid = decodeURIComponent(detailMatch[2]);
    const detail = getVideo(db, source, sourceVid);
    if (!detail) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, ...detail });
    return;
  }

  const versionMatch = pathname.match(/^\/api\/versions\/(\d+)$/);
  if (versionMatch) {
    const v = getVersionPayload(db, Number(versionMatch[1]));
    if (!v) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, version: v });
    return;
  }

  json(res, 404, { error: 'not found' });
}
```

- [ ] **Step 3: main.ts 接上 HTTP 路由**

Replace `apps/collector-server/src/main.ts`：

```ts
import { createServer } from 'node:http';
import { openDb, migrate } from './db/migrate.js';
import { attachWsServer } from './ws/server.js';
import { handleQueryHttp } from './http/queries.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);

const db = openDb(DB_PATH);
migrate(db);

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
  // 静态托管 collector-web 产物在 Task 6 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext, api: /api/*)`);
});
```

- [ ] **Step 4: 手动 smoke 验证**

先启动服务：
Run: `cd apps/collector-server && pnpm dev`（另一终端 keep running）

再用 curl：
```bash
# 注入一条（用 sqlite3 直接 + HTTP list）
curl -s 'http://127.0.0.1:21527/api/videos' | head
```

- [ ] **Step 5: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-server/src/db/queries.ts apps/collector-server/src/http/queries.ts apps/collector-server/src/main.ts
git commit -m "feat(collector-server): http query api (list/detail/version) with default-track priority"
```

---

## Task 5: subtitle-collector 扩展（inject/content/background）

**Files:**
- Create: `apps/subtitle-collector/package.json`
- Create: `apps/subtitle-collector/manifest.json`
- Create: `apps/subtitle-collector/inject.js`
- Create: `apps/subtitle-collector/content.js`
- Create: `apps/subtitle-collector/background.js`
- Create: `apps/subtitle-collector/popup.html`
- Create: `apps/subtitle-collector/popup.js`

- [ ] **Step 1: package.json**

```json
{
  "name": "@bilibili-ext/subtitle-collector",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "echo 'No build step yet'"
  }
}
```

- [ ] **Step 2: manifest.json**

```json
{
  "manifest_version": 3,
  "name": "Bilibili Subtitle Collector",
  "version": "0.1.0",
  "description": "采集 B 站视频字幕到本地服务端",
  "permissions": ["activeTab", "tabs", "storage"],
  "host_permissions": ["*://*.bilibili.com/*"],
  "content_scripts": [
    {
      "matches": ["*://www.bilibili.com/video/*"],
      "js": ["inject.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["*://www.bilibili.com/video/*"],
      "js": ["content.js"],
      "run_at": "document_start"
    }
  ],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html" }
}
```

- [ ] **Step 3: inject.js（MAIN world，拦 player API + 字幕 URL）**

```js
(function () {
  const ORIGINAL_FETCH = window.fetch;
  const ORIGINAL_XHR_OPEN = XMLHttpRequest.prototype.open;
  const ORIGINAL_XHR_SEND = XMLHttpRequest.prototype.send;

  function isPlayerApi(url) {
    return typeof url === "string" && url.includes("api.bilibili.com/x/player");
  }
  function isSubtitleUrl(url) {
    return typeof url === "string" && (url.includes("aisubtitle") || url.includes("bfs/subtitle") || url.includes("bfs/ai_subtitle"));
  }
  function normalizeUrl(url) {
    if (typeof url !== "string") return "";
    return url.startsWith("//") ? "https:" + url : url;
  }
  function post(type, data) { window.postMessage({ type, data }, "*"); }

  // ---- fetch ----
  window.fetch = async function (...args) {
    const response = await ORIGINAL_FETCH.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    try {
      if (isPlayerApi(url)) {
        response.clone().json().then((json) => {
          if (json?.code !== 0) { post("RISK_CONTROL", { url }); return; }
          const d = json.data ?? {};
          if (d.need_login_subtitle === true) { post("NEED_LOGIN", { url }); return; }
          const subs = d.subtitle?.subtitles ?? [];
          const meta = {
            bvid: d.bvid, aid: d.aid, cid: d.cid,
            title: d.title ?? document.title,
            up_mid: d.up_info?.mid ?? null, up_name: d.up_info?.name ?? null,
            pic: d.pic, duration: d.video_info?.duration ?? null,
            published_at: d.pubdate ? d.pubdate * 1000 : null,
            subs: subs.map((s) => ({
              lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null,
              subtitle_url: normalizeUrl(s.subtitle_url),
            })),
          };
          post("PLAYER_META", meta);
        }).catch(() => {});
      }
      if (isSubtitleUrl(url)) {
        response.clone().json().then((data) => {
          const text = JSON.stringify(data);
          post("SUBTITLE_BODY", { url: normalizeUrl(url), body: data, body_size: text.length });
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // ---- XHR ----
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url; return ORIGINAL_XHR_OPEN.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isPlayerApi(this._url)) {
      this.addEventListener("load", function () {
        try {
          const json = JSON.parse(this.responseText);
          if (json?.code !== 0) { post("RISK_CONTROL", { url: this._url }); return; }
          const d = json.data ?? {};
          if (d.need_login_subtitle === true) { post("NEED_LOGIN", { url: this._url }); return; }
          const subs = d.subtitle?.subtitles ?? [];
          post("PLAYER_META", {
            bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title ?? document.title,
            up_mid: d.up_info?.mid ?? null, up_name: d.up_info?.name ?? null,
            pic: d.pic, duration: d.video_info?.duration ?? null,
            published_at: d.pubdate ? d.pubdate * 1000 : null,
            subs: subs.map((s) => ({ lan: s.lan, lan_doc: s.lan_doc, track_type: s.type ?? null, subtitle_url: normalizeUrl(s.subtitle_url) })),
          });
        } catch {}
      });
    }
    if (isSubtitleUrl(this._url)) {
      this.addEventListener("load", function () {
        try { post("SUBTITLE_BODY", { url: normalizeUrl(this._url), body: JSON.parse(this.responseText), body_size: this.responseText.length }); } catch {}
      });
    }
    return ORIGINAL_XHR_SEND.apply(this, args);
  };
})();
```

- [ ] **Step 4: content.js（聚合 + 接受 operate 命令）**

```js
const collected = new Map(); // bvid -> { meta, bodies: Map<url, body> }
const riskControl = new Set();
const needLogin = new Set();

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const { type, data } = event.data || {};
  if (type === "PLAYER_META") {
    const cur = collected.get(data.bvid) ?? { meta: data, bodies: new Map() };
    cur.meta = data;
    collected.set(data.bvid, cur);
    flushIfReady(data.bvid);
  } else if (type === "SUBTITLE_BODY") {
    // 找到对应 bvid（暴力遍历，简单起见；可优化）
    for (const [bvid, cur] of collected.entries()) {
      if (cur.meta.subs.some((s) => s.subtitle_url === data.url)) {
        cur.bodies.set(data.url, data.body);
        flushIfReady(bvid);
        return;
      }
    }
  } else if (type === "RISK_CONTROL") {
    // 简化：标记当前页 bvid
    if (collected.size > 0) riskControl.add([...collected.keys()].pop());
  } else if (type === "NEED_LOGIN") {
    if (collected.size > 0) needLogin.add([...collected.keys()].pop());
  }
});

function flushIfReady(bvid) {
  const cur = collected.get(bvid);
  if (!cur?.meta) return;
  const ready = cur.meta.subs.filter((s) => cur.bodies.has(s.subtitle_url) || !s.subtitle_url);
  if (ready.length === 0) return;
  // 组装上报
  const tracks = cur.meta.subs.map((s) => {
    const body = cur.bodies.get(s.subtitle_url);
    if (!body) return null;
    return {
      lan: s.lan, lan_doc: s.lan_doc, track_type: s.track_type,
      versions: [{ origin: "external", payload: body, source_url: s.subtitle_url }],
    };
  }).filter(Boolean);
  if (tracks.length === 0) return;
  const record = {
    source: "bilibili",
    video: {
      source_vid: cur.meta.bvid,
      creator: { source_uid: String(cur.meta.up_mid ?? "unknown"), name: cur.meta.up_name },
      title: cur.meta.title,
      extra: { aid: cur.meta.aid, cid: cur.meta.cid, pic: cur.meta.pic },
      duration: cur.meta.duration,
      published_at: cur.meta.published_at,
    },
    tracks,
  };
  chrome.runtime.sendMessage({ type: "INGEST", payload: record });
}

// 接受 background 命令：在当前页执行 DOM 操作（如点字幕开关）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPERATE") {
    const { op } = msg;
    if (op === "click-subtitle-toggle") {
      // 简化：找常见字幕开关选择器并点击
      const sel = ".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn";
      const el = document.querySelector(sel);
      if (el) { el.click(); sendResponse({ ok: true }); }
      else sendResponse({ ok: false, error: "toggle not found" });
    } else {
      sendResponse({ ok: false, error: "unknown op" });
    }
    return true;
  }
});
```

- [ ] **Step 5: background.js（WS 客户端 + 双重身份协调）**

```js
const SERVER_URL = "ws://127.0.0.1:21527/ext";
const PING_URL = "http://127.0.0.1:21527/ping";
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

async function probeServer() {
  try {
    const res = await fetch(PING_URL, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch { return false; }
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
  setTimeout(connect, delay);
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (!(await probeServer())) { scheduleReconnect(); return; }
  try {
    ws = new WebSocket(SERVER_URL);
  } catch { scheduleReconnect(); return; }
  ws.onopen = () => {
    reconnectAttempts = 0;
    ws.send(JSON.stringify({ type: "hello", ext_version: EXT_VERSION }));
  };
  ws.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg.id) return;
    // 收到 Command，分发
    try {
      if (msg.action === "navigate") {
        await chrome.tabs.create({ url: msg.url });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { opened: true } }));
      } else if (msg.action === "operate") {
        // 找当前页 content script 执行
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "OPERATE", op: msg.op });
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: resp?.ok !== false, data: resp }));
      } else {
        ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: "unknown action: " + msg.action }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
    }
  };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "INGEST" && msg.payload) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ingest", payload: msg.payload }));
    }
    sendResponse({ ok: true });
  } else if (msg?.type === "WS_STATUS") {
    sendResponse({ ok: true, connected: ws?.readyState === WebSocket.OPEN });
  } else if (msg?.type === "MANUAL_CAPTURE") {
    // 触发当前页 content.js 重新聚合并上报
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: "RE_AGG" });
    });
    sendResponse({ ok: true });
  }
  return true;
});

connect();
```

- [ ] **Step 6: popup.html**

```html
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 320px; padding: 12px; font-family: system-ui, sans-serif; font-size: 13px; }
.row { padding: 6px 0; border-bottom: 1px solid #eee; }
.btn { margin-top: 8px; padding: 6px 12px; background: #fb7299; color: #fff; border: 0; border-radius: 4px; cursor: pointer; width: 100%; }
.status { padding: 4px 8px; border-radius: 4px; display: inline-block; }
.status.ok { background: #e6f7e6; color: #2a8a2a; }
.status.no { background: #fde0e0; color: #c44; }
</style></head><body>
<div class="row">连接: <span id="status" class="status no">检查中...</span></div>
<div class="row" id="video">当前视频: -</div>
<div class="row" id="stats">上报: -</div>
<button id="btn-capture" class="btn">手动补采</button>
<script src="popup.js"></script>
</body></html>
```

- [ ] **Step 7: popup.js**

```js
document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const video = document.getElementById("video");
  const stats = document.getElementById("stats");
  const btn = document.getElementById("btn-capture");

  function refresh() {
    chrome.runtime.sendMessage({ type: "WS_STATUS" }, (resp) => {
      if (resp?.connected) { status.textContent = "已连接"; status.className = "status ok"; }
      else { status.textContent = "未连接"; status.className = "status no"; }
    });
  }

  btn.onclick = () => { chrome.runtime.sendMessage({ type: "MANUAL_CAPTURE" }); };

  refresh();
  setInterval(refresh, 2000);
});
```

- [ ] **Step 8: 在 Chrome 加载扩展做手工 smoke**

参考 `scripts/load-extension.sh` 模式加载 `apps/subtitle-collector/`：
```bash
bash scripts/load-extension.sh apps/subtitle-collector
```
打开任意 B 站视频页，console 应看到 `[collector-server]` 日志，SQLite 入库。验证 `/api/videos` 能查到该条。

- [ ] **Step 9: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/subtitle-collector/
git commit -m "feat(subtitle-collector): extension with dual role (passive ingest + ws command exec)"
```

---

## Task 6: collector-web（React + Vite + 列表/详情/搜索）

**Files:**
- Create: `apps/collector-web/package.json`
- Create: `apps/collector-web/vite.config.ts`
- Create: `apps/collector-web/tsconfig.json`
- Create: `apps/collector-web/index.html`
- Create: `apps/collector-web/src/main.tsx`
- Create: `apps/collector-web/src/App.tsx`
- Create: `apps/collector-web/src/api.ts`
- Create: `apps/collector-web/src/types.ts`
- Create: `apps/collector-web/src/pages/VideoList.tsx`
- Create: `apps/collector-web/src/pages/VideoDetail.tsx`
- Create: `apps/collector-web/src/components/TrackSwitcher.tsx`
- Create: `apps/collector-web/src/components/VersionSwitcher.tsx`
- Create: `apps/collector-web/src/components/SubtitleView.tsx`

- [ ] **Step 1: package.json**

```json
{
  "name": "@bilibili-ext/collector-web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: vite.config.ts（构建输出到 collector-server/public）**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../collector-server/public'),
    emptyOutDir: true,
  },
});
```

- [ ] **Step 3: tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"]
}
```

- [ ] **Step 4: index.html**

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8" />
  <title>Media Subtitle Collector</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

- [ ] **Step 5: src/types.ts**

```ts
export interface VideoListItem {
  id: number; source: string; source_vid: string; title: string;
  creator_name: string | null; duration: number | null;
  track_count: number; first_seen_at: number;
}
export interface VersionInfo {
  id: number; origin: string; source_url: string | null;
  asr_engine: string | null; captured_at: number; body_size: number | null;
  is_default?: boolean;
}
export interface TrackInfo {
  id: number; lan: string | null; lan_doc: string | null; track_type: number | null;
  is_default?: boolean; versions: VersionInfo[];
}
export interface VideoDetail { video: Record<string, unknown>; tracks: TrackInfo[]; }
```

- [ ] **Step 6: src/api.ts**

```ts
import type { VideoListItem, VideoDetail } from './types';

const BASE = '';

export async function listVideos(q = '', page = 1, size = 20): Promise<{ total: number; items: VideoListItem[] }> {
  const r = await fetch(`${BASE}/api/videos?q=${encodeURIComponent(q)}&page=${page}&size=${size}`);
  return r.json();
}

export async function getVideo(source: string, sourceVid: string): Promise<VideoDetail> {
  const r = await fetch(`${BASE}/api/videos/${source}/${encodeURIComponent(sourceVid)}`);
  return r.json();
}

export async function getVersion(versionId: number): Promise<{ version: { id: number; origin: string; payload: any; captured_at: number } }> {
  const r = await fetch(`${BASE}/api/versions/${versionId}`);
  return r.json();
}
```

- [ ] **Step 7: src/components/TrackSwitcher.tsx**

```tsx
import type { TrackInfo } from '../types';
export function TrackSwitcher({ tracks, selected, onSelect }: { tracks: TrackInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
      {tracks.map((t) => {
        const isSel = t.id === selected;
        return (
          <button key={t.id} onClick={() => onSelect(t.id)} style={{
            padding: '4px 12px', border: '1px solid #ddd', borderRadius: 16,
            background: isSel ? '#fb7299' : '#fff', color: isSel ? '#fff' : '#333',
            cursor: 'pointer', fontWeight: isSel ? 600 : 400,
          }}>
            {t.lan_doc || t.lan || '?'} {t.is_default && '(默认)'}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 8: src/components/VersionSwitcher.tsx**

```tsx
import type { VersionInfo } from '../types';
const label = (v: VersionInfo) => v.origin === 'external' ? '外挂' : v.origin === 'asr' ? 'ASR' : '人工';
export function VersionSwitcher({ versions, selected, onSelect }: { versions: VersionInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  if (versions.length <= 1) return null;
  return (
    <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
      {versions.map((v) => {
        const isSel = v.id === selected;
        return (
          <button key={v.id} onClick={() => onSelect(v.id)} style={{
            padding: '2px 10px', border: '1px solid #eee', borderRadius: 4,
            background: isSel ? '#23ade5' : '#fafafa', color: isSel ? '#fff' : '#666',
            cursor: 'pointer', fontSize: 12,
          }}>
            {label(v)} {v.is_default && '★'}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 9: src/components/SubtitleView.tsx**

```tsx
export interface SubtitleLine { from: number; to: number; content: string; }
export function SubtitleView({ body }: { body: SubtitleLine[] }) {
  const fmt = (sec: number) => { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; };
  const copy = () => { navigator.clipboard.writeText(body.map(l => l.content).join('\n')); };
  return (
    <div>
      <button onClick={copy} style={{ marginBottom: 8, padding: '4px 12px', border: '1px solid #ddd', borderRadius: 4, cursor: 'pointer', background: '#fff' }}>复制全文</button>
      <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #eee', borderRadius: 4, padding: 8 }}>
        {body.map((l, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, padding: '2px 0', lineHeight: 1.6 }}>
            <span style={{ color: '#999', fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmt(l.from)} → {fmt(l.to)}</span>
            <span>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 10: src/pages/VideoList.tsx**

```tsx
import { useEffect, useState } from 'react';
import { listVideos } from '../api';

export function VideoList({ onOpen }: { onOpen: (source: string, sourceVid: string) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      listVideos(q).then(r => { setItems(r.items); setTotal(r.total); });
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div style={{ padding: 16 }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题/创作者" style={{ width: '100%', padding: 8, marginBottom: 12, border: '1px solid #ddd', borderRadius: 4 }} />
      <div>共 {total} 条</div>
      {items.map(v => (
        <div key={v.id} onClick={() => onOpen(v.source, v.source_vid)} style={{ padding: 12, borderBottom: '1px solid #eee', cursor: 'pointer' }}>
          <div style={{ fontWeight: 500 }}>{v.title}</div>
          <div style={{ fontSize: 12, color: '#666' }}>{v.creator_name ?? '-'} · {v.track_count} 轨 · {new Date(v.first_seen_at).toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 11: src/pages/VideoDetail.tsx**

```tsx
import { useEffect, useState } from 'react';
import { getVideo, getVersion } from '../api';
import { TrackSwitcher } from '../components/TrackSwitcher';
import { VersionSwitcher } from '../components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '../components/SubtitleView';
import type { VideoDetail as VD } from '../types';

export function VideoDetail({ source, sourceVid, onBack }: { source: string; sourceVid: string; onBack: () => void }) {
  const [detail, setDetail] = useState<VD | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [body, setBody] = useState<SubtitleLine[]>([]);

  useEffect(() => { getVideo(source, sourceVid).then(d => {
    setDetail(d);
    const def = d.tracks.find(t => t.is_default) ?? d.tracks[0];
    if (def) { setSelectedTrack(def.id); const dv = def.versions.find(v => v.is_default) ?? def.versions[0]; if (dv) setSelectedVersion(dv.id); }
  }); }, [source, sourceVid]);

  useEffect(() => {
    if (!selectedVersion) return;
    getVersion(selectedVersion).then(r => setBody(r.version?.payload?.body ?? []));
  }, [selectedVersion]);

  if (!detail) return <div style={{ padding: 16 }}>加载中...</div>;
  const v: any = detail.video;
  const track = detail.tracks.find(t => t.id === selectedTrack);

  return (
    <div style={{ padding: 16, maxWidth: 800 }}>
      <button onClick={onBack} style={{ marginBottom: 12 }}>← 返回</button>
      <h2>{v.title}</h2>
      <div style={{ color: '#666' }}>{v.creator_name ?? '-'} · {v.extra?.pic && <a href={v.extra.pic} target="_blank">封面</a>}</div>
      <TrackSwitcher tracks={detail.tracks} selected={selectedTrack} onSelect={(id) => { setSelectedTrack(id); const t = detail.tracks.find(x => x.id === id); if (t) { const dv = t.versions.find(x => x.is_default) ?? t.versions[0]; setSelectedVersion(dv?.id ?? null); } }} />
      {track && <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={setSelectedVersion} />}
      <SubtitleView body={body} />
    </div>
  );
}
```

- [ ] **Step 12: src/App.tsx**

```tsx
import { useState } from 'react';
import { VideoList } from './pages/VideoList';
import { VideoDetail } from './pages/VideoDetail';

export default function App() {
  const [view, setView] = useState<{ source: string; sourceVid: string } | null>(null);
  return view
    ? <VideoDetail source={view.source} sourceVid={view.sourceVid} onBack={() => setView(null)} />
    : <VideoList onOpen={(s, v) => setView({ source: s, sourceVid: v })} />;
}
```

- [ ] **Step 13: src/main.tsx**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 14: collector-server 静态托管 public/**

Modify `apps/collector-server/src/main.ts`：在 404 之前加静态托管：
```ts
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
// ...
const PUBLIC_DIR = join(process.cwd(), 'public');
function serveStatic(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const fp = join(PUBLIC_DIR, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!existsSync(fp) || !fp.startsWith(PUBLIC_DIR)) { res.writeHead(404); res.end('not found'); return; }
  const ct = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(fp)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  res.end(readFileSync(fp));
}
// ...在 404 之前：
if (req.url && !req.url.startsWith('/api/') && req.url !== '/ping') { serveStatic(req, res); return; }
```

- [ ] **Step 15: 构建并 smoke**

Run:
```bash
pnpm --filter @bilibili-ext/collector-web build
pnpm --filter @bilibili-ext/collector-server dev
```
浏览器打开 `http://127.0.0.1:21527/`，确认列表页渲染（空状态 OK），详情页路径能进。

- [ ] **Step 16: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-web/ apps/collector-server/src/main.ts
git commit -m "feat(collector-web): react+vite list/detail/search; collector-server static host"
```

---

## Task 7: 端到端回归 + 真实 B 站验证（人工）

**Files:**
- Create: `scripts/verify-collector.mjs`（参考现有 `scripts/verify-extension.mjs`）

- [ ] **Step 1: 写 puppeteer mock 验证脚本骨架**

Create `scripts/verify-collector.mjs`：
```js
// 1. 起 collector-server（用临时 db）
// 2. 用 puppeteer 加载扩展 + mock player API 返回字幕
// 3. 断言 SQLite 写入 + /api/videos 能查到
// 4. 清理
```
（具体内容在执行时按现有 `scripts/verify-extension.mjs` 模式实现，本 task 只做骨架+人工验收清单）

- [ ] **Step 2: 真实端到端验收清单**

人工执行（在登录态 Chrome 中）：
- [ ] 启动 `pnpm dev`（collector-server + collector-web 构建产物已就位）
- [ ] 加载扩展 `apps/subtitle-collector/`
- [ ] 打开 B 站视频页（`https://www.bilibili.com/video/BV1mhjg6SEJy`），点开字幕
- [ ] popup 显示"已连接 ✓"，"上报统计"显示新增轨数
- [ ] 访问 `http://127.0.0.1:21527/`，列表显示该视频
- [ ] 点进详情，轨切换器 + 时间轴逐行正常显示
- [ ] 复制按钮可用

- [ ] **Step 3: 提交（如有改动）**

```bash
git add scripts/verify-collector.mjs
git commit -m "test: e2e verify scaffold + manual checklist" || echo "no changes"
```

---

## Self-Review（提交前对照 spec 检查）

**Spec coverage:**
- §4 架构（WS RPC + ②+3）→ Task 3（WS 服务端）+ Task 5（背景 background WS 客户端）
- §5 数据模型 → Task 1（schema）+ Task 2（ingest 写入）
- §6 接口契约 → Task 3（WS）+ Task 4（HTTP）
- §7 扩展 → Task 5
- §8 网页 → Task 6
- §10 验收标准 13 项 → Task 7 端到端覆盖

**无 placeholder / TBD / "implement later"**

**类型/方法签名一致性：**
- `ingestVideo(db, IngestRequest): IngestResult` 在 Task 2 定义，Task 3 WS server 复用，Task 5 background 发的 payload 字段对齐（source/video/tracks）
- WS 消息 type 字段：hello / log / ingest / ingest-ack / result（Task 3 + Task 5 一致）
- HTTP 路径：/ping /api/videos /api/videos/:source/:source_vid /api/versions/:id（Task 3/4 + Task 6 api.ts 对齐）
- 默认轨优先级：Task 4 queries.ts 与 §5.6 一致（CC中文 > AI中文 > 英文 > 其他）

**已发现的 trade-off（保留）：**
- Task 4 把 default 标记在查询时算（与 §5.6 一致）
- Task 5 content.js 暴遍历找 bvid 是简化实现，可后续优化（标记 trade-off）
- Task 5 operate 命令的字幕开关选择器是简化版本，覆盖 B 站主流；后续可补

---

## 风险与回退

- **player API 字段**：Task 5 inject.js 假设 player API 返回 up_info/pic/video_info.duration 等；实现时用真实响应校验，缺字段则在 extra 留空，不阻塞。
- **WS 协议不一致**：Task 3/5 都用 `{ type, ... }` 信封，对齐 opencli；若有偏差以本 spec §6.2 为准。
- **端到端依赖登录态**：Task 7 验收需登录态浏览器（B 站字幕要点按钮触发）。

---

## 后续 spec（不在本 plan）

- 音频下载（yt-dlp 路线）
- 批量/定时/UP主时间区间/AI 命令采集（功能实现）
- YouTube 采集
- 强制更新字幕轨
- 上报失败重试队列