# 改造账本 2026-10

> 2026-10-04 `/grill-me`（一次性 10 问，旁观者视角）共识产物。2026-08-29 grilling 产出的六项改造清单未落盘成文（全仓与 git 全历史零记录，仅 [cli-completeness.md](cli-completeness.md) 残留三处「backlog P0 / P0-2」悬空引用），本文件重建为改造项**唯一台账**：完成即划销（状态改 ✅ 并留日期与简述），语义变化就地注明，不再允许无载体共识。
>
> 共识基础：项目定位 = 自用工具（改造过 ROI 过滤）；消费端闭环现状 = 偶尔用（6 周 4 例，09-22 后无新主题）→ 冻结政策维持；风险排序 = 数据丢失 > token 安全 > AI 协作断代 > 反爬 > 依赖衰减；维护占比过半 → 改造第一优先压降维护成本。
> 事实依据：四路并行盘点（进度与 backlog / 消费端闭环 / 质量与债务 / 架构与数据），时点 2026-10-04 @ `d00b865`。

## 0. 老六项承接盘点（2026-08-29 清单 → 现状）

| 老项 | 承接判定 | 证据 |
|---|---|---|
| 冻结维持 | **持续有效**：两次豁免（08-26 ASR、08-29 douyin）均登记在案；本轮按「偶尔用」判定继续维持，不因豁免惯性扩大解冻 | [CLAUDE.md §6](../../CLAUDE.md) |
| qa 拆层 | **已达成**：RULES §0 三层分级（日常 build / qa 门 / 低频偿还）即拆层产物 | [RULES.md](../quality/RULES.md) |
| 分析模板二例 | **已达成**：内置三模板（观点汇总/面试题库/理念整理），闭环实跑 4 例 | [analyze-template.ts](../../apps/collector-server/src/cli/analyze-template.ts)、[README.md:43](../../README.md#L43) |
| 存量回填+完整率指标 | **部分达成**：asr backfill 能力双平台闭环；存量批量回填跑数未执行；完整率指标被显式推迟 → 新 **P1-5 / P3-5** | [DOUYIN-PROGRESS.md:79](../../DOUYIN-PROGRESS.md#L79)、[consumption-loop.md:51](consumption-loop.md#L51) |
| yt 字幕加固 | **未执行**：yt ASR 兜底选型 ⏳、yt-login 探测未实证 → 新 **P3-1** 待拍板 | [README.md:27](../../README.md#L27) |
| 提交已上生产重构 | **已完成划销**：原意可考（老记忆 P0-1：v16 分类值域重构 30 文件已上生产、git 零提交需按主题补提交）——2026-08-25/26 已全部落地（313ccac 值域合一、ed89d18 台账固化、807ebd0 toast、7cf336e help 体系、84eb340 shilanwei 产物、yt-login.mjs 在库）；2026-10-04 核实后经用户确认划销 | git log 08-24~26 |

## 1. P0（止血）

### P0-1 生产 token 轮换 ✅ 生效（2026-10-04）

- **现状**：生产容器 env 实值 = compose 缺省 `change-me-collector-token`（docker inspect 实查 2026-10-04），端口 `0.0.0.0:21527` 全接口监听（[docker-compose.yml:30-31](../../docker-compose.yml#L30)），旧 token 请求 `/api/stats` 返回 200——控制面（含驱动扩展 navigate 任意 URL 的 command 通道，[main.ts:35-36](../../apps/collector-server/src/main.ts#L35) 自述风险面）仅由一个公开可读字符串保护。
- **动作**：主检出根目录 `.env` 写 `COLLECTOR_TOKEN=<48hex 随机>`（[.gitignore:31](../../.gitignore#L31) 已覆盖不入库；机制为 [docker-compose.yml:20,35-37](../../docker-compose.yml#L20) 既定设计）→ `docker compose up -d` 重建容器使 env 生效。
- **验收**（2026-10-04 实测全过）：旧 token 请求 401；新 token 200；`docker inspect` 实值 ≠ `change-me-*`；容器重建后 /ping 200。
- **用户侧配套**（§5 U-1 未完成部分）：popup server URL 追加 `?token=<新值>`；Android 设置页同步；CLI 写操作带 Bearer。

### P0-2 test:ext 冒烟坏用例修复 ✅（2026-10-04 本轮）

「subtitle_url 四情况」用例自基线 cbdee54 起同败，定性 main 存量、「不进 qa 悄悄坏了」（[DOUYIN-PROGRESS.md:158](../../DOUYIN-PROGRESS.md#L158)）。根因 = verifier 断言过期：0 轨视频信息上报（d9dd40e，有意行为变更，单测已锁定）未同步冒烟断言。verifier 断言对齐新契约（1 条含轨 + 空数组/需登录各 1 条 0 轨 + 风控零上报），源码零改动；`pnpm test:ext` 全绿、ext 单测 356 pass。

### P0-3 改造账本重建 ✅（2026-10-04 本轮）

本文件落盘 + [cli-completeness.md](cli-completeness.md) 三处悬空引用（L25/L34/L42）改指本账本 + #5 补部分落地标注（`--tags` AND 已由 0fd6972 落地，余 4 参数仍挂）。

## 2. P1（两周窗，维护成本压降）

| # | 项 | 验收标准 | 状态 |
|---|---|---|---|
| P1-1 | 文档漂移清零：cli-completeness #1 三处（playbooks `tags apply --source` 照跑必退 2、SKILL.md collect 计数、退出码表漏 EXT_UPDATE=6）+ compose 备份注释对齐（L9「每小时/滚动 24 份」→ 实况 15min/8∪14，改为指向 [backup.ts](../../apps/collector-server/src/db/backup.ts) 单源不复述数字） | grep 无残留旧文案；verify-skill-sync 过 | ✅（2026-10-04 本轮） |
| P1-2 | 死工具双删（cli-completeness #2）：`scripts/run-collector-server.mjs`、`scripts/body2subtitle.py` 零引用核实后删除，playbook 1 改指 CLI `server start` | 全仓 grep 零引用；qa 门绿 | ✅（2026-10-04 本轮） |
| P1-3 | 静态台账固化：`node scripts/quality-baseline.mjs update --write`（tasks.ts 538→529、sub.ts 458→452 两项已改善未入账；死工具删除后台账同步） | 此后 dry-run 零漂移 | ✅（2026-10-04 本轮） |
| P1-4 | manifest description 去掉未接入的小红书（[manifest.json:6](../../apps/subtitle-collector/manifest.json#L6)）+ bump 0.1.31（logo 预取保留，[platforms.ts:96](../../apps/subtitle-collector/src/popup/platforms.ts#L96) 注释口径不变） | build 过；popup 品牌头显示 0.1.31 | ✅（2026-10-04 本轮） |
| P1-5 | 存量 no-subtitle 回填跑数：`asr backfill` 对存量批量执行一轮（含美国加息批次 6 条待兜底），顺带盘点全库 no-subtitle 规模 | 跑数报告（回填数/失败数/剩余）；不违冻结（既有能力执行，非新采集能力） | ☐ 排队 |
| P1-6 | videos list 补 4 过滤参数：`creator_id / creator_uid / tag_source / date_field`（db 层 advanced.ts 已支持，纯包装；cli-completeness #5 余量——tags 多标 AND 已由 0fd6972 落地） | 4 参数可用；失败→通过用例；SKILL.md/help 同步 | ☐ 本轮执行 |
| P1-7 | creators 查询 CLI：`creators list/get`（`GET /api/creators` 七键排序已备；存量回填查缺资料配套，cli-completeness #7） | list/get 可用（排序/筛选透传）；失败→通过用例；SKILL.md/help 同步 | ☐ 本轮执行 |
| P1-8 | tags 改名/删标 CLI：`tags rename/delete`（HTTP `PATCH/DELETE /api/tags/:id` 已备；AI 打标纠错场景，cli-completeness #8） | rename/delete 可用（含 404/冲突路径）；失败→通过用例；SKILL.md/help 同步 | ☐ 本轮执行 |
| P1-9 | categories CRUD / settings 读写 CLI：`categories add/list/update/delete` + `settings get/set`（tag-priority、collect-timeout，cli-completeness #9；HTTP 端点已备） | 全子命令可用；失败→通过用例；SKILL.md/help 同步 | ☐ 本轮执行 |
| P1-10 | 选项命名统一：`tags list --topN`→`--top`、`translate pending --asc`→`--desc`；直接 breaking 不留 alias（对齐 `--source` 语义统一先例），同步 SKILL.md/help/测试（cli-completeness #10） | 旧参数退 2 列全合法键；全仓无旧名残留 | ☐ 本轮执行 |
| P1-11 | CLI VERSION 硬编码改读 package.json（cli/main.ts，cli-completeness #11） | VERSION 与 package.json 同源；单测锁定 | ✅（2026-10-05，version.ts 单源读 package.json（tsx/dist/容器三形态路径均成立）+ 失败兜底日志；红灯轮证硬编码不可测后 8 用例转绿，main.test.ts 断言同步去字面量，65cdb45） |
| P1-12 | scripts 层最小契约成文并统一：退出码 0/非 0、失败 stderr 带 `[tag]` 分步日志、stdout 数据可 pipe；**不推 CLI 的 0-6 语义**；现有优质工具（youtube-collect-videos.mjs）即范本（cli-completeness #12） | 契约文档落 docs/；存量 scripts 对齐或登记例外 | ☐ 本轮执行 |

> 2026-10-05 `/grill-me` 追加轮（用户拍板「按推荐追加 + 逐项完成」）：上表 P1-6~P1-12 = cli-completeness 批次 2/3 余量（已有能力包装，零冻结截留）转挂编号；小包装插本段与 P1-5 并列，大项 web 评论展示落 P2-5 排偿债三件之后。

## 3. P2（偿债/结构性，按窗口推进）

| # | 项 | 说明 | 状态 |
|---|---|---|---|
| P2-1 | 巨石偿还 | background.js（cx 161 / 1353 行）、Popup.tsx（1786 行）、collect.ts（1017 行）；**增量式**：涉改顺手拆，不专项大爆炸，每还一个 `baseline update --write` 固化，严禁 `--allow-degrade` 再扩容 | ☐ |
| P2-2 | 备份与 server 解耦 | 备份定时器与 server 同进程同生死（[main.ts:128](../../apps/collector-server/src/main.ts#L128)），server 挂 = 采集停 + 备份同时停（14h 备份空窗前科）；告警也依赖同进程活着。方案候选：compose sidecar / host 定时 `docker exec` 触发 VACUUM INTO | ☐ |
| P2-3 | 采集执行体单点缓解 | 三入口写 collect_tasks，唯一执行者 = 一台桌面 Chrome 的扩展 SW，扩展不在线任务全停；方案候选：dispatched 超时改派 / 多客户端派发（状态机已备，缺 policy） | ☐ |
| P2-4 | douyin 遗留三件 | popup 抖音卡、popup「上报」哑按钮（[DOUYIN-PROGRESS.md:161](../../DOUYIN-PROGRESS.md#L161)）、博主批量 CLI 入口；**前置 = U-2 真机验证通过** | ☐ 前置未满足 |
| P2-5 | web 评论展示 | VideoDetail 评论树渲染 + server 评论查询子路由（挂点已探明：统计卡 `stat.reply` 计数处 + `/api/videos/:source/:vid/*` 子资源先例，[comments/PLAN.md §1.3](comments/PLAN.md) 显式排除项）；2026-10-05 用户指令提级执行（消费侧非冻结截留） | ☐ 本轮执行 |

## 4. P3（观察 / 待拍板）

| # | 项 | 说明 | 状态 |
|---|---|---|---|
| P3-1 | yt 侧投入决策 | ASR 兜底 yt-dlp 选型（[README.md:27](../../README.md#L27) ⏳）+ yt-login 探测实证（32b9ba6 未验证）；不拍板 = 默认冻结 | ☐ 待拍板 |
| P3-2 | Stryker 重跑一轮 | 观察制，上轮 2026-08-23（server 96.97 / web 88.37 / ext 95.08），此后零重跑 | ☐ |
| P3-3 | server bundle 端点 / headless 分析初稿 | 维持「下个分析主题疼了再做」（[consumption-loop.md:52-53](consumption-loop.md#L52)） | ☐ 推迟 |
| P3-4 | android 复活或归档 | 08-30 后零提交、9 月无动静、仅 7 端点 MVP；归档也须显式（README 🚧 对齐） | ☐ 待拍板 |
| P3-5 | stats completeness 完整率指标 | 维持推迟（[consumption-loop.md:51](consumption-loop.md#L51)） | ☐ 推迟 |
| P3-6 | 小红书：接入或彻底移除 | manifest 宣传位已清（P1-4）；logo 预取与 onboarding 清单触发条件仍在，第四平台落地时重评 | ☐ 远期 |

## 5. 用户操作/拍板项（AI 不可代劳）

| # | 事项 | 关联 | 说明 |
|---|---|---|---|
| U-1 | popup / Android 更新 token | P0-1 | popup 服务器配置 URL 追加 `?token=<新值>`（值见主检出 `.env`）；断连窗口内主动采集暂停。2026-10-05 催办：已向用户给出操作步骤 |
| U-2 | douyin 博主批量真机重测 | P2-4 前置 | 悬置 5 周+（[DOUYIN-PROGRESS.md:6](../../DOUYIN-PROGRESS.md#L6)）：健康 sec_uid 匿名 1.5s 通、真实浏览器零到达，候选根因待真机区分 |
| U-3 | ~~「提交已上生产重构」语义追认~~ | §0 | ✅（2026-10-04：原意从老记忆考得，核实 08-25/26 已补提交落地，已完成划销） |
| U-4 | P3-1 / P3-4 拍板 | P3 | 不拍板 = 维持现状（冻结/静止） |
| U-5 | 下一个分析主题实跑 | P3-3/P3-5、README 🚧 | 解锁「疼了再做」推迟项链（INDEX 台账 → README 分析条目转 ✅ 的互锁条件，[README.md:46](../../README.md#L46)） |
