# 主动采集 P2（UP 主维度）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 P1 主动采集加 UP 主维度——`upper-info`（资料入库）/ `upper-videos`（拉列表不入库）/ `new-videos`（对比库找新增）。

**Architecture:** 复用 P1 链路（扩展内 fetch + Wbi 签名）。新增 2 个 WS action（`get-upper-info` / `list-upper-videos`）+ 1 条上行消息（`ingest-upper`）。creators 表扩 7 字段（sign/level/sex/official_type/official_title/fans/following）。CLI 加 3 个 collect 子命令。**upper-videos 不入库**（避免污染 P1 dedupe）。

**Tech Stack:** 同 P1（subtitle-collector Vite/crxjs + collector-server tsx/commander/better-sqlite3/ws；测试扩展 `node --test test/*.test.mjs` + `scripts/verify-*.mjs`，server `node --test --import tsx src/**/*.test.ts`）。

**Spec:** [2026-07-05-active-collection-p2-design.md](../specs/2026-07-05-active-collection-p2-design.md)

---

## File Structure

**collector-server（db + ws + cli）：**
- `apps/collector-server/src/db/schema.sql`（改）— creators 加 7 字段
- `apps/collector-server/src/db/migrate.ts`（新）— 启动迁移（ALTER ADD COLUMN 幂等）
- `apps/collector-server/src/db/ingest.ts`（改）— 加 `ingestUpper` 纯函数 + `IngestUpperRequest` 类型
- `apps/collector-server/src/db/ingest.test.ts`（新）— `ingestUpper` 单测
- `apps/collector-server/src/main.ts`（改）— 启动调 `runMigrations(db)`
- `apps/collector-server/src/ws/server.ts`（改）— `ingest-upper` 消息分支
- `apps/collector-server/src/cli/commands/collect.ts`（改）— `upper-info` / `upper-videos` / `new-videos` 纯处理 + commander
- `apps/collector-server/src/cli/commands/collect.test.ts`（改）— 加测试

**扩展（subtitle-collector）：**
- `apps/subtitle-collector/background.js`（改）— `get-upper-info` / `list-upper-videos` action 分支

**测试：**
- `scripts/verify-active-collect.mjs`（改）— mock acc/info / arc/search，断言 ingest-upper + 回执

---

## Task 1: creators 表扩字段 + 迁移 + ingestUpper 纯函数

**Files:**
- Modify: `apps/collector-server/src/db/schema.sql`（creators 加 7 字段）
- Create: `apps/collector-server/src/db/migrate.ts`
- Modify: `apps/collector-server/src/db/ingest.ts`（加 `ingestUpper`）
- Create: `apps/collector-server/src/db/ingest.test.ts`
- Modify: `apps/collector-server/src/main.ts`（启动调迁移）

- [ ] **Step 1: 改 schema.sql — creators 加 7 字段**

把 [schema.sql](../../apps/collector-server/src/db/schema.sql) 的 creators 表（L2-11）改为：
```sql
CREATE TABLE IF NOT EXISTS creators (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  source_uid    TEXT NOT NULL,
  name          TEXT,
  avatar        TEXT,
  sign          TEXT,
  level         INTEGER,
  sex           TEXT,
  official_type INTEGER,
  official_title TEXT,
  fans          INTEGER,
  following     INTEGER,
  first_seen_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(source, source_uid)
);
```
（新建库时直接含新字段；已建库的旧表由 migrate.ts 补列。）

- [ ] **Step 2: 写 migrate.ts**

`apps/collector-server/src/db/migrate.ts`:
```typescript
import type Database from 'better-sqlite3';

// 已建库的旧 creators 表（P2 前只有 name/avatar）补 P2 新列。幂等：列已存在时 SQLite 报
// "duplicate column name"，吞掉即可。新建库（schema.sql 已含新列）调这个也无副作用。
const CREATOR_COLUMNS: Array<{ name: string; type: string }> = [
  { name: 'sign', type: 'TEXT' },
  { name: 'level', type: 'INTEGER' },
  { name: 'sex', type: 'TEXT' },
  { name: 'official_type', type: 'INTEGER' },
  { name: 'official_title', type: 'TEXT' },
  { name: 'fans', type: 'INTEGER' },
  { name: 'following', type: 'INTEGER' },
];

export function runMigrations(db: Database.Database): void {
  for (const col of CREATOR_COLUMNS) {
    try {
      db.exec(`ALTER TABLE creators ADD COLUMN ${col.name} ${col.type}`);
    } catch (err) {
      const msg = (err as Error).message;
      if (!msg.includes('duplicate column name')) throw err;
      // 列已存在，幂等跳过
    }
  }
}
```

