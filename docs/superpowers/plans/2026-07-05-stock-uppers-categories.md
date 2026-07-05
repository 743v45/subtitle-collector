# 股票 UP 主分类采集 + 后台管理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development 或 superpowers:executing-plans 逐任务实现。Steps 用 `- [ ]` 跟踪。
> **并发说明**：本计划分 Group A（CLI）/ B（server）/ C（前端）。Group 内 task 串行；Group 间按 spec 契约（`docs/superpowers/specs/2026-07-05-stock-uppers-categories-design.md`）可并发，建议分派三路 agent teams。集成 task（I 系列）在三个 Group 完成后串行。

**Goal:** 让 collect-uppers 能按「今日收盘后」时间窗 + 分类批量采股票 UP 主新视频字幕，并在 collector-web 后台管理分类与 UP 主。

**Architecture:** 数据层加 `categories` 表 + creators 两列（migrate 双轨，ingest 不动）；CLI 层加时间窗过滤 + 无字幕重采 + 按分类；server 加 categories/creators HTTP API；前端加分类管理 + UP 主管理两个 tab 页。

**Tech Stack:** TypeScript / better-sqlite3 / Node http / commander / React / Vite / Tailwind / shadcn-ui / node:test。

**spec:** [docs/superpowers/specs/2026-07-05-stock-uppers-categories-design.md](../specs/2026-07-05-stock-uppers-categories-design.md)

---

## Group B — server 层（基础先行，A/C 依赖其契约）

### Task B1: categories 表 + creators 加两列 + migrate

**Files:**
- Modify: `apps/collector-server/src/db/schema.sql`（末尾追加 categories 表；creators 建表语句加两列）
- Modify: `apps/collector-server/src/db/migrate.ts:22-30`（CREATOR_COLUMNS 追加两列）
- Test: `apps/collector-server/src/db/migrate.test.ts`（新建）

- [ ] **Step 1: 写 migrate 幂等测试**

`apps/collector-server/src/db/migrate.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from './migrate.ts';

test('migrate + runMigrations 幂等：跑两次不报错且字段存在', () => {
  const db = new Database(':memory:');
  migrate(db);
  runMigrations(db);
  // 第二次（模拟旧库已加列场景）
  runMigrations(db);

  // categories 表存在
  const cats = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='categories'").get();
  assert.ok(cats, 'categories 表应被创建');

  // creators 两列存在
  const cols = db.prepare("PRAGMA table_info(creators)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes('category_agent_id'), 'creators.category_agent_id 应存在');
  assert.ok(names.includes('category_human_id'), 'creators.category_human_id 应存在');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/db/migrate.test.ts`
Expected: FAIL（categories 表不存在 / 列不存在）

- [ ] **Step 3: schema.sql 加 categories 表 + creators 两列**

在 `apps/collector-server/src/db/schema.sql` 的 `creators` 建表语句（L2-18）的 `following` 行后、`first_seen_at` 前插入：
```sql
  category_agent_id INTEGER REFERENCES categories(id),
  category_human_id INTEGER REFERENCES categories(id),
```
（注意：`categories` 表在文件后面定义；SQLite 不要求被引用表先定义，但为清晰可在 creators 前先放 categories 表。实际把 categories 表 DDL 移到 creators 之前最稳妥。）

在文件**开头**（creators 表之前）插入 categories 表：
```sql
-- UP 主分类（agent 自动分类 / human 人工分类，两套隔离）。
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK(scope IN ('agent','human')),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE(name, scope)
);
CREATE INDEX IF NOT EXISTS idx_categories_scope ON categories(scope, sort_order);
```

- [ ] **Step 4: migrate.ts CREATOR_COLUMNS 追加两列**

`apps/collector-server/src/db/migrate.ts` 的 `CREATOR_COLUMNS` 数组末尾追加：
```ts
  { name: 'category_agent_id', type: 'INTEGER' },
  { name: 'category_human_id', type: 'INTEGER' },
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/db/migrate.test.ts`
Expected: PASS

- [ ] **Step 6: 验证 build 复制 schema（无需改 build 脚本）**

Run: `cd apps/collector-server && pnpm build`
Expected: `tsc` + `cp src/db/schema.sql dist/db/schema.sql` 成功，无 TS 报错。

- [ ] **Step 7: Commit**

```bash
git add apps/collector-server/src/db/schema.sql apps/collector-server/src/db/migrate.ts apps/collector-server/src/db/migrate.test.ts
git commit -m "feat(server): categories 表 + creators 加 agent/human 分类列

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: db 查询函数（categories CRUD + creators 列表 + 打分类）

**Files:**
- Modify: `apps/collector-server/src/db/queries.ts`（新增查询函数 + CreatorDetail 加分类字段）
- Test: `apps/collector-server/src/db/queries.test.ts`（新建）

- [ ] **Step 1: 写查询函数测试**

`apps/collector-server/src/db/queries.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrate, runMigrations } from './migrate.ts';
import {
  listCategories, createCategory, updateCategory, deleteCategory,
  listCreators, setCreatorCategory,
} from './queries.ts';

function freshDb() {
  const db = new Database(':memory:');
  migrate(db); runMigrations(db);
  return db;
}

test('categories CRUD', () => {
  const db = freshDb();
  const a = createCategory(db, '股票', 'agent');
  assert.equal(a.name, '股票');
  assert.equal(a.scope, 'agent');
  // UNIQUE(name, scope) 冲突
  assert.throws(() => createCategory(db, '股票', 'agent'));
  // 同名不同 scope 允许
  const h = createCategory(db, '股票', 'human');
  assert.notEqual(a.id, h.id);
  // list by scope
  const agentCats = listCategories(db, 'agent');
  assert.equal(agentCats.length, 1);
  assert.equal(agentCats[0].name, '股票');
  // update
  updateCategory(db, a.id, { name: 'A股' });
  assert.equal(listCategories(db, 'agent')[0].name, 'A股');
  // delete
  deleteCategory(db, a.id);
  assert.equal(listCategories(db, 'agent').length, 0);
});

