# CLI 完整度补齐计划

> 2026-08-25 `/grilling cli 完整度` 共识产物；审计基线 @ main `32b9ba6`（文中 file:行号均为该时点）。本文件是 CLI 完整度的**缺口台账与排序计划**：执行项按改造清单判据插入，完成一项划一项（状态改 ✅ 并留 commit）。

## 0. 标准与验收（2026-08-25 共识）

- **链路标准为纲**：README「批量采集 → 查询导出 → 批量提取分析」全链路（含运维段）每一步都有代码化入口（CLI 命令或 `scripts/` 工具）。
- **反向标准为增量机制**：agent 经确认绕过 CLI/scripts 写内联编排的操作，登记进 §4 反向登记段。**反向登记清零之日，即 CLI 完整之日。**
- **第一验收对象 = agent**：能否零内联脚本跑通全链路；输出机器可读优先，人用为辅（允许 `--format` 类双轨开关）。
- **镜像标准仅参考**：端点粒度 ≠ 任务粒度，不机械要求 HTTP 端点逐一镜像。
- **范围**：collector-cli + `scripts/` 工具；web UI / HTTP 面不纳入（例外与放弃项见 §5）。
- **冻结边界**：本计划全部缺口无一属「采集侧新能力」——均为已有能力包装、治理或 bug 修复，采集侧冻结零截留。

## 1. 链路四段核对（审计基线结论）

| 段 | 状态 | 缺口 |
|---|---|---|
| 批量采集 | ✗ | **任务生命周期断链**：agent 建任务后查不了结果、重试不了失败任务（只能 curl HTTP 或翻 web） |
| 查询导出 | ✗ | videos list 5 个过滤参数未暴露（db 层已支持）；stats 聚合缺 tag 维度 |
| 批量提取分析 | ✅ | bundle 导出 + `analysis/<主题>/` 落盘规范已闭合 |
| 运维 | ✗ | settings 读写（tag-priority / collect-timeout）无 CLI 入口 |

## 2. 缺口台账

状态：☐ 待办 / ✅ 完成。批次语义（2026-10-04 起旧「改造清单/backlog」以 [improvement-backlog-2026-10.md](improvement-backlog-2026-10.md) 为唯一载体，原 2026-08 清单无文件载体已失传）：**批次 1** 随账本 P0/P1 执行流；**批次 2** 落 P1 窗口（消费端配套）；**批次 3** 为 P2+ 治理。

### 批次 1（随账本 P0/P1；执行序 = 漂移修复 → 死工具处置 → 任务生命周期 → 存量回填配套）