- [ ] **Step 3: 写 ingestUpper 失败测试**

`apps/collector-server/src/db/ingest.test.ts`:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ingestUpper } from './ingest.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE creators (id INTEGER PRIMARY KEY, source TEXT, source_uid TEXT, name TEXT, avatar TEXT,
      sign TEXT, level INTEGER, sex TEXT, official_type INTEGER, official_title TEXT, fans INTEGER, following INTEGER,
      first_seen_at INTEGER, updated_at INTEGER, UNIQUE(source, source_uid));
    CREATE TABLE change_log (id INTEGER PRIMARY KEY, entity TEXT, entity_id INTEGER, field TEXT,
      old_value TEXT, new_value TEXT, changed_at INTEGER);
  `);
  return db;
}

test('ingestUpper 首次插入 creator（含新字段）', () => {
  const db = makeDb();
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
  assert.deepEqual(out.updated_fields.sort(), ['avatar','fans','following','level','name','official_title','official_type','sex','sign']);
});

test('ingestUpper 字段变化记 change_log', () => {
  const db = makeDb();
  ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', sign: '旧签名' } });
  ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', sign: '新签名' } });
  const changes = db.prepare('SELECT field FROM change_log WHERE entity=? AND entity_id=?').all('creator', 1) as Array<{ field: string }>;
  assert.equal(changes.length, 1);
  assert.equal(changes[0].field, 'sign');
});

test('ingestUpper fans/following 波动不记 change_log（stat 类）', () => {
  const db = makeDb();
  ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', fans: 1000, following: 50 } });
  ingestUpper(db, { source: 'bilibili', creator: { source_uid: '123', name: 'up1', fans: 2000, following: 60 } });
  const changes = db.prepare('SELECT field FROM change_log WHERE entity=?').all('creator') as Array<{ field: string }>;
  // fans/following 变化不记 change_log
  assert.equal(changes.filter((c) => c.field === 'fans' || c.field === 'following').length, 0);
  const row = db.prepare('SELECT fans, following FROM creators WHERE source_uid=?').get('123') as Record<string, number>;
  assert.equal(row.fans, 2000); // 值仍更新
  assert.equal(row.following, 60);
});
```

- [ ] **Step 4: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: FAIL (`ingestUpper is not a function` 或 import 失败)。

- [ ] **Step 5: 实现 ingestUpper（加到 ingest.ts 末尾）**

