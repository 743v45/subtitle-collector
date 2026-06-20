# 媒体字幕采集库（Media Subtitle Collector）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `docs/superpowers/specs/2026-06-20-media-subtitle-collector-design.md` 定义的多渠道字幕采集库 MVP：B 站字幕拦截 + 本地 SQLite 落库 + 网页查阅 + 双向 WS RPC（为后续批量/自动/AI 命令采集预留）。

**Architecture:** 三个新 monorepo 包：`apps/subtitle-collector`（Chrome 扩展，双重身份）/ `apps/collector-server`（TS 常驻进程，WS 双向 RPC + SQLite + HTTP 查询）/ `apps/collector-web`（React + Vite）。通信核心是 WebSocket 双向 RPC，对齐 opencli 的 daemon/extension 模型（Command/Result 信封 + hello 握手 + /ping 探活 + 指数退避重连 + verifyClient 防 CSRF）。操作页面用 tabs + hook + content script（②+3），不用 CDP/debugger。

**Tech Stack:**
- 服务端：TypeScript + Node 22 + `ws` + `better-sqlite3` + Node 内置 `node:test`
- 扩展：原生 JS（MV3），零构建链
- 网页：React + Vite + TypeScript + Tailwind CSS + shadcn/ui（强制，对齐全局样式规则：禁止 `style={{}}` 内联、禁止手写 `.css`）
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
| `apps/subtitle-collector/config.js` | 服务端地址 + WS 握手 token（扩展与服务端共用同一 token） | 新建 |
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
| `apps/collector-web/tailwind.config.ts` | Tailwind 配置 | 新建 |
| `apps/collector-web/postcss.config.js` | PostCSS（tailwindcss + autoprefixer） | 新建 |
| `apps/collector-web/src/globals.css` | Tailwind 指令入口（@tailwind 三件套，不写自定义样式） | 新建 |
| `apps/collector-web/components.json` | shadcn/ui 配置 | 新建 |
| `scripts/spike-click-subtitle.mjs` | click 可行性 spike（Task 5 前置，真实登录态） | 新建 |
| `scripts/verify-collector.mjs` | 扩展 puppeteer mock 回归（subtitle_url 四情况 / navigate / operate） | 新建 |

**测试分层（务实）：**
- 服务端核心（db/ingest、ws/server、http/queries）→ `node:test` 自动化（`pnpm test` / `turbo run test`）
- 扩展采集链路 → puppeteer mock 回归（`scripts/verify-collector.mjs`，沿用 `scripts/verify-extension.mjs` 模式）
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
  captured_at   INTEGER NOT NULL
  -- 去重在应用层处理（见 db/ingest.ts version 写入分支）：
  --   origin IN ('external','asr')：按 (track_id, origin, coalesce(asr_engine,''), coalesce(source_url,'')) 先 SELECT，命中则跳过；
  --   origin = 'manual'：始终 INSERT 新行（人工导入不去重，保留历史快照）。
  -- 不在 DDL 上设 UNIQUE，否则 manual 多次导入会撞约束报错。
);
CREATE INDEX IF NOT EXISTS idx_versions_track ON subtitle_versions(track_id);
CREATE INDEX IF NOT EXISTS idx_versions_dedup ON subtitle_versions(track_id, origin, asr_engine, source_url);

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

    // 4. version 写入（按 origin 分支去重）
    //    - external/asr：按 (track_id, origin, asr_engine, source_url) 先 SELECT，命中跳过（幂等去重）
    //    - manual：始终 INSERT 新行（人工导入不去重，保留每次导入的快照）
    const verSel = db.prepare('SELECT id FROM subtitle_versions WHERE track_id = ? AND origin = ? AND coalesce(asr_engine,"") = coalesce(?,"") AND coalesce(source_url,"") = coalesce(?,"")');
    const verIns = db.prepare('INSERT INTO subtitle_versions (track_id, origin, payload, body_size, source_url, asr_engine, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?)');

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
        if (v.origin !== 'manual') {
          // external/asr：去重——命中现有行则跳过
          const ex = verSel.get(trackId, v.origin, v.asr_engine ?? null, v.source_url ?? null) as { id: number } | undefined;
          if (ex) { skipped++; continue; }
        }
        // manual（或 external/asr 首次）：始终 INSERT 新行
        verIns.run(trackId, v.origin, payloadStr, payloadStr.length, v.source_url ?? null, v.asr_engine ?? null, now);
        inserted++;
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
Expected: 6/6 PASS

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
      attachWsServer(httpServer, db, 'test-token'); // 预置 token；下方 hello 须带同一 token
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
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
    await new Promise(r => setTimeout(r, 50));
    ws.close();
  } finally { ctx.cleanup(); }
});

test('ingest 消息：服务端写入 SQLite 并回 ingest-ack', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
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
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
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
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'test-token' }));
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

