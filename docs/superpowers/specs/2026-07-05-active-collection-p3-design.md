# 主动采集 P3（多 UP 主批量发现 + skill 订阅）—— 设计文档

> 日期：2026-07-05
> 状态：**正式 spec**。关键决策「AI/skill 触发，无 server 调度」**待用户最终确认**（暂按推荐 A）。
> 关联：[P1 spec](./2026-07-05-active-collection-design.md)、[P2 spec](./2026-07-05-active-collection-p2-design.md)（new-videos 单 UP 基础）

---

## §1 概述

P3 给 P2 的 `new-videos`（单 UP 主）加**多 UP 主批量**：一次给多个 mid，汇总所有 UP 的新视频；并在 `bili-collect` skill 加**订阅流程**（配置 UP 列表，用户说「跑订阅」→ 批量发现新视频）。

两个能力：
- `collect discover <mid...>`：批量多 UP，每个跑 new-videos（拉列表 + 对比库），汇总新增 BV
- skill 订阅流程：UP 列表 + 跑 discover + 汇总

## §2 关键决策（待确认）

**AI/skill 触发，无 server 调度**（推荐 A，暂按此设计）。

| 选项 | 说明 | 代价 |
|---|---|---|
| **A AI/skill 触发（推荐）** | 用户说「跑订阅」→ CLI 批量 discover → 汇总新增；订阅 UP 列表存 skill/记忆 | 无调度层，复用 P2 按需；需要人说一声才跑 |
| B server 后台调度 | server 跑 cron 定时触发扩展 new-videos | 加 server 调度层 + 订阅配置存储；扩展必须在线 |
| C 扩展 alarm 定时 | MV3 alarm 定期触发 | 浏览器必须开着；订阅配置存哪 |

**选 A 的理由**：最简，复用 P2 按需模式（P1 spec 当时回避的调度层仍不引入）；对齐用户场景「按需分析 UP 主新视频」。若用户要真后台（B/C），本 spec §4/§5 调整。

## §3 需求

| # | 需求 | 验证 |
|---|---|---|
| R1 | 给多个 mid，批量发现每个 UP 的新视频 | `collect discover <mid...>` 汇总 per_mid + all_new |
| R2 | skill 订阅流程：配置 UP 列表 + 一句话跑批量 | skill 文档 + 真实跑通 |
| R3 | 全扩展通信（复用 P1/P2） | server/CLI 无 api.bilibili.com 出站 |

## §4 架构（复用 P2）

```
skill（订阅流程）→ CLI collect discover <mid...>
  │ 对每个 mid（CLI 循环，串行 + sleep ~1s 防风控）：
  │   server → 扩展 list-upper-videos（P2）→ CLI 对比库（P2 collectNewVideos）
  ▼
汇总 { per_mid: [{mid, new:[...], collected:[...]}], all_new: [BV...] }
```

无 server 调度。CLI 层循环多 mid（复用 P2 collectNewVideos 的"拉列表 + 对比库"）。

## §5 接口契约

### §5.1 CLI `collect discover <mid...>`（变参，多 mid）

server→扩展：复用 P2 `list-upper-videos`（每 mid 一次）。
CLI 纯处理 `collectDiscover(client, db, mids, opts, timeout)`：
```typescript
// 对每 mid 调 collectNewVideos（P2 已实现：拉列表 + 对比库），汇总。
// 串行（sleep ~1s 由调用方/skill 控制，CLI 不内置 sleep——保持纯函数可测）。
export async function collectDiscover(
  client: CollectClient, db: Database.Database, mids: string[],
  opts: UpperVideosOpts, timeout: number,
): Promise<{
  per_mid: Array<{ mid: string; total: number; new: string[]; collected: string[] }>;
  all_new: string[];
}> {
  const per_mid = [];
  const allNew = [];
  for (const mid of mids) {
    const clientId = await resolveClientId(client);  // 复用 P2（取在线扩展）
    const r = await collectNewVideos(client, clientId, mid, db, opts, timeout);
    per_mid.push({ mid, ...r });
    allNew.push(...r.new);
  }
  return { per_mid, all_new };
}
```

