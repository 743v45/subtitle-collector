# 调研:本仓库 douyin 平台接入改动清单(2026-08-29,agent: repo-platform-map)

> 原文来自调研 agent 报告,落盘防上下文压缩丢失。行号基于 worktree 起点 cbdee54。

## 关键结论

1. **`videos.source`/`creators.source` 是自由 TEXT 无 CHECK**,ingest 不校验 source → douyin 视频入库**零 schema 改动**
2. 真正的硬墙:`collect_tasks.source` 的 CHECK 约束(schema.sql:149,SQLite 无法 ALTER CHECK,需 **v18 表重建迁移**,抄 v9 migrate.ts:106-131 模板,单事务)
3. 全链路 `'bilibili' | 'youtube'` TS 窄联合 + action 派发分支
4. 扩展 popup platforms.ts 数据驱动,LOGOS **已预取 tiktok SVG path**(douyin 同 logo),注册条目即可

## 1. source 枚举硬编码分布

### collector-server
- **DB**:schema.sql:149 CHECK(必迁);videos/creators 无 CHECK;settings.ts:43-84 CollectTimeoutMs 两键→加第三键
- **tasks.ts**(8 处窄联合:18/57/74/170/192/259/285/464):commandTimeoutMs:56(youtube 分档);extractVideoUrl:86 host 白名单(**加 v.douyin.com/iesdouyin.com**);expandShortLink:102;parseVideoUrl:112-138(**douyin /video/<id> + ID 正则**);VID_RE:185;urlFor:199;parseYtChannelArg/ExpandUpperQuery:238-260(博主批量平行分支);**派发 action 映射 615-620**(`bilibili→fetch-subtitle{bvid} / else→fetch-youtube-subtitle{videoId,timeout_ms}`→douyin 加 `fetch-douyin-subtitle`);回执 reason 判定 626-634 平台无关可复用
- **amend.ts**:25-27/67 迟到回执定位(params.videoId→youtube / params.bvid→bilibili→**douyin 加 id 键判据**);58 错误前缀 LIKE('YouTube 采集超时(' 同构文案)
- **http 层**:tasks.ts:49 列表 source 白名单;**tasks.ts:111 批量 body source 归一(douyin 会被吞成 bilibili,必改)**;118 错误文案;157-170 upper-videos 分支;80/83 粘贴解析文案;creators.ts:47 by-uid 路由正则加段;queries.ts:130/160 路由通用零改动;http/asr.ts source 自由 string、lan 固定 asr-zh(零改动);ws/server.ts:163-192 ingest 透传不校验 source(零改动)
- **db/ingest.ts**:98-99 tid→tname B 站专属(douyin 无 tid 自然跳过);68-83 mergeExtraTags B 站专属
- **CLI**:http.ts:91/105/119 platform 类型;collect.ts:119-123(action+params 映射)/694-721(--source 校验)/167,215,238,286,292,418,856,956(SQL 硬编码);tags.ts:63-64 isPlatform;translate.ts:218,236;**asr.ts:111,128 asrSubmit('bilibili') 与圈定 source 硬编码**;bundle.ts:228 vidLabel(BV/YT→加 DY);changes.ts:102/sub.ts:372/videos.ts:200 自由透传零改动

### collector-web
- types.ts:109 CollectTask.source;api.ts:144,189-193,210;PlatformSelect.tsx:17-19(共享下拉加项);PlatformIcon.tsx:6-8,17-19(SVG+色,douyin 黑);externalLinks.ts:5-15(videoUrl/creatorUrl);VideoList.tsx:173-174,541;TasksHistoryPage.tsx:250-251,84;四页 URL 白名单 CreatorsPage:38/TagsPage:48/StatsPage:53/ChangesLog:37;CollectPage.tsx:45-67 parseUpperTarget(博主标识);VideoDetail:202-267/CreatorDetail:176-178(B 站专属展示);ClientsPage:71-72 + ClientLoginBadge:44(登录徽章,可选)

### subtitle-collector 扩展
- popup/platforms.ts:30-39 LOGOS 含 tiktok;41-58/60-74 条目;77 PLATFORMS 数组→注册
- vid-extract.mjs:8-10 → 加 extractDouyinVid
- popup/hooks.ts:290(白名单才查 server);429-451(UP 页识别);types.ts:115;hooks-collected.ts:18;Popup.tsx:405-406
- manifest.json:15-24 host_permissions 已 `http://*/*` 全放行(不必加);**31-72 content_scripts matches 需加 douyin 域**

### collector-android(镜像)
- ShareTextParser.kt:10-29 host 白名单同步

## 2. 扩展采集链路(现有两平台形态)

