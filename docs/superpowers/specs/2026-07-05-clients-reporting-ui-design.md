# Clients 页上报 UI 简化

## 1. 背景

collector-web 后台 `ClientsPage` 每个客户端卡片原本有 **3 处重复表达上报状态** + **1 个语义不清的按钮**：

| 位置 | 原文案 | 问题 |
|---|---|---|
| 副标题 | `版本 x · 上报：开/关` | 与徽章/按钮三处重复 |
| 状态徽章 | `上报中` / `已暂停` | 「上报中」像"正在传输"，实际只是 `reporting_enabled` 开关开着 |
| 主按钮 | `暂停上报` / `恢复上报` | 没点明是「自动上报」的开关 |
| 单次按钮 | `触发单次上报` | 不知所言 |

## 2. 决策

### 2.1 删除「触发单次上报」按钮

该按钮经 WS 下发 `collect-now`，操作的是**远程客户端当前激活的 B 站视频 tab**（[background.js:276-288](../../apps/subtitle-collector/background.js#L276)），`force:true` 绕过 `reporting_enabled` 开关。它在后台站不住脚：

- **盲触发**：后台只显示 `client_id/版本/reporting_enabled`（[types.ts:46-51](../../apps/collector-web/src/types.ts#L46)），管理员不知道客户端当前在看哪个视频；点了只回 `已触发`，连 result 里的 `bvid` 都没展示。
- **大概率失败**：客户端当前激活 tab 不是 B 站视频页就报错 `no active bilibili video tab`。
- **有更好替代**：① 扩展 popup 本地「手动上报」`MANUAL_CAPTURE`（[background.js:341-351](../../apps/subtitle-collector/background.js#L341)），用户自己知道在看啥；② `collector-cli` 命令行直接打开页面采集（[collect.ts](../../apps/collector-server/src/cli/commands/collect.ts)）。

故后台此按钮删除。

### 2.2 状态合并进唯一开关按钮（动作版）

删独立徽章 + 副标题的「·上报：开/关」。每张卡片只剩一个按钮，**文案=动作，颜色=状态**：

| 状态 | 按钮文案 | 颜色 | 图标(lucide) |
|---|---|---|---|
| `reporting_enabled=true`（运行中） | `暂停自动上报` | 绿 `emerald-600` | `Pause` |
| `reporting_enabled=false`（已暂停） | `恢复自动上报` | 灰 `outline` | `Play` |

副标题保留「版本 x」。

## 3. 改动范围

| 文件 | 改动 |
|---|---|
| `apps/collector-web/src/pages/ClientsPage.tsx` | 删 `collectNow`/`collectBusyId`/`collectMsg`/`COLLECT_OK_AUTO_CLEAR_MS`/`fetch` import/单次按钮/状态徽章/`collectMsg` 渲染块；副标题去「·上报：开/关」；主按钮换 variant+className+图标+文案 |
| `apps/subtitle-collector/background.js` | 删 `else if (msg.action === "collect-now")` 分支（原 L276-288）—— 按钮删除后失去唯一调用方，属本次更改造成的孤立代码；同步 [L301](../../apps/subtitle-collector/background.js#L301) INGEST force 日志 `collect-now`→`手动上报`（force 现仅由 popup 触发） |
| `apps/subtitle-collector/content.js` | 同步 [L137-138](../../apps/subtitle-collector/content.js#L137) 注释，去掉 `collect-now` 字样（`RE_AGG` 仍被 popup `MANUAL_CAPTURE` 使用，逻辑不动） |

**不动**：collector-server 的 `/api/clients/:id/command` 是通用命令转发端点，不专属 `collect-now`，保留。

## 4. 验收标准

1. `pnpm --filter collector-web build` 冒烟通过（项目对 collector-web 的测试要求）。
2. 视觉：运行态=绿色 `⏸ 暂停自动上报`、暂停态=灰色 `▶ 恢复自动上报`。
3. 功能：点击翻转 `reporting_enabled`，3s 刷新后按钮文案/颜色/图标正确切换。
4. 无残留：`grep -rn collect-now apps/collector-web apps/subtitle-collector` 为零。

## 5. 测试轮次记录表

| 轮次 | 内容 | 结果 |
|---|---|---|
| T1 | collector-web `vite build` 冒烟 | ✅ 通过（1.30s，1886 模块）；subtitle-collector build 同步通过、dist 已更新 |
| T2 | 实机：运行/暂停两态切换 | 待用户实机验证 |