test('hello 握手 token 不匹配：服务端关闭连接', async () => {
  const ctx = await setup();
  try {
    const ws = await connect(ctx.port);
    const closed = new Promise<boolean>((resolve) => {
      ws.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    ws.send(JSON.stringify({ type: 'hello', ext_version: '0.1.0', token: 'WRONG-TOKEN' }));
    assert.equal(await closed, true, 'bad token 应被关闭');
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

export function attachWsServer(httpServer: Server, _db: Database.Database, expectedToken?: string): void {
  const EXPECTED_TOKEN = expectedToken ?? process.env.COLLECTOR_TOKEN ?? ''; // 空 token 视为未配置，全部拒绝
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
        // WS 握手 token 校验：比对预置 token，不匹配关闭连接（防 WS CSRF，学 opencli）
        if (!EXPECTED_TOKEN || msg.token !== EXPECTED_TOKEN) {
          ws.send(JSON.stringify({ type: 'hello-nack', ok: false, error: 'bad token' }));
          ws.close(4001, 'bad token');
          return;
        }
        ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
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
const TOKEN = process.env.COLLECTOR_TOKEN ?? 'change-me-collector-token'; // 与扩展 config.js 一致

const db = openDb(DB_PATH);
migrate(db);

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  // HTTP 查询 API 与静态托管在后续 task 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[collector-server] listening on http://127.0.0.1:${PORT} (ws: /ext)`);
});
```

- [ ] **Step 5: 跑测试，全部通过**

Run: `cd apps/collector-server && pnpm test`
Expected: 5/5 PASS

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
import { createServer, type IncomingMessage } from 'node:http';
import { openDb, migrate } from './db/migrate.js';
import { attachWsServer } from './ws/server.js';
import { handleQueryHttp } from './http/queries.js';

const DB_PATH = process.env.COLLECTOR_DB_PATH ?? './bilibili-collector.db';
const PORT = Number(process.env.COLLECTOR_PORT ?? 21527);
const TOKEN = process.env.COLLECTOR_TOKEN ?? 'change-me-collector-token'; // 与扩展 config.js 一致

const db = openDb(DB_PATH);
migrate(db);

// C2: loopback HTTP 对浏览器是真实攻击面——DNS rebinding 可绕同源策略读 /api/* 与静态页。
// /ping 外的所有请求校验 Host（防 rebinding）+ Origin（浏览器请求须来自扩展或同源）。
const httpOriginAllowed = (req: IncomingMessage): boolean => {
  const host = String(req.headers['host'] ?? '').split(':')[0];
  if (host !== 'localhost' && host !== '127.0.0.1') return false; // DNS rebinding：非 loopback hostname 直接拒
  const origin = req.headers['origin'];
  if (!origin) return true; // curl / 服务端同源 fetch 无 Origin，放行
  const o = String(origin);
  return o.startsWith('chrome-extension://') // 扩展
    || o.startsWith('http://localhost')       // 同源 collector-web
    || o.startsWith('http://127.0.0.1');
};

const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  if (!httpOriginAllowed(req)) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"forbidden"}'); return; } // C2
  if (req.url?.startsWith('/api/')) { handleQueryHttp(req, res, db); return; }
  // 静态托管 collector-web 产物在 Task 6 接上
  res.writeHead(404); res.end('not found');
});

attachWsServer(httpServer, db, TOKEN);

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
- Create: `apps/subtitle-collector/config.js`
- Create: `apps/subtitle-collector/popup.html`
- Create: `apps/subtitle-collector/popup.js`

> **前置 spike（click 可行性，必做，阻塞 operate 命令实现）**
> B 站播放器字幕开关在真实 DOM 里能否用 `element.click()` 触发字幕请求，必须先用真实登录态 profile 验证，再决定 operate 命令走 click 还是 CDP 降级。

- [ ] **Step 0: click 可行性 spike（puppeteer + 真实登录态 profile）**

Create `scripts/spike-click-subtitle.mjs`（一次性验证脚本，不入正式测试套件）：

```js
// 前置：scripts/verify-collector.mjs 已装 puppeteer；用 --user-data-dir 复用已登录 B 站的 Chrome profile。
// 目的：在真实视频页 element.click() 字幕开关后，5s 内是否出现 aisubtitle/bfs/subtitle 请求。
import puppeteer from 'puppeteer';

const VIDEO = process.argv[2] || 'https://www.bilibili.com/video/BV1mhjg6SEJy';
const PROFILE = process.env.CHROME_PROFILE || `${process.env.HOME}/.spike-bilibili-profile`;

const browser = await puppeteer.launch({
  headless: false,
  userDataDir: PROFILE, // 复用登录态；首次跑需手动登录一次
  args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
const page = await browser.newPage();
let observed = false;
page.on('request', (req) => {
  const u = req.url();
  if (u.includes('aisubtitle') || u.includes('bfs/subtitle') || u.includes('bfs/ai_subtitle')) observed = true;
});

await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise(r => setTimeout(r, 5000)); // 等播放器就绪

// 方案 A：直接 click()
async function tryClick(strategy) {
  observed = false;
  const handle = await page.$(".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn");
  if (!handle) return { found: false, observed: false, strategy };
  if (strategy === 'click') {
    await handle.click();
  } else {
    await handle.evaluate((el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }
  await new Promise(r => setTimeout(r, 5000));
  return { found: true, observed, strategy };
}

const A = await tryClick('click');
console.log('[A] element.click() →', A.observed ? '✅ 触发字幕请求' : '❌ 未触发');
const B = A.observed ? A : await tryClick('pointer');
console.log('[B] pointerdown+up+click →', B.observed ? '✅ 触发' : '❌ 未触发');
console.log('\n结论：', B.observed
  ? 'operate 可走 click 路线（content.js subtitleObserved=true 即生效）'
  : 'click 路线不可行 → operate 必须 CDP 降级（attach debugger + Input.dispatchMouseEvent）');

await browser.close();
```

Run: `node scripts/spike-click-subtitle.mjs`
Expected: 输出方案 A/B 结论。**任一方案 5s 内观察到 aisubtitle/bfs/subtitle 请求 → content.js operate 走 click；都不行 → 在 operate sendResponse `subtitleObserved=false` 时由上层（后续批量 spec）走 CDP 降级。** 本 plan 内 operate 实现仍以 click 优先（content.js 已内建"先 click() 再 pointer 序列"的 fallback + subtitleObserved 真实结果回传）。

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
  "permissions": ["activeTab", "tabs", "storage", "alarms"],
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
// operate 用短超时观察点击后是否真的触发了字幕请求（aisubtitle/bfs/subtitle），
// 只报"找到并点了"不够——必须确认点击产生了字幕流量，否则上层据此降级到 CDP（见 Task 4b spike）。
let operateWatch = { active: false, observedSubtitle: false };
// 复用上面的 message 监听窗口：SUBTITLE_BODY 出现即视为点击生效
// （在已有 message listener 里追加一行标记，避免重复监听）
window.addEventListener("message", (event) => {
  if (event.source !== window && event.data?.type === "SUBTITLE_BODY") operateWatch.observedSubtitle = true;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPERATE") {
    const { op } = msg;
    if (op === "click-subtitle-toggle") {
      const sel = ".bpx-player-ctrl-btn-icon, [aria-label*='字幕'], .subtitle-btn";
      const el = document.querySelector(sel);
      if (!el) { sendResponse({ ok: false, error: "toggle not found" }); return true; }

      // 点击前重置观察窗口，尝试真实 click()
      operateWatch = { active: true, observedSubtitle: false };
      try { el.click(); } catch {}

      // 5s 内监听是否出现字幕请求；不行再试 pointerdown+pointerup+click 序列
      const tryWait = (clickedOk: boolean) => {
        setTimeout(() => {
          if (!operateWatch.observedSubtitle && clickedOk) {
            // click() 无效，退而试完整指针序列（部分播放器需要 pointerdown/up 配合）
            operateWatch.observedSubtitle = false;
            try {
              el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
              el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
            } catch {}
            setTimeout(() => finish(operateWatch.observedSubtitle), 5000);
          } else {
            finish(operateWatch.observedSubtitle);
          }
          function finish(observed: boolean) {
            operateWatch.active = false;
            sendResponse({ ok: true, clicked: true, subtitleObserved: observed,
              // subtitleObserved=false 即点击未触发字幕请求，上层据此决定是否走 CDP 降级
              note: observed ? "click 触发了字幕请求" : "点击后 5s 内未观察到字幕请求，建议 CDP 降级" });
          }
        }, 5000);
      };
      tryWait(true);
    } else {
      sendResponse({ ok: false, error: "unknown op" });
    }
    return true; // 异步 sendResponse
  }
});
```

- [ ] **Step 5: background.js（WS 客户端 + 双重身份协调）**

```js
import { SERVER_URL, PING_URL, TOKEN } from "./config.js";
// config.js 内容（见 Step 5b）：
//   export const SERVER_URL = "ws://127.0.0.1:21527/ext";
//   export const PING_URL   = "http://127.0.0.1:21527/ping";
//   export const TOKEN      = "change-me-collector-token";  // 与服务端 config.js 预置 token 一致
const EXT_VERSION = chrome.runtime.getManifest().version;

let ws = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 10000;

// MV3 SW 保活兜底：周期 alarm 唤醒 SW，若 ws 未 OPEN 则触发重连（学 opencli keepalive）
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "keepalive" && ws?.readyState !== WebSocket.OPEN) connect();
});

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
    ws.send(JSON.stringify({ type: "hello", ext_version: EXT_VERSION, token: TOKEN }));
    // 重连后补发：把 SW 被杀期间 content 暂存到 storage.local 的待上报记录一次性 flush
    flushPendingIngests();
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
    } else {
      // WS 未连（SW 被杀/服务端重启）：暂存 storage.local，onopen 时 flushPendingIngests 补发
      chrome.storage.local.get(["pendingIngests"], ({ pendingIngests = [] }) => {
        chrome.storage.local.set({ pendingIngests: [...pendingIngests, msg.payload] });
      });
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

// 补发暂存记录（重连成功后调用）
async function flushPendingIngests() {
  const { pendingIngests = [] } = await chrome.storage.local.get(["pendingIngests"]);
  if (pendingIngests.length === 0) return;
  for (const payload of pendingIngests) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ingest", payload }));
  }
  await chrome.storage.local.set({ pendingIngests: [] });
}

connect();
```

- [ ] **Step 5b: config.js（服务端地址 + WS 握手 token）**

Create `apps/subtitle-collector/config.js`：

```js
// 扩展侧配置：服务端地址 + WS 握手 token。
// token 必须与服务端 config.js 预置 token 一致（见 Task 3 Step 3 server.ts hello 校验）。
// 部署/分发前请改成随机串，勿提交默认值到公开仓库。
export const SERVER_URL = "ws://127.0.0.1:21527/ext";
export const PING_URL = "http://127.0.0.1:21527/ping";
export const TOKEN = "change-me-collector-token";
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
- Create: `apps/collector-web/tailwind.config.ts`
- Create: `apps/collector-web/postcss.config.js`
- Create: `apps/collector-web/components.json`
- Create: `apps/collector-web/src/globals.css`
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

> **样式总则（强制，对齐全局 CLAUDE.md 样式规则）：** collector-web 只允许 Tailwind 工具类 + shadcn/ui 组件。**禁止** `style={{}}` 内联、**禁止**手写 `.css` 自定义样式（`src/globals.css` 仅放 Tailwind 三件套指令 + shadcn 必需的 CSS 变量）。下方所有组件（TrackSwitcher/VersionSwitcher/SubtitleView/VideoList/VideoDetail）均遵守此规则。

- [ ] **Step 1: 初始化 Tailwind + shadcn/ui**

Run（在 monorepo 根，用 pnpm filter 操作 collector-web）：

```bash
# 1) 装 Tailwind 工具链
pnpm --filter @bilibili-ext/collector-web add -D tailwindcss@^3.4.0 postcss autoprefixer

# 2) 初始化 shadcn/ui（交互式，选 New York / Zinc / CSS variables=yes / src/ + @/ 别名）
npx shadcn@latest init -d

# 3) 加会用到的组件：切换器用 Tabs、按钮用 Button、卡片用 Card、搜索框用 Input
npx shadcn@latest add tabs button card input
```

产物（人工确认，缺失则补）：
- `tailwind.config.ts`（含 content 指向 `./index.html` + `./src/**/*`，plugins 加 `tailwindcss-animate`）
- `postcss.config.js`（`tailwindcss` + `autoprefixer`）
- `components.json`（shadcn 配置，aliases `@/components`、`@/lib/utils`）
- `src/globals.css`（仅 `@tailwind base; @tailwind components; @tailwind utilities;` + shadcn 的 `:root`/`.dark` CSS 变量块，不写任何自定义类样式）
- `src/lib/utils.ts`（导出 `cn(...)` = `twMerge(clsx(...))`）
- `src/components/ui/{tabs,button,card,input}.tsx`（shadcn 生成）

vite 别名：在 `vite.config.ts`（见 Step 3）里加 `@` → `./src` 的 resolve alias（shadcn 组件用 `@/components/ui` 引用）。

若 `shadcn init` 未生成（非交互/旧版本），手动补这两个文件，**不写任何自定义样式**：

`src/globals.css`（仅 Tailwind 三件套 + shadcn CSS 变量）：
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
@layer base {
  :root { --background: 0 0% 100%; --foreground: 240 10% 3.9%; --muted: 240 4.8% 95.9%; --muted-foreground: 240 3.8% 46.1%; --border: 240 5.9% 90%; --accent: 240 4.8% 95.9%; }
  .dark { --background: 240 10% 3.9%; --foreground: 0 0% 98%; --muted: 240 3.7% 15.9%; --muted-foreground: 240 5% 64.9%; --border: 240 3.7% 15.9%; --accent: 240 3.7% 15.9%; }
}
```

`src/lib/utils.ts`（shadcn 标准 `cn`，组件依赖）：
```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

- [ ] **Step 2: package.json**

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
    "react-dom": "^18.3.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "tailwind-merge": "^2.5.0",
    "tailwindcss-animate": "^1.0.7",
    "@radix-ui/react-tabs": "^1.1.1",
    "@radix-ui/react-slot": "^1.1.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.6.0",
    "tailwindcss": "^3.4.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}
```

- [ ] **Step 3: vite.config.ts（构建输出到 collector-server/public）**

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }, // shadcn 组件用 @/components/ui 引用
  },
  build: {
    outDir: resolve(__dirname, '../collector-server/public'),
    emptyOutDir: true,
  },
});
```

- [ ] **Step 4: tsconfig.json**

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
    "lib": ["ES2022", "DOM"],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src"]
}
```

- [ ] **Step 5: index.html**

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

- [ ] **Step 6: src/types.ts**

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

- [ ] **Step 7: src/api.ts**

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

- [ ] **Step 8: src/components/TrackSwitcher.tsx**

```tsx
import type { TrackInfo } from '../types';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// 轨切换器用 shadcn Tabs（受控）；选中态/胶囊样式由 Tabs variant 接管，不写内联样式。
export function TrackSwitcher({ tracks, selected, onSelect }: { tracks: TrackInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  return (
    <div className="my-3">
      <Tabs value={selected != null ? String(selected) : ''} onValueChange={(v) => onSelect(Number(v))}>
        <TabsList className="flex flex-wrap h-auto gap-2 bg-transparent p-0">
          {tracks.map((t) => (
            <TabsTrigger
              key={t.id}
              value={String(t.id)}
              className="rounded-full data-[state=active]:bg-[#fb7299] data-[state=active]:text-white data-[state=active]:font-semibold"
            >
              {t.lan_doc || t.lan || '?'} {t.is_default && '(默认)'}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 9: src/components/VersionSwitcher.tsx**

```tsx
import type { VersionInfo } from '../types';
import { Button } from '@/components/ui/button';
const label = (v: VersionInfo) => v.origin === 'external' ? '外挂' : v.origin === 'asr' ? 'ASR' : '人工';
export function VersionSwitcher({ versions, selected, onSelect }: { versions: VersionInfo[]; selected: number | null; onSelect: (id: number) => void; }) {
  if (versions.length <= 1) return null;
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {versions.map((v) => {
        const isSel = v.id === selected;
        return (
          <Button
            key={v.id}
            variant={isSel ? 'default' : 'outline'}
            size="sm"
            onClick={() => onSelect(v.id)}
            // 选中用 B 站蓝；非选中用 outline variant（shadcn 默认样式，不内联）
            className={isSel ? 'bg-[#23ade5] text-white hover:bg-[#23ade5]' : 'text-muted-foreground'}
          >
            {label(v)} {v.is_default && '★'}
          </Button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 10: src/components/SubtitleView.tsx**

```tsx
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SubtitleLine { from: number; to: number; content: string; }
export function SubtitleView({ body }: { body: SubtitleLine[] }) {
  const fmt = (sec: number) => { const m = Math.floor(sec / 60); const s = Math.floor(sec % 60); return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`; };
  const copy = () => { navigator.clipboard.writeText(body.map(l => l.content).join('\n')); };
  return (
    <div>
      <Button variant="outline" size="sm" onClick={copy} className="mb-2">复制全文</Button>
      <div className="max-h-[400px] overflow-y-auto rounded border border-border p-2">
        {body.map((l, i) => (
          <div key={i} className="flex gap-3 py-0.5 leading-relaxed">
            <span className={cn('whitespace-nowrap text-xs text-muted-foreground tabular-nums')}>{fmt(l.from)} → {fmt(l.to)}</span>
            <span>{l.content}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 11: src/pages/VideoList.tsx**

```tsx
import { useEffect, useState } from 'react';
import { listVideos } from '../api';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

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
    <div className="space-y-3 p-4">
      <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索标题/创作者" className="mb-3" />
      <div className="text-sm text-muted-foreground">共 {total} 条</div>
      <div className="space-y-2">
        {items.map(v => (
          <Card
            key={v.id}
            onClick={() => onOpen(v.source, v.source_vid)}
            // 整卡可点：加 cursor-pointer + hover 态，样式全走 shadcn Card + Tailwind 工具类
            className="cursor-pointer transition-colors hover:bg-accent"
          >
            <CardHeader className="p-4">
              <CardTitle className="text-base font-medium">{v.title}</CardTitle>
              <CardDescription className="text-xs">
                {v.creator_name ?? '-'} · {v.track_count} 轨 · {new Date(v.first_seen_at).toLocaleString()}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 12: src/pages/VideoDetail.tsx**

```tsx
import { useEffect, useState } from 'react';
import { getVideo, getVersion } from '../api';
import { TrackSwitcher } from '../components/TrackSwitcher';
import { VersionSwitcher } from '../components/VersionSwitcher';
import { SubtitleView, type SubtitleLine } from '../components/SubtitleView';
import { Button } from '@/components/ui/button';
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

  if (!detail) return <div className="p-4">加载中...</div>;
  const v: any = detail.video;
  const track = detail.tracks.find(t => t.id === selectedTrack);

  return (
    <div className="max-w-3xl space-y-3 p-4">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">← 返回</Button>
      <h2 className="text-xl font-semibold">{v.title}</h2>
      <div className="text-sm text-muted-foreground">{v.creator_name ?? '-'} · {v.extra?.pic && <a href={v.extra.pic} target="_blank" rel="noreferrer" className="underline">封面</a>}</div>
      <TrackSwitcher tracks={detail.tracks} selected={selectedTrack} onSelect={(id) => { setSelectedTrack(id); const t = detail.tracks.find(x => x.id === id); if (t) { const dv = t.versions.find(x => x.is_default) ?? t.versions[0]; setSelectedVersion(dv?.id ?? null); } }} />
      {track && <VersionSwitcher versions={track.versions} selected={selectedVersion} onSelect={setSelectedVersion} />}
      <SubtitleView body={body} />
    </div>
  );
}
```

- [ ] **Step 13: src/App.tsx**

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

- [ ] **Step 14: src/main.tsx**

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './globals.css'; // Tailwind 三件套 + shadcn CSS 变量（Vite 走 PostCSS → tailwindcss）

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 15: collector-server 静态托管 public/**

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

- [ ] **Step 16: 构建并 smoke**

Run:
```bash
pnpm --filter @bilibili-ext/collector-web build
pnpm --filter @bilibili-ext/collector-server dev
```
浏览器打开 `http://127.0.0.1:21527/`，确认列表页渲染（空状态 OK），详情页路径能进。

- [ ] **Step 17: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add apps/collector-web/ apps/collector-server/src/main.ts
git commit -m "feat(collector-web): react+vite list/detail/search; collector-server static host"
```

---

## Task 7: 端到端验收（自动化单元 + 真实 Chrome 集成）

**核心判断**：B 站字幕需登录态 + 真实播放器触发，puppeteer mock 登录态不可行/不可信。改为：

- **自动化（执行时我做）**：服务端四层写入 + WS RPC 协议 + HTTP 查询 API（已在前序 Task 用 `node:test` 覆盖）
- **真实 Chrome 集成（你做，登录态已在你的 Chrome 里）**：扩展装上 → 访问视频 → 验证入库 + 网页查阅

**Files:**
- Create: `scripts/load-collector-extension.sh`（参考 `scripts/load-extension.sh`，扩展加载说明）
- Create: `scripts/verify-collector.mjs`（puppeteer mock 回归脚本，不依赖真实登录）
- Create: `MANUAL-collector.md`（真实 Chrome 验收清单）
- Modify: `turbo.json`（加 `test` task）
- Modify: `package.json`（根，加 `test` 脚本 + puppeteer devDependency）

- [ ] **Step 1: 写扩展加载说明脚本**

Create `scripts/load-collector-extension.sh`：
```bash
#!/usr/bin/env bash
# 用法：bash scripts/load-collector-extension.sh
# 在 chrome://extensions/ 开发者模式加载此目录：apps/subtitle-collector/
set -e
EXT_DIR="$(cd "$(dirname "$0")/../apps/subtitle-collector" && pwd)"
echo "扩展目录: $EXT_DIR"
echo "在 chrome://extensions/ 打开开发者模式，点击'加载已解压的扩展程序'，选择："
echo "  $EXT_DIR"
echo ""
echo "依赖服务（运行中才能上报）："
echo "  cd apps/collector-server && pnpm dev"
```

```bash
chmod +x scripts/load-collector-extension.sh
```

- [ ] **Step 2: 写真实 Chrome 验收清单**

Create `MANUAL-collector.md`：
```markdown
# 媒体字幕采集库 — 真实 Chrome 验收清单

> 登录态已在你的 Chrome 里，无需 puppeteer mock。
> 沿用本项目 `MANUAL.md` 模式（现有 subtitle-extractor 已用此模式端到端验证）。

## 前置

1. 启动服务端：`cd apps/collector-server && pnpm dev`
   - 应看到 `[collector-server] listening on http://127.0.0.1:21527 (ws: /ext, api: /api/*)`
2. 构建 web（首次或 web 改动后）：`pnpm --filter @bilibili-ext/collector-web build`
3. 加载扩展：`bash scripts/load-collector-extension.sh`，按提示在 chrome://extensions/ 加载

## 验收项（对应 spec §10）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开 `https://www.bilibili.com/video/BV1mhjg6SEJy`（info/ 里的样本） | 扩展 popup 显示 "已连接 ✓" |
| 2 | 点开视频字幕按钮（中文字幕） | popup "上报统计" 显示新增轨数；服务端控制台看到 ingest-ack |
| 3 | 访问 `http://127.0.0.1:21527/api/videos` | JSON 列表包含 BV1mhjg6SEJy，标题正确 |
| 4 | 浏览器打开 `http://127.0.0.1:21527/` | 列表页显示该视频 |
| 5 | 点进详情 | 轨切换器 + 时间轴逐行 + 默认轨高亮 |
| 6 | 切换轨/版本 | 内容正确切换；默认轨带"默认"标记 |
| 7 | 复制按钮 | 复制成功 |
| 8 | 关闭服务端（Ctrl+C）后再访问视频页 | popup 变 "未连接 ✗"，无控制台 ERR 噪声 |
| 9 | 重新启动服务端 | popup 自动恢复 "已连接 ✓"（指数退避重连） |
| 10 | 同视频再访问一次 | 服务端不重复入库（version skipped）；title 没变则 change_log 不增加 |

## 服务端命令（排查）

```bash
# 看 db 状态
sqlite3 apps/collector-server/bilibili-collector.db "SELECT * FROM videos; SELECT * FROM change_log ORDER BY id DESC LIMIT 5;"

# 看连接状态
curl -s http://127.0.0.1:21527/api/videos | jq

# 重置 db（开发期）
rm apps/collector-server/bilibili-collector.db
```

## 已知限制

- B 站部分视频 `need_login_subtitle=true`，需确认你在 Chrome 已登录 B 站
- subtitle_url 为空时扩展不发 ingest；这类视频不会入库（正确行为）
```

- [ ] **Step 3: puppeteer mock 回归脚本（覆盖 subtitle_url 四情况 / navigate / operate）**

沿用 `scripts/verify-extension.mjs` 模式：Chrome for Testing + `--load-extension` 加载 `apps/subtitle-collector`，用 `setRequestInterception` mock player API + 字幕 URL，**不依赖真实登录态**（登录态只真实 Chrome 集成需要）。覆盖 spec §10 验收里可被 mock 的部分。

Create `scripts/verify-collector.mjs`：

```js
#!/usr/bin/env node
/**
 * subtitle-collector 扩展 — puppeteer mock 回归（不依赖真实登录态）。
 * 覆盖：
 *   1. inject.js 注入（fetch/XHR hook）
 *   2. PLAYER_META 抽取（bvid/aid/cid/title/up/subs[]）
 *   3. subtitle_url 四情况：正常 / 空数组(无字幕) / need_login_subtitle=true / code≠0 风控
 *   4. content.js 组装 → background WS ingest（mock WS server 收到上报）
 *   5. navigate 命令：broadcastCommand → 扩展 chrome.tabs.create
 *   6. operate 命令：mock 字幕按钮 DOM，验证点击后 content.js 回传 subtitleObserved 真实结果
 */
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, '..', 'apps', 'subtitle-collector');

// ---- mock collector-server（HTTP /ping + WS /ext，收扩展 ingest / 发 navigate+operate） ----
const received = { ingests: [], results: [] };
const httpServer = createServer((req, res) => {
  if (req.url === '/ping') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ext' });
wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.type === 'hello') ws.send(JSON.stringify({ type: 'hello-ack', ok: true }));
    else if (m.type === 'ingest') { received.ingests.push(m.payload); ws.send(JSON.stringify({ type: 'ingest-ack', ok: true, inserted_tracks: (m.payload?.tracks?.length ?? 0) })); }
    else if (m.type === 'result') received.results.push(m);
  });
});
await new Promise((r) => httpServer.listen(21527, '127.0.0.1', r));

// ---- Chrome for Testing ----
let exec = '';
try {
  const base = join(homedir(), '.cache/puppeteer/chrome');
  const ver = readdirSync(base).sort().pop();
  const cand = join(base, ver, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
  if (existsSync(cand)) exec = cand;
} catch {}
const browser = await puppeteer.launch({
  ...(exec ? { executablePath: exec } : {}),
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900'],
});
await new Promise(r => setTimeout(r, 3000));
const page = await browser.newPage();

// ---- mock player API：四情况 ----
await page.setRequestInterception(true);
page.on('request', (req) => {
  const u = req.url();
  const h = { 'access-control-allow-origin': '*' };
  if (u.includes('CASE_NORMAL')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVnormal', aid: 1, cid: 2, title: '正常', up_info: { mid: 11, name: 'up1' }, subtitle: { subtitles: [{ lan: 'zh-Hans', lan_doc: '简体中文', type: 2, subtitle_url: '//aisubtitle.hdslb.com/SUB_NORMAL.json' }] } } }) });
  } else if (u.includes('CASE_EMPTY')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVempty', aid: 3, cid: 4, title: '无字幕', up_info: { mid: 12 }, subtitle: { subtitles: [] } } }) });
  } else if (u.includes('CASE_LOGIN')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { bvid: 'BVlogin', aid: 5, cid: 6, title: '需登录', need_login_subtitle: true, subtitle: { subtitles: [] } } }) });
  } else if (u.includes('CASE_RISK')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: -509, data: {} }) });
  } else if (u.includes('SUB_NORMAL')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ body: [{ from: 0, to: 1, content: '正常字幕样例' }] }) });
  } else { req.continue(); }
});

