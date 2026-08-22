# collector 项目 skill(主动调度 CLI)+ 同步门禁 设计文档

- 日期:2026-08-23
- 状态:已批准(经 brainstorming 范围/机制两轮决策 + grilling 八问定案)
- 前置调研:[collector-cli 设计文档](2026-07-05-collector-cli-design.md)(§9 已有 agent 调用约定,但埋在 spec 里,日常会话不可见)

## 1. 目标与非目标

**目标**:
- Claude 在用户表达采集/查询/导出/字幕数据/server 运维意图时,主动、正确地调度 collector-cli(10 命令组)与 `scripts/` 采集工具。
- 命令用法一致:不瞎编参数、遵守调用约定(绕过 `pnpm run`、全局选项位置、退出码语义)。
- skill 与 CLI 更新同步:门禁拦截漂移,纪律提示维护。

**非目标**:
- 不复制完整参数手册——commander `--help` 每级自描述,兜底纪律「不确定先跑 `--help`」。
- 不做机器生成命令参考(已否:生成脚本自身维护成本 + 不含高层知识)。
- 门禁不执行真业务命令(`collect` 会真实下发采集,只做静态解析校验)。

## 2. 结构(正文与引用分离)

```
docs/skills/collector/SKILL.md                    # skill 正文,进 git(项目资产)
docs/skills/collector/references/playbooks.md     # 多步任务编排,按需加载
.claude/skills/collector → symlink                # 指向 docs/skills/collector,不进 git
scripts/verify-skill-sync.mjs                     # 同步门禁
scripts/verify-skill-sync.test.mjs                # 门禁自身测试
```

- `.claude/` 整目录 gitignore(私有笔记)维持不变;skill 正文住 `docs/skills/`,symlink 引用(用户定案:「skill 写项目里,.claude 里引用」)。
- 换机器重建:`mkdir -p .claude/skills && ln -s ../../docs/skills/collector .claude/skills/collector`

## 3. SKILL.md 内容分层(只写 `--help` 给不出的)

| 节 | 内容 | 来源 |
|---|---|---|
| 调用约定 | 直接 tsx 绕过 `pnpm run`(stdout 污染 + 退出码吞没两难);全局选项在子命令前;退出码 0-5;`-q`/`--format`;字幕纯文本导出直写 stdout;zsh 循环传参分词坑 | CLI 设计文档 §9 + baseline 实证 |
| 环境事实 | 双库陷阱(生产 repo 根 `data/`、dev 在 `apps/` 下);server 默认 21527/代理 21528;`COLLECTOR_DB_PATH`/`COLLECTOR_SERVER`/`COLLECTOR_TOKEN` | 部署事实 + baseline 实证 |
| 命令组速查 | 10 命令组各一行:名字 + 用途 + 最常用选项名,不抄参数表 | `--help` |
| scripts 速查 | 每工具一行:用途 + stdin/stdout 约定;verify-\* 族只列一行不展开 | 各工具头注释 |
| 纪律引用 | CLAUDE.md §9 可观察性(批量采集前先看日志能否定位)、措辞红线(字幕非弹幕) | CLAUDE.md |
| 兜底纪律 | 「不确定的参数,先跑 `<命令> --help` 再动手」 | — |

frontmatter 遵循 writing-skills 规范:`name: collector`;description 以「Use when...」开头、只写触发条件不总结流程、第三人称、含触发关键词。

**playbooks.md** 收五个任务编排:
1. 链路体检(server ping → clients list → collect search 试探;含 server down 救场:run-collector-server.mjs / launch-chrome)
2. 给 up 主建库(collect upper-info/upper-videos/new-videos → collect-uppers.mts → season/dedupe)
3. YouTube 链路(yt-videos --collect / youtube-collect-videos + youtube-collect-subs)
4. 消费端(export bundle → Claude Code 会话分析 → `analysis/<主题>/`,README 三类模板)
5. tags 打标(sub search → tags apply --source ai 官方 AI 打标工作流)

## 4. 同步门禁 verify-skill-sync.mjs