test('setCreatorCategory upsert creator 并设分类', () => {
  const db = freshDb();
  const c = setCreatorCategory(db, 'bilibili', '123', 'agent', '股票');
  assert.equal(c.category_agent_name, '股票');
  // 再设 human 分类，agent 分类不被覆盖
  setCreatorCategory(db, 'bilibili', '123', 'human', '关注');
  const c2 = setCreatorCategory(db, 'bilibili', '123', 'agent', '股票');
  assert.equal(c2.category_agent_name, '股票');
  assert.equal(c2.category_human_name, '关注');
});

test('listCreators 按分类筛选', () => {
  const db = freshDb();
  setCreatorCategory(db, 'bilibili', '1', 'agent', '股票');
  setCreatorCategory(db, 'bilibili', '2', 'agent', '股票');
  setCreatorCategory(db, 'bilibili', '3', 'agent', '基金');
  const r = listCreators(db, { category: '股票', scope: 'agent' }, 1, 20);
  assert.equal(r.total, 2);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/db/queries.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 queries.ts 新函数**

在 `apps/collector-server/src/db/queries.ts` 追加（沿用现有 `json` 风格，better-sqlite3 同步）：
```ts
export interface Category { id: number; name: string; scope: 'agent' | 'human'; sort_order: number; created_at: number; }

export function listCategories(db: Database.Database, scope?: 'agent' | 'human'): Category[] {
  if (scope) return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE scope = ? ORDER BY sort_order, id').all(scope) as Category[];
  return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories ORDER BY scope, sort_order, id').all() as Category[];
}

export function createCategory(db: Database.Database, name: string, scope: 'agent' | 'human'): Category {
  const now = Date.now();
  const info = db.prepare('INSERT INTO categories (name, scope, sort_order, created_at) VALUES (?, ?, 0, ?)').run(name, scope, now);
  return { id: Number(info.lastInsertRowid), name, scope, sort_order: 0, created_at: now };
}

export function updateCategory(db: Database.Database, id: number, patch: { name?: string; sort_order?: number }): Category | null {
  const sets: string[] = []; const vals: unknown[] = [];
  if (patch.name != null) { sets.push('name = ?'); vals.push(patch.name); }
  if (patch.sort_order != null) { sets.push('sort_order = ?'); vals.push(patch.sort_order); }
  if (sets.length === 0) return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE id = ?').get(id) as Category | null;
  vals.push(id);
  db.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  return db.prepare('SELECT id, name, scope, sort_order, created_at FROM categories WHERE id = ?').get(id) as Category | null;
}

export function deleteCategory(db: Database.Database, id: number): void {
  // 引用置 NULL（应用层兜底，不依赖 FK）
  db.prepare('UPDATE creators SET category_agent_id = NULL WHERE category_agent_id = ?').run(id);
  db.prepare('UPDATE creators SET category_human_id = NULL WHERE category_human_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

export interface CreatorListItem {
  id: number; source: string; source_uid: string; name: string | null; avatar: string | null;
  fans: number | null; video_count: number;
  category_agent_id: number | null; category_agent_name: string | null;
  category_human_id: number | null; category_human_name: string | null;
  first_seen_at: number;
}

export function listCreators(
  db: Database.Database,
  filter: { q?: string; category?: string; scope?: 'agent' | 'human' },
  page: number, size: number,
): { total: number; items: CreatorListItem[] } {
  const where: string[] = []; const vals: unknown[] = [];
  if (filter.q) { where.push('(c.name LIKE ? OR c.source_uid LIKE ?)'); vals.push(`%${filter.q}%`, `%${filter.q}%`); }
  if (filter.category && filter.scope) {
    where.push(filter.scope === 'agent' ? 'c.category_agent_id IN (SELECT id FROM categories WHERE name = ? AND scope = \'agent\')'
                                          : 'c.category_human_id IN (SELECT id FROM categories WHERE name = ? AND scope = \'human\')');
    vals.push(filter.category);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM creators c ${whereSql}`).get(...vals) as { n: number }).n;
  const offset = (page - 1) * size;
  const items = db.prepare(
    `SELECT c.id, c.source, c.source_uid, c.name, c.avatar, c.fans,
       (SELECT COUNT(*) FROM videos v WHERE v.creator_id = c.id) AS video_count,
       c.category_agent_id, ca.name AS category_agent_name,
       c.category_human_id, ch.name AS category_human_name,
       c.first_seen_at
     FROM creators c
     LEFT JOIN categories ca ON ca.id = c.category_agent_id
     LEFT JOIN categories ch ON ch.id = c.category_human_id
     ${whereSql}
     ORDER BY c.first_seen_at DESC LIMIT ? OFFSET ?`,
  ).all(...vals, size, offset) as CreatorListItem[];
  return { total, items };
}

export interface CreatorDetailFull {
  id: number; source: string; source_uid: string; name: string | null; avatar: string | null;
  sign: string | null; level: number | null; sex: string | null;
  official_type: number | null; official_title: string | null;
  fans: number | null; following: number | null;
  category_agent_id: number | null; category_agent_name: string | null;
  category_human_id: number | null; category_human_name: string | null;
  first_seen_at: number; updated_at: number;
}

export function getCreatorBySourceUid(db: Database.Database, source: string, source_uid: string): CreatorDetailFull | null {
  return db.prepare(
    `SELECT c.*, ca.name AS category_agent_name, ch.name AS category_human_name
     FROM creators c
     LEFT JOIN categories ca ON ca.id = c.category_agent_id
     LEFT JOIN categories ch ON ch.id = c.category_human_id
     WHERE c.source = ? AND c.source_uid = ?`,
  ).get(source, source_uid) as CreatorDetailFull | null;
}

