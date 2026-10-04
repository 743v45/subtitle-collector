# CLI 全功能 web 化 — 执行进度

计划文件：/Users/taevas/.claude/plans/gentle-sniffing-melody.md（已批准）
工作分支：human-husky（worktree /Users/taevas/.paseo/worktrees/08mry0gs/human-husky）

## 豁免（用户 2026-10-04 拍板）
- server start/stop、clients command 通用命令 UI、videos get-by-id、collect discover

## 期次状态

### Phase 1 只读查询补齐 ✅
- [x] server 五端点（sub-search / translate pending / translate source / check-exists / status）——tsc/1012 测试/depcruise/台账全绿
- [x] web（SubSearchPage 五态壳+Form/ResultCard/highlight 拆件 / TranslatePage 薄壳+PendingList/Workbench / SettingsPage 状态卡 / api-core+api-extra 三层化 api.ts 434→421 / TABS +search,+translate）——417 测试全绿，台账超标已偿还
- [ ] commit（与 P2 同批，见下方提交策略）

### Phase 2 下载通道与导出
- [x] server（http/zip.ts 零依赖 zip + http-util sendFile/contentDisposition + http/export.ts 三端点 GET /api/export/videos|subtitle/:s/:v|bundle，csvEscape 导出复用）——新增 18 测试，1012 全绿四门过
- [ ] web（lib/download.ts + buildExport*Url + VideoList 导出下拉 + ExportBundleDialog + VideoDetail TrackExportBar）——agent 进行中
- [ ] commit

### 提交策略（并行流水线导致文件交错，调整自「每期一 commit」）
1. P1+P2+P3 server 完成后：`git add apps/collector-server` → commit（message 分段写清 P1/P2/P3）
2. P1+P2+P3 web 完成后：`git add apps/collector-web` → commit
3. P4 同理两批；全量 `pnpm qa` 在每批 commit 前跑（server 批与 web 批各跑一次）

### Phase 3 写入与编排 UI
- [ ] server：POST /api/collect-search、POST /api/season/preview、POST /api/upper-info/refresh、tags.ts:37 文案修
- [ ] web：VideoList 批量打标、TranslatePage fill 工作台、CollectPage 搜索卡、VideoDetail 合集卡、创作者刷新按钮、ClientsPage/TasksHistoryPage 文案
- [ ] 审查 + qa + commit

### Phase 4 长任务异步化
- [ ] 基建：jobs 表迁移 v20 + 串行 runner + COLLECTOR_ASR_BASE_URL / COLLECTOR_BILI_COOKIE_FILE env
- [ ] server：POST /api/jobs（asr-backfill / collect-find）+ GET /api/jobs(/:id)
- [ ] web：ASR 卡（TranslatePage）+ find 条件面板 + JobProgress 组件
- [ ] 审查 + qa + commit

### 文档收尾
- [ ] docs/help/ 新页（检索/补翻/批量打标/导出与 bundle/ASR/server 状态）+ 受影响页更新
- [ ] README Feature 列表同步
- [ ] docs/plans/cli-completeness.md 反向登记（douyin 博主批量无 CLI、discover 豁免）

## 待处理风险
- web agent 中间态台账 FAIL：SubSearchPage/TranslatePage complexity 20（>15 新文件必须达标）、api.ts 434→545 行（存量不得恶化）——审查 Phase 1 web 时必须解决（拆组件/拆 api 模块）
- Phase 1 web agent 完成后:检查其 api.ts 是否拆分,未拆则要求拆（api/ 目录分模块或留 434 上限内）
