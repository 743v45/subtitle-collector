# 测试质量规则细则（RULES）

> [CLAUDE.md](../../CLAUDE.md) 第 3 节「测试质量政策」的完整展开。规则体系 27 项设计决策定稿见
> [2026-08-23-test-quality-rules-design.md](../superpowers/specs/2026-08-23-test-quality-rules-design.md)。

## 0. 三层分级总览

| 层 | 触发时机 | 内容 |
|---|---|---|
| 日常 | 每次代码改动完成 | 即时 `pnpm build`（类型/编译门，见 §6） |
| 日常 | 每次提交 | `pnpm qa` 质量门 + husky pre-commit（只查新增文件）+ 测试中文注释 |
| 低频 | 偿还 / 调整时 | 台账 update（默认 dry-run）、覆盖率锁定线上调（>2pp）、`--allow-degrade` 豁免 |
| 定期审计 | 阶段性大改后 | Stryker 变异测试（各 app `pnpm mutation`）、政策自检（§8） |

## 1. 单元测试与中文注释

三端现状惯例：裸 `test()` + **全中文测试名**。注释三档：

1. **测试名中文意图** —— 强制（现状惯例，新测试必须沿用）。
2. **文件头中文块注释** —— 强制；改动存量测试文件时顺手补齐（说明该文件测什么、关键夹具）。
3. **非显而易见断言 / 夹具的行注释** —— 软性，写清「为什么断言这个值」。

回归纪律：bug 修复 commit 必须含对应「失败→通过」的测试用例。

## 2. 覆盖率锁定线（只升不降）

按 2026-08-23 实测值向下取整锁定四指标（stmts / branch / funcs / lines），进各自 `test` 命令，随 `pnpm qa` 生效：

| App | 工具 | statements | branches | functions | lines | 配置位置 |
|---|---|---|---|---|---|---|
| collector-server | c8 | 98 | 93 | 99 | 98 | [package.json](../../apps/collector-server/package.json) `test` 的 `--check-coverage` |
| collector-web | vitest coverage | 100 | 93 | 93 | 100 | [vite.config.ts](../../apps/collector-web/vite.config.ts) `test.coverage.thresholds` |
| subtitle-collector | c8 | 99 | 98 | 99 | 99 | [package.json](../../apps/subtitle-collector/package.json) `test` 的 `--check-coverage` |

- 不设「新代码 80% 目标线」——现状 93-100%，多余。
- **上调流程**：qa 输出的实际覆盖率比锁定线高出 **>2pp** 时手动上调配置，commit message 说明；平时不动。
- **下调 = 豁免**：走 `--allow-degrade` 同款通道——改配置 + commit message 注明原因（见 §3 豁免流程），是留痕的例外不是后门。
- 扩展已换 c8 包裹（`--experimental-test-coverage` 退役）；web 的 `test` 只含 `vitest run --coverage`，`vite build` 归 build task。

## 3. 静态质量门（complexity ≤15 / max-lines ≤400）

两条规则，ESLint warn 级（[eslint.config.mjs](../../eslint.config.mjs)），**守门靠台账不靠编辑器**：

- 圈复杂度 ≤ **15**（文件内最大函数）。
- 模块 ≤ **400 行**（总行数，不跳过空行注释）。

范围：三 app 源码 + 扩展顶层裸脚本（`.mjs/.js`）+ 根 `scripts/*.mjs`。排除：`*.test.*` 与扩展 `test/**`（静态门只约束源码，测试质量由覆盖率管）、`apps/subtitle-extractor`（见 §10）、`dist` 等生成物。

**台账机制**（[docs/quality/baseline.json](baseline.json)，由 [scripts/quality-baseline.mjs](../../scripts/quality-baseline.mjs) 管理）：

- 新文件必须达标——台账外新增超标即失败。
- 存量超标登记在册，**数值不得恶化**——上升即失败；下降（改善）/消失（达标）输出提示，下次 update 固化。
- 偿还是软纪律：改动触碰台账文件时顺手偿还，或至少不恶化，不设硬性节奏。

