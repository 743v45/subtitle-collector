# 主动采集 P3（多 UP 批量发现 + skill 订阅）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 多 UP 主批量发现新视频（`collect discover <mid...>`）+ skill 加订阅流程。

**Architecture:** 复用 P2 `collectNewVideos`（拉列表 + 对比库），CLI 循环多 mid 汇总 `{per_mid, all_new}`。无 server 调度（A 方案）。

**Tech Stack:** 同 P1/P2（collector-server tsx/commander/better-sqlite3；测试 `node --test --import tsx`）。

**Spec:** [2026-07-05-active-collection-p3-design.md](../specs/2026-07-05-active-collection-p3-design.md)

---

## File Structure

- `apps/collector-server/src/cli/commands/collect.ts`（改）— `collectDiscover` 纯处理 + `discover` commander 子命令
- `apps/collector-server/src/cli/commands/collect.test.ts`（改）— `collectDiscover` 测试
- `.claude/skills/bili-collect/SKILL.md`（改，本地 gitignored）— 加「订阅 UP 主」节

---

## Task 1: CLI `collect discover <mid...>`（批量多 UP 发现新视频）

**Files:**
- Modify: `apps/collector-server/src/cli/commands/collect.ts`（`collectDiscover` 纯处理 + commander 子命令）
- Modify: `apps/collector-server/src/cli/commands/collect.test.ts`（加测试）

- [ ] **Step 1: 写失败测试（追加到 collect.test.ts）**

```typescript
test('collectDiscover 批量多 UP，汇总 per_mid + all_new', async () => {
  // mock：第一次 list-upper-videos 返回 BV1/BV2/BV3，第二次返回 BV2/BV4
  let call = 0;
  const c = {
    calls: [] as Array<{ action: string; mid: string }>,
    async listClients() { return [{ client_id: 'c1' }]; },
    async sendCommand(clientId: string, action: string, params: Record<string, unknown>, timeout: number) {
      c.calls.push({ action, mid: params.mid as string });
      call++;
      if (action === 'list-upper-videos') {
        const items = call === 1
          ? [{ bvid: 'BV1' }, { bvid: 'BV2' }, { bvid: 'BV3' }]
          : [{ bvid: 'BV2' }, { bvid: 'BV4' }];
        return { ok: true, result: { ok: true, data: { total: items.length, items } } };
      }
      return { ok: true };
    },
  };
  const db = makeDb();
  db.prepare("INSERT INTO videos (source, source_vid, title, first_seen_at) VALUES ('bilibili','BV2','t',1)").run();
  const out = await collectDiscover(c as any, 'c1', db, ['m1', 'm2'], { page: 1, size: 30 }, 15000);
  // m1：BV2 在库 → collected；BV1/BV3 不在 → new
  // m2：BV2 在库 → collected；BV4 不在 → new
  assert.equal(out.per_mid.length, 2);
  assert.deepEqual(out.per_mid[0].new.sort(), ['BV1', 'BV3']);
  assert.deepEqual(out.per_mid[0].collected, ['BV2']);
  assert.deepEqual(out.per_mid[1].new, ['BV4']);
  assert.deepEqual(out.per_mid[1].collected, ['BV2']);
  assert.deepEqual(out.all_new.sort(), ['BV1', 'BV3', 'BV4']);
});
```
顶部 import 加 `collectDiscover`。`makeDb` 复用 collect.test.ts 现有。

- [ ] **Step 2: 跑测试看失败**

Run: `pnpm --filter @bilibili-ext/collector-server test` — Expected: FAIL (`collectDiscover is not defined`)。

- [ ] **Step 3: 实现纯处理（加到 collect.ts 纯处理区）**

```typescript
/** `collect discover <mid...>`：批量多 UP，每个跑 new-videos（拉列表 + 对比库），汇总 per_mid + all_new。 */
export async function collectDiscover(
  client: CollectClient, clientId: string, db: Database.Database, mids: string[],
  opts: UpperVideosOpts, timeout: number,
): Promise<{
  per_mid: Array<{ mid: string; total: number; new: string[]; collected: string[] }>;
  all_new: string[];
}> {
  const per_mid: Array<{ mid: string; total: number; new: string[]; collected: string[] }> = [];
  const all_new: string[] = [];
  for (const mid of mids) {
    const r = await collectNewVideos(client, clientId, mid, db, opts, timeout);
    per_mid.push({ mid, ...r });
    all_new.push(...r.new);
  }
  return { per_mid, all_new };
}
```
（`CollectClient` / `UpperVideosOpts` / `collectNewVideos` 都已在 collect.ts 现有定义/导入，直接复用。）