在 `apps/collector-server/src/db/ingest.ts` 末尾追加：
```typescript
// ── P2: UP 主资料 upsert（独立于 ingestVideo，只写 creators）──

export interface IngestUpperRequest {
  source: string;
  creator: {
    source_uid: string;
    name?: string;
    avatar?: string;
    sign?: string;
    level?: number;
    sex?: string;
    official_type?: number;
    official_title?: string;
    fans?: number;
    following?: number;
  };
}

export interface IngestUpperResult {
  source: string;
  source_uid: string;
  updated_fields: string[];
}

// fans/following 是时点 stat（同 videos.stat 哲学），波动不记 change_log；其余字段变化照常记。
const UPPER_STAT_FIELDS = new Set(['fans', 'following']);
const UPPER_FIELDS = ['name', 'avatar', 'sign', 'level', 'sex', 'official_type', 'official_title', 'fans', 'following'] as const;

export function ingestUpper(db: Database.Database, req: IngestUpperRequest): IngestUpperResult {
  const now = Date.now();
  const creatorSel = db.prepare('SELECT * FROM creators WHERE source = ? AND source_uid = ?');
  const changeIns = db.prepare('INSERT INTO change_log (entity, entity_id, field, old_value, new_value, changed_at) VALUES (?, ?, ?, ?, ?, ?)');

  const existing = creatorSel.get(req.source, req.creator.source_uid) as Record<string, unknown> | undefined;

  if (!existing) {
    db.prepare(`INSERT INTO creators (source, source_uid, name, avatar, sign, level, sex, official_type, official_title, fans, following, first_seen_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req.source, req.creator.source_uid,
        req.creator.name ?? null, req.creator.avatar ?? null, req.creator.sign ?? null,
        req.creator.level ?? null, req.creator.sex ?? null, req.creator.official_type ?? null,
        req.creator.official_title ?? null, req.creator.fans ?? null, req.creator.following ?? null,
        now, now);
    return { source: req.source, source_uid: req.creator.source_uid, updated_fields: [...UPPER_FIELDS] };
  }

  const id = existing.id as number;
  const updated: string[] = [];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of UPPER_FIELDS) {
    const oldV = existing[f];
    const newV = (req.creator as Record<string, unknown>)[f] ?? null;
    if (String(oldV ?? '') !== String(newV ?? '')) {
      if (!UPPER_STAT_FIELDS.has(f)) {
        changeIns.run('creator', id, f, oldV == null ? null : String(oldV), newV == null ? null : String(newV), now);
      }
      updated.push(f);
      sets.push(`${f} = ?`);
      vals.push(newV);
    }
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    vals.push(now);
    vals.push(id);
    db.prepare(`UPDATE creators SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  return { source: req.source, source_uid: req.creator.source_uid, updated_fields: updated };
}
```

- [ ] **Step 6: main.ts 启动调迁移**

读 `apps/collector-server/src/main.ts`，在 db 打开后（`runMigrations` import 自 `./db/migrate.js`）调用：
```typescript
import { runMigrations } from './db/migrate.js';
// ... db 打开后：
runMigrations(db);
```
（具体插入位置：main.ts 里 db 初始化之后、server 启动之前。）

- [ ] **Step 7: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: PASS（3 个 ingestUpper test + 之前的 collect test 全过）。

- [ ] **Step 8: Commit**

```bash
git add apps/collector-server/src/db/schema.sql apps/collector-server/src/db/migrate.ts apps/collector-server/src/db/ingest.ts apps/collector-server/src/db/ingest.test.ts apps/collector-server/src/main.ts
git commit -m "feat(server): creators 扩字段 + 迁移 + ingestUpper

P2 数据层：creators 加 sign/level/sex/official_type/official_title/fans/following；
migrate.ts 幂等迁移；ingestUpper upsert + 字段级 change_log（fans/following 波动不记）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: server ws ingest-upper 消息分支

**Files:**
- Modify: `apps/collector-server/src/ws/server.ts`（`ingest-upper` 消息分支）

- [ ] **Step 1: 先确认 build 基线**

Run: `pnpm --filter @bilibili-ext/collector-server test` — 确认 Task 1 测试通过。

- [ ] **Step 2: 改 ws/server.ts — 加 ingest-upper 分支**

读 `apps/collector-server/src/ws/server.ts`，在 `ingest` 消息分支（约 L78-86）之后加 `ingest-upper` 分支：
```typescript
      if (msg.type === 'ingest-upper' && msg.payload) {
        try {
          const result = ingestUpper(_db, msg.payload as IngestUpperRequest);
          ws.send(JSON.stringify({ type: 'ingest-upper-ack', ok: true, ...result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ingest-upper-ack', ok: false, error: (err as Error).message }));
        }
        return;
      }
```
顶部 import 加：`import { ingestVideo, ingestUpper, type IngestRequest, type IngestUpperRequest } from '../db/ingest.js';`（把现有 `ingestVideo` import 行扩成同时 import `ingestUpper` + `IngestUpperRequest`）。

- [ ] **Step 3: build 冒烟（tsc）**

Run: `pnpm --filter @bilibili-ext/collector-server exec tsc --noEmit`
Expected: 0 error。

- [ ] **Step 4: Commit**

```bash
git add apps/collector-server/src/ws/server.ts
git commit -m "feat(server): ws ingest-upper 消息分支

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: 扩展 get-upper-info + list-upper-videos action

**Files:**
- Modify: `apps/subtitle-collector/background.js`（action 分发加 2 个分支）

- [ ] **Step 1: 先确认 background.js 干净 + build 基线**

`git status` — 确认 `apps/subtitle-collector/background.js` 无未提交改动。若有，报 BLOCKED。
`pnpm --filter @bilibili-ext/subtitle-collector build` — 确认基线 build 通过。

- [ ] **Step 2: 改 background.js — 加 get-upper-info + list-upper-videos 分支**

读 `apps/subtitle-collector/background.js`，在 action 分发链（search/fetch-subtitle 之后，set-reporting 之前）插入 2 个分支：
```javascript
      } else if (msg.action === "get-upper-info") {
        try {
          if (!wbiKeys) await refreshWbiKeys();
          const mid = msg.mid;
          // 1. acc/info（Wbi）：name/sign/level/sex/official/face
          const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
          if (!infoRes.ok) { ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: infoRes.code })); return; }
          const info = infoRes.data;
          // 2. relation/stat（cookie）：follower/following
          const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
          const stat = statRes.ok ? statRes.data : {};
          // 3. 上报 ingest-upper（入库 creators）
          const creator = {
            source_uid: String(mid),
            name: info.name ?? null,
            avatar: info.face ?? null,
            sign: info.sign ?? null,
            level: info.level ?? null,
            sex: info.sex ?? null,
            official_type: info.official?.type ?? null,
            official_title: info.official?.title ?? null,
            fans: stat.follower ?? null,
            following: stat.following ?? null,
          };
          ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
          // 4. 回执
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, data: { mid, ...creator } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
      } else if (msg.action === "list-upper-videos") {
        try {
          if (!wbiKeys) await refreshWbiKeys();
          const parsed = await biliFetch('/x/space/wbi/arc/search', {
            wbi: true,
            params: { mid: msg.mid, pn: msg.page ?? 1, ps: msg.page_size ?? 30, order: 'pubdate' },
            wbiKeys,
          });
          if (!parsed.ok) {
            ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: parsed.code }));
          } else {
            const vlist = parsed.data?.list?.vlist ?? [];
            const items = vlist.map((v) => ({
              bvid: v.bvid, title: v.title, created: v.created ?? null,
              play: v.play ?? null, length: v.length ?? null,
            }));
            ws.send(JSON.stringify({
              type: "result", id: msg.id, ok: true,
              data: { total: parsed.data?.page?.count ?? items.length, items },
            }));
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: "result", id: msg.id, ok: false, error: String(err.message || err) }));
        }
```
（`list-upper-videos` 不发 ingest，不入库——对齐 spec §2 决策 A。）

- [ ] **Step 3: build 冒烟**

Run: `pnpm --filter @bilibili-ext/subtitle-collector build`
Expected: build 成功。

- [ ] **Step 4: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): get-upper-info + list-upper-videos action

get-upper-info：fetch acc/info + relation/stat → ingest-upper 入库 creators。
list-upper-videos：fetch arc/search → 回执列表（不入库）。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: CLI collect upper-info / upper-videos / new-videos

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts`（3 个纯处理 + commander）
- Modify: `apps/collector-server/src/cli/commands/collect.test.ts`（加测试）

- [ ] **Step 1: 写失败测试（追加到 collect.test.ts）**

```typescript
test('collectUpperInfo 下发 get-upper-info', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { mid: '123', name: 'up1', fans: 1000 } } });
  const out = await collectUpperInfo(c as any, 'c1', '123', 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'get-upper-info', params: { mid: '123' }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { mid: '123', name: 'up1', fans: 1000 } } });
});