```bash
node scripts/quality-baseline.mjs check               # 对比现状与台账；恶化/新增超标 exit 1
node scripts/quality-baseline.mjs check --allow-degrade  # 显式豁免变差项
node scripts/quality-baseline.mjs update              # 默认 dry-run，打印改善/恶化/新增/消失四类 diff
node scripts/quality-baseline.mjs update --write      # 才落盘刷新台账
```

**豁免流程**：确实需要变差（重构中间态等）时 `check --allow-degrade` 通过，且 commit message 必须注明豁免原因。

## 4. 依赖结构规则（depcruise）

[.dependency-cruiser.cjs](../../.dependency-cruiser.cjs) 五组规则，`pnpm depcruise` 跑（进 qa 门）：

1. **跨 app 隔离**（三条）：collector-server / collector-web / subtitle-collector 互相不得 import——跨 app 只走 HTTP/WS API。
2. **web 分层**（两条）：`components/ui` 原子组件不得 import pages / 非 ui 组件 / lib / api（保持最底层）；`lib` 纯工具层不得 import pages / components。
3. **server 分层**（两条）：`db` 层不得 import http/cli/tasks/ws/main（db 是最底层）；`tasks` 层不得 import http/cli/ws/main（调度层只依赖 db）。
4. **扩展运行时脚本黑名单**：`src/`（popup/options React 侧）不得 import `background*/content*/inject*` 运行时脚本——各脚本有独立运行环境与全局态，只能走 chrome.runtime 消息；共享纯模块（顶层 `.mjs`，如 subtitleFormat.mjs）放行，popup→共享模块 9 处是既定模式。
5. **禁循环**：循环依赖全仓禁止（模块职责边界不清的信号）。

**违反处理**：直接修不豁免。现状 0 违反；若一次改动引入超过 10 处，说明规则与架构有冲突，带回重新决策而不是批量豁免。

## 5. Gherkin 验收（文档式）

- **形态**：spec 内嵌中文 Given/When/Then 验收场景，**每个场景下方标注映射的自动化测试文件**（可到用例名）。不做机器校验；发现标注过期时顺手改。
- 验收章节在 spec 内的位置灵活，但每个 spec **必须含「测试轮次记录表」**，且至少一行记录 `pnpm qa` 结果。
- 格式与标注法样例：[docs/quality/acceptance/main-pipeline.md](acceptance/main-pipeline.md)（主链路「批量采集 → 入库 → 导出 bundle」）。

## 6. QA 门与 pre-commit

**即时 build 门**（每次代码改动完成后，先于 qa）：

```
pnpm build        # 或受影响 app 的 pnpm -C apps/<app> build
```

- **为什么必须有**：测试 runner 不做类型检查——server 走 tsx 直译（跳过类型）、web 的 vitest 不跑 tsc，**测试全绿 ≠ 可构建**；server 的 tsc 门历史上只在 docker build 兜底，中途不 build 会把编译错误积攒到部署前才爆。
- 触发时机：完成一个逻辑单元的改动（交给用户/继续下一步）之前；qa 门内的 build 是最终兜底，不是唯一的编译验证点。

**`pnpm qa`**（根 [package.json](../../package.json)，手动跑、不进 hook）：

```
turbo run build --force && turbo run test --force   # --force 防 turbo 缓存误判
  && node scripts/quality-baseline.mjs check
  && node scripts/verify-skill-sync.mjs             # skill ↔ CLI/scripts 同步门
  && pnpm depcruise
  && node --test scripts/*.test.mjs                 # 根脚本自身的测试
```

- **触发纪律**：涉代码的提交前必跑，commit message 引用结果（如 `qa: 全绿` 或附覆盖率摘要）；纯文档/配置改动豁免。
- 尾部输出覆盖率上调提醒（对比锁定线，见 §2）。
- puppeteer 冒烟**不进 qa**：扩展链路改动时按需 `pnpm test:ext`（涉 YouTube 链路加 `pnpm test:youtube`）。

**skill 同步门**（`scripts/verify-skill-sync.mjs`，2026-08-23 引入）：

