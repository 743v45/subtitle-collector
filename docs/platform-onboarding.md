# 新平台接入清单（开发手册）

> 面向开发者的一页 checklist：给 subtitle-collector + collector-server 接入第 N 个视频平台。
> 首个完整验证案例 = **douyin**（2026-08-29，[DOUYIN-PROGRESS.md](../DOUYIN-PROGRESS.md)），所有参照实例均指它。
> 模式：**每平台一套四件套，复制-改造**（决策记录见 §6，抽象 adapter 待第四平台落地后再评估）。
> 措辞红线：本项目是字幕（subtitle）系统，严禁写成弹幕。改动涉扩展的提交 bump [manifest.json](../apps/subtitle-collector/manifest.json) `version`（项目 CLAUDE.md §7）。

## 0. 前置调研（写代码之前）

- [ ] **页面取数机制 spike**：目标平台的视频详情/列表接口是否带页面签名（决定 server 可直连还是必须扩展页面上下文取数）。douyin 实测结论：接口带全套签名（a_bogus/msToken），server 不可直连 → 后台 tab 导航 + MAIN world hook 是唯一正路（R1 定案，[DOUYIN-PROGRESS.md](../DOUYIN-PROGRESS.md) T1）。spike 结论落 `docs/plans/<platform>/`（含原始样例 fixture，douyin 先例 `_spike-raw/`）。
- [ ] **GPL/许可证红线**：禁止移植 GPL 签名代码（douyin 的 abogus.py GPL v3，TS 重写也算衍生，R1 否决项）。
- [ ] **ID 与 URL 形态盘点**：视频 ID 正则、URL 形态全集（douyin 四形态：`/video/<id>`、`?modal_id=`、`/note/<id>` 图集、`v.douyin.com` 短链）、博主/频道标识形态（douyin sec_uid `^MS4wLjAB` 前缀）。
- [ ] **范围定案（「明确不做」清单）**：同期明确砍掉什么并记录（douyin R3：搜索/话题采集、图集、直播、登录徽章均范围外，图集采集回执 `reason='not_video'`）。

## 1. 扩展侧四件套

