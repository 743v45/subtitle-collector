# 测试质量规则体系（八项）— 设计

日期：2026-08-23
状态：已确认（用户经 27 问拷问后拍板实施）

## 背景

项目需要一套完整的测试质量规则并让项目实际满足：单元测试、Gherkin 验收测试、QA 测试流程、圈复杂度阈值、模块大小限制、依赖结构分析、变异测试、测试覆盖率要求。原 CLAUDE.md 第 3 节引用的全局 `~/.claude/CLAUDE.md`（8.2/C4/C8 等）已不存在，本次一并收口为仓内自洽表述。

## 决策汇总（27 问拷问结论）

| # | 决策点 | 结论 |
|---|---|---|
| Q1 | Gherkin 形态 | **文档式**：spec 内嵌中文 Given/When/Then 验收场景，标注映射测试文件，不做机器校验 |
| Q2 | 存量达标 | **基线台账制**：新文件必须达标、存量数值不得恶化；软纪律偿还（改动触碰台账文件时顺手偿还或至少不恶化），不设硬性节奏 |
| Q3 | 变异测试范围 | **三 app 全接**：web 用 Stryker vitest runner，server/扩展用 command runner 限范围；定期手动审计，不进 qa 门 |
| Q4 | QA 流程形态 | `pnpm qa` 一条命令质量门 + husky pre-commit |
| Q5 | 静态质量工具 | **ESLint（typescript-eslint flat config）+ 自写基线脚本**，不用 betterer/biome |
| Q6 | 测试中文注释 | 三档（Q19 修正）：①测试名中文意图（现状惯例，强制）②文件头中文块注释（强制，改动存量时补齐）③非显而易见断言/夹具行注释（软性） |
| Q7 | 阈值 | complexity **15**、max-lines **400**（总行数，不跳过空行注释） |
| Q8 | pre-commit 职责 | **只查 git 新增文件**（`--diff-filter=A`）；改动文件交给 qa 台账 check |
| Q9 | mutation score | **纯观察起步**，不设阈值；记入测试轮次记录表，有数据后再议 |
| Q10 | Gherkin 映射校验 | 不自动化，标注过期发现顺手改 |
| Q11 | qa 执行纪律 | 手动 `pnpm qa`，涉代码提交前必跑并在 commit message 引用结果；纯文档/配置豁免；qa 不进 hook |
| Q12 | 扩展覆盖率门 | **换 c8**（与 server 同款，`--experimental-test-coverage` 退役） |
| Q13 | depcruise 违反处理 | 现状违反直接修不豁免；≤10 处本次修，>10 处带回重新决策（事实核查：现状 0 违反） |
| Q14 | 覆盖率锁定线 | 三 app 按现状锁定四指标（向下取整），只升不降；删除"新代码 80% 目标线"（现状 93-100%，多余）；上调靠 qa 输出人工观察 + RULES.md 纪律条款（>2pp 时手动上调） |
| Q15 | puppeteer 冒烟 | **不进 qa**：扩展链路改动时按需跑 `pnpm test:ext`（涉 YouTube 加 `test:youtube`） |
| Q16 | 样例 Gherkin | 主链路（批量采集→入库→导出 bundle）一份，落 `docs/quality/acceptance/main-pipeline.md` |
| Q17 | server 覆盖缺口 | `http/categories.ts`（16.66%）本次顺手补测试 |
| Q18 | 测试文件豁免 | `*.test.*` 对 complexity/max-lines 两条规则豁免（静态门只约束源码） |
| Q19 | 覆盖范围边界 | 根 `scripts/*.mjs` 纳入；`apps/subtitle-extractor` 排除（对齐测试冻结豁免先例） |
| Q20 | web test 拆分 | `test: "vitest run --coverage"`，内嵌 `vite build` 移除（build 归 build task） |
| Q21 | 砍 lint-staged | **只装 husky**，pre-commit = 自写 `scripts/pre-commit-check.mjs` |
| Q22 | 单向指标豁免通道 | `check --allow-degrade` 显式参数 + commit message 注明原因；覆盖率下调同理（留痕的例外，非后门） |
| Q23 | 新 app 准入清单 | CLAUDE.md 加条款：新 app 完成 = 接入四件套（ESLint 范围、测试 runner+覆盖率锁定、depcruise、Stryker）+ 豁免表登记 |
| Q24 | CLAUDE.md 瘦身 | 第 3 节压 ~30 行三层摘要，完整细则外移 `docs/quality/RULES.md` |
| Q25 | baseline update 守门 | 默认 dry-run 输出 diff（改善/恶化/新增/消失），`--write` 才落盘 |
| Q26 | Stryker command 绕开 c8 | server/扩展的 Stryker command **直跑 `node --test`**（复用 `pnpm test` 会因 c8 阈值失败把所有变异体误判为 killed，mutation score 虚高作废） |
| Q27 | depcruise 扩展规则措辞 | 黑名单制：禁 import `content*/inject*/background*` 运行时脚本；共享纯模块（顶层 .mjs）放行（现状 9 处 popup→共享模块是既定模式） |

## 事实基线（2026-08-23 子代理实测）

