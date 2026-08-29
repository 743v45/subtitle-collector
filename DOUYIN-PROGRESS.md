# 抖音平台全量集成 — 进度与决策记录

> 本文件是 `/loop`(cron `*/20 * * * *`,job `20c97e90`)循环任务的**续作锚点**。
> **状态:全量已合并进 main(2736d6e + f77e4a1,2026-08-29),当前阶段=审查修复→grilling 迭代**。
> 开发期 worktree(.claude/worktrees/douyin)已完成使命删除;后续迭代直接在 main 做。
> 原始过程记录(调研三份+spike-findings)在 [docs/plans/douyin/](docs/plans/douyin/)。

## 已定决策(2026-08-29 用户授权「全按 Claude 推荐」)

1. **ASR 解耦**:fireredasr-ui 是独立项目,本仓库只经配置接 HTTP(默认 `http://127.0.0.1:5079`);缺能力去上游补码,不在本仓库内嵌。配置走 settings 表/env,对齐现有 asr backfill 注入点。
2. **开发方式**:worktree 分任务(subagent 并行/串行混合,文件域隔离防冲突)→ 合并 → 审查修复 → 再 grilling 迭代。
3. **参考项目**:`/Users/taevas/Code/opensource/Douyin_TikTok_Download_API`(数据类型全量挖掘,存进 server)。
4. 用户全局偏好已记忆:逻辑往代码层推动(所有可复用编排落 CLI/脚本/配置)。

## 调研结论沉淀

### fireredasr-ui(fireredasr-capability ✅ 2026-08-29)

- 接口:`POST /v1/audio/transcriptions`(同步)/ `POST /v1/tasks` + `GET /v1/tasks/{id}`(异步队列);multipart `file` 必填 + `model`(AED/LLM)+ `response_format`;`verbose_json` 返回 `{text, segments:[{id,start,end(秒),text}]}`(VAD 段级,单段≤30s,无词级)
- **视频容器直接上传零缺口**:内部 ffmpeg 抽 16k 音轨(mp4/mkv/webm 免预抽)→ 抖音链路「下载 mp4 → multipart 上传 → verbose_json → 自拼 cues」今天即通
- **URL 直投不存在,且不必补**:推荐消费端自下载再上传(抖音解析/UA/Referer 本来就是消费端能力域)→ 上游零改动,解耦成立。若未来确要 URL 直投:上游加 `url` form 参数 + 流式下载并入 `_enqueue`(dispatcher.py:110-128)+ requirements 加 requests
- 陷阱:`response_format=srt` 退化为纯文本(SRT 拼接没迁移)→ 消费端一律用 verbose_json 自拼;language/prompt 被忽略;无 auth(0.0.0.0+caddy 明文,内网自用);严格串行队列(批量走 /v1/tasks);worker 冷启动 ~30s;task_timeout=1800s 只限同步等待侧
- 缓存 sha256+model,TTL 1 天

## T1 grilling 定案(2026-08-29,6 轮自我拷问,全按 Claude 推荐;用户授权)

