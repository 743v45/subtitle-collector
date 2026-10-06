<!--
  评论采集链路验收场景（文档式 Gherkin）：collect 全量/增量 → 入库幂等 → 删除对账 → 风控降级 → 树校验。
  格式对齐 [main-pipeline.md](main-pipeline.md) 先例；规则见 [docs/quality/RULES.md](../RULES.md) §5。
  不做机器校验；映射过期时发现顺手改。场景下方的「→」引用均为真实存在的测试文件与用例名（2026-10-04 核对）。
  规格唯一来源：[docs/plans/comments/PLAN.md](../../plans/comments/PLAN.md)（§7.4 场景清单、§3/§4/§5 行为定义）。
-->

# Feature: B 站评论分析树采集链路

单视频评论区（根评论 + 楼中楼全量）采集入库：宿主 CLI 直连 B 站（wbi 游标遍历）→ server HTTP ingest 幂等 upsert →
增量水位追新 → 删除两轮确认 → 树完整性校验。链路上每一步的行为都有自动化测试锁定。

## Scenario: 全量采集入库（根 + 楼中楼两层、置顶、member 快照）

- Given 视频已在库（comments 挂 videos.id），B 站 cookie 就绪
- When `comments collect --bvid <BV> --mode full`（wbi/main mode=2 时间序游标遍历 + 楼中楼按 page.count 实时分母翻全）
- Then 根评论与楼中楼按 `rpid_str` 幂等 upsert 入库，五 ID（rpid/root/parent/dialog/mid）取 `*_str`；
  置顶条目本体（实测不在首页 rows）并入 buffer 入库并打 `pin_kind`；member 快照存 JSON、uname 提一级
- And full 完整轮末批带 `full_scan:true` + `scan_start`，回执 `fetched.total = 根 + 楼`、内嵌 verify 结果

→ [apps/collector-server/src/cli/commands/comments.test.ts](../../../apps/collector-server/src/cli/commands/comments.test.ts)
　`full 完整轮：游标包裹 {"offset":原文} 透传 + is_end 标记批(full_scan/scan_start/pins) + missing 进回执`、
　`楼中楼：page.count 实时分母翻全 count_reached + 楼条目入库 + data.root 刷新不重复计根`、
　`hot 快照：full+hot 首发 mode=3 快照页随批入库；快照页失败降级继续时间序`
→ [apps/collector-server/src/db/comments.test.ts](../../../apps/collector-server/src/db/comments.test.ts)
　`upsert 幂等：同 rpid 二次入库更新观测列、保留首采列，返回 inserted/updated 计数`、
　`clearAndSetPins：先清后打——换置顶自然生效；incremental 不调用则 pin_kind 不动`
→ [apps/collector-server/src/http/comments.test.ts](../../../apps/collector-server/src/http/comments.test.ts)
　`comments ingest：正常 200（§2.3 解析归一落位 + inserted/updated 计数 + 幂等重采首采列保留）`

## Scenario: 幂等重采（同 rpid 二次 upsert，首采列保留）

- Given 视频评论区已采过一轮（行带 first_seen_at / first_page / batch_id）
- When 同一视频再采一轮，部分评论点赞数 / 状态有变化，置顶与列表双出现同 rpid
- Then 观测列（like_count / state / member / last_seen_at 等）更新，首采列（first_seen_at / batch_id / first_page）保留；
  同批重复 rpid 幂等吸收为单行；关联三元组（root/parent/dialog）库内自洽时不被新值改写

→ [apps/collector-server/src/db/comments.test.ts](../../../apps/collector-server/src/db/comments.test.ts)
　`upsert 幂等：同 rpid 二次入库更新观测列、保留首采列，返回 inserted/updated 计数`、
　`upsert：同批重复 rpid（置顶+列表双出现）幂等吸收为单行`、
　`upsert：关联三元组防御性保留——库内自洽时不被新值改写`、
　`upsert：R0 违例修正——库内现值违反 R0 且新值自洽 → 以新值修正并打 [store] 日志`

## Scenario: missing 两轮确认（候选 → 确认 → 恢复；仅根评论、仅完整轮）

- Given 某视频已采过完整全量轮，本轮为再次完整全量（partial 轮不参与计数）
- When 某根评论本轮缺席（置 `missing_since` 候选），下一完整轮仍缺席（`last_seen_at < missing_since` 确认），
  或中途重新出现（恢复 NULL）
- Then 仅根评论（`is_root=1`）参与对账——楼中楼行缺席不动水位（根被删后楼层结构性不可达，不连坐误判）；
  确认缺失行不再导出，但楼中楼孩子行保留（orphan_floor 建模，不物理删）

