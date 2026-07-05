# 主动采集 P4（被动 UP 采集）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 进视频页顺带被动采 UP 资料（7天 TTL）+ 最新视频（1h TTL，popup 展示不入库）。

**Architecture:** background 收到 video INGEST 后，异步顺带 `ensureUpperInfo`(7天) + `ensureUpperVideos`(1h)，TTL 用 chrome.storage 持久、失败静默不阻塞字幕主链路。popup 读 chrome.storage 缓存展示最新视频列表。

**Tech Stack:** 同 P1-P3（subtitle-collector Vite/crxjs；扩展测试 `node --test test/*.test.mjs` + `scripts/verify-*.mjs`）。

**Spec:** [2026-07-05-active-collection-p4-design.md](../specs/2026-07-05-active-collection-p4-design.md)

---

## File Structure

- `apps/subtitle-collector/background.js`（改）— `ensureUpperInfo` + `ensureUpperVideos` 函数 + INGEST 处理后顺带调用
- `apps/subtitle-collector/src/popup/hooks.ts`（改）— `useUpperVideos(mid)` hook（读 chrome.storage 缓存）
- `apps/subtitle-collector/src/popup/Popup.tsx`（改）— 最新视频列表组件（UP 卡片下）

---

## Task 1: background 被动 UP 采集（ensureUpperInfo + ensureUpperVideos + passive 触发）

**Files:**
- Modify: `apps/subtitle-collector/background.js`

- [ ] **Step 1: 先确认 background.js 干净 + build 基线**

1. `git status` — 确认 `apps/subtitle-collector/background.js` **无未提交改动**（工作树可能有并行会话的 popup 改动，那些不管；background.js 必须干净）。**若有，报 BLOCKED**。
2. `pnpm --filter @bilibili-ext/subtitle-collector build` — 确认基线 build 通过。

- [ ] **Step 2: 加 ensureUpperInfo + ensureUpperVideos 函数**

读 `apps/subtitle-collector/background.js`，找到 `ensureWbiKeys` 函数（约 [L26-28](apps/subtitle-collector/background.js#L26)）之后，加两个函数（复用 `ensureWbiKeys` + `biliFetch` + `ws`，对齐 P2 get-upper-info / list-upper-videos 的字段映射）：

```javascript
// P4：被动采 UP 资料（7 天 TTL）。TTL 用 chrome.storage 持久（SW 重启不丢）。失败抛错由调用方 catch。
async function ensureUpperInfo(mid) {
  const key = `upperInfoAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 7 * 24 * 3600 * 1000) return; // 7 天内跳过
  await ensureWbiKeys();
  const infoRes = await biliFetch('/x/space/wbi/acc/info', { wbi: true, params: { mid }, wbiKeys });
  if (!infoRes.ok) throw new Error('acc/info ' + infoRes.code);
  const statRes = await biliFetch('/x/relation/stat', { params: { vmid: mid } });
  const stat = statRes.ok ? statRes.data : {};
  const info = infoRes.data;
  const creator = {
    source_uid: String(mid),
    name: info.name ?? null, avatar: info.face ?? null,
    sign: info.sign ?? null, level: info.level ?? null, sex: info.sex ?? null,
    official_type: info.official?.type ?? null, official_title: info.official?.title ?? null,
    fans: stat.follower ?? null, following: stat.following ?? null,
  };
  ws.send(JSON.stringify({ type: "ingest-upper", payload: { source: "bilibili", creator } }));
  await chrome.storage.local.set({ [key]: Date.now() });
}