test('collectUpperVideos 下发 list-upper-videos', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 2, items: [{ bvid: 'BV1' }] } } });
  const out = await collectUpperVideos(c as any, 'c1', '123', { page: 1, size: 30 }, 15000);
  assert.deepEqual(c.calls[0], { clientId: 'c1', action: 'list-upper-videos', params: { mid: '123', page: 1, page_size: 30 }, timeout: 15000 });
  assert.deepEqual(out, { ok: true, result: { ok: true, data: { total: 2, items: [{ bvid: 'BV1' }] } } });
});

test('collectNewVideos 拉列表 + 对比库 → 返回 new/collected', async () => {
  const c = mockClient({ ok: true, result: { ok: true, data: { total: 3, items: [
    { bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' },
  ] } } });
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV2','t',1)").run();
  const out = await collectNewVideos(c as any, 'c1', '123', db, { page: 1, size: 30 }, 15000);
  assert.deepEqual(out.new.sort(), ['BV1', 'BV3']);
  assert.deepEqual(out.collected, ['BV2']);
});
```
顶部 import 加 `collectUpperInfo, collectUpperVideos, collectNewVideos`。`makeDb` 复用 collect.test.ts 现有的（P1 已定义）。

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: FAIL (`collectUpperInfo is not defined`)。

- [ ] **Step 3: 实现纯处理（加到 collect.ts 纯处理区）**

```typescript
import type Database from 'better-sqlite3';  // 顶部已 import（P1）

/** `collect upper-info <mid>`：下发 get-upper-info，扩展 fetch acc/info+stat → ingest-upper 入库。 */
export async function collectUpperInfo(
  client: CollectClient, clientId: string, mid: string, timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'get-upper-info', { mid }, timeout);
}