// 情况1：正常 → 应收到 ingest（含轨 + body）
await page.goto('https://www.bilibili.com/video/CASE_NORMAL', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_NORMAL'));
await page.evaluate(() => fetch('https://aisubtitle.hdslb.com/SUB_NORMAL.json'));
await new Promise(r => setTimeout(r, 1500));

// 情况2/3/4：空 / 需登录 / 风控 → 都不应产生 ingest
await page.goto('https://www.bilibili.com/video/CASE_EMPTY', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_EMPTY'));
await page.goto('https://www.bilibili.com/video/CASE_LOGIN', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_LOGIN'));
await page.goto('https://www.bilibili.com/video/CASE_RISK', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => fetch('https://api.bilibili.com/x/player/wbi/v2?z=CASE_RISK'));
await new Promise(r => setTimeout(r, 1500));

// 5. navigate 命令：服务端主动下发，扩展应 chrome.tabs.create
for (const c of wss.clients) c.send(JSON.stringify({ id: 'cmd-nav', action: 'navigate', url: 'https://www.bilibili.com/video/CASE_NORMAL' }));
await new Promise(r => setTimeout(r, 1500));
const navResult = received.results.find(r => r.id === 'cmd-nav');
console.log('[navigate]', navResult?.ok ? '✅ 扩展回 result ok' : '❌ 未收到 result');

// 6. operate 命令：注入 mock 字幕按钮到当前页，验证 content.js 回传 subtitleObserved 真实结果
await page.evaluate(() => {
  const btn = document.createElement('div');
  btn.className = 'bpx-player-ctrl-btn-icon';
  btn.id = 'mock-sub-toggle';
  btn.addEventListener('click', () => { /* 模拟点击后播放器会请求字幕 */ fetch('https://aisubtitle.hdslb.com/SUB_NORMAL.json'); });
  document.body.appendChild(btn);
});
for (const c of wss.clients) c.send(JSON.stringify({ id: 'cmd-op', action: 'operate', op: 'click-subtitle-toggle' }));
await new Promise(r => setTimeout(r, 12000)); // operate 最多等 5s+5s fallback
const opResult = received.results.find(r => r.id === 'cmd-op');
console.log('[operate]', opResult?.data?.subtitleObserved ? '✅ 点击触发了字幕请求' : '⚠️ 未观察到字幕请求（按 spike 结论决定是否 CDP 降级）');

// ---- 断言 ----
const ok = received.ingests.length === 1 && received.ingests[0]?.video?.source_vid === 'BVnormal';
console.log('\n[ingest 四情况]', ok ? '✅ 仅正常情况上报，其余三情况未上报' : '❌ subtitle_url 四情况处理异常');
console.log('  收到 ingest 数:', received.ingests.length, '| navigate:', !!navResult, '| operate:', !!opResult);

await browser.close();
httpServer.close();
process.exit(ok && navResult && opResult ? 0 : 1);
```

Run（前置：根 `package.json` 已含 puppeteer，见 Step 4）：
```bash
node scripts/verify-collector.mjs
```
Expected: ingest 四情况 ✅ + navigate ✅ + operate 回传 subtitleObserved 真实结果。**失败即回归，CI 应红。**

- [ ] **Step 4: 接入 turbo `test` task + 根 package.json puppeteer 依赖**

`scripts/verify-collector.mjs` 与 `scripts/verify-extension.mjs` 都依赖 `puppeteer`，但当前根 `package.json` 未声明，直接跑会 `Cannot find module 'puppeteer'`。补上：

Modify `turbo.json`（加 `test` task，依赖上游 `^build`，保证 collector-web 产物先就绪）：
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "outputs": ["dist/**"] },
    "dev": { "cache": false, "persistent": true },
    "test": { "dependsOn": ["^build"], "outputs": [] }
  }
}
```

Modify `package.json`（根）：
```json
{
  "name": "bilibili-extensions",
  "private": true,
  "scripts": {
    "build": "turbo build",
    "dev": "turbo dev",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2",
    "puppeteer": "^23.0.0"
  },
  "packageManager": "pnpm@9.15.4"
}
```

各包 `package.json` 的 `test` 脚本已存在（collector-server: `node --test --import tsx`）；collector-web/扩展无单测，puppeteer 回归脚本通过根目录直接 `node scripts/verify-collector.mjs` 运行（不入 turbo task，因 puppeteer 需下载 Chrome，放 CI 手动触发）。

Run（一次性安装新依赖）：
```bash
pnpm install
```
Expected: puppeteer 安装并下载 Chrome for Testing 到 `~/.cache/puppeteer/`。

- [ ] **Step 5: 跑服务端测试套件作为自动化端到端**

服务端各 task 已有 `node:test` 单测（ingest 幂等/变更日志、WS RPC、HTTP 查询）。Task 7 末尾跑一遍确认：
```bash
pnpm test
```
Expected: 所有测试通过（具体数量取决于 Task 2/3 实现）。

- [ ] **Step 6: 提交**

```bash
cd /Users/taevas/code/mymy/bilibili-extensions
git add scripts/load-collector-extension.sh scripts/verify-collector.mjs MANUAL-collector.md turbo.json package.json pnpm-lock.yaml
git commit -m "test(collector): puppeteer mock regression + turbo test task + e2e acceptance"
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
- WS 消息 type 字段：hello / log / ingest / ingest-ack / result（Task 3 + Task 5 一致）；C3 后 hello 必带 token、服务端回 hello-ack/hello-nack
- HTTP 路径：/ping /api/videos /api/videos/:source/:source_vid /api/versions/:id（Task 3/4 + Task 6 api.ts 对齐）
- 默认轨优先级：Task 4 queries.ts 与 §5.6 一致（CC中文 > AI中文 > 英文 > 其他）

**审查反馈 Critical 已修复（C1-C8）：**
- C1 MV3 SW 保活：manifest 加 `alarms` 权限；background 启动建 `keepalive` alarm（periodInMinutes 0.4），onAlarm 兜底重连；WS 未连时 content 记录暂存 `chrome.storage.local`，onopen flushPendingIngests 补发（Task 5 Step 5）
- C2 HTTP Origin/Host 校验：main.ts（Task 4 Step 3）加 `httpOriginAllowed` 守卫——`/ping` 外所有请求校验 Host ∈ {localhost,127.0.0.1} 防 DNS rebinding + Origin 白名单（扩展 / 同源 loopback），非法返 403；同时保护 `/api/*` 与 Task 6 静态托管（serveStatic 落在校验之后）
- C3 扩展身份/token：hello 带 token（取自 config.js）；server.ts hello 校验不匹配关闭（4001）；config.js 落 plan（Task 5 Step 5b）；服务端 token 取自 `COLLECTOR_TOKEN` env（Task 3 main.ts）
- C4 collector-web 样式：强制 Tailwind + shadcn/ui，Task 6 Step 1 init + Step 2 依赖；TrackSwitcher→shadcn Tabs、VersionSwitcher/SubtitleView→shadcn Button、VideoList→Input+Card、VideoDetail→Button+Tailwind；禁止 `style={{}}` 与手写 .css（globals.css 仅 Tailwind 指令 + shadcn CSS 变量）
- C5 click 可行性：Task 5 Step 0 新增 spike（真实登录态 profile，click()→pointer 序列→CDP 降级判定）；content.js operate sendResponse 改为 `{ clicked, subtitleObserved, note }` 真实结果（点击后 5s+5s 监听字幕请求）
- C6 manual 版本去重：schema 去 UNIQUE（改应用层去重 + idx_versions_dedup）；ingest.ts version 写入分支——origin='manual' 始终 INSERT 新行，external/asr 先 SELECT 命中跳过
- C7 ingest-ack 协议地位：由 spec §4.1 协议层澄清（ingest-ack 是服务端→扩展的主动消息，无 id，不进 pending Map，已从 Command 列表移除）；plan 侧 server.ts 以 `{type:'ingest-ack',...}` 主动推送、background 作主动消息处理，与 spec 一致
- C8 测试：新增 scripts/verify-collector.mjs（puppeteer mock，四情况/navigate/operate）；turbo.json 加 `test` task（dependsOn ^build）；根 package.json 加 `test` 脚本 + puppeteer devDependency

**已发现的 trade-off（保留）：**
- Task 4 把 default 标记在查询时算（与 §5.6 一致）
- Task 5 content.js 暴遍历找 bvid 是简化实现，可后续优化（标记 trade-off）
- Task 5 operate 命令的字幕开关选择器是简化版本，覆盖 B 站主流；C5 后点击结果回传 subtitleObserved 真实值（false 时上层按 spike 结论走 CDP 降级），后续可补

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