// P4：被动采 UP 最新视频（1h TTL，chrome.storage 缓存，不入库）。失败抛错由调用方 catch。
async function ensureUpperVideos(mid) {
  const key = `upperVideosAt:${mid}`;
  const { [key]: at = 0 } = await chrome.storage.local.get(key);
  if (Date.now() - at < 3600 * 1000) return; // 1h 内跳过
  await ensureWbiKeys();
  const parsed = await biliFetch('/x/space/wbi/arc/search', { wbi: true, params: { mid, pn: 1, ps: 10, order: 'pubdate' }, wbiKeys });
  if (!parsed.ok) throw new Error('arc/search ' + parsed.code);
  const items = (parsed.data?.list?.vlist ?? []).map((v) => ({ bvid: v.bvid, title: v.title, created: v.created ?? null }));
  await chrome.storage.local.set({ [`upperVideos:${mid}`]: { items, fetchedAt: Date.now() }, [key]: Date.now() });
}
```

- [ ] **Step 3: INGEST 处理后顺带调用（异步、失败静默）**

找到 `chrome.runtime.onMessage` 的 INGEST 处理（`if (msg?.type === "INGEST" && msg.payload)`，约 [L265-277](apps/subtitle-collector/background.js#L265)），在 `sendIngest(payload)` 之后（`sendResponse({ ok: true })` 之前或之后均可，因为异步不阻塞），加顺带调用：

```javascript
    sendIngest(payload);
    // P4：顺带被动采 UP 资料（7天）+ 最新视频（1h），异步、失败静默（不影响字幕主链路）
    const mid = payload.video?.creator?.source_uid;
    if (mid) {
      ensureUpperInfo(mid).catch((e) => console.warn('[background] passive upper-info failed', String(e?.message ?? e)));
      ensureUpperVideos(mid).catch((e) => console.warn('[background] passive upper-videos failed', String(e?.message ?? e)));
    }
    sendResponse({ ok: true });
```

（注意：`sendIngest(payload)` 已存在；只在它和 `sendResponse` 之间插这段。`force`/reporting 检查在前面的逻辑里，不动。）

- [ ] **Step 4: build 冒烟**

Run: `pnpm --filter @bilibili-ext/subtitle-collector build` — Expected: build 成功。

> TDD = build 冒烟（编排层依赖浏览器 chrome.*/fetch，纯单测不可达；TTL 逻辑靠 chrome.storage，端到端在 verify）。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/background.js
git commit -m "feat(subtitle-collector): 被动 UP 采集（ensureUpperInfo 7天 + ensureUpperVideos 1h）

P4：收到 video INGEST 后异步顺带采 UP 资料（ingestUpper）+ 最新视频（chrome.storage 缓存）。
TTL 持久（chrome.storage），失败静默不阻塞字幕主链路。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: popup 最新视频列表（从 chrome.storage 缓存读）

**Files:**
- Modify: `apps/subtitle-collector/src/popup/hooks.ts`（`useUpperVideos` hook）
- Modify: `apps/subtitle-collector/src/popup/Popup.tsx`（最新视频列表组件）

- [ ] **Step 1: 先确认 popup 工作树 + build 基线**

1. `git status` — 确认 `apps/subtitle-collector/src/popup/hooks.ts` + `Popup.tsx` **无未提交改动**（并行会话可能又在改 popup；若脏，报 BLOCKED 或等）。
2. `pnpm --filter @bilibili-ext/subtitle-collector build` — 基线。

- [ ] **Step 2: hooks.ts 加 useUpperVideos**

读 `apps/subtitle-collector/src/popup/hooks.ts`（看现有 hook 风格，如 `useCreator`/`useLocalCollected`）。加：
```typescript
// P4：UP 最新视频（从 background passive 缓存读，chrome.storage）。无缓存/过期 → empty。
export interface UpperVideoItem { bvid: string; title: string; created: number | null; }
export type UpperVideosState =
  | { state: 'loading' }
  | { state: 'empty' }   // 无缓存（首次/该 UP 从未被动采过）
  | { state: 'ok'; items: UpperVideoItem[]; fetchedAt: number };