export interface UpperVideosOpts { page?: number; size?: number; }

/** `collect upper-videos <mid>`：下发 list-upper-videos，返回视频列表（不入库）。 */
export async function collectUpperVideos(
  client: CollectClient, clientId: string, mid: string, opts: UpperVideosOpts, timeout: number,
): Promise<unknown> {
  return client.sendCommand(clientId, 'list-upper-videos',
    { mid, page: opts.page ?? 1, page_size: opts.size ?? 30 }, timeout);
}

/** `collect new-videos <mid>`：拉 UP 主视频列表（经扩展）+ 直读 SQLite 对比 → 返回 new/collected。 */
export async function collectNewVideos(
  client: CollectClient, clientId: string, mid: string, db: Database.Database,
  opts: UpperVideosOpts, timeout: number,
): Promise<{ total: number; new: string[]; collected: string[] }> {
  const resp = await collectUpperVideos(client, clientId, mid, opts, timeout) as {
    ok: boolean; result?: { ok: boolean; data?: { total?: number; items?: Array<{ bvid: string }> } };
  };
  const items = resp.result?.data?.items ?? [];
  const bvids = items.map((it) => it.bvid).filter(Boolean);
  if (bvids.length === 0) return { total: resp.result?.data?.total ?? 0, new: [], collected: [] };
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT source_vid FROM videos WHERE source = 'bilibili' AND source_vid IN (${placeholders})`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  const set = new Set(rows.map((r) => r.source_vid));
  const collected: string[] = [];
  const newArr: string[] = [];
  for (const b of bvids) (set.has(b) ? collected : newArr).push(b);
  return { total: resp.result?.data?.total ?? bvids.length, new: newArr, collected };
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test`
Expected: PASS（3 个新 test + 之前的全过）。

- [ ] **Step 5: 装配 commander（buildCollectCommand 内加 3 子命令）**

在 collect.ts 的 `buildCollectCommand` 内加：
```typescript
  collect
    .command('upper-info <mid>')
    .description('采集 UP 主资料入库（扩展 fetch acc/info + relation/stat）')
    .option('--client <id>', '扩展 client_id（缺省取第一个在线）')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectUpperInfo(client as CollectClient, clientId, mid, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) { handleHttpError(err); }
    });

  collect
    .command('upper-videos <mid>')
    .description('拉 UP 主视频列表（不入库）')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { page: number; size: number; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectUpperVideos(client as CollectClient, clientId, mid, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) { handleHttpError(err); }
    });

  collect
    .command('new-videos <mid>')
    .description('发现 UP 主新视频：拉列表 + 对比库 → 返回 new/collected')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mid: string, opts: { page: number; size: number; client?: string; timeout: number }) => {
      if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) emitError(`invalid --timeout: ${opts.timeout}`, 'ARGS');
      const ctx = getCliContext();
      const client = new ServerClient(ctx.serverUrl, ctx.token);
      let db: Database.Database;
      try { db = openReadonlyDb(ctx.dbPath); } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitError(msg, 'DB_UNREADABLE');
      }
      try {
        const clientId = await resolveClientId(client as CollectClient, opts.client);
        const data = await collectNewVideos(client as CollectClient, clientId, mid, db, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) { handleHttpError(err); }
    });

  return collect;
```

- [ ] **Step 6: 跑测试 + 冒烟**

Run:
```bash
pnpm --filter @bilibili-ext/collector-server test
pnpm --filter @bilibili-ext/collector-server cli -- collect --help
```
Expected: test PASS；`collect --help` 含 upper-info/upper-videos/new-videos。

- [ ] **Step 7: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collect upper-info / upper-videos / new-videos

upper-info/upper-videos 经扩展 fetch；new-videos 拉列表+对比库返回 new/collected。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: verify + 出站验证

**Files:**
- Modify: `scripts/verify-active-collect.mjs`（加 upper-info / upper-videos mock 段）

- [ ] **Step 1: 扩 verify 脚本（mock acc/info / relation/stat / arc/search）**

在 `scripts/verify-active-collect.mjs` 的 `page.on('request', ...)` mock 分支里，加：
```javascript
  } else if (u.includes('/x/space/wbi/acc/info')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { mid: 99, name: 'up主', face: 'f', sign: '签名', level: 6, sex: '男', official: { type: 1, title: '官方' } } }) });
  } else if (u.includes('/x/relation/stat')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { mid: 99, follower: 1000, following: 50 } }) });
  } else if (u.includes('/x/space/wbi/arc/search')) {
    req.respond({ status: 200, contentType: 'application/json', headers: h, body: JSON.stringify({ code: 0, data: { page: { count: 1 }, list: { vlist: [{ bvid: 'BVupper', title: 'UP视频', created: 1700000000, play: 5, length: '5:00' }] } } }) });
  }
```
在 search/fetch-subtitle 测试段之后，加 upper-info / upper-videos 测试段：
```javascript
// 3. upper-info
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-upper', action: 'get-upper-info', mid: 99 }));
await new Promise((r) => setTimeout(r, 3000));
const upperRes = received.results.find((r) => r.id === 't-upper');
const upperIngest = received.ingestUpper?.find((p) => p.creator?.source_uid === '99');  // 需在 mock server 收 ingest-upper
console.log('[upper-info]', upperRes?.ok && upperRes.data?.name === 'up主' ? '✅' : '❌', upperRes);

// 4. upper-videos
for (const c of wss.clients) c.send(JSON.stringify({ id: 't-uv', action: 'list-upper-videos', mid: 99, page: 1, page_size: 30 }));
await new Promise((r) => setTimeout(r, 3000));
const uvRes = received.results.find((r) => r.id === 't-uv');
console.log('[upper-videos]', uvRes?.ok && uvRes.data?.items?.length === 1 ? '✅' : '❌', uvRes);
```
mock WS server 的 message handler 加收 `ingest-upper`：`else if (m.type === 'ingest-upper') { (received.ingestUpper ??= []).push(m.payload); ws.send(JSON.stringify({ type: 'ingest-upper-ack', ok: true })); }`，`received` 初始化加 `ingestUpper: []`。

退出码判定：`const ok = searchRes?.ok && capRes?.ok && capIngest && upperRes?.ok && uvRes?.ok;`

- [ ] **Step 2: 跑 verify**

Run:
```bash
pnpm --filter @bilibili-ext/subtitle-collector build
node scripts/verify-active-collect.mjs
```
Expected: `[upper-info] ✅`、`[upper-videos] ✅`，退出码 0。
> 端口 21527 被占（server 跑）则停 server 再跑；SW fetch 拦截失败按 P1 同样回退（CDP 或标 concern）。

- [ ] **Step 3: 出站验证（spec R4）**

Run:
```bash
grep -rn "api.bilibili.com" apps/collector-server/src 2>/dev/null || echo "(server/CLI 无 api.bilibili.com 出站)"
```
Expected: 无输出（server/CLI 不出站，全扩展 fetch）。

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-active-collect.mjs
git commit -m "test: P2 upper-info/upper-videos 端到端 verify

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完工验收（对齐 spec §11 B1–B4）

跑完全部 task 后确认：

- [ ] B1 `cli collect upper-info <mid>` 入库 creators 新字段（sign/level/.../fans/following）
- [ ] B2 `cli collect upper-videos <mid>` 返回列表（videos 表无新增，不入库）
- [ ] B3 `cli collect new-videos <mid>` 对比库返回 new/collected（手造数据验证差集）
- [ ] B4 creators 迁移幂等（重复启动不报错）；fans/following 波动不记 change_log

## 测试轮次记录表（spec §12.1）

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |
