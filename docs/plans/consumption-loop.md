# 消费端闭环最小集（2026-10-02 拷问定案）

> 来源：产品评审工作流（10 agent，19 建议→验证合并 13 项）+ 用户逐项拷问定案。
> 范围 = 最小闭环集 6 项；其余推迟项登记在各台账，本文不展开。

## 范围（6 项）与验收标准

### 1. P0 · `scripts/export-bundle.mjs`：生产库 → 分析原料包一条命令

- 快照获取：默认**每次打新快照**（容器内 `VACUUM INTO` + `docker cp`，复用 backup-export.mjs 通道）；`--max-age-hours N` 可选复用 `data/exports/` 内 mtime 最新快照（**按 mtime 不按文件名**，09-22 误选事故教训）。
- `--theme <主题>`：`--out` 默认 `analysis/<主题>/bundle/`；过滤器透传 `export bundle`。
- stdout 透传 CLI 机器可读回执；stderr `[export-bundle]` 分步日志（§9 可观察性）。
- DB-only CLI 命令（videos/sub/export/stats/changes）收到显式 `--server` 时 stderr 一行警告「该命令只读本地 --db，--server 已忽略」。
- 文档：SKILL.md scripts 表、playbooks §4、help《分析工作流》第一步与《导出分析原料包》改写为新命令形态。
- ✅ 验收：`node scripts/export-bundle.mjs --theme test-验收 --creator <某UP>` 从生产库出包；`--server` 警告有用例；help 示例可直接复制执行。

### 2. bundle 落盘布局定死 + 存量回填

- 布局：原料 `analysis/<主题>/bundle/`，产物在 `<主题>/` 根；bundle.ts ANALYZE.md 措辞补显式指引。
- 回填（Q4c 定案）：ai-agent 目录 git 入库；shilanwei 原料三件套挪 `bundle/` 子目录、产物 HTML 留根；美国加息报告住 report 仓库（Q4b 定案），外链登记进 help《分析工作流》「现存主题一览」表（**不建 THEME.md**）。
- ✅ 验收：`git status` analysis/ 下无未跟踪；shilanwei 目录形态符合布局；一览表含 4 主题状态。

### 3. manifest 增补 `tags` / `view` + 字幕原始覆盖量

- video 条目加 `tags`（带 scope）、`view`（extra.stat.view）；subtitle 加 `lines` + `last_ts`（**不算比例、不设阈值、不告警**）。
- ANALYZE.md 盲区模型扩第三类「轨在但覆盖残缺」，只给描述性参照（健康 ≈16-40 行/分钟），判定留给分析会话。
- 存量 manifest 不回填，只对今后导出生效（历史原料忠实性）。
- ✅ 验收：新导出 manifest 含上述字段；覆盖率锁定不降；三模板注释与 SKILL.md/help 同步。

### 4. 修 translate 中文轨判定 bug

- `isZhLan` = 精确命中 OR `asr-zh-` 前缀；pending 的 NOT EXISTS 与 translate source 守卫同换；`--source` 帮助补 douyin。
- 前缀常量落点遵守 depcruise server 分层（不得 cli→http 直接 import，与 http/asr.ts 的 `ASR_LAN_PREFIX` 单一事实源对齐或共享落点）。
- ✅ 验收：两个失败→通过用例（仅 asr-zh-* 轨不进 pending；默认轨 asr-zh-* 拒翻）。

### 5. README 需求锚点对齐实况

- L40/L43：闭环实跑 4 例写入；「分析产物规范」**保持 🚧**，改注「闭环已实跑、规范工具化进行中」；✅ 等布局+manifest+INDEX 全落地。
- L27 ASR ⏳ 收窄到实际剩余项；help《分析工作流》冻结段对齐 CLAUDE.md §6 现行表述；cli-completeness.md「另行处理」欠账划销。
- ✅ 验收：三处状态（README/cli-completeness/help）不再打架。

### 6. `stats count --by tag`（一行白名单欠账）

- `STATS_GROUP_BY` 加 `'tag'` + 帮助文案六值；失败→通过用例；SKILL.md 同步；cli-completeness.md #6 划销。
- ✅ 验收：`stats count --by tag --tags <csv>` 出子集共现分布。

## 推迟项登记（不在本批）

- tasks 命令组 → cli-completeness.md #3 加注「下一批首选」。
- 抖音收口 → DOUYIN-PROGRESS.md 悬空指针（等 0.1.28）改「重测待约」（版本以 [manifest.json](../../apps/subtitle-collector/manifest.json) 为准），重测需用户真机配合。
- sub search --tags+池截断 / videos list 富化 / stats completeness / INDEX 台账 / --date-field / help 门禁 → 触发条件：下一分析主题实跑疼了再做。
- headless 分析初稿（2026-10-02 CLI 完整度批次追加）：`export-bundle` 出包后接 `claude -p` 按 ANALYZE.md 模板无人值守出分析初稿，人工只复核定稿——触发条件：下个分析主题实跑时试跑定形（prompt 模板、输出落点、失败重试策略都要实跑才知道）。
- server 端 bundle 导出端点（2026-10-02 CLI 完整度批次追加）：`/api/export/bundle` 在 server 内流式出包（zip/tar），免「VACUUM INTO 快照 → docker cp → CLI 出包」三跳——触发条件：库规模或出包频率上来、现有三跳真的疼了再做。
- web 评论展示（2026-10-03 评论采集落地的显式范围排除，[docs/plans/comments/PLAN.md §1.3](comments/PLAN.md)）→ ✅ 已落地（2026-10-05 账本 P2-5，091e248 + web 侧 commit）：VideoDetail 懒展开评论树区块 + `GET /api/videos/:source/:vid/comments`（树组装与 CLI tree 共享 db 层 shapeTree）；不再等待触发条件。

## 执行纪律

- 批次：①P0+translate+--by tag（并行）→ ②bundle 布局/manifest + 文档锚点。
- 涉代码提交前跑 `pnpm qa` 并在 commit message 引用结果；server 侧先 `npx tsc --noEmit`（tsc 门只在 docker build 跑）。
- 每项独立 commit；本轮不碰扩展，不 bump version。