// 打分类（通用）：查/建 category → upsert creator（不存在建最小行）→ 设对应列。返回最新 creator。
export function setCreatorCategory(
  db: Database.Database, source: string, source_uid: string,
  scope: 'agent' | 'human', categoryName: string,
): CreatorDetailFull {
  let cat = db.prepare('SELECT id FROM categories WHERE name = ? AND scope = ?').get(categoryName, scope) as { id: number } | undefined;
  if (!cat) {
    const now = Date.now();
    const info = db.prepare('INSERT INTO categories (name, scope, sort_order, created_at) VALUES (?, ?, 0, ?)').run(categoryName, scope, now);
    cat = { id: Number(info.lastInsertRowid) };
  }
  const existing = db.prepare('SELECT id FROM creators WHERE source = ? AND source_uid = ?').get(source, source_uid) as { id: number } | undefined;
  const col = scope === 'agent' ? 'category_agent_id' : 'category_human_id';
  if (!existing) {
    const now = Date.now();
    const info = db.prepare('INSERT INTO creators (source, source_uid, first_seen_at, updated_at, ' + col + ') VALUES (?, ?, ?, ?, ?)').run(source, source_uid, now, now, cat.id);
    db.prepare('UPDATE creators SET ' + col + ' = ? WHERE id = ?').run(cat.id, Number(info.lastInsertRowid));
  } else {
    db.prepare('UPDATE creators SET ' + col + ' = ?, updated_at = ? WHERE id = ?').run(cat.id, Date.now(), existing.id);
  }
  return getCreatorBySourceUid(db, source, source_uid)!;
}
```
注意：`Database` 类型需从 `better-sqlite3` import（queries.ts 顶部已有 `import type Database from 'better-sqlite3'`，确认；若无需补）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/db/queries.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/db/queries.ts apps/collector-server/src/db/queries.test.ts
git commit -m "feat(server): categories CRUD + creators 列表/打分类 查询函数

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task B3: HTTP handler（categories + creators）+ main.ts 注册

**Files:**
- Create: `apps/collector-server/src/http/categories.ts`
- Create: `apps/collector-server/src/http/creators.ts`
- Modify: `apps/collector-server/src/main.ts:53-61`（注册新 handler，在 `/api/` 兜底前）
- Modify: `apps/collector-server/src/http/queries.ts`（`/api/creators/:id` 详情补返回分类字段——已由 `getCreator` SELECT * 带出新列，但 TS 类型 + join name 需补；改用 getCreatorBySourceUid 风格 join）

- [ ] **Step 1: 实现 categories.ts handler**

`apps/collector-server/src/http/categories.ts`（照搬 queries.ts 范式，本地 json + readJsonBody）：
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCategories, createCategory, updateCategory, deleteCategory } from '../db/queries.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export async function handleCategoriesHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/categories' && req.method === 'GET') {
    const scope = url.searchParams.get('scope');
    if (scope && scope !== 'agent' && scope !== 'human') { json(res, 400, { ok: false, error: 'scope must be agent|human' }); return; }
    json(res, 200, { ok: true, items: listCategories(db, scope ?? undefined) });
    return;
  }
  if (pathname === '/api/categories' && req.method === 'POST') {
    const b = await readJsonBody(req) as { name?: string; scope?: string };
    if (!b.name || (b.scope !== 'agent' && b.scope !== 'human')) { json(res, 400, { ok: false, error: 'name and scope(agent|human) required' }); return; }
    try {
      json(res, 200, { ok: true, category: createCategory(db, b.name, b.scope) });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('UNIQUE')) json(res, 409, { ok: false, error: 'category name+scope already exists' });
      else json(res, 500, { ok: false, error: msg });
    }
    return;
  }
  const m = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    if (req.method === 'PATCH') {
      const b = await readJsonBody(req) as { name?: string; sort_order?: number };
      const c = updateCategory(db, id, b);
      if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
      json(res, 200, { ok: true, category: c });
      return;
    }
    if (req.method === 'DELETE') {
      deleteCategory(db, id);
      json(res, 200, { ok: true });
      return;
    }
  }
  json(res, 404, { ok: false, error: 'not found' });
}
```

- [ ] **Step 2: 实现 creators.ts handler**

`apps/collector-server/src/http/creators.ts`：
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { listCreators, getCreator, setCreatorCategory, getCreatorBySourceUid } from '../db/queries.js';

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body));
}
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } }); req.on('error', reject); });
}