export function useUpperVideos(mid: string | null | undefined): UpperVideosState {
  const [state, setState] = useState<UpperVideosState>({ state: 'loading' });
  useEffect(() => {
    if (!mid) { setState({ state: 'empty' }); return; }
    chrome.storage.local.get([`upperVideos:${mid}`], (items) => {
      const cached = items[`upperVideos:${mid}`] as { items: UpperVideoItem[]; fetchedAt: number } | undefined;
      if (cached?.items?.length) setState({ state: 'ok', items: cached.items, fetchedAt: cached.fetchedAt });
      else setState({ state: 'empty' });
    });
  }, [mid]);
  return state;
}
```
（`useState`/`useEffect` 顶部已 import。`chrome.storage.local.get` 异步，回调 setState。）

- [ ] **Step 3: Popup.tsx 加最新视频列表组件**

读 `apps/subtitle-collector/src/popup/Popup.tsx`（看 `CreatorCard` 组件位置，P4 列表放它之后）。加：

在 Popup 组件里取 `mid`（从 `serverCollected.video.creator_id` 或 `currentBvid` 对应的 UP；实际上 `useCreator` 用 creator_id，`useUpperVideos` 用 mid=source_uid——从 `serverCollected` 的 video 拿 `creator.source_uid` 或单独查。**简化**：`useUpperVideos` 接受 source_uid，从 `serverCollected.state==='ok'` 时拿 `serverCollected.video` 的 UP source_uid——但 CollectedVideo 可能没 source_uid。

**实现时**：先确认 `CollectedVideo` 类型有没有 UP 的 source_uid（`creator_id` 有，source_uid 要看 server getVideo 返回）。若没有，用 `creator_id` 反查或扩展类型。最稳：`useUpperVideos` 接受 `creatorId`，但 chrome.storage key 是 `upperVideos:<mid>`（source_uid）——需要 source_uid。

**取舍**：background 缓存 key 用 mid（=source_uid，passive INGEST 的 `creator.source_uid`）。popup 要拿 source_uid。若 CollectedVideo 没 source_uid，加一个字段（types.ts），或 popup 从 `useCreator(creatorId)` 的结果拿 `creator.source_uid` 再传 `useUpperVideos`。**推荐后者**（不扩 server 响应）：`const creatorState = useCreator(creatorId); const upMid = creatorState.state==='ok' ? creatorState.creator.source_uid : null; const upperVideos = useUpperVideos(upMid);`

加 `UpperVideosList` 组件（用 shadcn Card，对齐 CreatorCard 风格）：
```tsx
function UpperVideosList({ mid }: { mid: string | null }) {
  const v = useUpperVideos(mid);
  if (v.state === 'loading') return null;  // 静默 loading，不闪烁
  if (v.state === 'empty') return null;    // 无缓存不显示（用户浏览该 UP 视频后才有）
  return (
    <Card>
      <CardContent className="p-3 space-y-1">
        <div className="text-xs text-muted-foreground">UP 最新视频（被动缓存，{new Date(v.fetchedAt).toLocaleTimeString()} 更新）</div>
        {v.items.slice(0, 5).map((it) => (
          <a key={it.bvid} href={`https://www.bilibili.com/video/${it.bvid}`} target="_blank" rel="noreferrer"
             className="block text-xs hover:text-primary truncate">
            {it.title}
          </a>
        ))}
      </CardContent>
    </Card>
  );
}
```
在 Popup 的视频页分支（CreatorCard 之后）渲染 `<UpperVideosList mid={upMid} />`。

- [ ] **Step 4: build 冒烟**

Run: `pnpm --filter @bilibili-ext/subtitle-collector build` — Expected: build 成功。

- [ ] **Step 5: Commit**

```bash
git add apps/subtitle-collector/src/popup/hooks.ts apps/subtitle-collector/src/popup/Popup.tsx
git commit -m "feat(subtitle-collector): popup UP 最新视频列表（读 passive 缓存）

P4：useUpperVideos 从 chrome.storage 读 background 被动缓存的 UP 最新视频，
CreatorCard 下展示（无缓存不显示）。shadcn Card + Tailwind。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完工验收（对齐 spec §8 E1–E5）

- [ ] E1 进一个 UP 的视频页（资料 >7天/从未采）→ creators 更新；popup UP 卡片有完整资料
- [ ] E2 进视频页（最新视频 >1h/从未采）→ chrome.storage 缓存；popup 列表
- [ ] E3 7天/1h 内重复进 → 不重复 fetch（TTL 跳过，看 chrome.storage 时间戳）
- [ ] E4 UP fetch 失败 → 不影响 video 字幕 ingest
- [ ] E5 最新视频不入 videos 表

## 测试轮次记录表（spec §9.1）

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |
