# 主动采集 / 服务端控制中心 —— 设计探索笔记

> 日期：2026-06-23
> 状态：**探索中（未定稿），主架构已收敛** —— brainstorming 思路沉淀。架构岔路已收敛到 **D（AI 作纯决策者 + 复用被动采集链路）**，采集终端定为复用现有扩展；剩 MCP 工具粒度 + 采集完成判定两小点待拍。
> 关联：[2026-06-20-media-subtitle-collector-design.md](./2026-06-20-media-subtitle-collector-design.md) §4（任务调度层预留）、§9（批量采集推迟）

---

## 背景：为什么有这份笔记

被动采集 MVP 已跑通（浏览 B 站视频页即自动入库）。下一阶段的核心诉求（用户原话）：

> "在服务端控制需求，能让 AI 去搜索需要的内容，控制速度，然后搜集到数据。"

即：**把 collector-server 从"被动接收器"升级成"采集大脑/控制中心"**——
服务端表达需求 → 自己拉视频列表 → 控制采集速度 → 驱动采集终端逐个采集入库 → 进度可见。

这正是旧 spec §4 预留的"任务调度层" + §9 推迟的"批量/AI 命令采集"。

---

## 已确认的约束 / 起点

1. **服务端做控制中心** —— 调度逻辑放在 collector-server，不在扩展。
2. **要能控制速度** —— 限速是核心需求（防风控、防开一堆 tab）。
3. **要支持"AI 搜索需求"** —— 但 AI 的具体角色/接入方式待定（见下）。
4. **不动现有被动采集链路** —— 浏览即入库已可用，主动采集是叠加能力。
5. **现有 WS 命令通道已预留** —— `navigate` / `operate` / `fetch-subtitle` 三个 Command 在 spec §6.2/§7.3 预留，background.js 已实现 navigate/operate 骨架，fetch-subtitle 是占位。

---

## 当前实现现状（截至 2026-06-23）

| 组件 | 状态 |
|---|---|
| 被动采集（inject→content→background→ingest） | ✅ 跑通，浏览即入库 |
| 服务端 WS（hello/ingest/ingest-ack/log） | ✅ 跑通 |
| 服务端 HTTP 查询（/api/videos 等） | ✅ 跑通 |
| collector-web 列表/详情 | ✅ 跑通 |
| **任务调度层** | ❌ 不存在（spec §4 预留，未实现） |
| `navigate` Command | ⚠️ background 已实现 `chrome.tabs.create`，但服务端**没有调度器去下发**它 |
| `operate` Command | ⚠️ content.js 已实现 click-subtitle-toggle + 观察窗口，但服务端没有调用方 |
| `fetch-subtitle` Command | ❌ 占位（返回 not implemented） |
| popup "当前视频/上报" 两行 | ❌ 空壳，popup.js 没给 DOM 赋值 |
| popup "手动补采"按钮 | ⚠️ 能点但无反馈；依赖 `collected` Map 已有数据，错过加载时机则无效 |

---

## 核心架构岔路（**已收敛 → 推荐 D**）

> **2026-06-23 更新：** 用户提出更轻的方案（"像 skill 一样让 AI 控制；MCP 的 AI 只负责打开浏览器，被动采集自动收"），比原 A/B/C 都优。提升为推荐路线，记为 **D**。原 A/B/C 保留在下作对照。

### D. AI 作纯决策者 + 复用被动采集链路 —— **推荐**

**核心洞察：把"采集"降级成"打开页面"。** 被动采集引擎已跑通——页面一旦打开，inject hook 自动拦 player API + 字幕体并入库。所以 AI 只要"决定打开哪些页面 + 调一个 open 工具"，剩下全交给现有链路。

```
AI (MCP 调用方)
  │ open_bilibili_video(bvid)
  ▼
服务端 ──navigate Command──> 扩展 (chrome.tabs.create)
                                 │
           现有被动采集链路自动触发  │ (inject hook → content → background → ingest)
                                 ▼
AI <──采集结果── 服务端 <──ingest-ack── 扩展
```

**AI 只做一件事：决定打开哪些页面。** 一旦打开，现有 inject→content→background→ingest 链路自动收字幕。AI 不碰字幕、不碰 hook、不碰采集逻辑。

**为什么这个方案最优（相对 A/B/C）：**

| | D（推荐） | A 结构化任务API | B AI Agent循环 |
|---|---|---|---|
| 服务端要造的东西 | pending Map + MCP 工具 | 调度器+任务表+限速+进度 | A + LLM 调用/对话状态/幻觉处理 |
| 谁调度 | AI（天然知道一次开几个、等不等） | 服务端硬编码 | AI |
| 速度控制 | AI 在循环里控（开一个→等→再开 / 并行） | 限速参数 | 同 D |
| 改动量 | 最小 | 中 | 大 |