commander：
```
cli collect discover <mid...> [--page N] [--size N] [--client ID] [--timeout MS]
```
（变参 `<mid...>`，至少 1 个。复用 P2 的 resolveClientId / openReadonlyDb / handleHttpError 模式。）

### §5.2 skill 订阅流程（bili-collect skill 文档更新）

`.claude/skills/bili-collect/SKILL.md` 加一节「订阅 UP 主」：
```markdown
## 订阅 UP 主（发现新视频）
1. 你维护一份订阅列表（UP 主 mid，从 upper-info 或 search 拿）。建议存在 memory 或文档。
2. 用户说「跑订阅 / 看看订阅的 UP 有没有新视频」时：
   `collector-cli collect discover <mid1> <mid2> <mid3> --format json`
   → 汇总 `all_new`（所有 UP 的新视频 BV）。
3. 对 all_new 决定采哪些（`collect subtitle <BV>`，串行 + sleep）。
```

## §6 不做（YAGNI）

- server 调度层（A 方案；B/C 才需要）
- 订阅配置存 server（无状态；UP 列表在 skill/memory）
- 自动 fetch-subtitle 新视频（discover 只列出，用户/AI 决定采哪些）
- 新视频通知（push/邮件等）
- 并发批量（串行 + sleep 防风控；并发 = YAGNI + 风控风险）

## §7 数据模型

不变。`discover` 不入库（对比库找 new，复用 P2 new-videos 语义）。videos 表只增 fetch-subtitle 采过的。

## §8 验收标准

| # | 验收项 |
|---|---|
| D1 | `cli collect discover <mid1> <mid2>` 批量跑，返回 `{per_mid:[...], all_new:[...]}`，每 mid 的 new/collected 对比库正确 |
| D2 | skill 订阅流程文档完整（UP 列表 + discover + 决定采），Claude Code 能依此跑通 |
| D3 | 出站验证（server/CLI 无 api.bilibili.com） |

## §9 测试方式（对齐 [CLAUDE.md §3](../../CLAUDE.md)）

| 对象 | 方式 |
|---|---|
| CLI `collectDiscover` 纯处理 | `node --test --import tsx`（注入 mock ServerClient + 临时 DB，造多 UP 数据，断言 per_mid + all_new） |
| skill 文档 | 人工审（SKILL.md 含订阅流程） |

### §9.1 测试轮次记录表

| 轮次 | 日期 | 测试内容 | 结果 | 发现的问题 / 修复 |
|---|---|---|---|---|
| （实现阶段填写） | | | | |

## §10 风险

| 风险 | 缓解 |
|---|---|
| 多 UP 批量扩展往返（每 mid list-upper-videos）触发风控 | skill/CLI 串行 + sleep ~1s；discover 不内置 sleep（纯函数），由 skill 控制 |
| 订阅 UP 列表无固定存储（在 skill/memory） | 接受（A 方案无状态）；用户也可写在文档里 |
| 扩展离线时 discover 失败 | resolveClientId 抛 no online client（CLI 退 ARGS，提示用户连扩展） |

## §11 本地映射参考

- P2 `collectNewVideos`（复用拉列表 + 对比库）：[collect.ts](../../apps/collector-server/src/cli/commands/collect.ts) `collectNewVideos`
- P2 `list-upper-videos` action（扩展 fetch arc/search）：[background.js](../../apps/subtitle-collector/background.js)
- P2 `resolveClientId` / `openReadonlyDb` / `handleHttpError`：[collect.ts](../../apps/collector-server/src/cli/commands/collect.ts)
- skill：[.claude/skills/bili-collect/SKILL.md](../../.claude/skills/bili-collect/SKILL.md)（gitignored，本地）