**R1 采集路径 → 扩展页面上下文(navigate 模式)**
- ✗ 移植 a_bogus 到 server:abogus.py 是 GPL v3,TS 重写也算衍生,传染
- ✗ 本地常驻 Douyin_TikTok_Download_API 服务:多养一个 Python 服务+10.5 个月未更新(签名时效)+与既有扩展架构重复
- ✗ content script 同源 fetch /aweme/v1/web/*:仍需页面签名环境(webmssdk),脆弱
- ✓ **`fetch-douyin-subtitle` {awemeId, timeout_ms} → 后台 tab 导航 douyin.com/video/<id> → inject-dy.js(MAIN world)读 SSR `_ROUTER_DATA`(loaderData→aweme_detail)+ hook XHR 兜底**(对齐 YouTube collectYoutubeViaNavigate + inject-yt ytInitialPlayerResponse 模式)——零签名移植、零 GPL、天然带用户 cookie。结构细节由 S1 spike 实测(chrome-devtools MCP 开真实页)
- 字幕:页面有智能字幕数据就拿(no_subtitle 之外的正轨),预期主路径是 ASR 兜底

**R2 ASR 视频获取 → server 直构直链下载,扩展代理兜底**
- 圈定对齐 B 站:`asr backfill --source douyin --tag no-subtitle`(asr.ts 平台化)
- 视频来源链:extra.play_uri(入库存)→ `https://aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0` 直构(server 侧带 UA/Referer 下载)→ 失败降级 playwm→play 重解析(需扩展在线,WS 代理)→ 再失败标注跳过。S4 spike 实测第一链
- mp4 直接 multipart 上传 fireredasr(内部 ffmpeg 抽音轨);verbose_json→segmentsToCues;engine='fireredasr-aed-l'。fireredasr 上游零改动

**R3 范围(全套=对齐两平台现有能力面)**
- ✅ 单视频采集(分享短链/URL/popup 三入口)、博主批量(expandUpperVideos douyin 分支;扩展端 max_cursor 游标翻页聚合成一次回传,server 不感知游标)、web 全展示、ASR backfill、CLI、skill/help/README 同步
- ✂️ 搜索/话题采集(参考项目也无实现)、图集(aweme_type≠0:批量列表过滤;单视频采集回执 reason='not_video'→failed)、直播、dy_login 登录徽章(远期)

**R4 任务/超时/迁移**
- navigate 模式 → commandTimeoutMs douyin 档对齐 youtube 窗口式;settings CollectTimeoutMs 加 douyin 键
- collect_tasks.source CHECK → **v18 表重建迁移**(抄 v9 模板)+ schema.sql 双轨
- amend.ts 迟到回执判据:params.awemeId != null → douyin

**R5 extra 结构对齐(结构对齐优于新键)**
- `stat` 键名完全对齐 B 站(view←play_count、like←digg_count、reply←comment_count、share、favorite←collect_count)→ 排序/筛选/统计列/索引零改动复用
- 合集存 `ugc_season:{id:mix_id,title:mix_desc}`(同键名!)→ season 档标签/enrich/展示零改动复用
- 话题存 `tags:[{tag_id:hashtag_id,tag_name:hashtag_name}]`(对齐 B 站 tags)→ bili 档标签筛选复用;S5 顺手把 web「标签档位=B站」文案改「平台自带」(同步测试)
- `play_uri` 存稳定 video_id;duration 毫秒→秒;create_time unix 秒;creators.source_uid=sec_uid

**R6 派发顺序(subagent,文件域隔离)**
- **S1 spike(先行)**:chrome-devtools 实测抖音页(_ROUTER_DATA 结构/匿名可达/XHR/拿真实 play_uri)→ 写 docs/plans/douyin/spike-findings.md
- **S2 server 平台化(与 S1 并行)**:Source 类型/URL 三件套/v18/settings/http 白名单/amend/派发映射/CLI 类型
- S3 扩展端(依赖 S1)/ S4 ASR douyin 化(依赖 S1 play_uri+S2 类型)/ S5 web(依赖 S2)并行
- S6 收口:android 同步+skill/help/README+qa 全绿+tsc+合并审查

## 任务分解(随 grilling 迭代更新)

- [x] T0 调研:三份报告落盘(docs/plans/douyin/research-{fireredasr,platform-map,douyin-api}.md)
- [x] T1 grilling 定案:6 轮,见上节
- [x] S1 spike:抖音页 _ROUTER/XHR/直链实测 → [spike-findings.md](docs/plans/douyin/spike-findings.md) ✅ 2026-08-29 完成(原始证据 `_spike-raw/`;核心:`_ROUTER_DATA` 已不存在,双形态 detail XHR+SSR 双路取数;uri 直构链裸 curl 即通;play_count 恒 0;post 匿名空体)
- [x] S2 server 平台化(✅ R3 完成:908/908 全绿、tsc 0 错、baseline PASS 且改善(tasks.ts 复杂度 30→20/行数 669→530)、depcruise/build 过;新增 tasks/source.ts+douyin-url.ts+upper-expand.ts;v18 单事务表重建(migrate.test 两用例:旧库升级存量完整+douyin 可写/重放幂等);settings 三键(douyin 默认 45s 窗口式,GET 逐项回落/set 缺键 400);dispatchPayload 纯函数三分派;amend awemeId 判据+「抖音 采集超时(」前缀;批量 source 不再吞 douyin。S5 曾报的 upper-expand/collect 台账失败系 S2 中间态,最终报告已达标)

## 审查待办(收口前必查)

1. ~~S2 静态台账 2 项失败~~ ✅ S2 最终 baseline PASS(中间态自愈,收口时复跑确认)
2. **ID 正则口径记录**:server 锁 `^\d{19}$`(douyin-url.ts),android 预解析不锁(`\d+`)——设计上 android 宽松预解析+server 权威判定(400 可见),一致;历史短 ID 在 web 端基本不可达,可接受。URL 提取形态(server parseDouyinUrl)与 android 同为三形态归一。
3. **S3 与 S2 协议核对**(S2 已定契约:action 'fetch-douyin-subtitle' params {awemeId, timeout_ms(45s 默认,settings 可配,server 预算=窗口+135s)};回执 data 带 awemeId+captured/tracks/reason(no_subtitle/not_video);超时文案前缀「抖音 采集超时(Ns)」;博主列表 POST /api/upper-videos/expand {source:'douyin', sec_uid} sec_uid 或主页链接均可,一次全量回传对齐 youtube;VID 19 位)——S3 汇报后逐项对照。
4. ~~web SettingsPage 两键 PUT 会 400~~ ✅ **R4 主会话直接修复**(agent 通道熔断,按最小成本原则:api.ts/getCollectTimeout/setCollectTimeout 三键 + SettingsPage 抖音档(窗口式对齐 YouTube)+ 测试三键断言,50/50 过)。

## 事故记录

- **2026-08-29 18:25(UTC) API 网关故障**:S3/S4/S7 三 agent 同时被 503(所有供应商熔断)/429(5h 限额,04:18 本地重置)打掉。教训:**4 agent 并发可能打爆网关——恢复后一律串行(≤1 agent 并行)**。恢复方式:SendMessage 唤醒(上下文保留、落盘文件无丢失)。S3 已唤醒续作(R4);S4 已大量落地(asr-douyin.ts/asr.ts/asr-net.ts/测试已改),等 S3 完成后唤醒收尾。
- [x] S3 扩展端(✅ R4 完成:316/316 全绿+覆盖率达标+build ✓;manifest 0.1.23→0.1.24;新增 douyin-format.mjs(SSR camelCase→snake/字幕多形态容错/空体判未登录)+douyin-payload.js(R5 全对齐,music id_str 防精度,create_time×1000 对齐 B 站)+inject-dy(三类 URL hook+SSR 轮询)+content-dy(聚合/GET_DETAIL/博主滚动翻页状态机);fixture 取自 _spike-raw 实测样例;被动 INGEST 不做——主动采集语义全在 background,976/990 无需动)
- [x] S4 ASR douyin 化(✅ R4 完成:912/912 全绿+tsc 绿+覆盖率四指标过线;asr-douyin.ts 新文件达标(直构/500MB 双防线/403 退避复用/失败清残留);asr.ts --source 参数化(douyin 走详情取 play_uri→下载→上传全链,dry-run 支持零触网);douyin 失败分类 12 项;**顺带件 not_video→failed 映射已做**(+镜像测试,dispatchTask 复杂度 19→20 仍在改善侧))
- [x] S8 代码收尾(✅ R5 完成:**pnpm qa 全绿**。①博主列表接线 expandDouyinUpperVideos(reqCmd 180s,channel_id 映射,creators 走扩展 ingest-upper)+真接线测试;②扩展侧台账 8 项全修且反超——douyin-format 拆 6 子映射+新增 extractDouyinUpperKey(博主页 URL→sec_uid 单点)、douyin-payload 拆 5 片段、content-dy 拆消息链、**background.js 抽 dy-navigate.mjs(316 行 navigate/expand 编排)+nav-gate.mjs(三采集器锁+节流共享)+format.mjs(cmdError)**、hooks.ts 拆 hooks-upper.ts(920→658 行);manifest 0.1.24→0.1.25;③五门禁盘点全绿(913/371/318/gradle/depcruise 307 模块);④顺手修 S5 的 vitest toBe 两参类型错。注意:ESLint complexity 每 `?.` 链计 +1)
- [x] S6b 文档收口(✅ R6 完成:skill 同步四点——asr backfill --source douyin(直构直链/500MB/新失败分类/dry-run)+collect subtitle --source douyin(navigate 语义/19 位 aweme_id/图集 not_video)+博主批量(web/HTTP expand,sec_uid 裸值或主页链接,无 CLI)+超时三平台分档(bilibili 预算式 90s,youtube/douyin 窗口式 45s+135s 联动);help 七页——采集单个视频(抖音链接四形态表+popup 行为)、批量 UP(抖音博主入口)、无字幕处理(douyin ASR 链路+500MB+失败分类+路线表)、检索/导出(--source douyin)、采集模型(五入口+超时分档)、手机采集(抖音分享)、排错(抖音超时+需登录)、INDEX 五入口;README——Feature ✅ 抖音全量条目(含 2026-08-29 用户现场指令解冻注记)+ASR 条目扩 douyin+架构表/数据流三平台+android 分享抖音;台账 update --write(17 改善+3 达标消失,39 超标文件,check PASS);hooks-collected tsc 基线错修复;.gitignore `data/` 根因修复;pnpm qa 全绿)
- [x] S6b 收口:skill/help/README、pnpm qa、台账固化 ✅(合并/真机验证归主线,见「下一步」)

## 收口接线清单(S8/S6b 状态——全部终态)

1. ~~博主列表接线~~ ✅ S8 完成(expandDouyinUpperVideos + http sec_uid 归一 + 扩展滚动翻页状态机,真接线测试过)
2. ~~not_video 语义~~ ✅ S4 已做(reason='not_video'→failed,error='图文/图集,无视频轨',+镜像测试)
3. ~~hooks-collected.ts 基线既有 tsc 报错~~ ✅ S6b 已修(基线既有非 douyin 引入:TS 推断 JS 解构参数只认默认值,onRefresh 被丢出类型;[collected-refresh.mjs](apps/subtitle-collector/collected-refresh.mjs) 补 `@param` JSDoc 纯注释修复,扩展 tsc --noEmit 0 错 + 318/318 测试绿;错误来自手动 `tsc --noEmit`(扩展无 tsc 门),qa 不受影响)
4. 合并前真机验证(扩展载入 Chrome 实跑 douyin + 主 checkout pnpm test:ext)→ **唯一遗留,主线执行**(S6b 后、合并前)
5. ~~S3 遗漏的扩展侧静态台账~~ ✅ S8 全修反超(douyin-format/douyin-payload/content-dy 拆分达标、background 抽 dy-navigate/nav-gate/format、hooks.ts 拆 hooks-upper);skill 同步(asr backfill --source douyin / collect subtitle --source douyin / 博主批量 / 超时三键)/help(采集单个视频·抖音链接形态四表、批量 UP·抖音博主、无字幕处理·douyin ASR、排错·抖音超时与需登录、采集模型·五入口、手机采集·抖音分享)/README(Feature ✅ 抖音条目+冻结解冻注记、架构表、数据流图) ✅ S6b 完成
- [x] S5 web(✅ R3 完成:vitest 371/371 全绿+覆盖率达标+tsc/build/depcruise 过;台账 7 项恶化全部偿还**反超**(api 435→434、VideoList 605→533 等,S6b 可 update --write 固化);档位文案「B站」→「平台自带」全端同步;CollectPage 认 sec_uid/博主页链接;新增 lib/platformSource.ts/upperTarget.ts/TagMultiSelect 共享件;vite.config testTimeout=15s 防并行 flake)
- [x] S6a android ShareTextParser 同步(✅ R2 完成:双域识别+短链透传+6 测试+detekt 全绿;versionCode 1→2;平台徽章红 0xFFFE2C55)
- [x] S6b 收口(✅ R6 完成,明细见下方进度日志 R6):skill/help/README 同步、台账 update --write 固化(17 改善+3 达标消失,39 超标文件,check PASS)、hooks-collected tsc 修复、.gitignore `data/` 吞 android 包根因修复、pnpm qa 全绿

## 审查待办(收口前必查)

1. **S2 静态台账 2 项失败**(S5 跑 baseline 时发现,须 S2 或收口时修):`upper-expand.ts` 新文件 complexity=18(**新文件必须 ≤15**);`collect.ts` 1017→1023 恶化(存量不得恶化)。
2. S2 与 S6a host 集核对:android 侧是 www.douyin.com/iesdouyin.com/**www.iesdouyin.com**/v.douyin.com(短链透传),ID 正则不锁 19 位——server 侧对齐。
3. S3 与 S2 的协议一致性:action 名/params 键(awemeId)/回执字段/expand 返回形态——两边汇报后对照。