- **D 不需要调度器/任务表**：AI 自己就是调度器。我原推荐的"结构化任务 API + 服务端调度器"那一大坨可以不要。
- **速度控制天然在 AI 手里**：比硬编码限速灵活。
- **服务端改动最小**：navigate Command background 已实现（[background.js:43-45](apps/subtitle-collector/background.js#L43-L45)），被动采集已跑通。缺的只有两块半（见下）。

**D 方案下要补的最小清单：**

1. **服务端 `result` pending Map**（[server.ts:66-69](apps/collector-server/src/ws/server.ts#L66-L69) 现在只 `console.log`）—— MCP 工具下发 navigate 后要能等扩展回 `result`，需按 `id` 匹配的 pending Promise。
2. **MCP server**（新增，或独立包 `apps/collector-mcp`）—— 暴露工具给 AI。核心工具 `open_bilibili_video(bvid/url)`；可选 `search_bilibili(keyword)`（拉候选给 AI 选）、`list_collected(q)`（查已采的，去重判断）。**工具粒度待定**（见下）。
3. **"采集完成"判定**（半块）—— navigate 成功 ≠ 字幕已入库（inject 是异步拦的）。两种做法：
   - **简单**：navigate 回执后等固定 N 秒，查库该 bvid 在不在 → 返回结果给 AI
   - **精确**：服务端记"刚 navigate 了 bvid X"，收到该 bvid 的 `ingest-ack` 时关联唤醒

---

### 原 A/B/C（保留对照，不再是首选）

### A. 结构化任务 API（服务端调度器 + AI 作外部调用方）

- 服务端新增 `/api/tasks`（任务类型：keyword / upper / list / 时间段）+ 内置**调度器**。
- 调度器：拉视频列表 → 限速下发 navigate 给采集终端 → 收 ingest → 更新进度 → 失败重试/跳过。
- **比 D 重**：需要设计调度器/任务表/限速策略。D 把这些职责交还给 AI。

### B. AI Agent 对话循环（服务端内置 LLM 决策）

- 服务端跑对话循环 + 内置 LLM 调用。
- **比 D 重**：LLM 成本/幻觉/超时与采集逻辑耦合。D 让 AI 在外部决策，服务端只做"被调用的工具"，不内置 LLM。

### C. 先手走通再定（脚本实验驱动）

- 写脚本手走一遍记录痛点。D 的清单已足够小，可直接实现，不必先探路。

**结论：原"A 是 B 前置依赖"的判断被 D 推翻**——D 让 AI 直接复用被动采集链路，跳过了 A 的调度器，反而成了 A/B 的更轻前置。

---

## 采集终端是谁 —— **已定：复用现有扩展**

D 方案的逻辑必然指向"复用现有扩展"：既然核心是"打开页面让被动采集自动跑"，最自然的终端就是已带登录态、已跑通 hook 的现有 subtitle-collector 扩展。

- AI（MCP）→ 服务端 → navigate Command → 扩展在你当前 Chrome `chrome.tabs.create` 开页
- 页面一开，inject hook 自动拦 → ingest 入库
- 采集完 tab 可自动关（navigate result 后 `chrome.tabs.remove`，减打扰）

代价：批量时会在当前浏览器开 tab（可控，采完关）。headless / 直调 API 两条路 D 下不需要。

---

## D 方案下还需敲定的点（恢复 brainstorming 时过）

- **MCP 工具粒度**（待拍）：
  - 单工具 `open_bilibili_video(bvid)` —— AI 自己用 web search 能力搜 bvid，服务端最薄
  - 双工具 +`search_bilibili(keyword)` —— 服务端封装 B 站搜索（含 Wbi 签名坑），AI 只管决策
  - 多工具 +`list_collected(q)` —— AI 能先查"采过没"再决定，避免重复采集
- **采集完成判定**（待拍）：navigate 回执后等固定 N 秒查库 / 还是精确关联 `ingest-ack` 唤醒。
- **tab 生命周期**：采集完自动关（navigate result 后 `chrome.tabs.remove`），减打扰。
- **风控兜底**：AI 开页后若收到 RISK_CONTROL / NEED_LOGIN 信号，要能回报给 AI（MCP 工具结果带状态），让 AI 决定跳过/重试。
- **fetch-subtitle Command**：D 下大概率不需要（被动采集够用），spec §6.2 占位可长期搁置。
- **popup 空壳修复**（"当前视频/上报"两行 + 手动补采反馈）：偏 UX 收尾，与主动采集解耦，可单独做。

---

## 下一步

架构已收敛到 **D（AI 作纯决策者 + 复用被动采集链路）**，采集终端定为复用现有扩展。

等用户准备好开工时，从"MCP 工具粒度"+"采集完成判定"两个点拍板，即可把本笔记升级为正式 spec，再走 writing-plans 出实现计划。

---

> 本文件仅为思路沉淀，不入实现流程。被动采集 MVP 继续可用，不受影响。