- [ ] **Step 4: 跑测试看通过**

Run: `pnpm --filter @bilibili-ext/collector-server test` — Expected: PASS（新 test + 之前全过）。

- [ ] **Step 5: 装配 commander（buildCollectCommand 内加 discover 子命令）**

在 collect.ts 的 `buildCollectCommand` 内（new-videos 子命令之后、`return collect` 之前）加：
```typescript
  collect
    .command('discover <mid...>')
    .description('批量多 UP 主发现新视频：每 UP 拉列表 + 对比库 → 汇总 per_mid + all_new')
    .option('--page <n>', '页码（默认 1）', (v) => Number.parseInt(v, 10), 1)
    .option('--size <n>', '每页条数（默认 30）', (v) => Number.parseInt(v, 10), 30)
    .option('--client <id>', '扩展 client_id')
    .option('--timeout <ms>', '超时毫秒（默认 15000）', (v) => Number.parseInt(v, 10), DEFAULT_COLLECT_TIMEOUT_MS)
    .action(async (mids: string[], opts: { page: number; size: number; client?: string; timeout: number }) => {
      if (mids.length === 0) emitError('at least one <mid> required', 'ARGS');
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
        const data = await collectDiscover(client as CollectClient, clientId, db, mids, { page: opts.page, size: opts.size }, opts.timeout);
        emitResult(data, ctx.format);
      } catch (err) { handleHttpError(err); }
    });

  return collect;
```

- [ ] **Step 6: 跑测试 + 冒烟**

```bash
pnpm --filter @bilibili-ext/collector-server test
pnpm --filter @bilibili-ext/collector-server exec tsx src/cli/main.ts collect --help
```
Expected: test PASS；`collect --help` 含 `discover`。

- [ ] **Step 7: Commit**

```bash
git add apps/collector-server/src/cli/commands/collect.ts apps/collector-server/src/cli/commands/collect.test.ts
git commit -m "feat(cli): collect discover <mid...> 批量多 UP 发现新视频

复用 collectNewVideos（拉列表 + 对比库），循环多 mid 汇总 per_mid + all_new。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: skill 加「订阅 UP 主」流程

**Files:**
- Modify: `.claude/skills/bili-collect/SKILL.md`（本地 gitignored，加订阅节）

- [ ] **Step 1: 改 SKILL.md — 加订阅节**

在 `.claude/skills/bili-collect/SKILL.md` 的「标准流程」之后（或「聚合」之前），加一节：
```markdown
## 订阅 UP 主（批量发现新视频）

适用：你维护一批 UP 主（mid），想看他们最近有没有新视频、挑想采的。

1. **维护订阅列表**：从 `collect upper-info <mid>` 或 `collect search` 结果拿到 UP 主 mid，存一份列表（写在 memory 或文档里，项目无状态不存 server）。
2. **跑订阅**（用户说「跑订阅 / 看看订阅的 UP 有没有新视频」时）：
   `collector-cli collect discover <mid1> <mid2> <mid3> --format json`
   → 取返回的 `all_new`（所有 UP 的新视频 BV 汇总）+ `per_mid`（每 UP 明细）。
3. **挑采**：对 `all_new` 里感兴趣的 BV，串行 `collect subtitle <BV>`（sleep ~1s 防风控）。
   - 没想采的 → 告诉用户「这批 UP 暂无想采的新视频」。

注意：discover 走扩展（每 UP 一次 list-upper-videos），多 UP 串行由 CLI 循环；大批量 UP 注意风控（必要时分批）。
```

- [ ] **Step 2: 验证 SKILL.md（人工审 + 可选真实跑）**

肉眼审 SKILL.md 含订阅节。可选真实跑（需 server + 扩展在线）：
```bash
pnpm --filter @bilibili-ext/collector-server cli -- collect discover 61214429 <另一 mid> --size 3
```
看 per_mid + all_new。

- [ ] **Step 3: Commit（SKILL.md 是本地 gitignored，不入 git——这一步跳过 commit，只改本地文件）**

> SKILL.md 在 `.claude/`（gitignore），改本地不 commit。Task 2 无 git 操作。本地文件改好即完成。

---

## 完工验收（对齐 spec §8 D1–D3）

- [ ] D1 `cli collect discover <mid1> <mid2>` 批量跑，返回 `{per_mid:[...], all_new:[...]}`，每 mid new/collected 对比库正确
- [ ] D2 skill 订阅流程文档完整（SKILL.md 含「订阅 UP 主」节）
- [ ] D3 出站验证（server/CLI 无 api.bilibili.com）

## 测试轮次记录表（spec §9.1）

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |
