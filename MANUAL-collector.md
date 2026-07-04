# 媒体字幕采集库 — 真实 Chrome 验收清单

> 登录态已在你的 Chrome 里，无需 puppeteer mock。

## 前置

1. 启动服务端：`cd apps/collector-server && pnpm dev`
   - 应看到 `[collector-server] listening on http://127.0.0.1:21527 (ws: /ext, api: /api/*)`
2. 构建 web（首次或 web 改动后）：`pnpm --filter @bilibili-ext/collector-web build`
3. 加载扩展：`bash scripts/load-collector-extension.sh`，按提示在 chrome://extensions/ 加载

## 可选：mock 回归（verify-collector.mjs）

`pnpm test:ext`（或 `node scripts/verify-collector.mjs`）：用 puppeteer mock 验证扩展的 subtitle_url 四情况 + navigate + operate 命令。**需要 headed Chrome 环境**（headless 模式不加载 MV3 扩展）。失败时按 `[mock-server]` 日志排查 WS 握手。

自动化单元测试走 `pnpm test`（= turbo run test，跑 collector-server 11 个 node:test）。

## 验收项（对应 spec §10）

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开 `https://www.bilibili.com/video/BV1mhjg6SEJy`（info/ 里的样本） | 扩展 popup 显示 "已连接 ✓" |
| 2 | 点开视频字幕按钮（中文字幕） | popup "上报统计" 显示新增轨数；服务端控制台看到 ingest-ack |
| 3 | 访问 `http://127.0.0.1:21527/api/videos` | JSON 列表包含 BV1mhjg6SEJy，标题正确 |
| 4 | 浏览器打开 `http://127.0.0.1:21527/` | 列表页显示该视频 |
| 5 | 点进详情 | 轨切换器 + 时间轴逐行 + 默认轨高亮 |
| 6 | 切换轨/版本 | 内容正确切换；默认轨带"默认"标记 |
| 7 | 复制按钮 | 复制成功 |
| 8 | 关闭服务端（Ctrl+C）后再访问视频页 | popup 变 "未连接 ✗"，无控制台 ERR 噪声 |
| 9 | 重新启动服务端 | popup 自动恢复 "已连接 ✓"（指数退避重连） |
| 10 | 同视频再访问一次 | 服务端不重复入库（version skipped）；title 没变则 change_log 不增加 |
| 11 | 打开**已采集过**的视频页，点扩展 popup | "已收集"区域显示：上次收集时间、字幕轨数、分区、播放/点赞/投币/收藏/转发/弹幕数、标签 |
| 12 | 打开**未采集过**的视频页，点 popup | "已收集"显示"未收集（在视频页打开字幕后会自动采集）" |
| 13 | 关掉服务端后点 popup | "已收集"显示"服务端未运行，无法查询已收集数据" |
| 14 | 已采集视频再访问（仅 stat 数字变化） | 服务端 extra.stat 更新为最新值，但 change_log 不增加（stat 波动不记变更） |

## 服务端命令（排查）

```bash
# 看 db 状态
sqlite3 apps/collector-server/bilibili-collector.db "SELECT * FROM videos; SELECT * FROM change_log ORDER BY id DESC LIMIT 5;"

# 看连接状态
curl -s http://127.0.0.1:21527/api/videos | jq

# 重置 db（开发期）
rm apps/collector-server/bilibili-collector.db
```

## 已知限制

- B 站部分视频 `need_login_subtitle=true`，需确认你在 Chrome 已登录 B 站
- subtitle_url 为空时扩展不发 ingest；这类视频不会入库（正确行为）

## 测试轮次记录表

| 轮次 | 日期 | 结果 | 备注 |
|------|------|------|------|
| R1 | _待填_ | _待填_ | 首次端到端验收 |