- 校验对象：[docs/skills/collector/](../../docs/skills/collector/SKILL.md)（agent 调度参考，`.claude/skills/collector` 是其 symlink——skill 正文进 git，`.claude/` 目录整体 gitignore 维持私有定位）。
- 两级校验（全静态、不执行真业务命令）：` ```collector-cli ` 标注块里样例的子命令链逐级比对 CLI `--help`；`--opt` 长选项与叶子级 help 选项清单比对；`scripts/<name>` 引用做存在性检查。
- 维护契约：改 collector-cli 命令/选项或 scripts 工具入口后同步 skill 文件，否则此门拦截（CLAUDE.md 九项规则第 9 条）。

**husky pre-commit**（`scripts/pre-commit-check.mjs`，只装 husky 不用 lint-staged）：

- 范围：staged ∩ **git 新增文件**（`--diff-filter=A`）∩ 源码后缀——只拦「新文件就超标」，改动文件交给 qa 台账 check。
- 检查项：complexity / max-lines 两条静态规则，超标 exit 1。

## 7. 变异测试（Stryker，观察制）

| App | runner | mutate 范围 | 说明 |
|---|---|---|---|
| collector-web | vitest | `src/**/*.{ts,tsx}` | 全量源码 |
| collector-server | command | `src/cli/subtitleFormat.ts` | 限范围起步 |
| subtitle-collector | command | `subtitleFormat.mjs` | 限范围起步 |

- **观察制**：不设 mutation score 阈值、不进 qa 门；阶段性大改后手动跑，分数记入该 spec 的测试轮次记录表，积累数据后再议阈值。
- **command runner 必须直跑 `node --test`，禁止复用 `pnpm test`**：c8 的 `--check-coverage` 会让每个变异体都因覆盖率骤降而失败，全部被误判为 killed——mutation score 虚高作废（server 与扩展的 stryker.conf 已注明）。
- concurrency 限 2；报告产物已 gitignore。
- 跑法：各 app 目录下 `pnpm mutation`。

## 8. 政策自检（元规则）

- **触发**：每完成 5 个 spec，或 CLAUDE.md 大改时。
- **动作**：过一遍本文各条款的执行记录（测试轮次记录表 + qa 结果引用）——**连续两次自检零执行的条款提请退役**（向用户提出，不自行删除）。
- 目的：防止规则体系变成没人执行、只占篇幅的僵尸条款。

## 9. 新 app 准入清单

新 app 的「完成」= 接入四件套 + 豁免登记：

1. **ESLint 范围**：源码加入根 [eslint.config.mjs](../../eslint.config.mjs) 的 files。
2. **测试 runner + 覆盖率锁定**：定 runner（node:test + c8 或 vitest），首次实测值向下取整写入阈值配置（§2 口径）。
3. **depcruise**：若有内部分层，在 [.dependency-cruiser.cjs](../../.dependency-cruiser.cjs) 加对应规则；跨 app 隔离三条自动覆盖。
4. **Stryker**：加 stryker.conf + `mutation` script（command runner 记住 §7 直跑 node --test 的原因）。

需要豁免某项规则时，在 §10 登记表加行留痕。

## 10. 豁免登记表

| 对象 | 豁免项 | 原因 | 登记日期 |
|---|---|---|---|
| apps/subtitle-extractor | 测试 / ESLint / depcruise / Stryker 全套 | 依赖缺失测试冻结（[pnpm-workspace.yaml](../../pnpm-workspace.yaml) 排除；2026-08-19 用户决定保留该 app） | 2026-08-23 |
| `*.test.*` 与扩展 `test/**` | complexity / max-lines 两条静态规则 | 静态门只约束源码；测试文件质量由覆盖率指标管 | 2026-08-23 |
| 根 `scripts/*.mjs`（非 verify/quality 类） | 覆盖率 | 覆盖范围只纳入 `quality-baseline.test.mjs` 类可测脚本；一次性脚本以 §CLAUDE.md 第 9 节可观察性纪律约束 | 2026-08-23 |
| apps/collector-android | ESLint / 覆盖率锁定 / depcruise / Stryker 四件（§9 全套） | 原生 Kotlin 工程，四件均为 JS/TS 工具链无从接入（2026-08-26 grilling 共识）。原生等价物：**detekt** 当 lint、**JUnit** 写核心逻辑单测（分享文本解析、API 层），gradle 构建挂 turbo 但**不进 `pnpm qa`**（qa 是 node 链）；bug 修复「失败→通过」回归纪律同样适用 | 2026-08-26 |