- [ ] **`inject-<p>.js`（MAIN world，document_start）**：hook fetch/XHR + 轮询全局变量兜底，独立文件 + 独立消息源标记。参照 [inject-dy.js](../apps/subtitle-collector/inject-dy.js)：`MSG_SOURCE = 'dy-sub-ext'`（[L28](../apps/subtitle-collector/inject-dy.js#L28)），按 URL 子串拦截（detail/post/profile 三类，[L36-44](../apps/subtitle-collector/inject-dy.js#L36)），非目标请求零处理直透；SSR 数据（`SSR_RENDER_DATA`）轮询兜底（`MAX_POLLS` 40×500ms）。异常响应一等公民化（`POST_LIST_EMPTY` 200 空体、`PROFILE_OTHER_ERROR` 200+错误码——静默丢弃会伪装成「0 作品」）。
- [ ] **`content-<p>.js`（ISOLATED world，document_start）**：聚合 inject 消息、响应 background/popup 查询。参照 [content-dy.js](../apps/subtitle-collector/content-dy.js)：detail 幂等覆盖（[L20-27](../apps/subtitle-collector/content-dy.js#L20)）、博主批量聚合状态机 + 环形缓冲重放防 content-script 就绪竞态（[L39-46](../apps/subtitle-collector/content-dy.js#L39)）、滚动驱动翻页（后台 tab 定时器节流 ~1s 兼容）。注意平台语义差异：douyin 不发被动 INGEST（主动采集语义全在 background）；B 站/YouTube 被动链照旧。
- [ ] **`<p>-format.mjs`（纯函数归一，node:test 可测）**：平台原始形态 → 统一中间形态，零 `chrome.*` 依赖。参照 [douyin-format.mjs](../apps/subtitle-collector/douyin-format.mjs)：SSR camelCase → snake_case aweme_detail（[ssrVideoDetailToAwemeDetail L17](../apps/subtitle-collector/douyin-format.mjs#L17)），缺字段容忍缺省不抛错。复杂度超标时拆子映射函数（S8 先例：拆 6 个子映射）。
- [ ] **`<p>-payload.js`（ingest payload 组装）**：**结构对齐优于新键**——extra/stat/合集/话题键名对齐 B 站先例，server/web 排序筛选零改动复用（douyin R5 定案：`stat` 键名完全对齐、合集存 `ugc_season` 同键名、话题存 `tags` 同构）。参照 [douyin-payload.js](../apps/subtitle-collector/douyin-payload.js)（头部注释即字段口径表）；单位归一写明（duration ms→s、create_time s→ms、music id 走字符串防精度）。
- [ ] **manifest.json 注册**：`content_scripts` 每平台两条（MAIN inject + ISOLATED content，`run_at: document_start`）+ `host_permissions`。参照 [manifest.json L72-92](../apps/subtitle-collector/manifest.json#L72)（`www.douyin.com` + `www.iesdouyin.com` 分享域）。边缘域名（apex/m. 短域）评估过可不加（douyin 遗留清单⑤）。
- [ ] **（如走导航采集）background 编排独立模块**：`<p>-navigate.mjs` 承载「校验/防重/开 tab/轮询/回执」，依赖经 env 注入（`extLog/sendIngest/inFlightCollects/canDispatch/sendUpper`）。参照 [dy-navigate.mjs](../apps/subtitle-collector/dy-navigate.mjs)（S8 从 background.js 抽出，台账性重构）；超时用无进展窗口语义（窗口可随 `timeout_ms` 下发，超时文案前缀要与 server 迟到改判的 LIKE 匹配对齐——douyin 用「抖音 采集超时（」，见 [amend.ts L58](../apps/collector-server/src/tasks/amend.ts#L58)，**措辞是协议，勿改**）。

## 2. background 接线

- [ ] **action 注册**：在 [background.js](../apps/subtitle-collector/background.js) 命令派发链加 `fetch-<p>-subtitle` / `expand-<p>-upper` 等分支（douyin 分支 [L734](../apps/subtitle-collector/background.js#L734)，直接转发 `<p>-navigate.mjs` 的 `handleCommand`）。
- [ ] **仅上报状态防御**：任务型 action 开头查 `taskDispatchEnabled`（先例 [background.js L595-600](../apps/subtitle-collector/background.js#L595)），拒绝文案指向开关而非重试。
- [ ] **同视频防重**：`inFlightCollects` 按 `<source>:<vid>` 键去重（先例 [background.js L601-606](../apps/subtitle-collector/background.js#L601)）。
- [ ] **navigate 互斥（共用门闸）**：新平台的导航采集接入 [nav-gate.mjs](../apps/subtitle-collector/nav-gate.mjs) 的同一把锁（三采集器互斥 + 关闭间隔节流防风控，间隔 `nav_gap_base_ms`/`nav_gap_random_ms` storage 可覆盖）。
- [ ] **任务回执字段约定**：回执 `data` 带平台 ID 键（`awemeId`/`videoId`…——server 靠参数键判平台，见 §3 amend）+ `captured/tracks/reason`；登录态字段（`login`）随回执上报用于 no_subtitle 判因（B 站先例，douyin 登录徽章范围外）。

## 3. server 侧（6 处）

- [ ] **Source 类型**：[source.ts](../apps/collector-server/src/tasks/source.ts) 加平台字面量（[L5](../apps/collector-server/src/tasks/source.ts#L5)）；独立最小模块不 import 任何东西（tasks 与 upper-expand 都要用，防 depcruise 成环）。
- [ ] **DB 约束 + 迁移**：[schema.sql](../apps/collector-server/src/db/schema.sql) `collect_tasks.source` CHECK 加平台（[L149](../apps/collector-server/src/db/schema.sql#L149)）+ **单事务表重建迁移**（SQLite 无法 ALTER CHECK；抄 v18 模板 [migrate.ts L247-266](../apps/collector-server/src/db/migrate.ts#L247)，中断回滚重放幂等，SQL 不引用被删列保新库全量重放安全）。配套 migrate.test 两用例：旧库升级存量完整 / 新库重放幂等 + 新平台可写。
- [ ] **URL/标识解析独立模块**：`<p>-url.ts` 承载 URL 归一、ID 正则、分享短链域、博主标识解析——**独立小文件防主文件台账恶化**（tasks.ts 台账超标的教训）。参照 [douyin-url.ts](../apps/collector-server/src/tasks/douyin-url.ts)：`DOUYIN_AWEME_ID_RE` 19 位（[L9](../apps/collector-server/src/tasks/douyin-url.ts#L9)）、`parseDouyinUrl` 多形态归一（[L29](../apps/collector-server/src/tasks/douyin-url.ts#L29)）、`parseDouyinSecUid`（[L51](../apps/collector-server/src/tasks/douyin-url.ts#L51)）。**sec_uid 等标识正则多端镜像**（server / 扩展 format / web upperTarget 三处互注镜像，改动须同步——douyin M3 审查项）。
- [ ] **任务派发 action 映射**：[tasks.ts](../apps/collector-server/src/tasks/tasks.ts) `dispatchPayload` 纯函数加平台分支（[L442-444](../apps/collector-server/src/tasks/tasks.ts#L442)）；`commandTimeoutMs` 超时档位（navigate 平台用窗口式：窗口 + 135s 回执预算，[L62-64](../apps/collector-server/src/tasks/tasks.ts#L62)）；批量建任务 VID 正则映射（[L209](../apps/collector-server/src/tasks/tasks.ts#L209)）；parseVideoUrl / expandShortLink 接入新平台域（[L153-156](../apps/collector-server/src/tasks/tasks.ts#L153)）。
- [ ] **HTTP 校验 / expand 分支**：[http/tasks.ts](../apps/collector-server/src/http/tasks.ts) 三处 source 白名单——任务列表过滤（[L51](../apps/collector-server/src/http/tasks.ts#L51)）、批量建任务（[L150](../apps/collector-server/src/http/tasks.ts#L150) + 400 文案里的 ID 形态说明 [L157](../apps/collector-server/src/http/tasks.ts#L157)）、`/api/upper-videos/expand` 平台分支（[L89-101](../apps/collector-server/src/http/tasks.ts#L89)，标识解析在 server 单点归一，web 只传原始输入；**双端请求体键名要有一致断言**——C1 事故：web 发 `channel`/server 只认 `sec_uid`，各自 mock 导致「按博主批量」必 400）。expand 逻辑在 [upper-expand.ts](../apps/collector-server/src/tasks/upper-expand.ts)（注意新文件复杂度 ≤15 红线）+ 版本感知派发门槛（`DOUYIN_EXPAND_MIN_VERSION` 先例，多机版本参差防护）。
- [ ] **ingest / 迟到回执**：payload 结构对齐 B 站则 [ingest.ts](../apps/collector-server/src/db/ingest.ts) 零改动复用（douyin 仅加 creators 增强 `fans←follower_count`/`verify→official_title`，[L140](../apps/collector-server/src/db/ingest.ts#L140)）；真正的平台分支在 [amend.ts](../apps/collector-server/src/tasks/amend.ts)——**参数键判平台**（`awemeId→douyin / videoId→youtube / bvid→bilibili`，[L31-34](../apps/collector-server/src/tasks/amend.ts#L31)）+ no-subtitle 打标 vid 取回执 ID 优先（短链展开会迁移 ID，旧 ID 打标落空，[L91-98](../apps/collector-server/src/tasks/amend.ts#L91)）。
- [ ] **超时设置键**：[settings.ts](../apps/collector-server/src/db/settings.ts) `collect_timeout_ms` 加平台键（[L47-48](../apps/collector-server/src/db/settings.ts#L47)，douyin 默认 45s 窗口式），web 设置页同步三键可调。
- [ ] **CLI**：`collect subtitle --source` 白名单 + action 映射（[collect.ts L123](../apps/collector-server/src/cli/commands/collect.ts#L123)、[L698](../apps/collector-server/src/cli/commands/collect.ts#L698)）；打标 vid 同样回执 ID 优先（[L706](../apps/collector-server/src/cli/commands/collect.ts#L706)，镜像 server 修法）。

## 4. popup 侧

- [ ] **平台卡（数据驱动，零结构改动）**：[platforms.ts](../apps/subtitle-collector/src/popup/platforms.ts) 加一个 `Platform` 记录——`logo`（simple-icons path，douyin 复用 TikTok logo [L80](../apps/subtitle-collector/src/popup/platforms.ts#L80)）、`hostPattern`、`extractVid`、`statFields`（[douyin 卡 L76-94](../apps/subtitle-collector/src/popup/platforms.ts#L76)），push 进 `PLATFORMS` 即完事；品牌色用 Tailwind 任意值类（`brandBgClass`）。
- [ ] **vid 提取纯函数**：`extract<P>Vid` 抽在 [vid-extract.mjs](../apps/subtitle-collector/vid-extract.mjs)（popup 与 node:test 共用同一份逻辑，[platforms.ts L1](../apps/subtitle-collector/src/popup/platforms.ts#L1) import 先例）。
- [ ] **平台机制差异如实标注**：douyin `view` 恒 0 照存 0（web 端通用展示行为不为单平台特判，[L87-88](../apps/subtitle-collector/src/popup/platforms.ts#L87)）；无对应图标的 stat 键 popup 不展示但数据照入库。

## 5. 测试与验收点位

- [ ] **纯函数测试**（扩展侧 `test/*.test.mjs`，import 源码不依赖 dist）：vid 提取（[vid-extract.test.mjs](../apps/subtitle-collector/test/vid-extract.test.mjs)）、format 归一（[douyin-format.test.mjs](../apps/subtitle-collector/test/douyin-format.test.mjs)）、payload 组装（[douyin-payload.test.mjs](../apps/subtitle-collector/test/douyin-payload.test.mjs)）、导航编排（[dy-navigate-upper.test.mjs](../apps/subtitle-collector/test/dy-navigate-upper.test.mjs)、异常路径 [dy-profile-error.test.mjs](../apps/subtitle-collector/test/dy-profile-error.test.mjs)）。fixture 取 spike 实测样例，不手造。
- [ ] **server 侧测试**：URL/标识解析（[douyin-url.test.ts](../apps/collector-server/src/tasks/douyin-url.test.ts)）、迁移两用例（[migrate.test.ts](../apps/collector-server/src/db/migrate.test.ts)）、派发映射/回执迁移（[tasks.test.ts](../apps/collector-server/src/tasks/tasks.test.ts)、[amend.test.ts](../apps/collector-server/src/tasks/amend.test.ts)）、ingest 幂等（ingest 路已有，加平台样本）；ASR 如接入则平台解析下载测试（[asr-douyin.test.ts](../apps/collector-server/src/cli/asr-douyin.test.ts) 先例）。
- [ ] **真接线断言**（跨端契约）：server↔扩展↔web 三端的请求/回执形状至少一处集成测试固定同一 JSON（C1 教训：双端各自 mock 无一致断言 = 契约断裂盲区）。
- [ ] **冒烟**：`pnpm test:ext`（puppeteer mock 扩展回归；douyin 接入时无新增专用冒烟用例，如实记录）；导航采集三入口手动冒烟（扩展载 Chrome 实跑）。
- [ ] **静态门**：`pnpm qa` 全绿；新文件复杂度 ≤15 / ≤400 行（`upper-expand.ts` complexity 18 被台账拦下的教训）；涉扩展改动 bump [manifest.json](../apps/subtitle-collector/manifest.json) `version`（当前 0.1.30），涉 android bump `versionCode`。
- [ ] **文档同步**（qa 门 `verify-skill-sync.mjs` 拦漂移）：[docs/skills/collector/SKILL.md](skills/collector/SKILL.md)、[docs/help/](help/INDEX.md) 相关页、[README.md](../README.md) Feature 列表与架构表/数据流图、[docs/architecture.html](architecture.html)。

## 6. 决策记录（为什么这么接）

- **复制-改造，不抽象平台 adapter**：三平台页面机制差异过大——B 站可后台直调 wbi API（扩展 cookie 持有登录态）、YouTube 靠 `ytInitialPlayerResponse` + timedtext（pot 是唯一坑）、抖音接口带全套页面签名只能页面上下文取数。强行抽象会把三套生命周期/就绪语义拧进一个接口。**触发重评条件：第四平台（小红书 logo 已预取 [platforms.ts L37](../apps/subtitle-collector/src/popup/platforms.ts#L37)，popup 结构已零改动兼容）落地时，按当时四套实现的重复度再定**。
- **结构对齐优于新键**（R5）：新平台 extra/stat/合集/话题键名对齐 B 站先例，server/web 全链零改动复用；新增键只允许 genuinely 平台特有字段（douyin 的 `play_uri`、`region`/`is_ads` 等）。
- **「明确不做」清单模式**：接入即声明范围外项并落进度文档（douyin：搜索/话题采集、图集、直播、登录徽章；图集走 `not_video` 显式回执而非静默失败），后续 grilling 迭代按遗留清单逐项决策修/不修。
- **server 不直连平台取数**（expand 注释定案）：无浏览器 cookie/wbi 环境且数据中心 IP 易风控，列表/详情一律复用扩展 action 代理（例外：ASR backfill 的平台直链下载，该链路本就 server 侧、不走扩展）。

## 测试轮次记录表

| 轮次 | 命令 / 操作 | 结果 |
|---|---|---|
| 1 | 本文档为纯 checklist，随 douyin 接入（DOUYIN-PROGRESS R1-R6）实测流程整理 | 待随首次按单接入新平台回填 |