→ [apps/collector-server/src/db/comments.test.ts](../../../apps/collector-server/src/db/comments.test.ts)
　`reconcileMissing 四态：候选→确认→恢复；楼层行缺席不参与（is_root=1 双守卫）`、
　`reconcileMissing：partial 轮守卫由调用方负责——直接调用即对账（db 层无守卫重复）`、
　`verifyTree R7：missing 分档——missing_since 非空计候选，其中 last_seen < missing_since 计确认`
→ [apps/collector-server/src/http/comments.test.ts](../../../apps/collector-server/src/http/comments.test.ts)
　`comments ingest：full_scan 触发 missing 对账（候选→确认→恢复四态；楼中楼行不参与）`

## Scenario: 风控 partial 不污染水位（三档退避尽 → 不触发对账）

- Given 采集途中 B 站返回风控码（-352 等），三档退避（30s/120s/300s）后仍失败
- When 本轮以 `partial:true` 终止（回执带 `partial_reason` 与失败现场）
- Then 已入库批次保留（行级幂等，重跑安全），但 ingest 不带 `full_scan:true`——partial 轮不发 missing 对账，
  不置 missing_since 水位；伪完整轮（`is_end=true` 但活跃行数×1.2 < max(all_count, stat.reply)）同样视同 partial
  （`suspicious_truncation`，疑似软过滤截断）

→ [apps/collector-server/src/cli/commands/comments.test.ts](../../../apps/collector-server/src/cli/commands/comments.test.ts)
　`风控三档退避：-352 → 30s/120s/300s 后 partial；-403 → 强刷 wbi keys 重试成功`、
　`伪完整轮守卫：复查行数×1.2 < all_count → suspicious_truncation 不发标记批；复查失败/verify 失败不拦轮`、
　`判停：连续 2 空页（full 空壳形态带 [parse] 日志 / incremental 同停）`
→ [apps/collector-server/src/http/comments.test.ts](../../../apps/collector-server/src/http/comments.test.ts)
　`comments ingest：full_scan:false 不动 missing 与 pins（partial 轮只入库，§3.3 守卫 3）`

## Scenario: 树校验五类违例（verifyTree R0-R4）

- Given 库内评论行存在删除 / 异常形态：楼中楼 root 指向不在库、parent 悬空、dialog 指向既不在库也非自身、
  实采楼数缺于分母、根行三元组不自洽
- When `comments verify --bvid <BV>`（DB 只读；collect 收尾也经 server 端点内嵌同一校验）
- Then 分档报告：`orphan_floor`（R1，error）/ `dangling_parent`（R2，error）/ `dangling_dialog`（R3，warn，
  直回根 dialog=自身不算）/ `rcount_mismatch`（R4，分母=楼中楼实时 count，缺失回落根行 rcount，实采超分母
  clamp 为 0 并计 overshoot）/ `triple_inconsistent`（R0，error）；R4 附 top 样本并注记分母来源

→ [apps/collector-server/src/db/comments.test.ts](../../../apps/collector-server/src/db/comments.test.ts)
　`verifyTree R0：三元组不自洽计入 triple_inconsistent（根行 parent 非零）`、
　`verifyTree R1：楼中楼 root 指向库内不存在的行 → orphan_floor`、
　`verifyTree R2：parent 悬空 → dangling_parent`、
　`verifyTree R3：dialog 悬空（指向既不在库也非自身）→ dangling_dialog；直回根 dialog=自身不算`、
　`verifyTree R4：rcount 对账（fallback 分母）+ samples 注记分母来源 + overshoot`、
　`verifyTree R4 overshoot：实采超过 page.count 分母 → 缺口 clamp 0 并计 overshoot`
→ [apps/collector-server/src/cli/commands/comments.cli.test.ts](../../../apps/collector-server/src/cli/commands/comments.cli.test.ts)
　`verify：JSON 回执 counts（根 2 / 楼 5）+ --stat-reply 1 启 R9 root_count_gap；--server 警告同样出现`

---

## 测试轮次记录表

| 轮次 | 日期 | 命令 | 结果 | 备注 |
|---|---|---|---|---|
| R1 | 2026-10-04 | `pnpm qa` | 全绿（1002 tests） | C1（db 层 2755ea1）+ C3（解析层 9b6b3e4）合并验证；台账 PASS、depcruise 0 违反 |
| R2 | 2026-10-04 | `pnpm qa` | 全绿（1027 tests） | C2（http 三端点 849fa71，c8 门 98/93/99/98 过）；C6（bundle 导出 7066a53）同档 |
| R3 | 2026-10-04 | `pnpm qa` | 全绿（1102 tests） | C4+C5（CLI 采集编排 + 树查看 2ba0de3）；c8 99.64/94.12/99.82/99.64、台账 39/39 PASS、depcruise 0 违反 |