## 仓库级发现(收口必办)

1. ~~**main 的 android app 不可构建**~~ ✅ **S6b 已修根因**:非「漏提交」——.gitignore 裸 `data/` 模式吞任意深度同名目录,把 `apps/collector-android/app/.../data/{ApiClient,Models,Settings}.kt + data/ModelsTest.kt` 4 文件静默 ignore(9947d9f 的 `git add` 根本看不见它们)。已改锚定根 `/data/`(docker 挂载目录仍忽略),4 文件现可被 git 追踪——**合并提交 `git add -A` 即自然带上,合并即修复 main 构建**(勿再对 android data/ 路径用 add -f 绕)。
2. android 构建 env:`local.properties` 需从主 checkout 拷(gitignore);`JAVA_HOME=/opt/homebrew/opt/openjdk@21`(brew 默认 26,gradle 8.12 不认)。
3. S6a 的 host 集与 ID 正则约定:www.douyin.com / iesdouyin.com / **www.iesdouyin.com**(变体)/ v.douyin.com(短链透传不展开);aweme_id 正则 `\d+` 不锁 19 位;modal_id 归一、路径优先——server 侧 [douyin-url.ts](apps/collector-server/src/tasks/douyin-url.ts) host 集一致、ID 锁 19 位(设计:android 宽松预解析+server 权威判定),已核对一致。

