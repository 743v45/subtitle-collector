# AI 接手

> 新 AI 会话的默认入口:先读本页定位载体,再按任务清单读对应文件。本页只放指针,不复制内容——内容漂移以各单源为准。

## 载体分工(一件事只有一个权威载体)

| 要查什么 | 去哪 |
|---|---|
| 需求锚点(Feature 状态 ✅/🚧/📋) | [README](../../README.md) |
| 改造台账(改善项登记/划销/优先级,唯一台账) | [docs/plans/improvement-backlog-2026-10.md](../plans/improvement-backlog-2026-10.md) |
| 测试质量细则(三层分级/覆盖率锁定/豁免表) | [docs/quality/RULES.md](../quality/RULES.md) |
| CLI 调度参考(命令组/工具表/playbook) | [docs/skills/collector/SKILL.md](../skills/collector/SKILL.md) |
| 用法手册(按任务切页,本目录总目录) | [docs/help/INDEX.md](INDEX.md) |
| 备份参数单源(间隔/份数/天数) | [apps/collector-server/src/db/backup.ts](../../apps/collector-server/src/db/backup.ts) |
| 部署手册 | [docs/help/Docker 部署.md](Docker%20部署.md) |
| 平台接入(清单/决策模板) | [docs/platform-onboarding.md](../platform-onboarding.md) |
| douyin 进度与决策 | [DOUYIN-PROGRESS](../../DOUYIN-PROGRESS.md) |
| 项目纪律(CLAUDE.md,常驻上下文) | [CLAUDE.md](../../CLAUDE.md) |

## 按任务必读清单

**改代码前**(顺序即优先级):

1. [CLAUDE.md](../../CLAUDE.md) 全文——样式政策、测试质量、措辞红线(字幕非弹幕)、路线纪律(不绕路,外部方案先问)。
2. [改造账本](../plans/improvement-backlog-2026-10.md)——要做的改善是否已登记/已划销/是否在冻结政策内;绕过须先确认并反向登记 CLI 完整度缺口。
3. [docs/quality/RULES.md](../quality/RULES.md)——测试怎么写、覆盖率锁定、提交前 `pnpm qa`。
4. 涉扩展改动 → bump [manifest.json](../../apps/subtitle-collector/manifest.json) `version`;涉 CLI/scripts 改动 → 同步 [SKILL.md](../skills/collector/SKILL.md)(qa 门拦漂移)。

**查生产数据前**:

1. 生产库在 docker named volume 内,**宿主机上不存在该文件**——禁宿主直读(2026-08-24 两次 SQLITE_CORRUPT 教训,virtiofs+mmap 损库)。
2. 查库走 server HTTP / CLI(`--server` + token),或 `docker exec collector-server node -e '...'` 容器内只读;急需本地分析用 `VACUUM INTO` 即时快照 + `--db` 指快照文件。
3. 写操作走 `--server` + token;CLI 的 DB-only 命令(videos/export/sub search/stats)对 `--server` 静默无效,查生产必须指快照。
4. 命令样例见 [SKILL.md](../skills/collector/SKILL.md) 命令组速查表。

**部署前**:

1. server 改动先 `npx tsc --noEmit`——server 的 tsc 门只在 docker build 跑,本地 node --test 不编译。
2. 按部署手册走(先改 token,禁 bind mount 只用 named volume);`docker compose up -d --build` 后跑部署后自检(见下方速查)。
3. 涉扩展改动确认 manifest `version` 已 bump;生产验证依赖真机 popup 操作时直接找用户,勿自行拉 Chrome 装扩展(branded Chrome 已忽略 --load-extension)。

## 当前状态

**不在本页复制**——唯一现状看 [改造账本](../plans/improvement-backlog-2026-10.md)(登记/划销即最新);需求完成度看 [README](../../README.md) Feature 列表。

## 记忆 → 仓库晋升规约

- **项目级知识**(定案/流程/参数/事故教训):迁入对应仓库载体(账本/CLAUDE.md/help 页/RULES),会话记忆原位改为一句话指针——记忆易失,仓库为准。
- **个人偏好与涉密值**(token/密码/内网地址):留记忆不入库;文档里写 `<token>` 占位符。

## 备份与验收命令速查(参数不复述,见各单源)

```bash
node scripts/backup-export.mjs [目录] [--all|--keep N]      # 生产备份导出宿主
node scripts/backup-restore.mjs --list / --drill / --apply <文件名>  # 恢复/演练(--drill 不碰生产)
pnpm verify:deployed -- --token <t> [--server <url>] [--via-docker [容器名]]  # 部署后自检(容器内 integrity_check;生产库在容器卷里)
pnpm qa                                                     # 全量质量门(涉代码提交前必跑)
node scripts/verify-docs-sync.mjs                           # 文档漂移门(指针/版本断言/备份常数)
```