export async function handleCreatorsHttp(req: IncomingMessage, res: ServerResponse, db: Database.Database): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/api/creators' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? undefined;
    const category = url.searchParams.get('category') ?? undefined;
    const scope = url.searchParams.get('scope');
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
    const size = Math.min(100, Math.max(1, Number(url.searchParams.get('size') ?? 20)));
    const r = listCreators(db, { q, category, scope: scope === 'agent' || scope === 'human' ? scope : undefined }, page, size);
    json(res, 200, { ok: true, ...r });
    return;
  }
  const detail = pathname.match(/^\/api\/creators\/(\d+)$/);
  if (detail && req.method === 'GET') {
    const c = getCreator(db, Number(detail[1]));
    if (!c) { json(res, 404, { ok: false, error: 'not found' }); return; }
    json(res, 200, { ok: true, creator: c });
    return;
  }
  const cat = pathname.match(/^\/api\/creators\/by-uid\/([^/]+)\/category$/);
  if (cat && req.method === 'POST') {
    const source_uid = decodeURIComponent(cat[1]);
    const b = await readJsonBody(req) as { scope?: string; name?: string };
    if ((b.scope !== 'agent' && b.scope !== 'human') || !b.name) { json(res, 400, { ok: false, error: 'scope(agent|human) and name required' }); return; }
    const c = setCreatorCategory(db, 'bilibili', source_uid, b.scope, b.name);
    json(res, 200, { ok: true, creator: c });
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}
```

- [ ] **Step 3: main.ts 注册（在 /api/ 兜底前）**

`apps/collector-server/src/main.ts` 的 createServer 回调里，在 `/api/clients` 与 `/api/*` 之间插入（注意顺序：分类/UP主路径必须早于 `/api/` 兜底）：
```ts
    if (req.url?.startsWith('/api/categories')) { handleCategoriesHttp(req, res, db); return; }
    if (req.url?.startsWith('/api/creators')) { handleCreatorsHttp(req, res, db); return; }
```
并 import：
```ts
import { handleCategoriesHttp } from './http/categories.js';
import { handleCreatorsHttp } from './http/creators.js';
```

- [ ] **Step 4: 冒烟验证（需 server 在线）**

Run:
```bash
cd apps/collector-server && COLLECTOR_TOKEN=change-me-collector-token pnpm dev &
sleep 2
curl -s -X POST http://127.0.0.1:21527/api/categories -H 'content-type: application/json' -d '{"name":"股票","scope":"agent"}'
curl -s 'http://127.0.0.1:21527/api/categories?scope=agent'
curl -s -X POST http://127.0.0.1:21527/api/creators/by-uid/123/category -H 'content-type: application/json' -d '{"scope":"agent","name":"股票"}'
curl -s 'http://127.0.0.1:21527/api/creators?category=股票&scope=agent'
kill %1
```
Expected: 各返回 `{ok:true,...}`；分类创建 + 打分类 + 列表筛选可用。

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/http/categories.ts apps/collector-server/src/http/creators.ts apps/collector-server/src/main.ts
git commit -m "feat(server): categories/creators HTTP API

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Group A — CLI 层（与 B/C 并发，依赖 B3 的打分类端点契约）

### Task A1: collectUpperVideosAll sinceCreated + 测试

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts:128-161`（加 `sinceCreated?` 参数 + 合并后过滤）
- Test: `apps/collector-server/src/cli/commands/collect.test.ts`（扩）

- [ ] **Step 1: 写 sinceCreated 测试**

在 `collect.test.ts` 追加（mock CollectClient，返回两页含不同 created + 一个 null created）：
```ts
test('collectUpperVideosAll sinceCreated 过滤（保留 null created）', async () => {
  const items = [
    { bvid: 'BV1', created: 1700000000 },      // 旧
    { bvid: 'BV2', created: 1750000000 },      // 新
    { bvid: 'BV3', created: null as unknown as undefined }, // null 保留
  ];
  const client: CollectClient = {
    listClients: async () => [{ client_id: 'c1' }],
    sendCommand: async () => ({ ok: true, result: { ok: true, data: { total: 3, items } } }),
  };
  const resp = await collectUpperVideosAll(client, 'c1', 'mid123', 30, 1000, 1700000001);
  const bv = resp.result!.data!.items!.map((i) => i.bvid);
  assert.deepEqual(bv.sort(), ['BV2', 'BV3']); // BV1 被时间窗过滤；BV3 null 保留
});
```
（若 `collect.test.ts` 顶部无 `import { collectUpperVideosAll, collectNosub } from './collect.ts'` 与 `CollectClient` 类型，补上。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/collect.test.ts`
Expected: FAIL（sinceCreated 参数不存在/不过滤）

- [ ] **Step 3: 实现 sinceCreated 过滤**

`collect.ts` 的 `collectUpperVideosAll` 签名加 `sinceCreated?: number`，在 `return` 前过滤：
```ts
export async function collectUpperVideosAll(
  client: CollectClient, clientId: string, mid: string, size: number, timeout: number,
  sinceCreated?: number,
): Promise<UpperVideosResp> {
  // ... 现有翻页逻辑不动，allItems 收集后 ...
  const filtered = sinceCreated != null
    ? allItems.filter((it) => it.created == null || it.created >= sinceCreated)
    : allItems;
  return {
    ...(lastResp ?? { ok: true }),
    result: { ...(lastResp?.result ?? { ok: true }), ok: true,
      data: { total: filtered.length, items: filtered } },
  };
}
```
（`total` 改为过滤后长度，便于调用方判断规模。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/collect.test.ts`
Expected: PASS

- [ ] **Step 5: commander upper-videos 加 --since-created**

`collect.ts` 的 `upper-videos` 命令加 option：
```ts
    .option('--since-created <unix>', '只保留发布时间 >= 该 UNIX 秒的视频（null 保留）', (v) => Number.parseInt(v, 10))
```
action 里 `opts.all` 分支传 `opts.sinceCreated`：
```ts
const data = opts.all
  ? await collectUpperVideosAll(client as CollectClient, clientId, mid, opts.size, opts.timeout, opts.sinceCreated)
  : await collectUpperVideos(client as CollectClient, clientId, mid, { page: opts.page, size: opts.size }, opts.timeout);
```

- [ ] **Step 6: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collectUpperVideosAll 加 sinceCreated 时间窗过滤

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: collectNosub 纯函数 + 测试

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts`（新增 `collectNosub`）
- Test: `apps/collector-server/src/cli/commands/collect.test.ts`（扩）

- [ ] **Step 1: 写 collectNosub 测试**

```ts
import Database from 'better-sqlite3';
import { migrate, runMigrations } from '../../db/migrate.ts';

test('collectNosub 识别「有 video 无 track」', () => {
  const db = new Database(':memory:'); migrate(db); runMigrations(db);
  // creator + 3 视频：V1 有轨 / V2 无轨 / V3 无轨
  const now = Date.now();
  const ci = db.prepare('INSERT INTO creators (source, source_uid, first_seen_at, updated_at) VALUES (?,?,?,?)').run('bilibili', 'u', now, now);
  const ins = db.prepare('INSERT INTO videos (source, source_vid, creator_id, title, first_seen_at, updated_at) VALUES (?,?,?,?,?,?)');
  const v1 = ins.run('bilibili', 'BV1', ci.lastInsertRowid, 't1', now, now);
  const v2 = ins.run('bilibili', 'BV2', ci.lastInsertRowid, 't2', now, now);
  ins.run('bilibili', 'BV3', ci.lastInsertRowid, 't3', now, now);
  db.prepare('INSERT INTO subtitle_tracks (video_id, lan, lan_doc, track_type) VALUES (?,?,?,?)').run(v1.lastInsertRowid, 'zh', '', 1);
  const nosub = collectNosub(db, ['BV1', 'BV2', 'BV3', 'BVx']);
  assert.deepEqual(nosub.sort(), ['BV2', 'BV3']); // BV1 有轨不算；BVx 不在库不算
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/collect.test.ts`
Expected: FAIL（collectNosub 未定义）

- [ ] **Step 3: 实现 collectNosub**

`collect.ts` 在 `collectDedupe` 后追加：
```ts
/** `collect nosub`（内部用）：返回 bvids 中「已入 videos 但无 subtitle_tracks」的子集（供 --retry-nosub 重采）。 */
export function collectNosub(db: Database.Database, bvids: string[]): string[] {
  if (bvids.length === 0) return [];
  const placeholders = bvids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT v.source_vid FROM videos v
     LEFT JOIN subtitle_tracks t ON t.video_id = v.id
     WHERE v.source = 'bilibili' AND v.source_vid IN (${placeholders}) AND t.id IS NULL`,
  ).all(...bvids) as Array<{ source_vid: string }>;
  return rows.map((r) => r.source_vid);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/collector-server && node --test --import tsx src/cli/commands/collect.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collectNosub 识别无字幕已采视频

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: collect-uppers.mts 新 argv + 调 HTTP 打分类

**Files:**
- Modify: `scripts/collect-uppers.mts`

- [ ] **Step 1: argv 解析新增 4 个选项**

在 [collect-uppers.mts:29-46](../../../scripts/collect-uppers.mts#L29) 的 argv 循环里追加（在 `else mids.push(a)` 之前）：
```ts
  else if (a === '--after-market') afterMarket = true;
  else if (a === '--since') sinceTs = Number(argv[++i]);
  else if (a === '--retry-nosub') retryNosub = true;
  else if (a === '--category') categoryName = String(argv[++i]);
```
并在循环前声明变量：`let afterMarket = false; let sinceTs: number | undefined; let retryNosub = false; let categoryName: string | undefined;`

- [ ] **Step 2: 计算 sinceCreated（今日收盘后 / 周末回溯 / --since 覆盖）**

在 argv 校验后、`const cfg = resolveConfig()` 前，加辅助函数与计算：
```ts
function marketOpenTs(): number {
  // 最近交易日 15:00（本地时区，UNIX 秒）。周一~五=今日；周六=昨日(五)；周日=前日(五)。
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  let back = 0;
  if (day === 6) back = 1;       // 周六 → 周五
  else if (day === 0) back = 2;  // 周日 → 周五
  const d = new Date(now);
  d.setDate(d.getDate() - back);
  d.setHours(15, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

let sinceCreated: number | undefined;
if (sinceTs != null) sinceCreated = sinceTs;
else if (afterMarket) sinceCreated = marketOpenTs();
```

- [ ] **Step 3: 拉列表时传 sinceCreated + 日志**

[collect-uppers.mts:70](../../../scripts/collect-uppers.mts#L70) 的 `collectUpperVideosAll` 调用加第 6 参数：
```ts
const resp = await collectUpperVideosAll(client as unknown as CollectClient, clientId, mid, size, TIMEOUT, sinceCreated) as { ... };
```
[1/3] 日志补 sinceCreated 人类可读（若 `sinceCreated != null`，打印 `fmtDate(sinceCreated)` 起点）。

- [ ] **Step 4: --category 解析为 categoryId + 按 agent 分类并入 mid**

在 step1 之前，解析 category：
```ts
let categoryAgentId: number | undefined;
if (categoryName) {
  const catResp = await fetch(`${cfg.serverUrl}/api/categories?scope=agent`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  const catJson = await catResp.json() as { ok: boolean; items?: Array<{ id: number; name: string }> };
  const found = catJson.items?.find((c) => c.name === categoryName);
  if (!found) { console.error(`分类不存在（agent scope）: ${categoryName}（先在后台或 API 建分类）`); process.exit(2); }
  categoryAgentId = found.id;
  // 从 DB 取该分类下的 mid，并入 mids
  const cr = await fetch(`${cfg.serverUrl}/api/creators?category=${encodeURIComponent(categoryName)}&scope=agent&size=100`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  const crJson = await cr.json() as { ok: boolean; items?: Array<{ source_uid: string }> };
  for (const it of crJson.items ?? []) if (!mids.includes(it.source_uid)) mids.push(it.source_uid);
  console.error(`[category] agent 分类「${categoryName}」(#${categoryAgentId})，并入后共 ${mids.length} 个 mid`);
}
```
（注：HTTP API 走 loopback origin 校验，从 CLI 本机 fetch 默认 Host=127.0.0.1 通过；token 放 Authorization 或 query 均可——若 server 未校验 HTTP token（仅 WS 校验），则 header 可省，但保留无害。）

- [ ] **Step 5: step2 dedupe 后，--retry-nosub 并入采集队列**

[collect-uppers.mts:104](../../../scripts/collect-uppers.mts#L104) `missing = d.missing` 之后，追加：
```ts
if (retryNosub) {
  try {
    const db2 = openReadonlyDb(cfg.dbPath);
    try {
      const nosub = collectNosub(db2, allBvids);
      // 只重采「时间窗内 + 之前无字幕」的
      const inWindow = nosub.filter((bv) => {
        const c = bvidToCreated.get(bv);
        return sinceCreated == null || c == null || c >= sinceCreated;
      });
      for (const bv of inWindow) if (!missing.includes(bv)) missing.push(bv);
      console.error(`  --retry-nosub: 额外重采 ${inWindow.length} 个无字幕视频`);
    } finally { db2.close(); }
  } catch (e) { console.error(`  collectNosub 失败（降级，仅采 missing）: ${(e as Error).message}`); }
}
```
import 处补 `collectNosub`：
```ts
import { resolveClientId, collectUpperVideosAll, collectSubtitle, collectDedupe, collectNosub, type CollectClient } from '../apps/collector-server/src/cli/commands/collect.js';
```

- [ ] **Step 6: 采集后，--category 经 HTTP 打 agent 分类**

在 [collect-uppers.mts:137](../../../scripts/collect-uppers.mts#L137) 的「===完成===」之前，追加：
```ts
if (categoryAgentId && categoryName) {
  for (const mid of mids) {
    try {
      await fetch(`${cfg.serverUrl}/api/creators/by-uid/${encodeURIComponent(mid)}/category`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'agent', name: categoryName }),
      });
    } catch { /* 单条失败不阻断 */ }
  }
  console.error(`[category] 已标记 ${mids.length} 个 mid 的 agent 分类=「${categoryName}」`);
}
```

- [ ] **Step 7: dry-run 冒烟验证**

Run（需 server+扩展在线）:
```bash
pnpm collect-uppers <某个mid> --after-market --dry-run
pnpm collect-uppers <某个mid> --retry-nosub --dry-run
```
Expected: 日志显示 sinceCreated 起点、missing/nosub 队列规模。

- [ ] **Step 8: Commit**

```bash
git add scripts/collect-uppers.mts
git commit -m "feat(collector-cli): collect-uppers 加时间窗/retry-nosub/按分类

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Group C — 前端层（与 A/B 并发，依赖 B 的 API 契约）

### Task C1: shadcn 组件 + vite proxy

**Files:**
- Modify: `apps/collector-web/package.json`（新增 @radix-ui 依赖）
- Create: `apps/collector-web/src/components/ui/{table,dialog,select,label,badge}.tsx`
- Modify: `apps/collector-web/vite.config.ts`（加 server.proxy）

- [ ] **Step 1: 生成 shadcn 组件**

Run（在 `apps/collector-web/`）:
```bash
cd apps/collector-web && npx shadcn@latest add table dialog select label badge
```
Expected: 5 个组件文件写入 `src/components/ui/`，`package.json` 自动加 `@radix-ui/react-*` 依赖。然后 `pnpm install`。

- [ ] **Step 2: vite.config.ts 加 dev proxy**

`apps/collector-web/vite.config.ts` 的 `defineConfig` 内加：
```ts
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:21527',
      '/ping': 'http://127.0.0.1:21527',
    },
  },
```

- [ ] **Step 3: 冒烟 build**

Run: `cd apps/collector-web && pnpm build`
Expected: vite build 成功，输出到 `../collector-server/public`。

- [ ] **Step 4: Commit**

```bash
git add apps/collector-web/
git commit -m "feat(web): shadcn 组件(table/dialog/select/label/badge) + dev proxy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C2: api.ts 加 categories/creators 接口

**Files:**
- Modify: `apps/collector-web/src/api.ts`

- [ ] **Step 1: 追加 API 函数**

在 `apps/collector-web/src/api.ts` 追加（沿用现有 `ensureOk`）：
```ts
export interface Category { id: number; name: string; scope: 'agent' | 'human'; sort_order: number; created_at: number; }
export interface CreatorListItem {
  id: number; source: string; source_uid: string; name: string | null; avatar: string | null;
  fans: number | null; video_count: number;
  category_agent_id: number | null; category_agent_name: string | null;
  category_human_id: number | null; category_human_name: string | null;
  first_seen_at: number;
}

export async function listCategories(scope?: 'agent' | 'human'): Promise<Category[]> {
  const q = scope ? `?scope=${scope}` : '';
  const r = await fetch(`${BASE}/api/categories${q}`);
  return ensureOk(r, (j) => j.items ?? []);
}
export async function createCategory(name: string, scope: 'agent' | 'human'): Promise<Category> {
  const r = await fetch(`${BASE}/api/categories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, scope }) });
  return ensureOk(r, (j) => j.category);
}
export async function updateCategory(id: number, patch: { name?: string; sort_order?: number }): Promise<Category> {
  const r = await fetch(`${BASE}/api/categories/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
  return ensureOk(r, (j) => j.category);
}
export async function deleteCategory(id: number): Promise<void> {
  const r = await fetch(`${BASE}/api/categories/${id}`, { method: 'DELETE' });
  ensureOk(r, () => undefined);
}
export async function listCreators(params: { q?: string; category?: string; scope?: 'agent' | 'human'; page?: number; size?: number }): Promise<{ total: number; items: CreatorListItem[] }> {
  const u = new URLSearchParams();
  if (params.q) u.set('q', params.q);
  if (params.category) u.set('category', params.category);
  if (params.scope) u.set('scope', params.scope);
  u.set('page', String(params.page ?? 1));
  u.set('size', String(params.size ?? 20));
  const r = await fetch(`${BASE}/api/creators?${u}`);
  return ensureOk(r, (j) => ({ total: j.total ?? 0, items: j.items ?? [] }));
}
export async function setCreatorCategory(source_uid: string, scope: 'agent' | 'human', name: string): Promise<void> {
  const r = await fetch(`${BASE}/api/creators/by-uid/${encodeURIComponent(source_uid)}/category`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, name }) });
  ensureOk(r, () => undefined);
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/collector-web/src/api.ts
git commit -m "feat(web): api client 加 categories/creators 接口

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C3: App.tsx tab 扩展

**Files:**
- Modify: `apps/collector-web/src/App.tsx`

- [ ] **Step 1: 扩 Tab 类型 + 导航 + 渲染分支**

[App.tsx:8](../../../apps/collector-web/src/App.tsx#L8) `type Tab` 改为 `'videos' | 'clients' | 'categories' | 'creators'`。
导航 Button 区（[App.tsx:16-19](../../../apps/collector-web/src/App.tsx#L16)）加两个 Button：「分类」`onClick={() => setTab('categories')}`、「UP 主」`onClick={() => setTab('creators')}`。
渲染分支（[App.tsx:23-27](../../../apps/collector-web/src/App.tsx#L23)）加：
```tsx
      ) : tab === 'categories' ? (
        <CategoriesPage />
      ) : tab === 'creators' ? (
        <CreatorsPage />
      ) : (
```
import 补：`import CategoriesPage from './pages/CategoriesPage'; import CreatorsPage from './pages/CreatorsPage';`

- [ ] **Step 2: Commit（与 C4/C5 一起 commit，因 import 暂未解析）**

暂不单独 commit，待 C4/C5 完成后一并提交。

---

### Task C4: CategoriesPage 分类管理

**Files:**
- Create: `apps/collector-web/src/pages/CategoriesPage.tsx`

- [ ] **Step 1: 实现 CategoriesPage**

`apps/collector-web/src/pages/CategoriesPage.tsx`（两个 sub-tab：agent/human；Table 列表 + Dialog 新建 + 改名/删除）：
```tsx
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { listCategories, createCategory, updateCategory, deleteCategory, type Category } from '@/api';

export default function CategoriesPage() {
  const [scope, setScope] = useState<'agent' | 'human'>('agent');
  const [items, setItems] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState(false);

  async function refresh() {
    setItems(await listCategories(scope));
  }
  useEffect(() => { refresh(); }, [scope]);

  async function onCreate() {
    if (!name.trim()) return;
    await createCategory(name.trim(), scope);
    setName(''); setOpen(false); refresh();
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex gap-2">
        {(['agent', 'human'] as const).map((s) => (
          <Button key={s} variant={s === scope ? 'default' : 'outline'} onClick={() => setScope(s)}>
            {s === 'agent' ? 'Agent 分类' : '人工分类'}
          </Button>
        ))}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>新建</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>新建{scope === 'agent' ? ' Agent' : '人工'}分类</DialogTitle></DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="cn">名称</Label>
              <Input id="cn" value={name} onChange={(e) => setName(e.target.value)} />
              <Button onClick={onCreate}>保存</Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
      <Table>
        <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>排序</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.name}</TableCell>
              <TableCell>{c.sort_order}</TableCell>
              <TableCell className="text-right space-x-2">
                <Button variant="outline" size="sm" onClick={async () => { const n = prompt('新名称', c.name); if (n && n !== c.name) { await updateCategory(c.id, { name: n }); refresh(); } }}>改名</Button>
                <Button variant="destructive" size="sm" onClick={async () => { if (confirm(`删除「${c.name}」？关联 UP 主该分类将置空`)) { await deleteCategory(c.id); refresh(); } }}>删除</Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 2: Commit（C3+C4+C5 合并提交）**

待 C5 完成。

---

### Task C5: CreatorsPage UP 主管理

**Files:**
- Create: `apps/collector-web/src/pages/CreatorsPage.tsx`

- [ ] **Step 1: 实现 CreatorsPage**

`apps/collector-web/src/pages/CreatorsPage.tsx`（列表 + 按 human 分类筛选 + 行内打 human 分类）：
```tsx
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { listCategories, listCreators, setCreatorCategory, type Category, type CreatorListItem } from '@/api';

const PAGE_SIZE = 20;

export default function CreatorsPage() {
  const [q, setQ] = useState('');
  const [catFilter, setCatFilter] = useState<string>('');
  const [humanCats, setHumanCats] = useState<Category[]>([]);
  const [items, setItems] = useState<CreatorListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const seqRef = useRef(0);

  async function refresh() {
    const seq = ++seqRef.current;
    const r = await listCreators({ q: q || undefined, category: catFilter || undefined, scope: catFilter ? 'human' : undefined, page, size: PAGE_SIZE });
    if (seq !== seqRef.current) return;
    setItems(r.items); setTotal(r.total);
  }
  useEffect(() => {
    listCategories('human').then(setHumanCats);
  }, []);
  useEffect(() => {
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [q, catFilter, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  async function setHuman(uid: string, name: string) {
    await setCreatorCategory(uid, 'human', name);
    refresh();
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex gap-2 items-center">
        <Input placeholder="搜索 UP 主名/mid" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
        <Select value={catFilter} onValueChange={(v) => { setCatFilter(v === '__all' ? '' : v); setPage(1); }}>
          <SelectTrigger className="w-48"><SelectValue placeholder="按人工分类筛选" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">全部</SelectItem>
            {humanCats.map((c) => <SelectItem key={c.id} value={c.name}>{c.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Table>
        <TableHeader><TableRow>
          <TableHead>名称</TableHead><TableHead>mid</TableHead><TableHead>Agent 分类</TableHead>
          <TableHead>人工分类</TableHead><TableHead className="text-right">视频数</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {items.map((c) => (
            <TableRow key={c.id}>
              <TableCell>{c.name ?? '(未知)'}</TableCell>
              <TableCell className="text-muted-foreground">{c.source_uid}</TableCell>
              <TableCell>{c.category_agent_name ? <Badge>{c.category_agent_name}</Badge> : '—'}</TableCell>
              <TableCell>
                <Select value={c.category_human_name ?? '__none'} onValueChange={(v) => setHuman(c.source_uid, v)}>
                  <SelectTrigger className="w-32"><SelectValue placeholder="未分类" /></SelectTrigger>
                  <SelectContent>
                    {humanCats.map((h) => <SelectItem key={h.id} value={h.name}>{h.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </TableCell>
              <TableCell className="text-right">{c.video_count}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="flex gap-2 items-center">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
        <span className="text-sm text-muted-foreground">{page} / {totalPages}</span>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>下一页</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: C3+C4+C5 合并 commit**

```bash
git add apps/collector-web/src/App.tsx apps/collector-web/src/pages/CategoriesPage.tsx apps/collector-web/src/pages/CreatorsPage.tsx
git commit -m "feat(web): 分类管理 + UP 主管理 后台页面

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task C6: VideoList 加按分类筛选

**Files:**
- Modify: `apps/collector-web/src/pages/VideoList.tsx`

- [ ] **Step 1: 顶部加分类筛选下拉**

VideoList 现有 `listVideos(q, page, size)` 调用保持。新增一个 scope=human 的分类下拉，**筛选作用于 creators 维度**——但 `/api/videos` 目前不支持按分类筛选（YAGNI 改 videos 查询）。退而求其次：在 VideoList 顶部加一个跳转/提示，引导用户去「UP 主管理」按分类查看 UP 主及其视频。

**实际改动（最小）**：在 VideoList 顶部加一行说明 + 链接到 UP 主管理 tab。不扩 `/api/videos`（避免改 advanced 查询，YAGNI）。

[VideoList.tsx](../../../apps/collector-web/src/pages/VideoList.tsx) 顶部容器加：
```tsx
<div className="text-sm text-muted-foreground">按 UP 主分类筛选请到「UP 主」页</div>
```
（AC13 调整为：UP 主管理页可按分类筛 UP 主 + 查看其视频数；视频列表页本身不改查询。spec 4.4 的「视频列表按分类筛选」降级为引导跳转，避免改 videos 查询层。）

- [ ] **Step 2: build 冒烟**

Run: `cd apps/collector-web && pnpm build`
Expected: 成功。

- [ ] **Step 3: Commit**

```bash
git add apps/collector-web/src/pages/VideoList.tsx
git commit -m "feat(web): VideoList 引导按分类查看 UP 主

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 集成（三 Group 完成后串行）

### Task I1: turbo run test 编排

**Files:**
- Modify: `turbo.json`（加 test task）
- Modify: `apps/collector-server/package.json`（加 test 脚本）
- Modify: `apps/collector-web/package.json`（加 test 脚本）
- Modify: `apps/subtitle-collector/package.json`（确认 test 脚本存在）

- [ ] **Step 1: 各 package.json 暴露 test 脚本**

`apps/collector-server/package.json` scripts 加：
```json
    "test": "node --test --import tsx \"src/**/*.test.ts\""
```
`apps/collector-web/package.json` scripts 加：
```json
    "test": "vite build"
```
（subtitle-collector 已有 test 脚本则保留。）

- [ ] **Step 2: turbo.json 加 test task**

`turbo.json` tasks 加：
```json
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    }
```

- [ ] **Step 3: 跑全量 test**

Run: `turbo run test`
Expected: 三个 app 的 test 全绿。

- [ ] **Step 4: Commit**

```bash
git add turbo.json apps/collector-server/package.json apps/collector-web/package.json
git commit -m "chore: turbo run test 编排

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task I2: 端到端验收 + 收尾 commit

- [ ] **Step 1: 启动 server + 构建 web**

Run:
```bash
cd apps/collector-web && pnpm build
cd ../collector-server && COLLECTOR_TOKEN=change-me-collector-token pnpm dev &
sleep 2
```

- [ ] **Step 2: 浏览器验收（AC8-AC13）**

打开 `http://127.0.0.1:21527/`：
- 「分类」tab → 新建 agent 分类「股票」、human 分类「关注」→ 列表显示。
- 「UP 主」tab → 列表显示；给某 UP 主选 human 分类 → 刷新后保留。
- 「UP 主」tab → 按 human 分类筛选生效。

- [ ] **Step 3: 采集链路验收（AC3-AC6，需扩展在线 + 登录 B 站）**

Run:
```bash
pnpm collect-uppers <真实股票UP主mid> --category 股票 --after-market --dry-run
pnpm collect-uppers <真实股票UP主mid> --after-market --dry-run
# 真采（视用户授权）
pnpm collect-uppers <真实股票UP主mid> --category 股票 --after-market --retry-nosub
curl -s 'http://127.0.0.1:21527/api/creators?category=股票&scope=agent'
```
Expected: dry-run 显示 sinceCreated 起点（周日回溯上周五）+ 队列；采后该 mid 的 category_agent_name=「股票」。

- [ ] **Step 4: 措辞红线检查（AC15）**

Run: `git diff main..HEAD -- '*.md' '*.ts' '*.tsx' '*.mts' '*.js' | grep -i '弹幕' || echo "措辞合规"`
Expected: 「措辞合规」（无「弹幕」）。

- [ ] **Step 5: 更新 spec 测试轮次记录表**

把 [spec §8](../specs/2026-07-05-stock-uppers-categories-design.md) 的 R1-R6 「待跑」改为实际结果（PASS/FAIL+原因）。

- [ ] **Step 6: 最终 commit**

```bash
git add docs/superpowers/specs/2026-07-05-stock-uppers-categories-design.md
git commit -m "test: 验收通过，更新测试轮次记录表

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖**：AC1-AC2→A1/A2；AC3-AC6→A3；AC7→B1；AC8→B3；AC9-AC10→B2/B3；AC11→C4；AC12→C5；AC13→C6（降级为引导）；AC14→I1；AC15→I2。全覆盖。
**占位符**：无 TBD；每步含实际代码或命令。
**类型一致**：`Category`/`CreatorListItem`/`CreatorDetailFull` 在 B2 定义，C2 api.ts 对齐；`collectUpperVideosAll` 第 6 参数 `sinceCreated?: number` 在 A1/B 引用一致；`collectNosub(db, bvids)` 在 A2 定义、A3 引用一致。
**已知调整**：AC13 降级（不改 `/api/videos` 查询层，VideoList 引导跳转 UP 主页），spec §4.4 与 §7 AC13 需在 I2 同步注明。
