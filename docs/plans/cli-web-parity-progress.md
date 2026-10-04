# CLI 全功能 web 化 — 执行进度

> ✅ **全部完成（2026-10-04）**：四期代码 + 文档收尾均已落地。server 批 `f5e89b3`、web 批 `ff6e15f`，文档批见本文件末尾。

计划文件：/Users/taevas/.claude/plans/gentle-sniffing-melody.md（已批准）
工作分支：human-husky（worktree /Users/taevas/.paseo/worktrees/08mry0gs/human-husky）

## 豁免（用户 2026-10-04 拍板）
- server start/stop、clients command 通用命令 UI、videos get-by-id、collect discover
- 登记落点见 [cli-completeness.md](cli-completeness.md) §4 反向登记 / §5 不纳入记录

## 期次状态

### Phase 1 只读查询补齐 ✅
- [x] server 五端点（sub-search / translate pending / translate source / check-exists / status）——tsc/1012 测试/depcruise/台账全绿
- [x] web（SubSearchPage 五态壳+Form/ResultCard/highlight 拆件 / TranslatePage 薄壳+PendingList/Workbench / SettingsPage 状态卡 / api-core+api-extra 三层化 api.ts 434→421 / TABS +search,+translate）——417 测试全绿，台账超标已偿还
- [x] commit（与 P2/P3 同批：server `f5e89b3`、web `ff6e15f`）

### Phase 2 下载通道与导出 ✅
- [x] server（http/zip.ts 零依赖 zip + http-util sendFile/contentDisposition + http/export.ts 三端点 GET /api/export/videos|subtitle/:s/:v|bundle，csvEscape 导出复用）——新增 18 测试，1012 全绿四门过
- [x] web（lib/download.ts + buildExport*Url + VideoList 导出下拉 + ExportBundleDialog + VideoDetail TrackExportBar）
- [x] commit（server `f5e89b3`、web `ff6e15f`）

### 提交策略（并行流水线导致文件交错，调整自「每期一 commit」）
1. P1+P2+P3 server 完成后：`git add apps/collector-server` → commit（message 分段写清 P1/P2/P3）——已按此落 `f5e89b3`（实际含 P4 server）
2. P1+P2+P3 web 完成后：`git add apps/collector-web` → commit——已按此落 `ff6e15f`（实际含 P4 web）
3. 全量 `pnpm qa` 在每批 commit 前跑（server 批与 web 批各跑一次）——两批均全绿

### Phase 3 写入与编排 UI ✅
- [x] server：POST /api/collect-search、POST /api/season/preview、POST /api/upper-info/refresh、tags.ts:37 文案修
- [x] web：VideoList 批量打标、TranslateWorkbench fill 写回、CollectPage 搜索卡、VideoDetail 合集卡、创作者刷新按钮、ClientsPage/TasksHistoryPage 文案
- [x] 审查 + qa + commit（`f5e89b3` / `ff6e15f`）

### Phase 4 长任务异步化 ✅
- [x] 基建：jobs 表迁移 v20 + 串行 runner + COLLECTOR_ASR_BASE_URL / COLLECTOR_BILI_COOKIE_FILE env
- [x] server：POST /api/jobs（asr-backfill / collect-find）+ GET /api/jobs(/:id) + DELETE（取消语义）
- [x] web：ASR 卡（TranslatePage）+ find 条件面板 + JobCard 进度 + RecentJobs 台账
- [x] 审查 + qa + commit（`f5e89b3` / `ff6e15f`）

### 文档收尾 ✅（2026-10-04）
- [x] docs/help/ 新页（字幕检索页 / 补翻与转写 / Web 导出与原料包 / Web 批量操作；server 状态卡并入 Docker 部署页）+ 受影响页更新（检索视频库 / 无字幕视频处理 / 补翻中文字幕 / 环境变量 / 采集合集与搜索 / 客户端与任务派发）+ INDEX.md 目录项
- [x] README Feature 列表同步（「CLI 全功能 web 化」主导航条目 + 六子条目）
- [x] docs/plans/cli-completeness.md 反向登记（douyin 博主批量无 CLI；discover / clients command / start/stop / get-by-id 豁免）

## 待处理风险

（已清零，2026-10-04）原记录两项均已在 Phase 1 web 批偿还：api.ts 三层化拆 api-core/api-extra（434→421 行，后续模块 api-export/api-jobs 独立成文件）；SubSearchPage/TranslatePage 复杂度经拆组件（Form/ResultCard/Workbench/PendingList）达标。web 批 commit qa 全绿（570 测试，覆盖率 statements/lines 100%、branches 93.38% ≥ 93 锁定线），quality-baseline PASS。