- **bilibili 双通道**:被动(content_scripts 注入 inject.js MAIN world 拦 `api.bilibili.com/x/player` + `__INITIAL_STATE__` → content.js 聚合 → INGEST) / 主动(action `fetch-subtitle` {bvid} → background.js:600-706 纯 API 链:view→tags→player/wbi→AI 字幕→buildIngestPayload(ingest-payload.js:43)→sendIngest+回执;充电加密降级 collectViaNavigate:1149 开后台 tab 复用被动链路)
- **youtube 双通道**:被动(inject-yt.js 轮询 ytInitialPlayerResponse.captions → content-yt.js → buildYoutubePayload) / 主动(action `fetch-youtube-subtitle` {videoId,timeout_ms} → collectYoutubeViaNavigate:1209 后台 tab + GET_LOCAL_STATE 轮询 + 无进展超时 + 8s 宽限 → 回执)
- 未知 action 回 needs_update:true(background.js:920)
- **douyin 平行件**:douyin-payload.js(对齐 youtube-payload.js)+ content-dy.js(/视需 inject-dy.js——抖音 API 有签名,页面运行时路径更稳)+ background.js `fetch-douyin-subtitle` 分支(inFlightCollects key `douyin:<id>`;976/990 source 判断)+ manifest matches + platforms.ts 注册 + vid-extract

## 3. ingest 数据模型

- IngestRequest(ingest.ts:13-40):`{source, video:{source_vid,title,creator:{source_uid,name,avatar},extra,duration,published_at}, tracks:[{lan,lan_doc,track_type,versions:[{origin:'external'|'asr'|'manual',payload,source_url,asr_engine}]}]}`;creator 缺 source_uid → creator_id=null
- bilibili extra:aid,cid,pic,desc,ctime,tid,copyright,state,publocation,tags[{tag_id,tag_name}],dimension,pages,rights,honor,ugc_season{id,title},stat{view,danmaku,reply,favorite,coin,share,like,now_rank,his_rank},paid,paid_detail;tid→tname 走 data/zones-v1.json 反查
- youtube extra(youtube-payload.js:94-101):`stat{view,like}, desc`——**刻意对齐 stat 结构让 web/CLI 一视同仁**
- **douyin 建议**:`stat{digg_count→like, play_count→view, share_count, comment_count}, desc, aweme_id, duration/published_at` + creator sec_uid;至少给 stat.view 使统计列可用
- track lan:ASR='asr-zh'(track_type=1);默认轨优先级 queries.ts:26-29

## 4. B 站 ASR backfill 链路(平台化参考)

1. 编排 cli/commands/asr.ts(`asr backfill`,buildAsrCommand:154-197):圈定 listVideos({tags:'no-subtitle',source:'bilibili'})(HTTP,:127-131)
2. 音轨:resolveWbiKeys(nav 匿名恒 -101 **cookie 必配**,:57)→ view→cid → playurl→dash.audio[0]/**durl 降级**(asr-bili.ts:30-56)→ asr-net.ts downloadAudio:62(412 三档退避 30s/2m/5m)
3. 转写:asr-transcribe.ts — **POST {asrApi}/v1/tasks(FormData file+verbose_json+model=AED)→ 轮询 /v1/tasks/{id}(2s,1900s 上限,超时 DELETE)**(平台无关,直接复用)
4. segmentsToCues + 覆盖率校验(末段<50% 拒收,:104-108)
5. 写回:client.asrSubmit('bilibili',…)→ POST /api/asr/submit → insertTracksVersions(lan='asr-zh',track_type=1,origin='asr',asr_engine,source_url='asr://<engine>')+ 同事务 unmarkNoSubtitle
- **配置注入点(全 CLI flag/env)**:`--asr-url`(默认 http://127.0.0.1:5079,:23)、`--engine`(默认 fireredasr-aed-l)、`--cookie-file`/$COLLECTOR_BILI_COOKIE_FILE
- douyin ASR:转写层零改动复用;需平台化的是「圈定 source + 音轨/视频获取(douyin 无 wbi,有自己的签名 → 路径:经扩展 WS 代理拿实时 play_url,或 SSR)+ processVideo B 站段抽分支」;/api/asr/submit source 自由 string 零改动

## 5. 流程纪律(实施时)

- 改 CLI 命令/选项 → 同步 docs/skills/collector/SKILL.md(qa 门 verify-skill-sync 拦)+ docs/help/ 对应页 + README Feature 列表
- server 改动 → `npx tsc --noEmit` 本地先过(tsc 门只在 docker build 跑)
- 涉扩展改动 → manifest version bump
- android ShareTextParser.kt 白名单同步
- CLAUDE.md §6 冻结政策:新增 douyin 平台属采集侧新能力——**已由用户 2026-08-29 现场指令解冻**(「全量把抖音做了」,loop job 20c97e90),记录在案