- server：672 用例 / 52.4s / 覆盖率 98.26-93.28-99.28-98.26（stmts-branch-funcs-lines）；短板 `http/categories.ts` 16.66%
- web：321 用例 / 9.0s / 100-93.07-93.39-100
- 扩展：205 用例 / 1.1s / 原生 99.84-98.48-99.01；c8 实测可行（99.78-99.31-100-99.78，需加 devDep；npx 走 npmmirror 拉不动，直接加 devDep 安装）
- 依赖违反现状：0 处（跨 app / web 分层 / server 分层均干净；扩展 popup→共享 .mjs 9 处为既定模式）
- 测试名惯例：三端一致，裸 `test()` + 全中文测试名（故注释规则落三档而非每条一行）
- turbo：test task 默认缓存开启，inputs 未显式；qa 门用 `--force` 直跑防缓存误判

## 架构

```
日常层（每次提交）     pnpm qa（build+test+覆盖率锁定+ESLint 台账 check+depcruise）
                      husky pre-commit（只查新增文件的两条静态规则）
                      测试中文注释三档
低频层（偿还/调整时）   quality-baseline.mjs update（dry-run 默认）
                      覆盖率锁定线上调（>2pp 时手动）
                      豁免通道 --allow-degrade（commit 留痕）
定期审计层             Stryker 变异测试（三 app，手动）
                      政策自检（每 5 个 spec / CLAUDE.md 大改时；连续两次零执行提请退役）
```

## 实施清单

1. 依赖安装（根 devDeps：eslint、typescript-eslint、@eslint/js、dependency-cruiser、husky、@stryker-mutator/core；web 加 @stryker-mutator/vitest-runner；扩展加 c8）
2. 根 `eslint.config.mjs`（complexity 15 / max-lines 400，warn 级；`*.test.*` 豁免；subtitle-extractor 与 dist 排除；覆盖三 app 源码+config+根 scripts/*.mjs）
3. `scripts/quality-baseline.mjs`（check/update，台账 `docs/quality/baseline.json`；check 支持 `--allow-degrade`；update 默认 dry-run `--write` 落盘；输出按第 9 节可观察性：新增/恶化/改善/消失四类分节）+ `scripts/quality-baseline.test.mjs`（diff 核心逻辑，node:test）
4. `.dependency-cruiser.cjs`（五组规则：跨 app 禁 import、web 分层、server 分层、扩展运行时脚本黑名单、禁循环）+ 根 script `depcruise`；实测全绿
5. 覆盖率阈值：server c8 加 `--check-coverage --lines 98 --statements 98 --functions 99 --branches 93`；web vitest.config thresholds（100/100/93/93）；扩展 test 换 c8 包裹（99/98/99）；Q20 web test 拆 build
6. Stryker 三处（Q26：command 直跑 node --test；web mutate src/**、server 限 `src/cli/subtitleFormat.ts`、扩展限 `subtitleFormat.mjs`；concurrency 限 2；报告产物 gitignore）+ 各跑通一次出分
7. husky（prepare 脚本 + `.husky/pre-commit` → `scripts/pre-commit-check.mjs`：staged∩added∩源码后缀 → ESLint 两规则 → 超标 exit 1）+ 实测拦截一个超标新文件
8. 根 `qa` script：`turbo run build --force && turbo run test --force && node scripts/quality-baseline.mjs check && pnpm depcruise` + `node --test scripts/*.test.mjs`；尾部覆盖率上调提醒语
9. CLAUDE.md 第 3 节改写（三层摘要 ~30 行 + 八项一行一条 + 准入清单 + 自检元规则 + 豁免通道；清理全局悬空引用）
10. `docs/quality/RULES.md`（完整细则）
11. `docs/quality/acceptance/main-pipeline.md`（主链路 Gherkin 验收样例，场景映射真实存在的测试文件）
12. `http/categories.ts` 补测试至正常覆盖（套现有 http 测试模式，中文注释三档合规）
13. README/MANUAL 过期测试命令引用检查更新
14. 扩展 manifest bump 0.1.14 → 0.1.15（涉及扩展改动）
15. 全量验收：`pnpm qa` 全绿 + pre-commit 实测 + Stryker 三处出分 + 台账首版生成提交

## 不做（YAGNI）

- 存量超标模块重构拆分（台账制，另行偿还）
- mutation score 阈值、Gherkin 映射机器校验、覆盖率自动改写配置、cognitive complexity 第二指标、lint-staged、puppeteer 冒烟进 qa、新代码 80% 目标线

## 测试轮次记录表

| 轮次 | 命令 | 结果 |
|---|---|---|
| 1 | `pnpm qa`（turbo build/test --force + scripts 测试 + 台账 check + depcruise） | ✅ server 675 / web 321 / 扩展 209 用例全过、覆盖率阈值全咬合、scripts 测试 12/12、台账 41/41 PASS、depcruise 0 violations |
| 2 | 各 app `pnpm mutation`（Stryker） | ✅ server 96.97%（mutate subtitleFormat.ts）/ web 88.37%（mutate 核心纯逻辑层）/ 扩展 95.08%（mutate subtitleFormat.mjs） |
| 3 | `pnpm test:ext` / `pnpm test:youtube`（puppeteer 冒烟） | ✅ 双绿（33.8s / 16.0s），分步日志齐备 |
| 4 | pre-commit 实测（husky → pre-commit-check.mjs） | ✅ 超标新文件拦截 exit 1（maxLines=462）、合规新文件放行、无新增时跳过 |