## 进度日志

### 2026-08-29 R6(S6b 文档收口)
- ✅ skill 同步([SKILL.md](docs/skills/collector/SKILL.md)):asr backfill --source douyin(直构直链/零 cookie/500MB/missing_play_uri·video_too_large·detail_fetch_error/dry-run 先行)+collect subtitle --source douyin(navigate 语义/19 位 aweme_id/图集 not_video→failed)+博主批量(web/HTTP expand,sec_uid 裸值或主页链接,无 CLI)+超时三平台分档(settings 三键);frontmatter 触发词加抖音;verify-skill-sync 20 样例过
- ✅ help 十页([docs/help/](docs/help/INDEX.md)):采集单个视频(抖音链接四形态表+popup 行为)、批量 UP(抖音博主入口+HTTP 形态)、无字幕处理(douyin ASR 链路/500MB/失败分类/路线表)、检索/导出(--source douyin)、采集模型(五入口+超时分档)、手机采集(抖音分享+平台过滤)、排错(抖音窗口超时+博主需登录)、客户端派发(抖音无登录徽章注记)、INDEX 五入口
- ✅ README:Feature ✅ 抖音全量条目(含 2026-08-29 用户现场指令解冻冻结政策注记)+批量采集五入口+ASR 条目扩 douyin+无字幕标记三平台+外链三平台+架构表/数据流图+android 分享抖音
- ✅ 台账固化:`quality-baseline.mjs update --write`(17 改善+3 达标消失→39 超标文件,check PASS)
- ✅ hooks-collected.ts 基线 tsc 错修复(collected-refresh.mjs 补 @param JSDoc,纯注释零行为;扩展 tsc 0 错+318 测试绿)
- ✅ **.gitignore `data/` 根因修复**(仓库级发现 #1 的真因:裸模式吞 android data/ 包→锚定 `/data/`;4 文件现可被 git 追踪,合并 add -A 自然带上)
- ✅ pnpm qa 全绿(build 3/3+三端测试+baseline PASS+skill-sync+depcruise 307 模块)

### 2026-08-29 R1(loop 第一轮)
- ✅ cron 调度 + 记忆三条(douyin-asr-decoupling / push-logic-to-code-layer / prefer-subagent-delegation)+ 全局 CLAUDE.md 逻辑沉淀政策
- ✅ main 干净基线:筛选修复已提交(cbdee54)
- ✅ worktree `.claude/worktrees/douyin`(branch douyin-platform)+ pnpm install
- ✅ T0 三调研完成并落盘;T1 grilling 6 轮定案
- ✅ S1 spike 完成(2026-08-29,匿名态 7 页次实测,无封禁):`_ROUTER_DATA` 已不存在 → `/video/<id>` 走 detail XHR(snake_case aweme_detail 148 键,匿名可用)、`/jingxuan?modal_id=` 走 SSR `SSR_RENDER_DATA.app.videoDetail`(camelCase),**S3 双路都要**;直构链 `aweme.snssdk.com/aweme/v1/play/?video_id=<uri>&ratio=1080p&line=0` **裸 curl 即 206 mp4**(S4 主链成立,playwm→play 不需要);字幕判据 `is_subtitled`+`cla_info`(匿名全 0/null,ASR 主路径坐实);post 列表匿名 200 空体(扩展登录态无碍);**play_count web 端恒 0**(stat.view 存 0,S5 展示 —)
- ⏳ S2(server 平台化)+ S5(web)并行运行中

## 下一步(当前阶段:审查修复 → grilling 迭代)

1. ~~合并回 main~~ ✅ 2736d6e(抖音全量)+ f77e4a1(CLAUDE.md 链接修正),fast-forward;worktree/分支已清理
2. ~~CLAUDE.md §6 解冻注记~~ ✅ 主线已补(一次性解冻,不改变冻结政策本身)
3. **审查修复(进行中)**:review-douyin agent 双轴审查 cbdee54..f77e4a1(Spec:定案符合性/GPL 红线/协议一致性/迁移保数据;Standards:边界/竞态/安全/可观察性)——报告回来按严重度修复
4. **真机验证**(审查后):`pnpm test:ext` + 本地 server 起后 API 冒烟(v18 迁移在真库跑一次)+ fireredasr 健康检查 + 扩展载 Chrome 实跑 douyin(需用户环境配合的留说明)
5. **继续 grilling**:真机暴露的问题 + 下方遗留清单 → 下一轮迭代

## 进度日志(补充:2026-08-29 上午真机闭环阶段)

- ✅ **首采成功**(任务 3836 → 旧 ID 302 迁移到 7663873788873821476):视频元数据入库(stat 真实值 like 31589/share 9842/favorite 15106;play_uri;sec_uid 创作者)
- ✅ **字段增强+ID 迁移修复提交**(c976995,qa 全绿):web 详情页收藏/转发/回复三平台展示;extra 补 region/is_top/is_ads/video_quality/chapters/share_url;creator fans/verify→official_title(ingest 抽 upsertCreator,台账 52→40);ID 迁移两端修(扩展回执实际 ID+server markNoSubtitleForReceipt,**扩展需刷新到 0.1.26**)
- ✅ **fireredasr-ui 上游看门狗补码**(cd32bdd,35/35 测试绿):真实故障(220MB 任务 worker 挂死卡 processing>31min)触发用户预授权路径——worker 死亡通知 in-flight 失败/启动恢复重置残留 processing/看门狗超时强杀(task_timeout×1.5)/max_retries 注释为预留;服务已重启且三机制当场验证生效(重置 1 条→临时文件丢失明确报错,不再永久卡)
- ⏳ **ASR 转写重跑中**(bd4qcgsy6):220MB 重新上传+转写,预计 10-15 分钟——完成即验证 asr-zh 轨入库,抖音全链路闭环
- 生产部署:f77e4a1 时已部署;**c976995(server 侧 ID 修复)未部署**——下次部署带上

## 遗留清单(grilling 迭代输入)

- **API 限额耗尽(2026-08-29 05:35 本地)**:review-douyin 审查 agent 被 429 打掉,**10:00:56 重置**——重置后 SendMessage 唤醒 review-douyin 续作(上下文保留)。重置前不派新 agent。
- **真机验证部分完成(R6)**:`pnpm test:ext` 跑过——**「subtitle_url 四情况」在基线 cbdee54 同败**(临时 worktree 复跑,输出逐字一致)→ main 存量问题(该冒烟不进 qa,悄悄坏了),非抖音引入,记入 B 站被动链路旧账;其余用例(hook 三时机/navigate/ingest 首样本)均过。fireredasr :5079 健康(200)。
- **真机验证未做项**:①**部署**(docker rebuild 生产,含 v18 真库迁移——runMigrations 自动跑,有测试保障但属生产变更,留用户知情/指示;部署后跑 verify-deployed 与 `asr backfill --source douyin --dry-run` 真圈定);②扩展载 Chrome 实跑 douyin 三入口(需用户侧 chrome://extensions 刷新 0.1.25)。
- **CLI 链路真机验证 ✓(R7)**:`pnpm cli asr backfill --source douyin --dry-run` 命令解析/HTTP 请求形状正确(tags=no-subtitle&source=douyin&sort=first_seen);生产 server(旧码)401 鉴权层拦截→带 token 后 200 total:0(未部署无 douyin 数据,符合预期)。
- **popup「上报」按钮在抖音页是哑按钮**:MANUAL_CAPTURE 的 tab URL 过滤只含 bilibili/youtube([background.js](apps/subtitle-collector/background.js) MANUAL_CAPTURE 分支),抖音页点击 8s 后显示「失败」。抖音语义是任务式主动采集,按钮本不该出现——可改为抖音页隐藏该按钮或接入任务提交
- **douyin 博主批量无 CLI 命令**(web/HTTP 入口可用):若需要,按 `yt-videos` 形态补,同步登记 skill
- **hooks-upper.ts 的 douyin 博主页识别已就位但 popup 未消费**(useUpperEntry 识别 /user/<sec_uid>,Popup.tsx 无 douyin 卡):给 popup 补抖音博主卡的现成地基
- S3 未实测点清单(inject/字幕真实样本/博主页滚动翻页真机形态)在 spike-findings §6 与 S3 汇报——真机验证时逐项核