| # | 缺口 | 归类 | 状态 |
|---|---|---|---|
| 1 | **「运行即错」级文档漂移三处**：[playbooks.md:70-71](../skills/collector/references/playbooks.md#L70) `tags apply --source ai` 照文档跑必退 2（isPlatform 校验）＋「三档」/「删全部三档」文案 stale；[SKILL.md:63](../skills/collector/SKILL.md#L63) collect 子命令计数 12→实际 11；[SKILL.md:20](../skills/collector/SKILL.md#L20) 退出码表漏 EXT_UPDATE=6（[output.ts:8-16](../../apps/collector-server/src/cli/output.ts#L8) 有定义） | bug 级漂移 | ✅（2026-10-04 漂移修复批次：`tags apply --source ai` 命令本体已被 0fd6972 顺手修为 `--scope ai --source bilibili`，残留为「三档」stale ×2——playbooks tags 段改四档口径并显式标注 `--scope`=档位/`--source`=平台、「删全档」实义是 `--scope` 省略；SKILL.md collect 计数 12→11（collect.ts 注册 10 + yt-search 组装层 1）；退出码表补 6=扩展版本过旧；verify-skill-sync 全绿） |
| 2 | **死工具双删**：`scripts/run-collector-server.mjs`（硬编码已迁移旧仓库路径必挂，功能被 CLI `server start` 覆盖；[playbooks.md](../skills/collector/references/playbooks.md) playbook 1 同步改指 CLI）＋ `scripts/body2subtitle.py`（零引用零登记，功能被 `export subtitle` 覆盖） | 处置 | ✅（2026-10-04 双删落地：两文件零引用核实后 `git rm`（-131 行）；SKILL.md scripts 表删行、playbook 1 改指 `collector-cli server start`；verify-skill-sync 全绿证清理完整） |
| 3 | **采集任务生命周期 CLI**（批次 1 功能最高位）：`tasks list / get / retry` 为主（HTTP 端点已备：`GET /api/collect-tasks` 筛选排序、`GET /api/collect-tasks/:id`、`POST /api/collect-tasks/retry`），`delete` / batch 直暴露视需——**下一批首选**（2026-10-02 消费端闭环批次推迟项登记，见 [consumption-loop.md](consumption-loop.md)「推迟项」） | 闭环配套 | ✅（2026-10-02 CLI 完整度批次：`tasks list/get/retry` 落地（[tasks.ts](../../apps/collector-server/src/cli/commands/tasks.ts)，list 对齐 GET /api/collect-tasks 全部筛选参数、get 含失败原因/回执、retry 多 id）；顺带落同批次的「`--server` 缺省防呆提示」（[main.ts](../../apps/collector-server/src/cli/main.ts)）；SKILL.md 命令表+样例块、help 客户端页、README 查询导出段同步；`delete` / batch 直暴露维持视需不落） |
| 4 | **按字段缺失筛选 → force 刷新代码化**（存量回填配套，对齐 no-subtitle 回填先例；随账本 [P1-5](improvement-backlog-2026-10.md) 执行时顺带） | 闭环配套 | ☐ |

### 批次 2（P1 窗口，消费端配套 + 查询补齐）

| # | 缺口 | 归类 | 状态 |
|---|---|---|---|
| 5 | videos list 补 5 个过滤参数：`creator_id / creator_uid / tags（多标 AND）/ tag_source / date_field`（db 层 [advanced.ts:10-34](../../apps/collector-server/src/db/advanced.ts#L10) 已支持，纯包装；「按标签选料导 bundle」是消费端高频） | 闭环配套 | ☐→转挂账本 [P1-6](improvement-backlog-2026-10.md)（2026-10-05；子项 `tags（多标 AND）` 已由 0fd6972 落地，余 4 参数本轮执行） |
| 6 | `stats count --by tag`：[stats.ts:36](../../apps/collector-server/src/cli/commands/stats.ts#L36) STATS_GROUP_BY 补 tag（[http/stats.ts:12](../../apps/collector-server/src/http/stats.ts#L12) 已有） | 闭环配套 | ✅（2026-10-02 消费闭环第 6 项：白名单+帮助六值、失败→通过用例×3、SKILL.md 同步） |
| 7 | creators 查询 CLI（列表/详情/打分类；`GET /api/creators` 七键排序已备）——与存量回填绑定（账本 [P1-5](improvement-backlog-2026-10.md)；查缺资料 UP 清单） | 闭环配套 | ☐→转挂账本 [P1-7](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |

### 批次 3（P2+ 治理）

| # | 缺口 | 归类 | 状态 |
|---|---|---|---|
| 8 | tags 改名/删标（HTTP `PATCH/DELETE /api/tags/:id` 已备；AI 打标纠错场景） | 已有能力包装 | ☐→转挂账本 [P1-8](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |
| 9 | categories CRUD / settings 读写 CLI（tag-priority、collect-timeout） | 已有能力包装 | ☐→转挂账本 [P1-9](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |
| 10 | 选项命名统一：`tags list --topN`→`--top`、`translate pending --asc`→`--desc` 惯例；**直接 breaking 不留 alias**（对齐 2026-08-24 `--source` 语义统一先例），同步 SKILL.md | 治理 | ☐→转挂账本 [P1-10](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |
| 11 | CLI VERSION 硬编码（[main.ts:14](../../apps/collector-server/src/cli/main.ts#L14)）改为读 package.json | 治理 | ☐→转挂账本 [P1-11](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |
| 12 | scripts 层最小契约成文并统一：退出码 0/非 0、失败 stderr 带 `[tag]` 分步日志（§9 可观察性）、stdout 数据可 pipe；现有优质工具（`youtube-collect-videos.mjs`）即范本。**不推 CLI 的 0-6 语义** | 治理 | ☐→转挂账本 [P1-12](improvement-backlog-2026-10.md)（2026-10-05 本轮执行） |

## 3. 每项执行纪律 checklist

每条缺口落地时逐项过：

- [ ] 失败 → 通过的测试用例（回归纪律）
- [ ] SKILL.md 命令速查表同步（`verify-skill-sync` 门拦截）
- [ ] docs/help/ 对应页同步（help 手册同步纪律）
- [ ] `pnpm qa` 全绿并在 commit message 引用结果
- [ ] 涉扩展改动 bump `manifest.json` version

## 4. 反向登记段（CLAUDE.md §8 执法落点）

> CLAUDE.md §8：经确认的绕过发生后，必须把该操作登记为 CLI 完整度缺口（落本段）。

（空——2026-08-25 起点。登记格式：日期 / 被绕过的操作 / 缺口描述 / 是否已转正为 §2 台账条目。）

## 5. 不纳入记录（2026-08-25 共识，防重议）

- **HTTP `--paid` 反向缺口**：db 层支持、[filter.ts](../../apps/collector-server/src/http/filter.ts) 不解析（web 筛不了付费）。web/HTTP 面在本计划范围外，将来需要时是一行改动。
- **web UI 能力对齐**：UI 是人肉浏览面，非代码化调度面。
- **scripts 全量对齐 CLI 退出码 0-6**：最小契约即可（见 #12）。
- **navigate/operate 泛型下发**：扩展 10 个 WS action 中这两个无专属子命令，经泛型 `clients command` 已覆盖，不立缺口（[background.js:562-854](../../apps/subtitle-collector/background.js#L562)）。
- ~~**README 分析条目状态**（🚧 vs 已跑通 2 例）：README 纪律问题，不属本计划，另行处理。~~ ✅ 划销（2026-10-02）：消费端闭环已实跑 4 例（ai-mianshiguan、shilanwei、美国加息202609、ai-agent-岗位分析），README 需求锚点已按实况对齐（[consumption-loop.md](consumption-loop.md) 第 5 项），欠账清零。