- 提取 SKILL.md 与 playbooks.md 中 ` ```collector-cli ` 标注代码块里的命令样例。
- 两级校验(全静态、无副作用):
  - **命令路径**:样例子命令链逐级比对 `node --import tsx src/cli/main.ts <路径> --help` 输出(commander 自描述;有子命令的级,下一个非选项 token 必须是其子命令)。
  - **长选项拼写**:样例中 `--opt`(全局选项白名单除外)与叶子级 help 选项清单比对。
- `scripts/<name>.{mjs,mts,sh,py}` 引用 → 文件存在性。
- 零样例 = 校验空转,报错。
- 接入点:`pnpm qa`(不进 pre-commit——tsx 拉起数百毫秒,pre-commit 刻意轻量;纯文档提交豁免 qa 已覆盖)。
- 对齐 quality-baseline.mjs 先例:守门员自身必须有测试,进 qa 的 `node --test scripts/*.test.mjs` 列表。

## 5. 测试策略

- **skill 本体**(Reference 型,按 writing-skills):
  - RED:无 skill 时派 subagent 做查询/导出任务,记录 baseline 失败模式。已执行,实证:① `pnpm cli` banner 污染 stdout 致 `| jq` 解析失败(靠试错发现 `pnpm -s` 但其吞退出码);② 双库歧义靠跨会话记忆解救(仓库内零文档消歧,CLI 默认 dev 库与生产差 307 条数据);③ collect 链路前置(server 起停/token 来源/扩展在线确认)完全靠猜;④ 排序语义(first_seen vs published_at)歧义。
  - GREEN:带 skill 重跑同场景,验证调用方式正确。
- **门禁脚本**:node --test 20 用例覆盖样例提取/前缀剥离/help 解析/两级校验/scripts 引用;全中文测试名 + 注释三档;拦截路径已实证(`--limit` 误用与 `videoz` 拼错均被拦)。

## 6. 验收清单

- [x] baseline 场景记录在案(RED,见 §5)
- [x] SKILL.md + playbooks.md + symlink 落地,GREEN 场景通过
- [x] verify-skill-sync.mjs 两级校验 + 测试全绿(20/20)
- [x] 拦截路径实证(坏样例被精确报错)
- [x] qa 挂接(package.json qa 命令 + node --test 列表)
- [x] CLAUDE.md §3 登记(九项规则第 9 条)+ RULES §6 同步
- [x] `pnpm qa` 全绿(32 根脚本测试 + baseline + skill-sync + depcruise)
- [x] 不涉扩展改动,不 bump manifest version(版本纪律)

## 7. GREEN 场景实证与 REFACTOR 记录

带 skill 的 subagent 完成同款任务(查库 + CSV 导出),调度约定(调用形态/双库选择/--help 兜底/全局选项位置)全部被正确使用;同时抓出三处文档缺陷,已修复并复验:

1. **【硬错误,已修】**`pnpm -C` 切 cwd → 双库样例相对路径 `--db data/...` 按字面执行 exit 4。修复:调用形态节加 cwd 陷阱警告,路径参数约定一律绝对路径(`<repo>` 占位),SKILL.md 与 playbooks.md 全部 `--db` 样例同步改写;复验按新文档字面执行返回正确数据(videos: 3683)。
2. **【措辞,已修】**「stdout 纯数据 JSON」在 `--format csv` 下不成立 → 改为「数据 + 结果报告,格式随 --format」。
3. **【缺失,已修】**「最近」排序歧义无默认值 → 补「无法确认时默认 first_seen(查询主语是库)」。

## 8. 测试轮次记录

| 轮次 | 命令 | 结果 |
|---|---|---|
| 1 | `node --test scripts/verify-skill-sync.test.mjs` | 20/20 通过(修 fake resolver 深度分派 + 段头解析 + 短选项分支后) |
| 2 | `node scripts/verify-skill-sync.mjs` | ✓ 15 条样例 + scripts 引用全有效 |
| 3 | `pnpm qa` | ✓ 全绿(build+test+32 根脚本测试+baseline+skill-sync+depcruise) |
| 4 | 复杂度重构后 `node --test scripts/verify-skill-sync.test.mjs` + eslint 静态规则 + 门禁真跑 | 三绿(complexity 17→拆分达标;qa 内含) |
| 5 | GREEN 修复后 `node scripts/verify-skill-sync.mjs` + 双库样例字面执行 | ✓ 15 样例有效;stats overview 返回生产库正确数据 |
